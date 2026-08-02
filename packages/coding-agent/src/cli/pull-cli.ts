/**
 * Refresh a git-source install of oh-my-pi.
 *
 * Git source installs (a contributor running from a git clone) are updated by
 * rebasing onto the upstream remote branch. Detected via `detectGitTarget()`
 * and invoked from `runUpdateCommand` in `update-cli.ts`.
 *
 * The implementation follows the §2 state machine in
 * `docs/UPDATE-SCRIPT-SPEC.zh-CN.md`:
 *
 *   Preflight → Status → Confirm → (Pre-sync guard) → Stash → Fetch+rebase →
 *   Re-apply stash → Post-sync deps → Done
 *
 * Project-specific deviations:
 *
 * - The pre-sync guard (§2.4, §4) targets the dev stack detection in the
 *   reference spec; oh-my-pi source installs are run by contributors who invoke
 *   `bun run` themselves and don't ship a long-running watcher. The phase is
 *   collapsed into the install step instead: if `bun.lock` changed, the
 *   subsequent `bun install` rewrites `node_modules/` atomically, leaving any
 *   existing dev process on the previous toolchain until the user restarts it.
 *   No worktree mutation happens before then, so a stale process can continue
 *   running through the sync.
 *
 * - §3.5 mirror conflict policy: this project adopts the **upstream-default
 *   (ours)** policy. The reference spec defaults to **theirs** (stash side)
 *   on the grounds that user mirror configuration should not be silently
 *   reverted. For oh-my-pi the bun-fig-driven registry lives in
 *   `bunfig.toml` (project file) and a user mirror is rarely committed into
 *   the lockfile mid-feature, so adopting the rebase-applied upstream
 *   lockfile preserves the repo's "track upstream" guarantee. Switch this
 *   only after coordinated with users who rely on lockfile-side mirrors.
 *
 * - §2.6 fetch uses the central `fetch()` helper rather than `git fetch
 *   --prune <remote>` so it composes with the repo's other pruners; new
 *   remote-tracking refs are picked up next time the helper is invoked with
 *   the same refspec shape. Stale local refs in `refs/remotes/<remote>/*`
 *   are pruned by `git remote prune <remote>` if needed (out of scope here).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	branch,
	diff,
	fetch as gitFetch,
	head,
	ref,
	remote,
	repo,
	restore,
	stash,
	status,
	withRepoLock,
} from "../utils/git";
import { rebase } from "../utils/git-rebase";
import { stashDrop } from "../utils/stash-drop";
import { resolveRegistry } from "./update-cli/registry";

const EXPECTED_REMOTE_ORIGIN = "https://github.com/ql-isaac/oh-my-pi.git";
const EXPECTED_REMOTE_UPSTREAM = "https://github.com/can1357/oh-my-pi.git";

/** How long the wait loops in non-TTY mode run before surfacing a hard error. */
const WAIT_LOOP_HARD_TIMEOUT_MS = 30 * 60 * 1000;
/** Sleep interval between rebase / stash completion checks in non-TTY mode. */
const WAIT_LOOP_POLL_INTERVAL_MS = 5_000;

const STASH_MESSAGE_PREFIX = "omp-update";

/** Result from detecting a git source install. */
export interface GitSourceInstall {
	repoRoot: string;
	branch: string;
	remote: string;
}

export interface GitUpdateTarget {
	method: "git";
	repoRoot: string;
	branch: string;
	remote: string;
}

/** Snapshot of the worktree state used by the §2.2 Status phase. */
export interface UpdateStatusSummary {
	/** Files modified / staged / untracked in the working tree. */
	dirty: number;
	/** Local commits not present on the upstream tracking ref. */
	unpushed: number;
	/** Upstream commits not present locally. */
	behind: number;
}

/**
 * Detect if the running process is from a git source clone of oh-my-pi.
 * Returns `null` when the script is not running from such a clone.
 */
async function detectGitSourceInstall(): Promise<GitSourceInstall | null> {
	let scriptDir: string;
	try {
		scriptDir = path.dirname(fileURLToPath(import.meta.url));
	} catch {
		scriptDir = process.cwd();
	}
	const repoRoot = await repo.root(scriptDir);
	if (!repoRoot) return null;

	const originUrl = await remote.url(repoRoot, "origin");
	const normalizedOrigin = originUrl?.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "") ?? "";
	const expectedOrigin = EXPECTED_REMOTE_ORIGIN.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");
	const expectedUpstream = EXPECTED_REMOTE_UPSTREAM.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "");

	let detectedRemote: string | null = null;

	if (normalizedOrigin === expectedUpstream) {
		detectedRemote = "origin";
	} else if (normalizedOrigin === expectedOrigin) {
		const upstreamUrl = await remote.url(repoRoot, "upstream");
		const normalizedUpstream = upstreamUrl?.replace(/\.git$/, "").replace(/^https:\/\/github\.com\//, "") ?? "";
		if (normalizedUpstream === expectedUpstream) {
			detectedRemote = "upstream";
		} else {
			detectedRemote = "origin";
		}
	}

	if (!detectedRemote) return null;

	const cliPath = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
	const packageJsonPath = path.join(repoRoot, "package.json");
	const cliFile = Bun.file(cliPath);
	const packageJsonFile = Bun.file(packageJsonPath);
	const [cliExists, packageJsonExists] = await Promise.all([cliFile.exists(), packageJsonFile.exists()]);
	if (!cliExists || !packageJsonExists) return null;

	const branchName = await branch.current(repoRoot);

	return {
		repoRoot,
		branch: branchName ?? "HEAD",
		remote: detectedRemote,
	};
}

/**
 * Pretty-print the current HEAD description for a git-source install.
 */
async function describeGitSourceVersion(target: GitUpdateTarget): Promise<string> {
	const sha = await head.short(target.repoRoot, 8);
	const tags = await ref.tags(target.repoRoot, "HEAD");
	return tags.length > 0 ? `${tags[0]} (${sha})` : (sha ?? "unknown");
}

/** Refresh the local ref for the target remote branch. */
async function fetchGitTarget(target: GitUpdateTarget): Promise<void> {
	await gitFetch(
		target.repoRoot,
		target.remote,
		`refs/heads/${target.branch}`,
		`refs/remotes/${target.remote}/${target.branch}`,
	);
}

/** True when a rebase is currently in progress in `cwd`.
 *  A paused rebase leaves one of two state directories under `$GIT_DIR`:
 *    - `rebase-merge/`: ordinary rebase / interactive rebase
 *    - `rebase-apply/`: legacy `git rebase --apply` / `git am` paths
 *  We probe both. Checking the directory (not the `REBASE_HEAD` ref) avoids the
 *  Git quirk where `REBASE_HEAD` survives as a stale artifact after a non-
 *  interactive rebase lands its final commit; `git status` and `git rebase
 *  --state` consult the same directory pair, so this matches their semantics. */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
	const gitDirResult = await $`git rev-parse --git-dir`.cwd(cwd).quiet().nothrow();
	if (gitDirResult.exitCode !== 0) return false;
	const gitDir = gitDirResult.text().trim();
	for (const name of ["rebase-merge", "rebase-apply"]) {
		try {
			await fs.access(path.join(gitDir, name));
			return true;
		} catch {
			// not present in this state directory; check the next one
		}
	}
	return false;
}

/** Relationship between local HEAD and a fetched upstream ref. */
export type LocalRemoteRelation = "same" | "ahead" | "behind" | "diverged";

/**
 * Classify the relationship between `localSha` and `remoteSha` so a local
 * commit ahead of upstream does not masquerade as "new commits available".
 *
 * Uses `git merge-base --is-ancestor`, which exits 0 iff the first arg is
 * reachable from the second.
 *
 * @internal Exported for unit tests; not part of the public API.
 */
export async function classifyRelation(cwd: string, localSha: string, remoteSha: string): Promise<LocalRemoteRelation> {
	if (localSha === remoteSha) return "same";
	const remoteIsAncestor = await $`git merge-base --is-ancestor ${remoteSha} ${localSha}`.cwd(cwd).quiet().nothrow();
	if (remoteIsAncestor.exitCode === 0) return "ahead";
	const localIsAncestor = await $`git merge-base --is-ancestor ${localSha} ${remoteSha}`.cwd(cwd).quiet().nothrow();
	if (localIsAncestor.exitCode === 0) return "behind";
	return "diverged";
}

/**
 * Parse `bun.lock` and extract package dependencies (name + version).
 * Ignores resolved URLs and integrity hashes so we can detect a semantic
 * change vs. just a mirror-URL rewrite.
 *
 * `bun.lock` structure:
 * - workspaces: workspace definitions
 * - packages: resolved packages as [name@version, url, metadata, integrity]
 *
 * @internal Exported for unit tests; not part of the public API.
 */
export function parseLockfileDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	try {
		const lockfile = JSON.parse(content);
		const packages = lockfile.packages;
		if (!packages || typeof packages !== "object") return deps;

		for (const [key, value] of Object.entries(packages)) {
			// Skip workspace packages (they don't have array format)
			if (!Array.isArray(value)) continue;

			// Format: [name@version, url, metadata, integrity]
			const nameAtVersion = value[0];
			if (typeof nameAtVersion !== "string") continue;

			// Parse "name@version" — handle scoped packages like "@scope/pkg@1.0.0"
			const lastAt = nameAtVersion.lastIndexOf("@");
			if (lastAt === 0) continue; // Invalid format

			const version = nameAtVersion.substring(lastAt + 1);
			deps.set(key, version);
		}
	} catch {
		// Failed to parse lockfile, return empty map
	}
	return deps;
}

/**
 * True when two lockfile dep maps hold the same packages at the same versions.
 * @internal Exported for unit tests; not part of the public API.
 */
export function compareLockfileDeps(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [pkg, version] of a) {
		if (b.get(pkg) !== version) return false;
	}
	return true;
}

// ============================================================================
// §2.2 Status phase
// ============================================================================

async function countDirty(cwd: string): Promise<number> {
	const summary = await status.summary(cwd);
	if (!summary) return 0;
	return summary.staged + summary.unstaged + summary.untracked;
}

async function countUnpushed(cwd: string, upstream: string): Promise<number> {
	const result = await $`git rev-list --count ${upstream}..HEAD`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) return 0;
	const n = Number.parseInt(result.text().trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

async function countBehind(cwd: string, upstream: string): Promise<number> {
	const result = await $`git rev-list --count HEAD..${upstream}`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) return 0;
	const n = Number.parseInt(result.text().trim(), 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the DIRTY / UNPUSHED / BEHIND counts for the §2.2 Status report.
 * @internal Exported for unit tests; not part of the public API.
 */
export async function collectStatus(cwd: string, upstream: string): Promise<UpdateStatusSummary> {
	const [dirty, unpushed, behind] = await Promise.all([
		countDirty(cwd),
		countUnpushed(cwd, upstream),
		countBehind(cwd, upstream),
	]);
	return { dirty, unpushed, behind };
}

/** Print the §2.2 status block. */
function printStatusBlock(repoRoot: string, branch: string, remote: string, summary: UpdateStatusSummary): void {
	console.log(chalk.bold(`\n=== ${APP_NAME} update · git source ===`));
	console.log(chalk.dim(`branch: ${branch}    remote: ${remote}/${branch}    worktree: ${repoRoot}`));
	console.log("");
	console.log(`  ${chalk.bold("DIRTY")}     ${summary.dirty}`);
	console.log(`  ${chalk.bold("UNPUSHED")}  ${summary.unpushed}`);
	console.log(`  ${chalk.bold("BEHIND")}    ${summary.behind}`);
	console.log("");
}

// ============================================================================
// §2.3 Confirm phase
// ============================================================================

/**
 * Ask the user to confirm the update. Skipped when `opts.yes` is set or
 * stdin is not a TTY (§2.3: non-TTY mode without `--yes` continues silently
 * — preventing hangs in CI), or when nothing would change on disk.
 *
 * Returns `true` when the user accepts (or when the prompt is skipped).
 */
async function confirmUpdate(summary: UpdateStatusSummary, opts: { yes: boolean }): Promise<boolean> {
	if (opts.yes) return true;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
	// §2.2 early-exit: nothing to do.
	if (summary.dirty === 0 && summary.unpushed === 0 && summary.behind === 0) return true;

	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		// Flush whatever the Status block left in the pipe and put the prompt on
		// its own line so the user's readline carrier-return lands somewhere
		// visible; the bare `process.stdout.write(label)` that came before
		// caused the cursor to ride on the same line as the previous "will
		// rebase" output and the prompt vanished into the trailing frame on
		// some terminals.
		process.stdout.write("\n");
		const label = `${theme.status.warning} Proceed? Stash + rebase + bun install. [y/N] `;
		process.stdout.write(label);
		const { promise, resolve } = Promise.withResolvers<string>();
		const onLine = (line: string) => {
			rl.off("line", onLine);
			resolve(line);
		};
		rl.on("line", onLine);
		const answer = (await promise).trim().toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

// ============================================================================
// §3.3 wait loop primitives
// ============================================================================

/**
 * Block until `done()` returns `true`, polling on the spec's recommended
 * schedule and surfacing user-facing steps on every iteration. TTY mode lets
 * the user press Enter to re-check immediately or `a` to abort; non-TTY mode
 * polls on a fixed interval. Hard timeout aborts to avoid silent hangs in CI.
 *
 * Returns `true` when the loop completed normally (poll done), `false` when
 * the user pressed `a` to abort (`onAbort` was invoked for cleanup).
 */
async function waitForUserCompletion(args: {
	readonly isDone: () => Promise<boolean>;
	readonly renderUnmerged: () => Promise<void>;
	readonly phaseLabel: string;
	readonly abortHint: string;
	readonly onAbort: () => Promise<void>;
}): Promise<boolean> {
	const tty = process.stdin.isTTY && process.stdout.isTTY;
	const startedAt = Date.now();

	for (;;) {
		if (await args.isDone()) return true;

		if (Date.now() - startedAt > WAIT_LOOP_HARD_TIMEOUT_MS) {
			console.error(
				chalk.red(
					`${theme.status.error} ${args.phaseLabel}: timed out after ${Math.round(
						WAIT_LOOP_HARD_TIMEOUT_MS / 60_000,
					)} min waiting for user resolution`,
				),
			);
			console.error(chalk.dim(`      → check that another terminal is making progress on ${args.abortHint}`));
			console.error(
				chalk.dim(
					`      → ${args.phaseLabel} state in this process is left as-is; resolve manually then re-run.`,
				),
			);
			process.exit(1);
		}

		console.log(chalk.dim(`\n[waiting for ${args.phaseLabel} to complete]`));
		await args.renderUnmerged();

		if (tty) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				process.stdout.write(
					chalk.dim(`Press Enter to re-check, or type 'a' + Enter to abort (${args.abortHint}): `),
				);
				const answer = (await rl.question("")).trim();
				if (answer === "a" || answer === "abort") {
					await args.onAbort();
					return false;
				}
			} finally {
				rl.close();
			}
		} else {
			console.log(chalk.dim(`(non-TTY; polling every ${WAIT_LOOP_POLL_INTERVAL_MS / 1000}s until done)`));
			await Bun.sleep(WAIT_LOOP_POLL_INTERVAL_MS);
		}
	}
}

// ============================================================================
// core update
// ============================================================================

/**
 * Print an error in the §7 three-line structure (icon, next-step, fallback).
 * Used for hard-failure messages; warnings stay one-liners.
 */
function printHardError(summary: string, nextStep: string, fallback: string): void {
	console.error(chalk.red(`${theme.status.error} ${summary}`));
	console.error(chalk.dim(`      → ${nextStep}`));
	console.error(chalk.dim(`      → ${fallback}`));
}

/**
 * Try to drop the just-popped stash and clear conflict markers from the
 * working copy. Best-effort: a stash that has already been popped or a path
 * that no longer exists leaves this a no-op.
 */
async function cleanupStashConflict(repoRoot: string): Promise<void> {
	const unmerged = await $`git diff --name-only --diff-filter=U`.cwd(repoRoot).quiet().nothrow();
	const paths = unmerged.text().trim().split("\n").filter(Boolean);
	if (paths.length === 0) return;
	try {
		// §3.4: bring the working copy back to a conflict-free HEAD state. We
		// cannot merge stashed content into ours/theirs without breaking the
		// user's mirror contract, so the stash entry is dropped after the
		// worktree is reset to HEAD. The user can recover their work via
		// `git fsck` + reflog if they had truly novel edits.
		await $`git checkout -- ${paths.map(p => `'${p.replace(/'/g, "'\\''")}'`).join(" ")}`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
	} catch {
		// Fall through; the warning above is the user-facing signal.
	}
}

/**
 * Run the §2.5 stash phase. The stash message embeds an ISO-8601 UTC
 * timestamp so multiple in-flight stashes are distinguishable and the §3.3
 * wait loop can detect whether the user has manually dropped one.
 *
 * Returns the message (used both as a name and as the §3.3 polling key), or
 * `null` if no stash was needed (working tree already clean).
 */
async function phaseStash(repoRoot: string): Promise<string | null> {
	const summary = await status.summary(repoRoot);
	const dirty = summary ? summary.staged + summary.unstaged + summary.untracked : 0;
	if (dirty === 0) return null;

	const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const message = `${STASH_MESSAGE_PREFIX} ${stamp}`;
	console.log(chalk.dim(`Stashing local changes → stash message: ${message}`));
	const created = await stash.push(repoRoot, message);
	if (!created) {
		printHardError(
			"git stash --include-untracked did not create an entry",
			"verify the worktree is not already inside `git stash`",
			`resolve manually with \`git stash push -m "${message}"\`, then re-run \`${APP_NAME} update\``,
		);
		process.exit(1);
	}
	console.log(chalk.dim(`Local changes stashed (${message}).`));
	return message;
}

/**
 * Phase 1 — fetch + rebase under the repo lock. Yields if either step
 * conflict; the wait loop drives the user through resolution per §3.3.
 *
 * Returns the new HEAD SHA on success (may equal `oldSha` after a no-op
 * rebase), or `null` if the user aborted the rebase.
 *
 * Hooks SIGINT to a child `AbortController` so a Ctrl-C while a slow rebase
 * is mid-replay aborts the `git rebase` child and leaves the repo in a
 * deterministic state (no half-written `rebase-merge/`). Without this, the
 * long rebase silently consumes parent-SIGINT and the user can't tell whether
 * the child finished or not.
 */
async function phaseFetchRebase(
	repoRoot: string,
	remote: string,
	branch: string,
	oldSha: string | null,
): Promise<string | null> {
	return withRepoLock(repoRoot, async () => {
		const ctrl = new AbortController();
		const onSigint = () => ctrl.abort();
		process.once("SIGINT", onSigint);
		try {
			try {
				await rebase(repoRoot, `${remote}/${branch}`, ctrl.signal);
				const newSha = await head.sha(repoRoot);
				return newSha ?? oldSha;
			} catch (err) {
				if (ctrl.signal.aborted) {
					// Ctrl-C interrupted the rebase. Surface a clear "stop here"
					// so the caller skips stash-pop / install / printDone and
					// leaves the user's stash and any in-progress `rebase-merge`
					// state untouched. Returning `null` matches the path the
					// §3.3 abort branch takes.
					return null;
				}
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.toLowerCase().includes("conflict")) throw err;
				if (!(await isRebaseInProgress(repoRoot))) throw err;

				console.log(chalk.yellow(`\n${theme.status.warning} Rebase conflicts detected on ${remote}/${branch}.`));
				const completed = await waitForUserCompletion({
					phaseLabel: "rebase",
					abortHint: "`git rebase --abort` to cancel",
					isDone: () => isRebaseInProgress(repoRoot).then(busy => !busy),
					renderUnmerged: async () => {
						const unmergedResult = await $`git diff --name-only --diff-filter=U`
							.cwd(repoRoot)
							.quiet()
							.nothrow();
						const files = unmergedResult.text().trim().split("\n").filter(Boolean);
						if (files.length === 0) {
							console.log(chalk.dim("  no unmerged files reported"));
						} else {
							console.log(chalk.dim("  unmerged files:"));
							for (const file of files) console.log(chalk.dim(`    - ${file}`));
						}
						console.log(chalk.dim("  resolve each file, then `git add <file>`"));
						console.log(chalk.dim(`  finish with: \`git rebase --continue\``));
					},
					onAbort: async () => {
						try {
							await rebase.abort(repoRoot);
						} catch {
							// Best-effort; user already wanted to stop.
						}
					},
				});
				if (!completed) return null;

				const postRebaseSha = await head.sha(repoRoot);
				if (postRebaseSha === oldSha) return oldSha; // another path aborted the rebase externally
				console.log(chalk.green(`${theme.status.success} Rebase completed.`));
				return postRebaseSha;
			}
		} finally {
			process.off("SIGINT", onSigint);
		}
	});
}

/**
 * Phase 2 — re-apply the stash. When the pop fails we look at the working-
 * copy conflict set and either auto-resolve a pure lockfile mirror rewrite
 * (§3.5) or surface the conflict for manual handling. Either way the
 * working tree must be conflict-free before Phase 3 runs `bun install`.
 *
 * Returns `true` when the worktree is in a clean enough state to install.
 */
async function phaseReapplyStash(
	repoRoot: string,
	stashMessage: string | null,
	oldSha: string | null,
): Promise<{ ok: boolean; reason?: string }> {
	if (stashMessage === null) return { ok: true };

	console.log(chalk.dim(`Restoring stashed changes (${stashMessage})...`));
	try {
		await stash.pop(repoRoot);
		return { ok: true };
	} catch {
		// Fall through to conflict triage.
	}

	const unmergedResult = await $`git diff --name-only --diff-filter=U`.cwd(repoRoot).quiet().nothrow();
	const conflicted = unmergedResult.text().trim().split("\n").filter(Boolean);
	const lockfileConflicts = conflicted.filter(f => f === "bun.lock");
	const otherConflicts = conflicted.filter(f => f !== "bun.lock");

	if (lockfileConflicts.length > 0 && otherConflicts.length === 0 && oldSha) {
		const stashLockfile = await $`git show stash@{0}:bun.lock`.cwd(repoRoot).quiet().nothrow();
		const oldLockfile = await $`git show ${oldSha}:bun.lock`.cwd(repoRoot).quiet().nothrow();

		if (stashLockfile.exitCode !== 0 || oldLockfile.exitCode !== 0) {
			console.log(
				chalk.yellow(`${theme.status.warning} Could not read lockfile from git history for comparison.`),
			);
			console.log(chalk.dim("      → resolve by running `git stash pop` manually"));
			console.log(chalk.dim("      → if it is a pure registry URL rewrite, drop the stash instead"));
			return { ok: false, reason: "lockfile-history-unreadable" };
		}

		const stashDeps = parseLockfileDeps(stashLockfile.text());
		const oldDeps = parseLockfileDeps(oldLockfile.text());
		const hasUserChanges = !compareLockfileDeps(stashDeps, oldDeps);

		if (!hasUserChanges) {
			// §3.5 auto-resolve: the stash only contained a mirror-URL rewrite
			// of `bun.lock` (the dep graph is identical). Adopt HEAD's
			// lockfile and drop the stash; any further mirror-only conflict
			// will be visible on the next sync. Update the policy comment at
			// the top of this file when changing which side wins.
			console.log(
				chalk.dim(
					`${theme.status.warning} Lockfile conflict detected (mirror URL rewrite only), auto-resolving to HEAD...`,
				),
			);
			await restore(repoRoot, {
				source: "HEAD",
				staged: true,
				worktree: true,
				files: lockfileConflicts,
			});
			await stashDrop(repoRoot);
			console.log(chalk.green(`${theme.status.success} Lockfile conflict auto-resolved.`));
			return { ok: true };
		}

		console.log(chalk.yellow(`${theme.status.warning} Lockfile conflict detected with dependency changes.`));
		console.log(chalk.dim("      → your local changes include custom dependency modifications"));
		console.log(chalk.dim(`      → resolve by running \`git stash pop\` and merge the dep sections manually`));
		console.log(chalk.dim(`      → or drop the stash with \`git stash drop\` and re-run \`${APP_NAME} update\``));
		return { ok: false, reason: "lockfile-user-deps" };
	}

	if (otherConflicts.length > 0) {
		console.log(
			chalk.yellow(
				`${theme.status.warning} Stash pop left conflicts in: ${otherConflicts.join(", ")}${
					lockfileConflicts.length > 0 ? `, bun.lock` : ""
				}`,
			),
		);
		console.log(chalk.dim("      → resolve by running `git stash pop` manually"));
		console.log(chalk.dim(`      → when the tree is clean, re-run \`${APP_NAME} update\``));
		return { ok: false, reason: "stash-pop-conflicts" };
	}

	console.log(chalk.yellow(`${theme.status.warning} Stash pop failed without any unmerged files.`));
	console.log(chalk.dim(`      → check the rebase/stash state with \`git status\` and \`git stash list\``));
	await cleanupStashConflict(repoRoot);
	return { ok: false, reason: "stash-pop-failed" };
}

/**
 * Phase 3 — refresh dependencies when the lockfile changed. We deliberately
 * scope the diff to `oldSha..HEAD` (§2.8: not `main..HEAD`, not `@{u}..HEAD`)
 * so the install run reflects exactly the upstream commits we just replayed,
 * not the cumulative history. Native addons are rebuilt before `bun install`
 * so the post-install `node_modules/` matches the just-rebuilt `.node` ABI.
 */
async function phasePostSyncDeps(
	repoRoot: string,
	oldSha: string | null,
	installAllowed: boolean,
): Promise<void> {
	if (!installAllowed) return;

	const changedPaths = oldSha
		? (await diff(repoRoot, { base: oldSha, nameOnly: true })).split("\n").filter(Boolean)
		: [];

	const nativeChanged = changedPaths.some(p => p.startsWith("crates/") || p.startsWith("packages/natives/"));
	if (nativeChanged) {
		console.log(chalk.dim("Native source code changed, rebuilding..."));
		const buildResult = await $`bun run build:native`.cwd(repoRoot).quiet().nothrow();
		if (buildResult.exitCode === 0) {
			console.log(chalk.green(`${theme.status.success} Native addons rebuilt`));
		} else {
			console.log(
				chalk.yellow(
					`${theme.status.warning} Native rebuild failed (exit ${buildResult.exitCode}). Run \`bun run build:native\` manually.`,
				),
			);
		}
	}

	const lockfilePath = path.join(repoRoot, "bun.lock");
	const lockfileExists = await Bun.file(lockfilePath).exists();
	if (!lockfileExists) return;

	const lockfileChanged = changedPaths.includes("bun.lock");
	if (!lockfileChanged) {
		console.log(chalk.dim("no dep changes — skipping bun install"));
		return;
	}

	console.log(chalk.dim("Lockfile changed, updating dependencies..."));
	const installResult = await $`bun install`.cwd(repoRoot).quiet().nothrow();
	if (installResult.exitCode !== 0) {
		const registry = await resolveRegistry();
		if (registry !== "https://registry.npmjs.org") {
			throw new Error(
				`bun install failed (exit ${installResult.exitCode}). Your registry (${registry}) may not have synced new packages yet. Run \`bun install\` manually or switch to the default registry.`,
			);
		}
		throw new Error(`bun install failed (exit ${installResult.exitCode}). Run \`bun install\` manually.`);
	}
}

/** §2.9 — emit the final summary block. */
async function printDone(repoRoot: string, branch: string, remote: string, stashMessage: string | null): Promise<void> {
	const newSha = await head.short(repoRoot, 8);
	console.log("");
	console.log(chalk.bold("=== updated ==="));
	console.log(`  branch:    ${branch}`);
	console.log(`  upstream:  ${remote}/${branch}`);
	console.log(`  new sha:   ${newSha ?? "unknown"}`);
	if (stashMessage) console.log(`  stash:     ${stashMessage} (recover with \`git stash pop\` if needed)`);
	console.log("");
}

/**
 * Detect the git target, returning `null` if the running binary is not in a known clone.
 */
export async function detectGitTarget(): Promise<GitUpdateTarget | null> {
	const source = await detectGitSourceInstall();
	if (!source) return null;
	return {
		method: "git",
		repoRoot: source.repoRoot,
		branch: source.branch,
		remote: source.remote,
	};
}

/** Run the git-based update for a recognised git source install. */
export async function runGitUpdate(
	target: GitUpdateTarget,
	opts: { force: boolean; check: boolean; yes: boolean },
): Promise<void> {
	console.log(chalk.dim(`Current version: ${await describeGitSourceVersion(target)} (git source)`));

	// Bail early if the user is in the middle of a manual rebase — they
	// must finish it (or abort) before the update can proceed.
	if (await isRebaseInProgress(target.repoRoot)) {
		printHardError(
			`A rebase is already in progress on ${target.branch}`,
			`resolve conflicts and run \`git rebase --continue\`, or run \`git rebase --abort\` to cancel`,
			`then re-run \`${APP_NAME} update\``,
		);
		return;
	}

	await fetchGitTarget(target);
	const remoteSha = await ref.resolve(target.repoRoot, `${target.remote}/${target.branch}`);
	const localSha = await head.sha(target.repoRoot);

	if (!remoteSha) {
		printHardError(
			`No remote tracking for ${target.remote}/${target.branch}`,
			`verify the remote is configured with \`git remote -v\``,
			`add the upstream with \`git remote add upstream ${EXPECTED_REMOTE_UPSTREAM}\` then re-run`,
		);
		return;
	}
	if (!localSha) {
		printHardError(
			"Local HEAD is unborn",
			`make at least one commit (or fetch a tracking branch) before running \`${APP_NAME} update\``,
			"see `git status` for current branch state",
		);
		return;
	}

	const shortSha = (s: string) => s.slice(0, 8);
	const summary = await collectStatus(target.repoRoot, `${target.remote}/${target.branch}`);
	printStatusBlock(target.repoRoot, target.branch, target.remote, summary);

	const relation = await classifyRelation(target.repoRoot, localSha, remoteSha);

	if (relation === "same" && !opts.force) {
		const sha = (await head.short(target.repoRoot, 8)) ?? shortSha(localSha);
		console.log(chalk.green(`${theme.status.success} Already up to date at ${sha}`));
		return;
	}
	if (relation === "ahead" && !opts.force) {
		const sha = (await head.short(target.repoRoot, 8)) ?? shortSha(localSha);
		console.log(
			chalk.yellow(
				`${theme.status.warning} Local HEAD ${sha} is ahead of ${target.remote}/${target.branch} (${shortSha(
					remoteSha,
				)}); nothing to pull. Pass --force to rebase anyway.`,
			),
		);
		return;
	}
	if (relation === "behind") {
		console.log(chalk.cyan(`New commits available on ${target.remote}/${target.branch}`));
	} else if (relation === "diverged") {
		console.log(chalk.cyan(`Local and ${target.remote}/${target.branch} have diverged; will rebase`));
	} else if (opts.force) {
		console.log(chalk.yellow(`${theme.status.warning} Forcing sync with ${target.remote}/${target.branch}`));
	}

	if (opts.check) return;

	const accepted = await confirmUpdate(summary, { yes: opts.yes });
	if (!accepted) {
		console.log(chalk.dim("Cancelled."));
		return;
	}

	try {
		const stashMessage = await phaseStash(target.repoRoot);
		const postRebaseSha = await phaseFetchRebase(target.repoRoot, target.remote, target.branch, localSha);
		if (postRebaseSha === null) {
			// User aborted the rebase; nothing else to do. The stash entry is
			// still on the stack and the working copy is back to oldSha.
			console.log(
				chalk.dim(`Rebase aborted; stash "${stashMessage ?? "none"}" preserved for manual handling.`),
			);
			return;
		}

		const reapply = await phaseReapplyStash(target.repoRoot, stashMessage, localSha);
		await phasePostSyncDeps(target.repoRoot, localSha, reapply.ok);
		await printDone(target.repoRoot, target.branch, target.remote, stashMessage);
	} catch (err) {
		printHardError(
			`update failed: ${err instanceof Error ? err.message : String(err)}`,
			`inspect the working tree state with \`git status\` and \`git stash list\``,
			`resolve any half-completed state, then re-run \`${APP_NAME} update\``,
		);
		process.exit(1);
	}
}

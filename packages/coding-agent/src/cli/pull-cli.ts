/**
 * Refresh a git-source install of oh-my-pi.
 *
 * Git source installs (a contributor running from a git clone) are updated
 * via rebasing onto the upstream remote branch. Detected via `detectGitTarget()`
 * and invoked from `runUpdateCommand` in `update-cli.ts`.
 *
 * Flow when `omp` is running from a recognised git clone:
 *
 * 1. Detect the clone by walking up to the repo root, then matching the
 *    `origin` (and optionally `upstream`) remote URL against the known
 *    upstream `can1357/oh-my-pi` and the local fork `ql-isaac/oh-my-pi`.
 * 2. Stash local changes if the worktree is dirty.
 * 3. Fetch and rebase onto the target remote branch. If the rebase
 *    encounters conflicts, the user is prompted to resolve them and run
 *    `git rebase --continue`; the script waits for the rebase to complete
 *    before continuing to the next step. If the rebase is aborted, the
 *    script exits and the user must re-run `omp update`.
 * 4. Restore the stash. If the pop conflicts on `bun.lock` and the stash's
 *    dep graph is semantically identical to HEAD's, auto-resolve by
 *    adopting the upstream lockfile and dropping the stash (mirrors a
 *    registry URL rewrite only); otherwise surface the conflict and let
 *    the user resolve manually.
 * 5. If `bun.lock` changed (rebase or stash restore), re-run `bun install`
 *    against the merged tree. Surface mirror-aware errors when the user's
 *    registry has not synced the release yet.
 * 6. Print the new SHA.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
 *  Checks the authoritative `.git/rebase-merge/` directory rather than the
 *  `REBASE_HEAD` ref, which can persist as a stale artifact after the rebase
 *  has completed (Git quirk when the last commit is applied non-interactively).
 *  See `git status` / `git rebase --state` for the same semantics. */
export async function isRebaseInProgress(cwd: string): Promise<boolean> {
	const gitDirResult = await $`git rev-parse --git-dir`.cwd(cwd).quiet().nothrow();
	if (gitDirResult.exitCode !== 0) return false;
	const rebaseMergeDir = path.join(gitDirResult.text().trim(), "rebase-merge");
	try {
		await fs.access(rebaseMergeDir);
		return true;
	} catch {
		return false;
	}
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

// --- bun.lock helpers ----------------------------------------------------
// --- bun.lock helpers ----------------------------------------------------

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

// --- core update ---------------------------------------------------------

async function updateViaGit(repoRoot: string, branch: string, remote: string): Promise<void> {
	console.log(chalk.dim(`Updating via git pull from ${remote}...`));

	const summary = await status.summary(repoRoot);
	let stashed = false;
	if (summary && (summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0)) {
		console.log(chalk.dim("Stashing local changes..."));
		stashed = await stash.push(repoRoot, "omp-update stash");
		console.log(chalk.dim("Local changes stashed."));
	}

	const oldSha = await head.sha(repoRoot);

	// Phase 1: fetch + rebase under the repo lock. Anything that mutates
	// refs belongs in here; stash handling and install deliberately happen
	// outside so the lockfile we install against reflects both upstream and
	// the user's stashed changes.
	await withRepoLock(repoRoot, async () => {
		console.log(chalk.dim(`Rebasing onto ${remote}/${branch}...`));
		try {
			await rebase(repoRoot, `${remote}/${branch}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes("conflict")) {
				console.log(chalk.yellow(`\nRebase conflicts detected on ${remote}/${branch}.`));
				console.log(
					chalk.dim("Resolve the conflicts, stage them with `git add`, then run `git rebase --continue`."),
				);
				console.log(
					chalk.dim("Waiting for rebase to complete... (Ctrl+C to exit, then `git rebase --abort` to cancel)"),
				);
				while (await isRebaseInProgress(repoRoot)) {
					await Bun.sleep(2000);
				}
				const postRebaseSha = await head.sha(repoRoot);
				if (postRebaseSha === oldSha) {
					console.log(chalk.red("Rebase was aborted. Run `omp pull` again to retry."));
					return;
				}
				console.log(chalk.green("Rebase completed, continuing update..."));
			} else {
				throw err;
			}
		}
	});

	// Phase 2: restore stashed changes. A failed pop is either:
	//   - a lockfile mirror-URL rewrite only → resolve and drop the stash,
	//   - a real conflict (user changed deps, or non-lockfile files conflict),
	//   - or something else (worktree dirty, stash entry gone).
	// In every failure case we surface the reason and let the user decide,
	// so install below only runs against a clean tree.
	let stashConflict: "lockfile-mirror" | "user-deps" | "other" | null = null;
	if (stashed) {
		console.log(chalk.dim("Restoring local changes..."));
		try {
			await stash.pop(repoRoot);
		} catch (err) {
			const unmerged = await $`git diff --name-only --diff-filter=U`.cwd(repoRoot).quiet().nothrow();
			const conflicted = unmerged.text().trim().split("\n").filter(Boolean);
			const lockfileConflicts = conflicted.filter(f => f === "bun.lock");
			const otherConflicts = conflicted.filter(f => f !== "bun.lock");

			if (lockfileConflicts.length > 0 && otherConflicts.length === 0 && oldSha) {
				const stashLockfile = await $`git show stash@{0}:bun.lock`.cwd(repoRoot).quiet().nothrow();
				const oldLockfile = await $`git show ${oldSha}:bun.lock`.cwd(repoRoot).quiet().nothrow();

				if (stashLockfile.exitCode !== 0 || oldLockfile.exitCode !== 0) {
					console.log(chalk.yellow("Could not read lockfile from git history for comparison."));
					console.log(chalk.yellow("Run `git stash pop` manually to resolve conflicts."));
					stashConflict = "other";
				} else {
					const stashDeps = parseLockfileDeps(stashLockfile.text());
					const oldDeps = parseLockfileDeps(oldLockfile.text());
					const hasUserChanges = !compareLockfileDeps(stashDeps, oldDeps);

					if (!hasUserChanges) {
						// Mirror-URL rewrite: the only stashed file is bun.lock
						// (otherConflicts is empty, so the stash holds nothing
						// else). `git restore --source=HEAD` resolves the
						// working copy to upstream, then drop the stash.
						console.log(chalk.dim("Lockfile conflict detected (mirror URL rewrite only), auto-resolving..."));
						await restore(repoRoot, {
							source: "HEAD",
							staged: true,
							worktree: true,
							files: lockfileConflicts,
						});
						await stashDrop(repoRoot);
						console.log(chalk.green(`${theme.status.success} Lockfile conflict auto-resolved.`));
						stashConflict = "lockfile-mirror";
					} else {
						console.log(chalk.yellow("Lockfile conflict detected with dependency changes."));
						console.log(chalk.yellow("Your local changes include custom dependency modifications."));
						console.log(chalk.yellow("Run `git stash pop` manually to resolve conflicts."));
						stashConflict = "user-deps";
					}
				}
			} else {
				const reason = err instanceof Error ? err.message : String(err);
				console.log(chalk.yellow(`Warning: could not restore stashed changes: ${reason}`));
				if (otherConflicts.length > 0) {
					console.log(chalk.yellow(`  Conflicted files: ${otherConflicts.join(", ")}`));
					console.log(chalk.yellow(`  Run \`git stash pop\` manually to resolve.`));
				}
				stashConflict = "other";
			}
		}
	}

	// Phase 3: install + native rebuild, only against a clean tree. Skip
	// when the stash could not be restored cleanly — installing against a
	// half-popped tree would resolve the wrong dep graph.
	if (stashConflict === null) {
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
		if (await Bun.file(lockfilePath).exists()) {
			const lockfileChanged = changedPaths.includes("bun.lock");
			if (lockfileChanged) {
				console.log(chalk.dim("Lockfile changed, updating dependencies..."));
				const installResult = await $`bun install`.cwd(repoRoot).quiet().nothrow();
				if (installResult.exitCode !== 0) {
					const registry = await resolveRegistry();
					if (registry !== "https://registry.npmjs.org") {
						throw new Error(
							`Failed to install dependencies (exit ${installResult.exitCode}). Your registry (${registry}) may not have synced new packages yet. Run \`bun install\` manually or switch to the default registry.`,
						);
					}
					throw new Error(
						`Failed to install dependencies (exit ${installResult.exitCode}). Run \`bun install\` manually.`,
					);
				}
			}
		}
	}

	const newSha = await head.short(repoRoot, 8);
	console.log(chalk.green(`\n${theme.status.success} Updated to ${newSha ?? "unknown"}`));
}

/** Detect the git target, returning `null` if the running binary is not in a known clone. */
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
export async function runGitUpdate(target: GitUpdateTarget, opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${await describeGitSourceVersion(target)} (git source)`));

	// Bail early if the user is in the middle of a manual rebase — they
	// must finish it (or abort) before the update can proceed.
	if (await isRebaseInProgress(target.repoRoot)) {
		console.log(
			chalk.yellow(
				`A rebase is already in progress on ${target.branch}. Resolve conflicts and run \`git rebase --continue\`, or \`git rebase --abort\` to cancel. Then run \`${APP_NAME} update\` again.`,
			),
		);
		return;
	}

	await fetchGitTarget(target);
	const remoteSha = await ref.resolve(target.repoRoot, `${target.remote}/${target.branch}`);
	const localSha = await head.sha(target.repoRoot);

	// No remote tracking at all — just report the local state and stop.
	if (!remoteSha) {
		console.log(chalk.yellow(`No remote tracking for ${target.remote}/${target.branch}, cannot check for updates`));
		return;
	}
	if (!localSha) {
		console.log(chalk.yellow("Local HEAD is unborn, cannot check for updates"));
		return;
	}

	const shortSha = (s: string) => s.slice(0, 8);

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
				`Local HEAD ${sha} is ahead of ${target.remote}/${target.branch} (${shortSha(remoteSha)}); nothing to pull. Pass --force to rebase anyway.`,
			),
		);
		return;
	}
	if (relation === "behind") {
		console.log(chalk.cyan(`New commits available on ${target.remote}/${target.branch}`));
	} else if (relation === "diverged") {
		console.log(chalk.cyan(`Local and ${target.remote}/${target.branch} have diverged; will rebase`));
	} else if (opts.force) {
		console.log(chalk.yellow(`Forcing sync with ${target.remote}/${target.branch}`));
	}

	if (opts.check) return;

	try {
		await updateViaGit(target.repoRoot, target.branch, target.remote);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { $which, APP_NAME, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	branch,
	diff,
	fetch as gitFetch,
	head,
	rebase,
	ref,
	remote,
	repo,
	restore,
	stash,
	status,
	withRepoLock,
} from "../utils/git";

const REPO = "can1357/oh-my-pi";
const EXPECTED_REMOTE_ORIGIN = "https://github.com/ql-isaac/oh-my-pi.git";
const EXPECTED_REMOTE_UPSTREAM = "https://github.com/can1357/oh-my-pi.git";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
/**
 * Official npm registry origin.
 *
 * Pinned across both the version check and the bun install step so the two
 * agree on which catalog they are talking to. A user's bun may be pointed at
 * an unofficial mirror (corporate proxy, Taobao, etc.) that lags the upstream
 * registry by minutes-to-hours, in which case `getLatestRelease` would resolve
 * a version the mirror has not yet replicated and the install would fail with
 * `No version matching "X" found for specifier "<pkg>" (but package exists)`.
 * See #1686.
 */
const NPM_REGISTRY = "https://registry.npmjs.org/";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const CACHE_DIR = path.join(os.homedir(), ".omp", "cache");
const RELEASE_CACHE_FILE = path.join(CACHE_DIR, "release-cache.json");
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";

/**
 * Platform tags the release pipeline publishes as
 * `@oh-my-pi/pi-natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

interface ReleaseInfo {
	tag: string;
	version: string;
}

interface CachedRelease {
	info: ReleaseInfo;
	fetchedAt: number;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

function extractRegistryFromBunfig(content: string): string | undefined {
	const match = content.match(/^\s*registry\s*=\s*["'](.+?)["']/m);
	return match?.[1]?.replace(/\/$/, "") ?? undefined;
}

function extractRegistryFromNpmrc(content: string): string | undefined {
	const match = content.match(/^\s*registry\s*=\s*(.+)/m);
	return match?.[1]?.trim().replace(/\/$/, "") ?? undefined;
}

/**
 * Resolve the npm registry URL the user has configured.
 * Checks bunfig.toml (project then global), then ~/.npmrc, then falls back to npmjs.org.
 */
async function resolveRegistry(): Promise<string> {
	const candidates = [path.join(process.cwd(), "bunfig.toml"), path.join(os.homedir(), ".bunfig.toml")];
	for (const bunfig of candidates) {
		try {
			const content = await Bun.file(bunfig).text();
			const registry = extractRegistryFromBunfig(content);
			if (registry) return registry;
		} catch {
			// file not found or unreadable
		}
	}

	try {
		const content = await Bun.file(path.join(os.homedir(), ".npmrc")).text();
		const registry = extractRegistryFromNpmrc(content);
		if (registry) return registry;
	} catch {
		// file not found or unreadable
	}

	return DEFAULT_REGISTRY;
}

/**
 * Parse bun.lock and extract package dependencies (name + version).
 * Ignores resolved URLs and integrity hashes to detect semantic changes.
 *
 * bun.lock structure:
 * - workspaces: workspace definitions
 * - packages: resolved packages as [name@version, url, metadata, integrity]
 */
function parseLockfileDeps(content: string): Map<string, string> {
	const deps = new Map<string, string>();
	try {
		const lockfile = JSON.parse(content);
		const packages = lockfile.packages;
		if (!packages || typeof packages !== "object") {
			return deps;
		}

		for (const [key, value] of Object.entries(packages)) {
			// Skip workspace packages (they don't have array format)
			if (!Array.isArray(value)) continue;

			// Format: [name@version, url, metadata, integrity]
			const nameAtVersion = value[0];
			if (typeof nameAtVersion !== "string") continue;

			// Parse "name@version" - handle scoped packages like "@scope/pkg@1.0.0"
			const lastAt = nameAtVersion.lastIndexOf("@");
			if (lastAt === 0) continue; // Invalid format

			const version = nameAtVersion.substring(lastAt + 1);

			deps.set(key, version);
		}
	} catch (err) {
		// Failed to parse lockfile, return empty map
		console.log(chalk.yellow(`Warning: failed to parse lockfile: ${err}`));
	}
	return deps;
}

/**
 * Compare two lockfile dependency maps.
 * Returns true if they have the same packages and versions.
 */
function compareLockfileDeps(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [pkg, version] of a) {
		if (b.get(pkg) !== version) return false;
	}
	return true;
}

function isCustomRegistry(registry: string): boolean {
	return registry !== DEFAULT_REGISTRY;
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!fileDir || !dirReal) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type UpdateTarget =
	| { method: "bun" }
	| { method: "binary"; path: string }
	| { method: "git"; repoRoot: string; branch: string; remote: string };

function resolveUpdateMethod(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	if (!bunBinDir) return "binary";
	return isPathInDirectory(ompPath, bunBinDir) ? "bun" : "binary";
}

export function resolveUpdateMethodForTest(ompPath: string, bunBinDir: string | undefined): "bun" | "binary" {
	return resolveUpdateMethod(ompPath, bunBinDir);
}

/**
 * Detect if the running process is from a git source clone of oh-my-pi.
 */
async function detectGitSourceInstall(): Promise<
	{ isGitSource: true; repoRoot: string; branch: string; remote: string } | { isGitSource: false }
> {
	let scriptDir: string;
	try {
		scriptDir = path.dirname(fileURLToPath(import.meta.url));
	} catch {
		scriptDir = process.cwd();
	}
	const repoRoot = await repo.root(scriptDir);
	if (!repoRoot) return { isGitSource: false };

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

	if (!detectedRemote) return { isGitSource: false };

	const cliPath = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
	const packageJsonPath = path.join(repoRoot, "package.json");
	const cliFile = Bun.file(cliPath);
	const packageJsonFile = Bun.file(packageJsonPath);
	const [cliExists, packageJsonExists] = await Promise.all([cliFile.exists(), packageJsonFile.exists()]);
	if (!cliExists || !packageJsonExists) return { isGitSource: false };

	const branchName = await branch.current(repoRoot);

	return {
		isGitSource: true,
		repoRoot,
		branch: branchName ?? "HEAD",
		remote: detectedRemote,
	};
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const [gitCheck, bunBinDir] = await Promise.all([detectGitSourceInstall(), getBunGlobalBinDir()]);

	if (gitCheck.isGitSource) {
		return { method: "git", repoRoot: gitCheck.repoRoot, branch: gitCheck.branch, remote: gitCheck.remote };
	}

	const ompPath = resolveOmpPath();

	if (ompPath) {
		const method = resolveUpdateMethod(ompPath, bunBinDir);
		if (method === "bun") return { method };
		return { method, path: ompPath };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

async function readCachedRelease(): Promise<CachedRelease | null> {
	try {
		const cached = (await Bun.file(RELEASE_CACHE_FILE).json()) as CachedRelease;
		if (cached && Date.now() - cached.fetchedAt < RELEASE_CACHE_TTL_MS) {
			return cached;
		}
	} catch {
		// cache miss or corrupt — fall through to network fetch
	}
	return null;
}

async function writeCachedRelease(info: ReleaseInfo): Promise<void> {
	await Bun.write(RELEASE_CACHE_FILE, JSON.stringify({ info, fetchedAt: Date.now() }));
}

/**
 * Get the latest release info from the official npm registry.
 *
 * Always hits {@link NPM_REGISTRY} directly so the version check agrees with
 * the pinned `--registry` flag in {@link buildBunInstallArgs} — using the
 * user's configured mirror could resolve a version the mirror hasn't
 * replicated yet. See #1686.
 *
 * Caches results locally for 5 minutes to avoid repeated network calls.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const cached = await readCachedRelease();
	if (cached) return cached.info;

	const response = await fetch(`${NPM_REGISTRY}${PACKAGE}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info from ${NPM_REGISTRY}: ${response.statusText}`);
	}

	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;

	const info = { tag, version };
	await writeCachedRelease(info);
	return info;
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `omp` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		printVerifiedVersion(expectedVersion);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow(`You may need to reinstall: curl -fsSL https://omp.sh/install | sh`));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await unlinkIfExists(options.backupPath);
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		await unlinkIfExists(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Build the bun argv used to globally install a specific omp version.
 *
 * The version is selected by hitting {@link NPM_REGISTRY} directly in
 * {@link getLatestRelease}, so the install MUST observe the same catalog:
 *
 * - `--registry=${NPM_REGISTRY}` pins the install to the official registry
 *   regardless of the user's bunfig/`.npmrc`. A mirror (corporate proxy,
 *   Taobao, …) that hasn't yet replicated the release would otherwise reject
 *   a version the upstream registry already advertises.
 * - `--no-cache` tells bun to ignore its on-disk manifest snapshot so it
 *   re-fetches metadata from that registry on every invocation.
 *
 * Together these two flags make `omp update` produce exactly the registry
 * lookup the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@oh-my-pi/pi-natives-<tag>` leaf to `expectedVersion`. `bun install -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@oh-my-pi/pi-coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces bun to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		`${PACKAGE}@${expectedVersion}`,
		`${NATIVES_PACKAGE}@${expectedVersion}`,
	];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	const args = buildBunInstallArgs(expectedVersion);
	const result = await $`bun ${args}`.nothrow();
	if (result.exitCode !== 0) {
		const registry = await resolveRegistry();
		if (isCustomRegistry(registry)) {
			throw new Error(
				`bun install failed (exit ${result.exitCode}). Your registry (${registry}) may not have synced v${expectedVersion} yet. Try again later or switch to the default registry.`,
			);
		}
		throw new Error(`bun install failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion);
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const buffer = await response.arrayBuffer();
	await Bun.write(tempPath, buffer);
	await fs.promises.chmod(tempPath, 0o755);

	console.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion,
	});
	printVerifiedVersion(expectedVersion);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Update via git pull in a source clone.
 * Handles local changes via git stash, updates deps via bun install,
 * and reports the new git SHA as the version.
 */
async function updateViaGit(repoRoot: string, branch: string, remote: string, expectedVersion: string): Promise<void> {
	console.log(chalk.dim(`Updating via git pull from ${remote}...`));

	const summary = await status.summary(repoRoot);
	let stashed = false;
	if (summary && (summary.staged > 0 || summary.unstaged > 0 || summary.untracked > 0)) {
		console.log(chalk.dim("Stashing local changes..."));
		stashed = await stash.push(repoRoot, "omp-update stash");
		console.log(chalk.dim("Local changes stashed."));
	}

	const oldSha = await head.sha(repoRoot);

	await withRepoLock(repoRoot, async () => {
		console.log(chalk.dim(`Rebasing onto ${remote}/${branch}...`));
		try {
			await rebase(repoRoot, `${remote}/${branch}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes("conflict")) {
				throw new Error(
					`Rebase conflicts detected on ${remote}/${branch}. Please resolve conflicts manually, run 'git rebase --abort' to cancel or 'git rebase --continue' to resolve, then run '${APP_NAME} update' again.`,
				);
			}
			throw err;
		}

		const changedPaths = oldSha
			? (await diff(repoRoot, { base: oldSha, nameOnly: true })).split("\n").filter(Boolean)
			: [];

		const nativeChanged = changedPaths.some(p => p.startsWith("crates/") || p.startsWith("packages/natives/"));
		if (nativeChanged) {
			console.log(
				chalk.yellow(
					`\n${theme.status.warning} Native source code changed. Run \`bun run build:native\` to rebuild.`,
				),
			);
		}

		const lockfilePath = path.join(repoRoot, "bun.lock");
		if (await Bun.file(lockfilePath).exists()) {
			const lockfileChanged = changedPaths.includes("bun.lock");
			if (lockfileChanged) {
				console.log(chalk.dim("Lockfile changed, updating dependencies..."));
				const installResult = await $`bun install`.cwd(repoRoot).quiet().nothrow();
				if (installResult.exitCode !== 0) {
					const registry = await resolveRegistry();
					if (isCustomRegistry(registry)) {
						console.log(
							chalk.red(
								`\n${theme.status.error} Failed to install dependencies (exit ${installResult.exitCode}).`,
							),
						);
						console.log(chalk.yellow(`  Your registry (${registry}) may not have synced new packages yet.`));
						console.log(chalk.yellow(`  Run \`bun install\` manually or switch to the default registry.`));
					} else {
						console.log(
							chalk.red(
								`\n${theme.status.error} Failed to install dependencies (exit ${installResult.exitCode}). Run \`bun install\` manually.`,
							),
						);
					}
				}
			}
		}

		const newSha = await head.short(repoRoot, 8);
		console.log(chalk.green(`\n${theme.status.success} Updated to ${newSha ?? expectedVersion}`));
	});

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
				} else {
					const stashDeps = parseLockfileDeps(stashLockfile.text());
					const oldDeps = parseLockfileDeps(oldLockfile.text());
					const hasUserChanges = !compareLockfileDeps(stashDeps, oldDeps);

					if (!hasUserChanges) {
						console.log(chalk.dim("Lockfile conflict detected (mirror URL rewrite only), auto-resolving..."));
						await restore(repoRoot, { source: "HEAD", staged: true, worktree: true, files: lockfileConflicts });
						await stash.drop(repoRoot);
						console.log(chalk.green(`${theme.status.success} Lockfile conflict auto-resolved.`));
					} else {
						console.log(chalk.yellow("Lockfile conflict detected with dependency changes."));
						console.log(chalk.yellow("Your local changes include custom dependency modifications."));
						console.log(chalk.yellow("Run `git stash pop` manually to resolve conflicts."));
					}
				}
			} else {
				console.log(chalk.yellow(`Warning: could not restore stashed changes: ${err}`));
				if (otherConflicts.length > 0) {
					console.log(chalk.yellow(`  Conflicted files: ${otherConflicts.join(", ")}`));
					console.log(chalk.yellow(`  Run \`git stash pop\` manually to resolve.`));
				}
			}
		}
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	const target = await resolveUpdateTarget();

	if (target.method === "git") {
		const sha = await head.short(target.repoRoot, 8);
		const tags = await ref.tags(target.repoRoot, "HEAD");
		const versionStr = tags.length > 0 ? `${tags[0]} (${sha})` : (sha ?? "unknown");
		console.log(chalk.dim(`Current version: ${versionStr} (git source)`));
	} else {
		console.log(chalk.dim(`Current version: ${VERSION}`));
	}

	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	if (target.method === "git") {
		await gitFetch(
			target.repoRoot,
			target.remote,
			`refs/heads/${target.branch}`,
			`refs/remotes/${target.remote}/${target.branch}`,
		);

		const localSha = await head.sha(target.repoRoot);
		const remoteSha = await ref.resolve(target.repoRoot, `${target.remote}/${target.branch}`);

		if (!remoteSha) {
			console.log(
				chalk.yellow(`No remote tracking for ${target.remote}/${target.branch}, cannot check for updates`),
			);
			return;
		}

		const comparison = localSha !== remoteSha ? 1 : 0;

		if (comparison <= 0 && !opts.force) {
			const sha = await head.short(target.repoRoot, 8);
			console.log(chalk.green(`${theme.status.success} Already up to date at ${sha ?? localSha}`));
			return;
		}

		if (comparison > 0) {
			console.log(chalk.cyan(`New commits available on ${target.remote}/${target.branch}`));
		} else {
			console.log(chalk.yellow(`Forcing sync with ${target.remote}/${target.branch}`));
		}

		if (opts.check) {
			return;
		}

		try {
			await updateViaGit(target.repoRoot, target.branch, target.remote, release.version);
		} catch (err) {
			console.error(chalk.red(`Update failed: ${err}`));
			process.exit(1);
		}
		return;
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		return;
	}

	try {
		if (target.method === "bun") {
			await updateViaBun(release.version);
		} else {
			await updateViaBinaryAt(target.path, release.version);
		}
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}

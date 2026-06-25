/**
 * Registry detection used by `omp pull` to surface mirror-lag install
 * failures. The install there is unconstrained (`bun install` in the
 * user's repo), so a lagging or unreachable custom mirror is a real
 * failure mode worth naming. `omp update`'s bun path is pinned to
 * {@link DEFAULT_REGISTRY} via `--registry` and does not consult this.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Default npm registry; used to detect user mirrors. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Resolve the npm registry URL the user has configured.
 * Checks bunfig.toml (project then global), then ~/.npmrc, then falls back to npmjs.org.
 */
export async function resolveRegistry(): Promise<string> {
	const candidates = [path.join(process.cwd(), "bunfig.toml"), path.join(os.homedir(), ".bunfig.toml")];
	for (const bunfig of candidates) {
		try {
			const content = await Bun.file(bunfig).text();
			const bunfigMatch = content.match(/^\s*registry\s*=\s*["'](.+?)["']/m);
			const registry = bunfigMatch?.[1]?.replace(/\/$/, "");
			if (registry) return registry;
		} catch {
			// file not found or unreadable
		}
	}

	try {
		const content = await Bun.file(path.join(os.homedir(), ".npmrc")).text();
		const npmrcMatch = content.match(/^\s*registry\s*=\s*(.+)/m);
		const registry = npmrcMatch?.[1]?.trim().replace(/\/$/, "");
		if (registry) return registry;
	} catch {
		// file not found or unreadable
	}

	return DEFAULT_REGISTRY;
}

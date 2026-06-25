/**
 * `git stash drop` wrapper.
 *
 * Fork-local addition. Lives outside `utils/git.ts` so that pulling upstream
 * changes to that file does not conflict with this helper. Re-exported from
 * `utils/git.ts` as `stashDrop` for any caller that needs the canonical name.
 */
import { $which } from "@oh-my-pi/pi-utils";

/** Drop the most recent stash entry. */
export async function stashDrop(cwd: string): Promise<void> {
	if (!$which("git")) throw new Error("git is not installed.");
	const proc = Bun.spawn(["git", "stash", "drop"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const stderrReader = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
	const [stderr, exitCode] = await Promise.all([stderrReader, proc.exited]);
	if (exitCode !== 0) {
		const message = stderr.trim() || `git stash drop failed with exit code ${exitCode}`;
		throw new Error(message);
	}
}

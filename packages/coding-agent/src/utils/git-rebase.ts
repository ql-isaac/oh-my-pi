/**
 * `git rebase` wrapper.
 *
 * Fork-local addition. Lives outside `utils/git.ts` so that pulling upstream
 * changes to that file does not conflict with the rebase helper. Re-exported
 * from `utils/git.ts` for any caller that already imports it from there.
 */
import { $which } from "@oh-my-pi/pi-utils";

async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
	if (!$which("git")) throw new Error("git is not installed.");
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		signal,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const stderrReader = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
	const [stderr, exitCode] = await Promise.all([stderrReader, proc.exited]);
	if (exitCode !== 0) {
		const message = stderr.trim() || `git ${args.join(" ")} failed with exit code ${exitCode}`;
		throw new Error(message);
	}
}

export const rebase = Object.assign(
	async function rebase(cwd: string, onto: string, signal?: AbortSignal): Promise<void> {
		await runGit(cwd, ["rebase", onto], signal);
	},
	{
		async abort(cwd: string, signal?: AbortSignal): Promise<void> {
			await runGit(cwd, ["rebase", "--abort"], signal);
		},
	},
);

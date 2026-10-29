import * as path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { type SandboxExtras, clipOutput, formatCommandResult, gitRoots, isInside, runCommand, runInSandbox } from "./sandbox.ts";
import { PROGRESS_TOOL } from "./trace.ts";

/**
 * Self-reported progress for nested reviewers: a plan up front, then each
 * item as it's done. The tool only acknowledges; ReviewTrace reads the
 * calls off the session's event stream.
 */
export function createProgressTool(state: { plan: string[]; done: number; calls: number } = { plan: [], done: 0, calls: 0 }) {
	return {
		name: PROGRESS_TOOL,
		label: "Progress",
		description: "Report review progress to the lead. Call once with `plan` (the 3–8 things you will check), then with `done` (one item) as you finish each.",
		parameters: Type.Object({
			plan: Type.Optional(Type.Array(Type.String(), { description: "Things you will check, in order" })),
			done: Type.Optional(Type.String({ description: "A plan item you just finished" })),
		}),
		async execute(_id: string, params: { plan?: string[]; done?: string }) {
			state.calls++;
			if (params.plan?.length) state.plan = params.plan;
			if (params.done) state.done++;
			return { content: [{ type: "text" as const, text: `Recorded (${state.done}/${state.plan.length || "?"} done). Continue.` }], details: undefined };
		},
	};
}

// ---------- executing code: sandbox, git, checks ----------

export const GIT_TOOL = "git";
export const RUN_TOOL = "run";
const RUN_DEFAULT_SEC = 120;
const RUN_MAX_SEC = 300;

const GIT_SUBCOMMANDS = ["log", "show", "blame", "diff"] as const;
/** Long options that write files, read files from outside the repo, or run configured programs. */
const GIT_BLOCKED_LONG = ["--output", "--output-directory", "--no-index", "--ext-diff", "--textconv", "--contents", "--orderfile", "--open-files-in-pager", "--exec"];

/**
 * Why `args` may not reach git, or null. Git accepts unambiguous prefixes of
 * long options (--cont for --contents), so any prefix of a blocked option is
 * refused; and a path outside the repo would switch diff into no-index mode
 * or point blame at a host file, so non-option arguments must stay inside it.
 */
export function gitArgProblem(top: string, args: string[]): string | null {
	for (const a of args) {
		if (a.startsWith("--") && a.length > 2) {
			const name = a.split("=")[0];
			if (name.length >= 4 && GIT_BLOCKED_LONG.some((b) => b.startsWith(name))) return `option ${a} is not allowed`;
		} else if (/^-[A-Za-z]*O/.test(a)) {
			return `option ${a} is not allowed`;
		} else if (!a.startsWith("-")) {
			// rev:path, rev..rev and plain paths all name files by their path part.
			const p = a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
			if (path.isAbsolute(p) || !isInside(path.resolve(top, p), top)) return `path ${a} is outside the repository`;
		}
	}
	return null;
}

/** Read-only git history for reviewers: why the code is the way it is, and what touched it before. */
export async function runGitTool(dir: string, subcommand: string, args: string[], signal?: AbortSignal): Promise<string> {
	if (!(GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) return `git ${subcommand} is not allowed; use one of ${GIT_SUBCOMMANDS.join(", ")}`;
	const problem = gitArgProblem(gitRoots(dir).top, args);
	if (problem) return `git: ${problem}`;
	const safety = subcommand === "blame" ? [] : ["--no-ext-diff", "--no-textconv"];
	// A default cap the caller can override (the last -n wins).
	const cap = subcommand === "log" ? ["-n", "30"] : [];
	const r = await runCommand("git", ["--no-pager", subcommand, ...safety, ...cap, ...args], {
		cwd: dir,
		timeoutMs: 20_000,
		signal,
		env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
	});
	return r.exitCode === 0 && !r.error && !r.timedOut ? clipOutput(r.output, 4_000, 16_000) || "(no output)" : formatCommandResult(r, 1_000, 3_000);
}

export function createGitTool(dir: string) {
	return {
		name: GIT_TOOL,
		label: "Git",
		description:
			"Read-only git history of the repository: log, show, blame, or diff, with extra arguments as you would type them " +
			"(e.g. subcommand \"blame\", args [\"-L\", \"120,140\", \"src/x.ts\"]; or \"log\", [\"-n\", \"10\", \"--oneline\", \"--\", \"src/x.ts\"]). " +
			"Use it to learn why touched code is the way it is and whether the change reverts an earlier fix.",
		parameters: Type.Object({
			subcommand: StringEnum(GIT_SUBCOMMANDS),
			args: Type.Optional(Type.Array(Type.String(), { description: "Arguments after the subcommand" })),
		}),
		async execute(_id: string, params: { subcommand: string; args?: string[] }, signal?: AbortSignal) {
			const text = await runGitTool(dir, params.subcommand, params.args ?? [], signal);
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

export function createRunTool(dir: string, homeDirs: string[], extras: SandboxExtras = {}) {
	return {
		name: RUN_TOOL,
		label: "Run",
		description:
			"Run a bash script in a sandbox (working directory: the repo) to settle a claim by execution: " +
			"a targeted test, compiling the touched files, or a short repro script. The repository is read-only and there is no network; " +
			"write files under $TMPDIR (a fresh scratch directory, also $HOME, deleted when the call ends). Put a whole repro (write files, then run them) in one script. " +
			`Returns the exit code and output. Default timeout ${RUN_DEFAULT_SEC}s, max ${RUN_MAX_SEC}s.`,
		parameters: Type.Object({
			script: Type.String({ description: "bash script" }),
			timeout_sec: Type.Optional(Type.Number({ description: `Seconds before the script is killed (max ${RUN_MAX_SEC})` })),
		}),
		async execute(_id: string, params: { script: string; timeout_sec?: number }, signal?: AbortSignal) {
			const secs = Math.min(RUN_MAX_SEC, Math.max(5, params.timeout_sec ?? RUN_DEFAULT_SEC));
			const r = await runInSandbox(dir, params.script, secs * 1000, homeDirs, signal, extras);
			return { content: [{ type: "text" as const, text: formatCommandResult(r) }], details: undefined };
		},
	};
}

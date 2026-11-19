/**
 * pi-agent: run a pi agent headlessly as a subagent, e.g. from Claude Code.
 *
 *   pi-agent list [--json]
 *   pi-agent run <agent|none> [options] [--] <task…|->
 *   pi-agent resume <run-dir> [options] [--] <follow-up…|->
 *   pi-agent start <agent|run-dir> [options] [--] <task…|->   (detached; prints JSON)
 *   pi-agent wait <events-file> [--from n] [--until-tool id]
 *   pi-agent stop <run-dir>
 *
 * `run` resolves the agent definition (src/agents.ts), spawns
 * `pi --mode json -p` with its model, tools and system prompt, folds the
 * event stream (src/stream.ts), and prints the agent's final answer on stdout
 * with a one-line summary. Each run gets a directory holding the pi session,
 * so `resume` can send a follow-up with the whole conversation intact and
 * `pi --session <file>` can open it interactively.
 *
 * `start`, `wait` and `stop` serve the pi-subagent Claude Code mod
 * (claude-code-mod/). `start` runs `run`/`resume` detached with `--events`,
 * so the run outlives any one hook; `wait` blocks until the events file has
 * the next assistant message (or the named tool's result), so a hook waits
 * inside a child process, which costs it none of its 10 s budget.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type AgentConfig, discoverAgents, parseThinking, THINKING_LEVELS } from "./agents.ts";
import { applyEvent, emptyState, type EventLine, isFailed, type RateLookup, type RunState, toEventLine, toolSummary } from "./stream.ts";

/** Fits a foreground Claude Code Bash call (10-minute cap) with time to report. */
export const DEFAULT_TIMEOUT_S = 540;
const KILL_GRACE_MS = 5000;

/** What a run was started with; `resume` reuses it. */
export interface RunMeta {
	agent: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	cwd: string;
	systemPromptFile?: string;
	createdAt: string;
}

export interface RunResult {
	ok: boolean;
	agent: string;
	model?: string;
	turns: number;
	toolCalls: Record<string, number>;
	toolErrors: number;
	seconds: number;
	timedOut: boolean;
	usage: RunState["usage"];
	error?: string;
	runDir: string;
	sessionFile?: string;
}

function dataHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(dataHome(env), "pi-subagent", "runs");
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Input price per Mtok from models.json, for billed-cost estimates. */
export function loadRates(env: NodeJS.ProcessEnv = process.env): RateLookup {
	const file = path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "models.json");
	let providers: Record<string, { models?: Array<{ id?: string; cost?: { input?: number } }> }> = {};
	try {
		providers = JSON.parse(fs.readFileSync(file, "utf-8")).providers ?? {};
	} catch {
		// No catalog: billed equals catalog cost.
	}
	return (provider, model) => providers[provider]?.models?.find((m) => m.id === model)?.cost?.input;
}

/** pi's argument list for one turn: a new session in `sessionDir`, or a follow-up in `sessionFile`. */
export function buildPiArgs(meta: RunMeta, task: string, session: { dir: string } | { file: string }): string[] {
	const args = ["--mode", "json", "-p"];
	if ("file" in session) args.push("--session", session.file);
	else args.push("--session-dir", session.dir);
	if (meta.model) args.push("--model", meta.model);
	if (meta.thinking) args.push("--thinking", meta.thinking);
	if (meta.tools?.length) args.push("--tools", meta.tools.join(","));
	if (meta.systemPromptFile) args.push("--append-system-prompt", meta.systemPromptFile);
	args.push("--", task);
	return args;
}

/** The run's meta from an agent definition plus command-line overrides. */
export function resolveMeta(
	agent: AgentConfig | undefined,
	opts: { model?: string; thinking?: string; tools?: string },
	cwd: string,
): Omit<RunMeta, "systemPromptFile" | "createdAt"> {
	const model = opts.model ?? agent?.model;
	// A `:level` suffix on the model (pi's shorthand) wins over the agent's default level.
	const thinking = opts.thinking ?? (model?.includes(":") ? undefined : agent?.thinking);
	const tools = opts.tools !== undefined
		? opts.tools.split(",").map((t) => t.trim()).filter(Boolean)
		: agent?.tools;
	return { agent: agent?.name ?? "none", model, thinking, tools, cwd };
}

function sessionFileIn(dir: string): string | undefined {
	try {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
		return files.length ? path.join(dir, files[files.length - 1]) : undefined;
	} catch {
		return undefined;
	}
}

function fmtCost(usd: number): string {
	return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** The one-line summary printed under the answer. */
export function summaryLine(r: RunResult): string {
	const parts = [
		r.ok ? "ok" : r.timedOut ? "timed out" : "failed",
		r.agent,
		r.model ?? "default model",
		`${r.turns} turn${r.turns === 1 ? "" : "s"}`,
	];
	const tools = toolSummary({ toolCalls: r.toolCalls } as RunState);
	if (tools) parts.push(tools);
	parts.push(`${r.seconds}s`, `${fmtCost(r.usage.billed)} billed`);
	return `pi-agent: ${parts.join(" · ")}`;
}

/**
 * The pi process's environment. pi-lite-subagent registers no `subagent` tool
 * at `PI_SUBAGENT_DEPTH` >= 1, so without `nesting` the agent can't fan out
 * further. `PI_SUBAGENT_NAME` must stay unset: with it, pi-lite-subagent
 * marks the session "inspection only" and silently drops every later prompt,
 * which breaks `resume`.
 */
export function childEnv(base: NodeJS.ProcessEnv, nesting: boolean): NodeJS.ProcessEnv {
	const env = { ...base };
	delete env.PI_SUBAGENT_NAME;
	if (!nesting) env.PI_SUBAGENT_DEPTH = String((Number(base.PI_SUBAGENT_DEPTH) || 0) + 1);
	return env;
}

interface TurnOptions {
	meta: RunMeta;
	task: string;
	runDir: string;
	resume: boolean;
	timeoutS: number;
	nesting: boolean;
	verbose: boolean;
	env: NodeJS.ProcessEnv;
	/** Each assistant message and tool result, as it happens. */
	onEvent?: (line: EventLine) => void;
}

/** Runs one pi turn (a new task or a follow-up) to completion and records its result. */
export async function runTurn(o: TurnOptions): Promise<RunResult & { text: string }> {
	const sessionDir = path.join(o.runDir, "session");
	fs.mkdirSync(sessionDir, { recursive: true });
	const existing = sessionFileIn(sessionDir);
	if (o.resume && !existing) throw new Error(`no pi session in ${sessionDir}`);
	const args = buildPiArgs(o.meta, o.task, o.resume && existing ? { file: existing } : { dir: sessionDir });
	fs.appendFileSync(path.join(o.runDir, "tasks.md"), `## ${new Date().toISOString()}\n\n${o.task}\n\n`);

	const env = childEnv(o.env, o.nesting);

	const state = emptyState();
	const rate = loadRates(o.env);
	const startedAt = Date.now();
	let timedOut = false;
	let stderr = "";

	const exitCode = await new Promise<number | null>((resolve) => {
		const child = spawn(o.env.PI_AGENT_PI || "pi", args, {
			cwd: o.meta.cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		const onLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const eventLine = toEventLine(event);
			if (eventLine) o.onEvent?.(eventLine);
			if (!applyEvent(state, event, rate)) return;
			const e = event as { type?: string; message?: { stopReason?: string } };
			if (o.verbose && e.type === "tool_execution_start" && state.runningTool) {
				process.stderr.write(`  [${o.meta.agent}] ${state.runningTool}\n`);
			}
			// The answer is the last message's text, not text written on the way there.
			if (e.type === "message_end" && e.message?.stopReason === "toolUse") state.text = "";
		};
		child.stdout.on("data", (d: Buffer) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) onLine(line);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		let killTimer: NodeJS.Timeout | undefined;
		const stop = () => {
			if (killTimer) return;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
		};
		const deadline = o.timeoutS > 0
			? setTimeout(() => {
				timedOut = true;
				stop();
			}, o.timeoutS * 1000)
			: undefined;
		const onSignal = () => stop();
		process.on("SIGTERM", onSignal);
		process.on("SIGINT", onSignal);
		process.on("SIGHUP", onSignal);

		child.on("error", (err) => {
			stderr += `${err.message}\n`;
		});
		child.on("close", (code) => {
			if (buffer.trim()) onLine(buffer);
			clearTimeout(deadline);
			clearTimeout(killTimer);
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
			process.off("SIGHUP", onSignal);
			resolve(code);
		});
	});

	const failed = timedOut || isFailed(state, exitCode);
	const error = !failed
		? undefined
		: timedOut
			? `timed out after ${o.timeoutS}s`
			: state.errorMessage
				|| stderr.trim().split("\n").slice(-5).join("\n")
				|| (exitCode === 0 ? "pi ran no model turn: an extension handled the prompt, or the session is marked inspection-only" : `pi exited with code ${exitCode}`);
	const result: RunResult = {
		ok: !failed,
		agent: o.meta.agent,
		model: state.model ?? o.meta.model,
		turns: state.turns,
		toolCalls: state.toolCalls,
		toolErrors: state.toolErrors,
		seconds: Math.round((Date.now() - startedAt) / 1000),
		timedOut,
		usage: state.usage,
		error,
		runDir: o.runDir,
		sessionFile: sessionFileIn(sessionDir),
	};
	fs.writeFileSync(path.join(o.runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	fs.writeFileSync(path.join(o.runDir, "result.md"), `${state.text}\n`);
	if (stderr) fs.writeFileSync(path.join(o.runDir, "stderr.txt"), stderr);
	return { ...result, text: state.text };
}

function readTask(positionals: string[], taskFile: string | undefined): string {
	if (taskFile) return fs.readFileSync(taskFile, "utf-8").trim();
	if (positionals.length === 1 && positionals[0] === "-") return fs.readFileSync(0, "utf-8").trim();
	return positionals.join(" ").trim();
}

const USAGE = `Usage:
  pi-agent list [--json]
  pi-agent run <agent|none> [options] [--] <task…|->
  pi-agent resume <run-dir> [options] [--] <follow-up…|->
  pi-agent start <agent|none|run-dir> [options] [--] <task…|->
  pi-agent wait <events-file> [--from n] [--until-tool id]
  pi-agent stop <run-dir>

Options:
  --model <provider/id[:level]>  Model (default: the agent's, else pi's default)
  --thinking <level>             ${THINKING_LEVELS.join("|")}
  --tools <a,b,…>                Tool allowlist (default: the agent's; "none" agent: all)
  --task-file <path>             Read the task from a file ("-" as the task reads stdin)
  --cwd <dir>                    Working directory (default: current)
  --timeout <s>                  Stop the agent after this long; 0 = never (default ${DEFAULT_TIMEOUT_S})
  --out <dir>                    Run directory (default: ${"$XDG_DATA_HOME"}/pi-subagent/runs/<stamp>-<agent>)
  --nesting                      Let the agent use pi's own subagent tool
  --verbose                      Print each tool call on stderr
  --stream-json                  stdout is JSON lines: start, message, tool_end, done
  --events <file>                Also append those lines to <file>
wait: --from <n> (first line to read), --until-tool <id> (stop at that tool's result)
  --json                         list: print JSON`;

function printAgents(agents: AgentConfig[], json: boolean): void {
	if (json) {
		console.log(JSON.stringify(agents.map(({ systemPrompt: _, ...a }) => a), null, 2));
		return;
	}
	if (!agents.length) {
		console.log("No agent definitions found. Add Markdown files to ~/.pi/agent/agents/ or .pi/agents/.");
		return;
	}
	for (const a of agents) {
		const bits = [a.model ?? "default model", a.thinking && `@${a.thinking}`, a.tools ? `tools: ${a.tools.join(",")}` : "all tools", a.source === "project" ? "project" : undefined]
			.filter(Boolean)
			.join(" · ");
		console.log(`${a.name} — ${a.description}\n    ${bits}`);
	}
	console.log(`none — no definition: pi's default prompt and every tool\n    default model · all tools`);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [command, ...rest] = argv;
	if (!command || command === "-h" || command === "--help" || command === "help") {
		console.log(USAGE);
		return command ? 0 : 2;
	}
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			model: { type: "string" },
			thinking: { type: "string" },
			tools: { type: "string" },
			"task-file": { type: "string" },
			cwd: { type: "string" },
			timeout: { type: "string" },
			out: { type: "string" },
			nesting: { type: "boolean" },
			verbose: { type: "boolean" },
			"stream-json": { type: "boolean" },
			events: { type: "string" },
			from: { type: "string" },
			"until-tool": { type: "string" },
			json: { type: "boolean" },
		},
	});
	const cwd = path.resolve(values.cwd ?? process.cwd());

	if (command === "list") {
		printAgents(discoverAgents(cwd, env), !!values.json);
		return 0;
	}
	if (command === "wait") return waitEvents(positionals[0], Number(values.from ?? 0), values["until-tool"]);
	if (command === "stop") return stopRun(positionals[0]);
	if (command === "start") return startDetached(rest, values, positionals, env);
	if (command !== "run" && command !== "resume") {
		console.error(`pi-agent: unknown command "${command}"\n\n${USAGE}`);
		return 2;
	}
	if (values.thinking !== undefined && !parseThinking(values.thinking)) {
		console.error(`pi-agent: --thinking must be one of ${THINKING_LEVELS.join(", ")}`);
		return 2;
	}
	const timeoutS = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout);
	if (!Number.isFinite(timeoutS) || timeoutS < 0) {
		console.error("pi-agent: --timeout must be a number of seconds (0 = never)");
		return 2;
	}
	const [target, ...taskWords] = positionals;
	if (!target) {
		console.error(`pi-agent: ${command} needs ${command === "run" ? "an agent name" : "a run directory"}\n\n${USAGE}`);
		return 2;
	}
	const task = readTask(taskWords, values["task-file"]);
	if (!task) {
		console.error("pi-agent: no task given (words, --task-file, or - for stdin)");
		return 2;
	}

	let meta: RunMeta;
	let runDir: string;
	if (command === "run") {
		const agents = discoverAgents(cwd, env);
		const agent = target === "none" ? undefined : agents.find((a) => a.name === target);
		if (target !== "none" && !agent) {
			console.error(`pi-agent: unknown agent "${target}". Known: ${[...agents.map((a) => a.name), "none"].join(", ")}`);
			return 2;
		}
		runDir = path.resolve(values.out ?? path.join(runsDir(env), `${stamp(new Date())}-${target}-${Math.random().toString(36).slice(2, 6)}`));
		fs.mkdirSync(runDir, { recursive: true });
		meta = { ...resolveMeta(agent, values, cwd), createdAt: new Date().toISOString() };
		if (agent?.systemPrompt) {
			meta.systemPromptFile = path.join(runDir, "system-prompt.md");
			fs.writeFileSync(meta.systemPromptFile, `${agent.systemPrompt}\n`);
		}
		fs.writeFileSync(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	} else {
		runDir = path.resolve(target);
		try {
			meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf-8"));
		} catch {
			console.error(`pi-agent: ${runDir} is not a pi-agent run (no meta.json)`);
			return 2;
		}
		// Overrides apply to this follow-up only; meta.json keeps the original.
		if (values.model) meta = { ...meta, model: values.model, thinking: values.thinking };
		else if (values.thinking) meta = { ...meta, thinking: values.thinking };
		if (values.tools !== undefined) meta = { ...meta, tools: values.tools.split(",").map((t) => t.trim()).filter(Boolean) };
		if (values.cwd) meta = { ...meta, cwd };
	}

	const streamJson = !!values["stream-json"];
	const eventsFile = values.events;
	const emit = (line: object) => {
		const text = `${JSON.stringify(line)}\n`;
		if (streamJson) process.stdout.write(text);
		if (eventsFile) fs.appendFileSync(eventsFile, text);
	};
	const streaming = streamJson || !!eventsFile;
	process.stderr.write(`pi-agent: ${meta.agent} on ${meta.model ?? "pi's default model"} → ${runDir}\n`);
	if (streaming) emit({ type: "start", agent: meta.agent, model: meta.model, runDir });
	let result: RunResult & { text: string };
	try {
		result = await runTurn({
			meta,
			task,
			runDir,
			resume: command === "resume",
			timeoutS,
			nesting: !!values.nesting,
			verbose: !!values.verbose,
			env,
			onEvent: streaming ? emit : undefined,
		});
	} catch (err) {
		if (streaming) emit({ type: "done", ok: false, error: (err as Error).message, runDir });
		console.error(`pi-agent: ${(err as Error).message}`);
		return 1;
	}
	if (streaming) emit({ type: "done", ...result, summary: summaryLine(result) });
	if (streamJson) return result.ok ? 0 : 1;

	if (result.text) console.log(result.text);
	else if (result.ok) console.log("(the agent gave no text answer)");
	console.log("");
	console.log(summaryLine(result));
	if (result.error) console.log(`error: ${result.error}`);
	if (result.timedOut) console.log(`To collect what it found: pi-agent resume ${runDir} "Time is up. Report what you found so far."`);
	console.log(`run: ${runDir}`);
	if (result.sessionFile) console.log(`session: ${result.sessionFile}`);
	return result.ok ? 0 : 1;
}

/**
 * Starts `run` (a new task) or `resume` (when the target is a run directory)
 * as a detached process writing `<run>/events-<n>.jsonl`, and prints
 * `{ runDir, events, pid }` as JSON. The task goes through a file, so no
 * argument parsing can mangle it.
 */
function startDetached(
	rest: string[],
	values: Record<string, string | boolean | undefined>,
	positionals: string[],
	env: NodeJS.ProcessEnv,
): number {
	const [target, ...taskWords] = positionals;
	if (!target) {
		console.error("pi-agent: start needs an agent name or a run directory");
		return 2;
	}
	const task = readTask(taskWords, values["task-file"] as string | undefined);
	if (!task) {
		console.error("pi-agent: no task given");
		return 2;
	}
	const isResume = fs.existsSync(path.join(target, "meta.json"));
	const runDir = path.resolve(
		isResume ? target : ((values.out as string | undefined) ?? path.join(runsDir(env), `${stamp(new Date())}-${target}-${Math.random().toString(36).slice(2, 6)}`)),
	);
	fs.mkdirSync(runDir, { recursive: true });
	const n = fs.readdirSync(runDir).filter((f) => /^events-\d+\.jsonl$/.test(f)).length + 1;
	const events = path.join(runDir, `events-${n}.jsonl`);
	const taskFile = path.join(runDir, `task-${n}.md`);
	fs.writeFileSync(taskFile, task);
	fs.writeFileSync(events, "");
	const passOn: string[] = [];
	for (const key of ["model", "thinking", "tools", "cwd", "timeout"]) {
		if (typeof values[key] === "string") passOn.push(`--${key}`, values[key] as string);
	}
	if (values.nesting) passOn.push("--nesting");
	const args = [
		"--no-warnings",
		import.meta.filename,
		isResume ? "resume" : "run",
		isResume ? runDir : target,
		...passOn,
		...(isResume ? [] : ["--out", runDir]),
		"--events", events,
		"--task-file", taskFile,
	];
	const log = fs.openSync(path.join(runDir, `detached-${n}.log`), "a");
	const child = spawn(process.execPath, args, { cwd: (values.cwd as string | undefined) ?? process.cwd(), env, detached: true, stdio: ["ignore", log, log] });
	child.unref();
	fs.writeFileSync(path.join(runDir, "pid"), String(child.pid));
	console.log(JSON.stringify({ runDir, events, pid: child.pid }));
	return 0;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Prints the events file's lines from line `from` on, each as
 * `{ "n": <line>, "event": {…} }`, and returns once it printed an assistant
 * message or the run's end. With `untilTool` it returns after that tool's
 * result instead, and stops short of the next message, which is the step's
 * to read. If the run's process died without a `done` line, it prints one.
 */
export async function waitEvents(file: string | undefined, from: number, untilTool?: string): Promise<number> {
	if (!file) {
		console.error("pi-agent: wait needs an events file");
		return 2;
	}
	const pidFile = path.join(path.dirname(file), "pid");
	let n = Number.isFinite(from) && from > 0 ? from : 0;
	const out = (event: unknown) => process.stdout.write(`${JSON.stringify({ n: n++, event })}\n`);
	for (let idle = 0; ; ) {
		let lines: string[] = [];
		try {
			const text = fs.readFileSync(file, "utf-8");
			lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").slice(0, -1);
		} catch {
			// Not there yet.
		}
		for (; n < lines.length; ) {
			let event: { type?: string; id?: string };
			try {
				event = JSON.parse(lines[n] ?? "");
			} catch {
				n++;
				continue;
			}
			if (untilTool && (event.type === "message" || event.type === "done")) return 0;
			out(event);
			if (untilTool ? event.type === "tool_end" && event.id === untilTool : event.type === "message" || event.type === "done") return 0;
		}
		// Every ~2s, check the run is still alive; a crash leaves no done line.
		if (++idle % 20 === 0) {
			const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf-8") : NaN);
			if (Number.isFinite(pid) && !isAlive(pid)) {
				// Its last lines may have landed after the read above.
				const text = fs.readFileSync(file, "utf-8");
				if (text.split("\n").filter(Boolean).length > n) continue;
				out({ type: "done", ok: false, error: `the pi-agent process (pid ${pid}) ended without a result; see ${path.dirname(file)}/detached-*.log` });
				return 0;
			}
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

function stopRun(runDir: string | undefined): number {
	if (!runDir) {
		console.error("pi-agent: stop needs a run directory");
		return 2;
	}
	const pid = Number(fs.readFileSync(path.join(runDir, "pid"), "utf-8"));
	if (Number.isFinite(pid) && isAlive(pid)) process.kill(pid, "SIGTERM");
	return 0;
}

if (import.meta.main) {
	// exitCode rather than exit(): exit() can cut off stdout piped to Claude Code.
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}

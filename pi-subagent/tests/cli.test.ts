import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAgents, parseAgent, parseFrontmatter } from "../src/agents.ts";
import { buildPiArgs, childEnv, resolveMeta } from "../src/cli.ts";
import { applyEvent, emptyState, isFailed } from "../src/stream.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
const FAKE_PI = path.join(import.meta.dirname, "fake-pi.mjs");

/** A scratch home with one agent definition; runs `pi-agent` against the fake pi. */
function sandbox() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "agents", "explore.md"),
		"---\nname: explore\ndescription: Search.\ntools: read, grep\nmodel: amd-gateway/x\nthinking: low\n---\n\nYou search.\n",
	);
	const log = path.join(root, "pi-calls.jsonl");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		PI_AGENT_PI: FAKE_PI,
		FAKE_PI_LOG: log,
		PI_SUBAGENT_NAME: "leaked",
	};
	const run = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf-8" });
	const calls = () => fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
	return { root, run, calls };
}

test("frontmatter: scalars, quotes, inline and block lists", () => {
	const { frontmatter, body } = parseFrontmatter('---\nname: "a"\ntools: [read, "grep"]\nlist:\n  - x\n  - y\n---\nbody\n');
	assert.deepEqual(frontmatter, { name: "a", tools: ["read", "grep"], list: ["x", "y"] });
	assert.equal(body, "body\n");
	assert.equal(parseAgent("---\nname: a\n---\n", "user", "f"), undefined, "no description");
	assert.equal(parseAgent("---\nname: a\ndescription: d\nthinking: huge\n---\n", "user", "f")?.thinking, undefined);
});

test("a project agent overrides a user agent of the same name", () => {
	const { root } = sandbox();
	const proj = path.join(root, "repo", ".pi", "agents");
	fs.mkdirSync(proj, { recursive: true });
	fs.writeFileSync(path.join(proj, "explore.md"), "---\nname: explore\ndescription: Project search.\n---\n");
	const agents = discoverAgents(path.join(root, "repo"), { PI_CODING_AGENT_DIR: path.join(root, "agent") });
	assert.deepEqual(agents.map((a) => [a.name, a.source, a.description]), [["explore", "project", "Project search."]]);
});

test("pi args: model suffix beats the agent's level; task goes after --", () => {
	const agent = parseAgent("---\nname: e\ndescription: d\nmodel: p/m\nthinking: low\ntools: read\n---\nbody", "user", "f");
	assert.deepEqual(resolveMeta(agent, { model: "p/other:high" }, "/w"), { agent: "e", model: "p/other:high", thinking: undefined, tools: ["read"], cwd: "/w" });
	const meta = { ...resolveMeta(agent, {}, "/w"), createdAt: "" };
	assert.deepEqual(buildPiArgs(meta, "-x task", { dir: "/s" }), [
		"--mode", "json", "-p", "--session-dir", "/s", "--model", "p/m", "--thinking", "low", "--tools", "read", "--", "-x task",
	]);
});

test("child env blocks nesting and never passes PI_SUBAGENT_NAME", () => {
	assert.deepEqual(childEnv({ PI_SUBAGENT_NAME: "x", A: "1" }, false), { A: "1", PI_SUBAGENT_DEPTH: "1" });
	assert.deepEqual(childEnv({ PI_SUBAGENT_NAME: "x" }, true), {});
});

test("stream: a model error after exit 0 is a failure; billed adds cache reads", () => {
	const s = emptyState();
	applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "x", provider: "p", model: "claude-x", usage: { input: 0, output: 0, cacheRead: 1_000_000, cost: { total: 0 } } } }, () => 2);
	assert.equal(isFailed(s, 0), true);
	assert.ok(Math.abs(s.usage.billed - 0.2) < 1e-9, `billed ${s.usage.billed}`);
	assert.equal(isFailed(emptyState(), 0), true, "no turn at all");
});

test("run then resume: answer on stdout, same pi session, follow-up sees it", () => {
	const { run, calls } = sandbox();
	const first = run(["run", "explore", "--", "find foo"]);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /^answer to: find foo\n/);
	assert.match(first.stdout, /pi-agent: ok · explore · amd-gateway-anthropic\/Claude-Sonnet-5.5 · 2 turns · grep×1/);
	const runDir = first.stdout.match(/^run: (.*)$/m)?.[1] ?? "";
	assert.ok(fs.existsSync(path.join(runDir, "meta.json")));

	const second = run(["resume", runDir, "--", "and bar?"]);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /^answer to: and bar\?/);
	const [c1, c2] = calls();
	assert.equal(c1.args[c1.args.indexOf("--tools") + 1], "read,grep");
	assert.equal(c2.args[c2.args.indexOf("--session") + 1], path.join(runDir, "session", "2026-01-01_fake.jsonl"));
	assert.equal(c2.args[c2.args.indexOf("--append-system-prompt") + 1], path.join(runDir, "system-prompt.md"));
	assert.equal(c1.depth, "1");
	assert.equal(c1.name, null);
});

test("--stream-json: each message whole, each tool result, then done", () => {
	const { run } = sandbox();
	const r = run(["run", "none", "--stream-json", "--", "hi"]);
	const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(lines.map((l) => l.type), ["start", "message", "tool_end", "message", "done"]);
	assert.deepEqual(lines[1], {
		type: "message", thinking: "Plan: grep.", text: "Let me look.", stopReason: "toolUse",
		toolCalls: [{ id: "call_1", name: "grep", args: { pattern: "foo", path: "src" } }],
	});
	assert.deepEqual(lines[2], { type: "tool_end", id: "call_1", name: "grep", isError: false, text: "src/a.ts:1: foo" });
	assert.equal(lines[4].ok, true);
	assert.equal(lines[4].text, "answer to: hi", "the answer is the last message's text alone");
});

/** Runs `pi-agent wait` and returns the events it printed. */
function waitFor(run: ReturnType<typeof sandbox>["run"], args: string[]) {
	const r = run(["wait", ...args]);
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { n: number; event: { type: string; id?: string; text?: string } });
}

test("start runs detached; wait reads message by message; a second start resumes", () => {
	const { run, calls } = sandbox();
	const started = JSON.parse(run(["start", "explore", "--", "find foo"]).stdout);
	assert.match(started.events, /events-1\.jsonl$/);

	const first = waitFor(run, [started.events]);
	assert.deepEqual(first.map((l) => [l.n, l.event.type]), [[0, "start"], [1, "message"]]);
	const tool = waitFor(run, [started.events, "--from", "2", "--until-tool", "call_1"]);
	assert.deepEqual(tool.map((l) => [l.n, l.event.type, l.event.id]), [[2, "tool_end", "call_1"]]);
	const final = waitFor(run, [started.events, "--from", "3"]);
	assert.deepEqual(final.map((l) => [l.n, l.event.type, l.event.text]), [[3, "message", "answer to: find foo"]]);
	assert.deepEqual(waitFor(run, [started.events, "--from", "4"]).map((l) => l.event.type), ["done"]);

	const again = JSON.parse(run(["start", started.runDir, "--", "and bar?"]).stdout);
	assert.equal(again.runDir, started.runDir);
	assert.match(again.events, /events-2\.jsonl$/);
	assert.equal(waitFor(run, [again.events]).at(-1)?.event.text, "Let me look.");
	assert.equal(waitFor(run, [again.events, "--from", "2"]).at(-1)?.event.text, "answer to: and bar?");
	const c2 = calls()[1];
	assert.ok(c2.args.includes("--session"), "the second start resumed the pi session");
});

test("--until-tool stops short of the next message, which is the step's", () => {
	const { root, run } = sandbox();
	const events = path.join(root, "events-1.jsonl");
	fs.writeFileSync(events, [{ type: "start" }, { type: "message" }, { type: "message" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
	assert.deepEqual(waitFor(run, [events, "--from", "1", "--until-tool", "x"]), []);
});

test("stop ends a run; wait reports a run that died without a result", () => {
	const { root, run } = sandbox();
	const started = JSON.parse(run(["start", "none", "--", "x"], { FAKE_PI_MODE: "hang" }).stdout);
	assert.equal(run(["stop", started.runDir]).status, 0);
	const done = waitFor(run, [started.events]).at(-1)?.event as { type: string; ok: boolean };
	assert.deepEqual([done.type, done.ok], ["done", false]);
	assert.equal(fs.existsSync(path.join(started.runDir, "pid")), false, "an ended run leaves no pid to reuse");
	assert.equal(run(["stop", started.runDir]).status, 0, "stopping an ended run is a no-op");

	const dead = path.join(root, "dead");
	fs.mkdirSync(dead);
	fs.writeFileSync(path.join(dead, "events-1.jsonl"), `${JSON.stringify({ type: "start" })}\n`);
	const exited = spawnSync("true");
	fs.writeFileSync(path.join(dead, "pid"), String(exited.pid));
	const crashed = waitFor(run, [path.join(dead, "events-1.jsonl"), "--from", "1"]);
	assert.match(String((crashed[0]?.event as { error?: string }).error), /ended without a result/);
});

test("failures: model error, no model turn, timeout, unknown agent", () => {
	const { run } = sandbox();
	const err = run(["run", "none", "--", "x"], { FAKE_PI_MODE: "error" });
	assert.equal(err.status, 1);
	assert.match(err.stdout, /error: gateway 400/);
	const silent = run(["run", "none", "--", "x"], { FAKE_PI_MODE: "silent" });
	assert.equal(silent.status, 1);
	assert.match(silent.stdout, /pi ran no model turn/);
	const hang = run(["run", "none", "--timeout", "1", "--", "x"], { FAKE_PI_MODE: "hang" });
	assert.equal(hang.status, 1);
	assert.match(hang.stdout, /timed out after 1s/);
	const unknown = run(["run", "nope", "--", "x"]);
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /unknown agent "nope". Known: explore, none/);
});

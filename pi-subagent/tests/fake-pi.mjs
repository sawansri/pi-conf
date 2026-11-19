#!/usr/bin/env node
// Stands in for `pi --mode json -p`: writes a session file and canned events.
// FAKE_PI_MODE: ok (default), error (model call fails), hang (never ends),
// silent (no model turn, like an extension swallowing the prompt).
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const task = args[args.indexOf("--") + 1];
const mode = process.env.FAKE_PI_MODE ?? "ok";
fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args, depth: process.env.PI_SUBAGENT_DEPTH ?? null, name: process.env.PI_SUBAGENT_NAME ?? null })}\n`);
const sessionFile = opt("--session") ?? path.join(opt("--session-dir"), "2026-01-01_fake.jsonl");
fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", task })}\n`);
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const usage = { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0, totalTokens: 1015, cost: { total: 0.001 } };
const assistant = (content, stopReason, extra = {}) => ({ role: "assistant", content, provider: "amd-gateway-anthropic", model: "Claude-Sonnet-5.5", usage, stopReason, ...extra });

out({ type: "session", id: "s1" });
if (mode === "silent") process.exit(0);
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "error") {
  out({ type: "message_end", message: assistant([], "error", { errorMessage: "gateway 400" }) });
} else {
  out({ type: "message_end", message: assistant([
    { type: "thinking", thinking: "Plan: grep." },
    { type: "text", text: "Let me look." },
    { type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "foo", path: "src" } },
  ], "toolUse") });
  out({ type: "tool_execution_start", toolCallId: "call_1", toolName: "grep", args: { pattern: "foo", path: "src" } });
  out({ type: "tool_execution_end", toolCallId: "call_1", toolName: "grep", isError: false, result: { content: [{ type: "text", text: "src/a.ts:1: foo" }] } });
  out({ type: "message_end", message: assistant([{ type: "text", text: `answer to: ${task}` }], "stop") });
}

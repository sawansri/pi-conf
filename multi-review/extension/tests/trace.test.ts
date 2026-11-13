import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ReviewTrace } from "../src/trace.ts";

function events(trace: ReviewTrace): Array<Record<string, unknown>> {
	return fs.readFileSync(trace.tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("every assistant turn records its usage, so a cache leak shows turn by turn", () => {
	// A run billed Kimi 3.5x the fresh input its context could account for,
	// and nothing in the trace could say on which turns the cache missed.
	const trace = new ReviewTrace(fs.mkdtempSync(path.join(os.tmpdir(), "mr-trace-")));
	const h = trace.start("p/kimi@high", "review", "/work");
	const usage = { input: 25_000, output: 400, cacheRead: 160_000, cacheWrite: 0, totalTokens: 185_400, cost: { total: 0.054 } };
	// A turn that only calls tools has no text, but was still billed.
	h.onEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }], usage } } as unknown as AgentSessionEvent);
	const msg = events(trace).find((e) => e.kind === "message");
	assert.ok(msg, "a tool-only turn is traced");
	assert.deepEqual(msg.usage, { input: 25_000, output: 400, cacheRead: 160_000, cacheWrite: 0 });
});

test("every tool result records its size, including reads, whose text is not kept", () => {
	const trace = new ReviewTrace(fs.mkdtempSync(path.join(os.tmpdir(), "mr-trace-")));
	const h = trace.start("p/kimi@high", "review", "/work");
	h.onEvent({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: [{ type: "text", text: "x".repeat(12_000) }] } } as unknown as AgentSessionEvent);
	const r = events(trace).find((e) => e.kind === "tool_result");
	assert.ok(r);
	assert.equal(r.tool, "read");
	assert.equal(r.chars, 12_000);
	assert.equal(r.text, undefined);
});

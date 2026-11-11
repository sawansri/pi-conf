import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, classifierTarget, dedupeTarget, scaledMinToolCalls } from "../src/config.ts";
import { cacheHitRate } from "../src/cost.ts";
import { judgeOutputCap } from "../src/judge.ts";
import { whichChangedLines } from "../src/pipeline.ts";
import { capGrepOutput, capReadOutput, capToolResult } from "../src/tool-budget.ts";
import { buildNarrowVerifyPrompt, splitDiffByFile } from "../src/verdicts.ts";
import type { DedupeGroup } from "../src/grouping.ts";

// ---------- tool output budget ----------

test("a read under the cap is untouched", () => {
	const text = "line one\nline two";
	assert.equal(capReadOutput(text, { maxChars: 1000 }), text);
});

test("an over-cap read keeps the head and resumes after the last complete line", () => {
	// pi returns raw text: no line-number gutter to parse.
	const text = Array.from({ length: 500 }, (_, i) => `const x${i} = 1;`).join("\n");
	const out = capReadOutput(text, { maxChars: 2000 });
	assert.ok(out.length < text.length);
	assert.match(out, /Output clipped/);
	assert.match(out, /^const x0 = 1;/);
	assert.doesNotMatch(out, /const x499/);
	// No half-line survives to be mistaken for code.
	for (const line of out.split("\n")) {
		if (line.startsWith("const x")) assert.match(line, /^const x\d+ = 1;$/);
	}
});

test("the resume offset counts complete lines from the requested start", () => {
	const text = Array.from({ length: 500 }, (_, i) => `const x${i} = 1;`).join("\n");
	const fromTop = capReadOutput(text, { maxChars: 2000 });
	const keptTop = fromTop.split("\n").filter((l) => l.startsWith("const x")).length;
	// Resuming at offset N must land on the first line not yet shown.
	assert.match(fromTop, new RegExp(`offset=${keptTop + 1}\\b`));
	// Starting mid-file shifts the offset by the requested start.
	const midway = capReadOutput(text, { maxChars: 2000, startLine: 100 });
	assert.match(midway, new RegExp(`offset=${keptTop + 100}\\b`));
});

test("a two-line file never yields an offset past EOF", () => {
	// Numbers in the file's own text must not be read as a line gutter.
	const out = capReadOutput(`9000\t${"x".repeat(300)}\nsecond line\n`, { maxChars: 100 });
	const next = Number(out.match(/offset=(\d+)/)![1]);
	assert.ok(next <= 3, `offset ${next} should stay within a 2-line file`);
});

test("an empty cap disables clipping", () => {
	const text = "x".repeat(10_000);
	assert.equal(capReadOutput(text, { maxChars: 0 }), text);
	assert.equal(capGrepOutput(text, { maxChars: 0 }), text);
});

test("a clipped grep keeps whole matches and reports what it dropped", () => {
	const text = Array.from({ length: 200 }, (_, i) => `src/a.ts:${i}: const foo = ${i};`).join("\n");
	const out = capGrepOutput(text, { maxChars: 500 });
	assert.match(out, /more clipped/);
	assert.match(out, /Narrow the pattern/);
	// No half-line left dangling: every kept line is a complete match.
	for (const line of out.split("\n")) {
		if (line.startsWith("src/")) assert.match(line, /^src\/a\.ts:\d+: const foo = \d+;$/);
	}
});

test("only text blocks are capped, and an untouched result keeps its identity", () => {
	const short = { content: [{ type: "text", text: "ok" }], details: { a: 1 } };
	assert.equal(capToolResult(short, (t) => t), short);
	const long = { content: [{ type: "text", text: "x".repeat(100) }], details: { a: 1 } };
	const capped = capToolResult(long, () => "short");
	assert.equal(capped.content[0].text, "short");
	assert.deepEqual(capped.details, { a: 1 });
});

test("a capped result drops structuredContent so no full copy escapes", () => {
	const full = "x".repeat(5000);
	const result = { content: [{ type: "text", text: full }], structuredContent: full };
	const capped = capToolResult(result, () => "short");
	assert.equal(capped.content[0].text, "short");
	assert.equal("structuredContent" in capped, false);
});

// ---------- narrow verify context ----------

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	" const a = 1;",
	"+const broken = 2;",
	" const c = 3;",
	"diff --git a/src/b.ts b/src/b.ts",
	"index 333..444 100644",
	"--- a/src/b.ts",
	"+++ b/src/b.ts",
	"@@ -1,1 +1,2 @@",
	" keep();",
	"+alsoBroken();",
	"",
].join("\n");

const grp = (over: Partial<DedupeGroup>): DedupeGroup => ({
	id: "g1", file: "src/a.ts", line_start: 2, line_end: 2, severity: "high", category: "correctness",
	title: "broken", titles: [], reviewerSpecs: ["p/m"], consensus: false,
	members: [{ spec: "p/m", severity: "high", line_start: 2, line_end: 2, comment: "broken" }],
	...over,
});

test("a diff is split into one section per file, keyed by the b/ path", () => {
	const byFile = splitDiffByFile(DIFF);
	assert.deepEqual([...byFile.keys()], ["src/a.ts", "src/b.ts"]);
	assert.match(byFile.get("src/a.ts")!, /const broken = 2/);
	assert.doesNotMatch(byFile.get("src/a.ts")!, /alsoBroken/);
});

test("a verifier gets only its findings' files, not the whole diff", () => {
	const prompt = buildNarrowVerifyPrompt(
		{ diffText: DIFF },
		{ intent: "fix the cache", requirements: ["must not leak"] },
		[grp({})],
	)!;
	assert.match(prompt, /const broken = 2/);
	assert.doesNotMatch(prompt, /alsoBroken/, "unrelated file's hunk must not be re-sent");
	// Intent and requirements still travel: they are what "broken" is judged against.
	assert.match(prompt, /fix the cache/);
	assert.match(prompt, /must not leak/);
	assert.match(prompt, /Claim 1: broken/);
});

test("findings in two files bring both files' hunks", () => {
	const prompt = buildNarrowVerifyPrompt({ diffText: DIFF }, undefined, [grp({}), grp({ id: "g2", file: "src/b.ts" })])!;
	assert.match(prompt, /const broken = 2/);
	assert.match(prompt, /alsoBroken/);
});

test("an unscoped hypothesis falls back to the whole diff", () => {
	const prompt = buildNarrowVerifyPrompt({ diffText: DIFF }, undefined, [grp({ category: "suspicion", file: "", line_start: null, line_end: null })])!;
	assert.match(prompt, /alsoBroken/);
	assert.match(prompt, /hypothesis/);
});

test("a file the diff does not mention falls back to the whole diff", () => {
	const prompt = buildNarrowVerifyPrompt({ diffText: DIFF }, undefined, [grp({ file: "src/elsewhere.ts" })])!;
	assert.match(prompt, /alsoBroken/);
});

test("no diff means no narrow prompt, so the caller keeps the full brief", () => {
	assert.equal(buildNarrowVerifyPrompt({ diffText: "" }, undefined, [grp({})]), undefined);
});

test("a spec finding brings the spec text; other findings do not pay for it", () => {
	const spec = { path: "spec.md", text: "REQUIRED_SENTINEL" };
	const withSpec = buildNarrowVerifyPrompt({ diffText: DIFF }, { intent: "", requirements: [], spec }, [grp({ category: "spec" })])!;
	assert.match(withSpec, /REQUIRED_SENTINEL/);
	const without = buildNarrowVerifyPrompt({ diffText: DIFF }, { intent: "", requirements: [], spec }, [grp({ category: "correctness" })])!;
	assert.doesNotMatch(without, /REQUIRED_SENTINEL/);
});

test("the narrow prompt's wide fallback is budgeted like the reviewer prompt", () => {
	const huge = `diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+${"x".repeat(300_000)}\n`;
	const prompt = buildNarrowVerifyPrompt({ diffText: huge }, undefined, [grp({ file: "src/nowhere.ts" })])!;
	assert.ok(prompt.length <= 200_000 + 2_000, `fallback diff must stay near the budget, got ${prompt.length}`);
	assert.match(prompt, /diff truncated/);
});

// ---------- cost telemetry ----------

test("the cache-hit rate is the cached share of the prompt, or undefined with no cache", () => {
	assert.equal(cacheHitRate({ input: 100, output: 5, total: 105, cost: 0 }), undefined);
	// Share of the *prompt* (uncached input + cache read + cache write).
	assert.equal(cacheHitRate({ input: 100, output: 5, total: 205, cost: 0, cacheRead: 100 }), 0.5);
	// A write is not a hit, but it is part of the prompt the provider saw:
	// 100 read of (50 fresh + 100 read + 50 written).
	assert.equal(cacheHitRate({ input: 50, output: 5, total: 205, cost: 0, cacheRead: 100, cacheWrite: 50 }), 0.5);
	// Output tokens are not part of the prompt, so they never move the rate.
	assert.equal(cacheHitRate({ input: 0, output: 9999, total: 9999, cost: 0, cacheRead: 300 }), 1);
});

// ---------- routing knobs ----------

test("a failing session still reports the tokens it was billed for", async () => {
	// Two reviewers timed out in a real run and the cost roll-up showed $0 for
	// them, under-reporting what the gateway charged. Every failure return in
	// the agentic path must carry usage like any other result.
	const fs = await import("node:fs");
	const src = fs.readFileSync(new URL("../src/reviewers.ts", import.meta.url), "utf8");
	// Every `return {` inside runAgenticReviewer that sets stopReason "error"
	// has to also set usage.
	const fnStart = src.indexOf("async function runAgenticReviewer");
	const fn = src.slice(fnStart, src.indexOf("function harvestedResult"));
	const errorReturns = [...fn.matchAll(/return \{([\s\S]{0,400}?)\n\t\t\};/g)]
		.map((m) => m[1])
		.filter((body) => body.includes('stopReason: "error"'));
	assert.ok(errorReturns.length > 0, "expected an error return to check");
	for (const body of errorReturns) {
		assert.match(body, /usage: sessionUsage\(stats\)/, `error return without usage:\n${body}`);
	}
});

test("the read cap is on by default: fresh tool output is what a run pays for", () => {
	assert.ok(DEFAULTS.readMaxChars > 0);
});

test("the tool-call floor shrinks with the diff but never below 2", () => {
	assert.equal(scaledMinToolCalls(10, 20), 2);
	assert.equal(scaledMinToolCalls(10, 100), 5);
	assert.equal(scaledMinToolCalls(10, 400), 10);
	// Scaling can lower a configured floor but never raise it.
	assert.equal(scaledMinToolCalls(3, 400), 3);
	assert.equal(scaledMinToolCalls(1, 400), 1);
	// 0 disables the nudge entirely.
	assert.equal(scaledMinToolCalls(0, 400), 0);
});

test("a review with no diff keeps the configured floor", () => {
	// No size signal: a file-scope or free-text review is broad by nature, so
	// the default must not silently drop from 10 to 2.
	assert.equal(scaledMinToolCalls(10, 0), 10);
});

test("the judge's cap grows with the finding count so a big review isn't truncated", () => {
	assert.equal(judgeOutputCap(0, 40), undefined, "0 leaves pi's default in place");
	assert.equal(judgeOutputCap(8_000, 0), 8_000, "never below the configured cap");
	assert.equal(judgeOutputCap(8_000, 10), 8_000, "a small review keeps the configured cap");
	assert.ok(judgeOutputCap(8_000, 60)! > 8_000, "a large review gets room for every finding");
});

test("grouping defaults to the cheap model, not the judge", () => {
	const cfg = { ...DEFAULTS };
	assert.equal(dedupeTarget(cfg), DEFAULTS.dedupeDefaultModel);
	assert.notEqual(dedupeTarget(cfg), cfg.judge);
	// An explicit choice wins; clearing the default falls back to the judge.
	assert.equal(dedupeTarget({ ...cfg, dedupeModel: "p/cheap@low" }), "p/cheap@low");
	assert.equal(dedupeTarget({ ...cfg, dedupeDefaultModel: null }), cfg.judge);
	// "lexical" is a switch, not a model: nothing should try to resolve it.
	assert.equal(dedupeTarget({ ...cfg, dedupeModel: "lexical" }), null);
	// Classification always needs a real model, so lexical still gets the judge.
	assert.equal(classifierTarget({ ...cfg, dedupeModel: "lexical" }), cfg.judge);
});

test("changed lines count additions, removals and hunk headers", () => {
	// Two hunk headers, and the two `+` lines; `---`/`+++` file headers don't count.
	assert.equal(whichChangedLines(DIFF), 4);
	assert.equal(whichChangedLines(""), 0);
});

test("the second-pass gate skips the pass below its threshold and keeps it at 0", () => {
	const lines = whichChangedLines(DIFF);
	const runs = (threshold: number) => lines >= threshold;
	assert.equal(runs(0), true, "the default keeps the unconditional second pass");
	assert.equal(runs(lines), true, "a diff exactly at the threshold still qualifies");
	assert.equal(runs(lines + 1), false, "below the threshold the extra session is skipped");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, emptyRunCost, formatCost, formatRunCost, formatTokens, mergeRunCost, runCostBreakdown } from "../src/cost.ts";

test("a run total sums tokens and cost across calls", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a", { input: 100, output: 10, total: 110, cost: 0.5 });
	addUsage(run, "p/b", { input: 200, output: 20, total: 220, cost: 1.5 });
	assert.equal(run.calls, 2);
	assert.equal(run.usage.input, 300);
	assert.equal(run.usage.output, 30);
	assert.equal(run.usage.cost, 2);
});

test("cache tokens are tracked: they are billed separately from fresh input", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a", { input: 10, output: 1, total: 111, cost: 0.1, cacheRead: 90, cacheWrite: 10 });
	assert.equal(run.usage.cacheRead, 90);
	assert.equal(run.usage.cacheWrite, 10);
	// A cache read bills at a fraction of fresh input, so cost is not
	// derivable from input+output alone — the provider's figure is kept.
	assert.equal(run.usage.cost, 0.1);
});

test("one row per model spec, however many calls it made", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a@high", { input: 10, output: 1, total: 11, cost: 0.1 });
	addUsage(run, "p/a@high", { input: 20, output: 2, total: 22, cost: 0.2 });
	addUsage(run, "p/b@low", { input: 5, output: 1, total: 6, cost: 0.05 });
	assert.equal(run.bySpec.length, 2);
	assert.equal(run.bySpec[0].calls, 2);
	assert.equal(run.bySpec[0].usage.cost, 0.30000000000000004);
	// Breakdown is ordered by spend, so the first line is where to cut.
	assert.equal(runCostBreakdown(run)[0].startsWith("- `a@high`"), true);
	assert.equal(runCostBreakdown(run).length, 2);
});

test("a missing usage (failed or unparsable call) adds nothing", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a", undefined);
	assert.equal(run.calls, 0);
	assert.equal(run.usage.cost, 0);
});

test("merging accumulates calls and cost without duplicating rows", () => {
	const a = emptyRunCost();
	addUsage(a, "p/a", { input: 1, output: 1, total: 2, cost: 1 });
	const b = emptyRunCost();
	addUsage(b, "p/a", { input: 2, output: 2, total: 4, cost: 2 });
	addUsage(b, "p/b", { input: 3, output: 3, total: 6, cost: 3 });
	mergeRunCost(a, b);
	assert.equal(a.calls, 3);
	assert.equal(a.usage.cost, 6);
	assert.equal(a.bySpec.length, 2);
	assert.equal(a.bySpec.find((r) => r.spec === "p/a")?.calls, 2);
});

test("tokens are abbreviated so a total stays one glance", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(12345), "12k");
	assert.equal(formatTokens(1234567), "1.2M");
});

test("cost is never rounded to a misleading zero", () => {
	assert.equal(formatCost(0), "$0");
	// A sub-cent run must not read as free.
	assert.equal(formatCost(0.00000357), "<$0.0001");
	assert.equal(formatCost(0.0731), "$0.073");
	assert.equal(formatCost(12.345), "$12.35");
});

test("the run-cost line names cache tokens and call count", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a", { input: 1000, output: 500, total: 1500, cost: 0.25, cacheRead: 2000, cacheWrite: 0 });
	const line = formatRunCost(run);
	assert.match(line, /\$0\.250/);
	assert.match(line, /1\.0k in/);
	assert.match(line, /500 out/);
	assert.match(line, /2\.0k cached/);
	assert.match(line, /across 1 call\b/);
});

test("cache writes are reported apart from cache reads", () => {
	const run = emptyRunCost();
	addUsage(run, "p/a", { input: 10, output: 1, total: 111, cost: 1, cacheRead: 50, cacheWrite: 50 });
	const line = formatRunCost(run);
	assert.match(line, /50 cached \+ 50 written/);
});

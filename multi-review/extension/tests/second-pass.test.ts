import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewerRunResult } from "../src/findings.ts";
import { dedupeReviewerFindings } from "../src/grouping.ts";
import { reverseDiffFiles } from "../src/prompts.ts";
import { runAllReviewers } from "../src/reviewers.ts";
import { fakeCtx, row } from "./support/fake-models.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n@@ a\n+1\ndiff --git a/b.ts b/b.ts\n@@ b\n+2\ndiff --git a/c.ts b/c.ts\n@@ c\n+3\n";

test("the second pass's diff lists the files in reverse order, hunks intact", () => {
	const reversed = reverseDiffFiles(DIFF);
	assert.deepEqual([...reversed.matchAll(/^diff --git a\/(\w)\.ts/gm)].map((m) => m[1]), ["c", "b", "a"]);
	assert.equal(reversed.length, DIFF.length);
	assert.match(reversed, /diff --git a\/b\.ts b\/b\.ts\n@@ b\n\+2\n/);
	assert.equal(reverseDiffFiles("note\ndiff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n"), "note\ndiff --git a/y b/y\n+2\ndiff --git a/x b/x\n+1\n");
});

test("a second pass runs with its own prompt and shows as #2", async () => {
	const { ctx, calls } = fakeCtx(() => "[]");
	const runs = await runAllReviewers(
		[row("p/sonnet"), row("p/opus"), row("p/sonnet", 2)],
		"SYS", (r) => (r.pass ? "REVERSED" : "FORWARD"), 3, 0, undefined, ctx,
		{ useTools: false, timeoutMs: 60_000 },
	);
	assert.deepEqual(calls.map((c) => `${c.model}:${c.user}`).sort(), ["opus:FORWARD", "sonnet:FORWARD", "sonnet:REVERSED"]);
	assert.deepEqual(runs.map((r) => [r.formattedSpec, r.pass]), [["p/sonnet", undefined], ["p/opus", undefined], ["p/sonnet #2", 2]]);
});

const finding = (title: string) => ({ file: "a.ts", line_start: 10, line_end: 10, severity: "high" as const, category: "correctness", title, comment: title, match_text: title });
const run = (spec: `${string}/${string}`, titles: string[], pass?: number) =>
	({ spec, formattedSpec: spec, ok: true, findings: titles.map(finding), ...(pass ? { pass } : {}) }) as unknown as ReviewerRunResult;

test("one model's two passes group together but aren't consensus", () => {
	const bug = "get returns expired cache entries after ttl";
	const groups = dedupeReviewerFindings([run("p/sonnet", [bug]), run("p/sonnet", [bug], 2), run("p/opus", ["unrelated logging typo in banner"])]);
	const g = groups.find((x) => x.title === bug)!;
	assert.equal(g.members.length, 2);
	assert.deepEqual(g.members.map((m) => m.pass), [undefined, 2]);
	assert.deepEqual(g.reviewerSpecs, ["p/sonnet"]);
	assert.equal(g.consensus, false);
});

test("another model raising it too is consensus, counted by models", () => {
	const bug = "get returns expired cache entries after ttl";
	// Lexical grouping ignores words in ≥40% of findings; a real run has others.
	const others = run("p/kimi", ["banner typo in logging", "retry delay ignores config", "socket leak on reconnect", "tests miss timezone edge", "readme example is stale"]);
	const g = dedupeReviewerFindings([run("p/sonnet", [bug]), run("p/sonnet", [bug], 2), run("p/opus", [bug]), others]).find((x) => x.title === bug)!;
	assert.equal(g.members.length, 3);
	assert.deepEqual(g.reviewerSpecs, ["p/sonnet", "p/opus"]);
	assert.equal(g.consensus, true);
});

test("one run's two findings never merge, even when they look alike", () => {
	const groups = dedupeReviewerFindings([run("p/sonnet", ["get returns expired cache entries after ttl", "get returns expired cache entries after ttl again"])]);
	assert.equal(groups.length, 2);
});

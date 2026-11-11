/**
 * Prompt-size accounting for the reviewer and verifier prompts, on the real
 * repository: how many characters each kind of session is sent, before and
 * after the efficiency changes. Character counts are deterministic, so this
 * is a stable measurement where whole-run costs are not (±12% run to run).
 *
 *   node --experimental-transform-types tests/bench/prompt-size.ts [repo] [base]
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { DedupeGroup } from "../../src/grouping.ts";
import type { ReviewTarget } from "../../src/target.ts";
import { REVIEWER_SYSTEM_PROMPT, buildReviewUserPrompt } from "../../src/prompts.ts";
import { buildNarrowVerifyPrompt, buildVerifyPrompt } from "../../src/verdicts.ts";
import { type ReviewerRunOptions, buildToolPromptAddendum } from "../../src/reviewers.ts";

const repo = process.argv[2] ?? process.cwd();
const base = process.argv[3] ?? "HEAD~1";

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const diffText = git(["diff", `${base}...HEAD`]) || git(["diff", base]);
const files = git(["diff", "--name-only", `${base}...HEAD`])
	.split("\n")
	.filter(Boolean)
	.map((p) => ({ path: p }));

const target = {
	kind: "diff",
	label: `${base}...HEAD`,
	files,
	diffText,
	metaLines: [],
	warnings: [],
	checkResults: [],
} as unknown as ReviewTarget;

const brief = {
	intent:
		"This change adds per-run token and cost accounting for a multi-model review pipeline, so a run's real " +
		"spend is visible after the fact. Costs come from the model catalog and must match what the provider billed.",
	requirements: [
		"A run reports total cost and tokens across every billed call",
		"Cache reads and writes are tracked separately from fresh input",
		"A failed call that was still billed is included in the total",
		"Sub-cent totals never round to a misleading $0.00",
	],
	spec: undefined,
	contextFiles: [],
	checks: [],
	suspicions: [],
};
target.brief = brief;

// A plausible pool result: findings spread over the files the diff touches,
// which is what decides how many hunks a narrow verify prompt must carry.
const groups: DedupeGroup[] = files.slice(0, 6).map((f, i) => ({
	id: `g${i + 1}`,
	file: f.path,
	line_start: 10 + i,
	line_end: 14 + i,
	severity: "high",
	category: "correctness",
	title: `problem ${i + 1} in ${path.basename(f.path)}`,
	titles: [],
	reviewerSpecs: ["p/a"],
	consensus: false,
	members: [
		{
			spec: "p/a",
			severity: "high",
			line_start: 10 + i,
			line_end: 14 + i,
			comment: `problem ${i + 1}: the accounting drops a field. Evidence: it is not added to the total.`,
		},
	],
}));

const n = (s: string) => s.length.toLocaleString();
const tok = (s: string) => Math.round(s.length / 4).toLocaleString();

const reviewerPrompt = buildReviewUserPrompt(target);
const system = REVIEWER_SYSTEM_PROMPT +
	buildToolPromptAddendum({ id: "x", api: "openai-completions" } as never, { useTools: true } as ReviewerRunOptions, true, false);

const oldVerify = buildVerifyPrompt(reviewerPrompt, groups);
const narrowVerify = buildNarrowVerifyPrompt(target, brief, groups) ?? "(none: falls back to the full brief)";

// A verifier is assigned a subset of the findings, not all of them.
const subset = groups.slice(0, 2);
const oldVerifySubset = buildVerifyPrompt(reviewerPrompt, subset);
const narrowVerifySubset = buildNarrowVerifyPrompt(target, brief, subset) ?? "(none)";

console.log(`repo:   ${repo}`);
console.log(`diff:   ${base}...HEAD · ${files.length} files · ${n(diffText)} chars (~${tok(diffText)} tok)\n`);

const row = (label: string, before: string, after: string) => {
	const saved = before.length - after.length;
	const pct = before.length ? Math.round((saved / before.length) * 100) : 0;
	console.log(`${label}`);
	console.log(`  before: ${n(before).padStart(9)} chars (~${tok(before).padStart(7)} tok)`);
	console.log(`  after:  ${n(after).padStart(9)} chars (~${tok(after).padStart(7)} tok)   -${pct}%\n`);
};

console.log("STATIC per-session context (system prompt + tool addenda), sent on EVERY turn:");
console.log(`  ${n(system).padStart(9)} chars (~${tok(system)} tok)\n`);

row(`REVIEWER user prompt (unchanged by the levers; ${groups.length} findings' files in the diff):`, reviewerPrompt, reviewerPrompt);
row(`VERIFIER prompt, all ${groups.length} findings:`, oldVerify, narrowVerify);
row(`VERIFIER prompt, ${subset.length} findings in ${new Set(subset.map((g) => g.file)).size} file(s):`, oldVerifySubset, narrowVerifySubset);

// What a whole verify round sends.
const allBefore = groups.map((_, i) => buildVerifyPrompt(reviewerPrompt, [groups[i]]));
const allAfter = groups.map((_, i) => buildNarrowVerifyPrompt(target, brief, [groups[i]]) ?? buildVerifyPrompt(reviewerPrompt, [groups[i]]));
const sum = (xs: string[]) => xs.reduce((s, x) => s + x.length, 0);
const sumBefore = sum(allBefore);
const sumAfter = sum(allAfter);
const num = (x: number) => x.toLocaleString();
console.log(`VERIFY ROUND, ${groups.length} sessions of 1 finding each:`);
console.log(`  before: ${num(sumBefore).padStart(9)} chars (~${num(Math.round(sumBefore / 4))} tok)`);
console.log(`  after:  ${num(sumAfter).padStart(9)} chars (~${num(Math.round(sumAfter / 4))} tok)   ` +
	`-${Math.round(((sumBefore - sumAfter) / sumBefore) * 100)}%`);

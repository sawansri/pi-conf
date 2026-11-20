import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_QUOTE_ADDENDUM, modelAddendum } from "../src/prompts.ts";

test("Gemini is told up front not to quote code; other models aren't", () => {
	assert.equal(modelAddendum({ id: "gemini-4-argon" }), NO_QUOTE_ADDENDUM);
	assert.equal(modelAddendum({ id: "Gemini-3.8-Flash" }), NO_QUOTE_ADDENDUM);
	assert.match(NO_QUOTE_ADDENDUM, /file:line/);
	for (const id of ["Claude-Opus-5.5", "gpt-6.1-sol", "Kimi-K3.1-Pro"]) assert.equal(modelAddendum({ id }), "");
});

test("reviewers aim for recall and leave the filtering to verification", async () => {
	const { REVIEWER_SYSTEM_PROMPT } = await import("../src/prompts.ts");
	assert.match(REVIEWER_SYSTEM_PROMPT, /Aim for recall/);
	assert.match(REVIEWER_SYSTEM_PROMPT, /report it anyway and say in evidence what you traced and what you couldn't/);
	assert.doesNotMatch(REVIEWER_SYSTEM_PROMPT, /Don't inflate nits|An empty review is a valid outcome/);
});

test("non-goals reach reviewers as out of scope, and an empty list adds nothing", async () => {
	const { buildReviewUserPrompt } = await import("../src/prompts.ts");
	const { buildBrief } = await import("../src/brief.ts");
	const brief = buildBrief(process.cwd(), { intent: "pick an image", nonGoals: [" no background install path ", ""] }, []);
	const target = { brief, metaLines: [], files: [], diffText: "diff --git a/x b/x\n" } as never;
	const prompt = buildReviewUserPrompt(target);
	assert.match(prompt, /## Out of scope \(non-goals\)[\s\S]*Don't report a finding that only asks for one of them[\s\S]*- no background install path\n/);
	const none = buildReviewUserPrompt({ ...(target as object), brief: buildBrief(process.cwd(), { intent: "x" }, []) } as never);
	assert.doesNotMatch(none, /Out of scope/);
});

test("the lead keeps Act On to merge-blocking, introduced problems with a proportional fix", async () => {
	const { leadJudgmentInstructions } = await import("../src/lead.ts");
	const text = leadJudgmentInstructions(false);
	assert.match(text, /goes in Act On only when all three hold: the change introduced it; it blocks merging/);
	assert.match(text, /no new machinery/);
	assert.match(text, /### Act On[\s\S]*### Side effects[\s\S]*### Follow-ups[\s\S]*### Consider/);
});

test("fix rounds report the change's size and stop after two", async () => {
	const { leadJudgmentInstructions } = await import("../src/lead.ts");
	const text = leadJudgmentInstructions(false);
	assert.match(text, /git diff --shortstat/);
	assert.match(text, /`non_goals` = the original non-goals plus each Follow-up/);
	assert.match(text, /Stop after two fix rounds/);
});

test("the reply caps the buckets past Act On", async () => {
	const { leadJudgmentInstructions } = await import("../src/lead.ts");
	const text = leadJudgmentInstructions(false);
	assert.match(text, /### Follow-ups\n[^\n]*Show at most 5, most important first[^\n]*verdict\.md keeps them all/);
	assert.match(text, /### Consider\n[^\n]*At most 3/);
});

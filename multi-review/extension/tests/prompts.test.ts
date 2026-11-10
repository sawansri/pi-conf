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

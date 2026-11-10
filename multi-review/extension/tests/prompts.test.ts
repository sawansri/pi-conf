import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_QUOTE_ADDENDUM, modelAddendum } from "../src/prompts.ts";

test("Gemini is told up front not to quote code; other models aren't", () => {
	assert.equal(modelAddendum({ id: "gemini-4-argon" }), NO_QUOTE_ADDENDUM);
	assert.equal(modelAddendum({ id: "Gemini-3.8-Flash" }), NO_QUOTE_ADDENDUM);
	assert.match(NO_QUOTE_ADDENDUM, /file:line/);
	for (const id of ["Claude-Opus-5.5", "gpt-6.1-sol", "Kimi-K3.1-Pro"]) assert.equal(modelAddendum({ id }), "");
});

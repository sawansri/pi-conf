import assert from "node:assert/strict";
import { test } from "node:test";
import type { DedupeGroup, Verification } from "../src/grouping.ts";
import { VERIFY_SYSTEM_PROMPT, buildVerifyPrompt, parseVerificationJson, vetoes } from "../src/verdicts.ts";

const group = (over: Partial<DedupeGroup> = {}): DedupeGroup => ({
	id: "g1", file: "a.ts", line_start: 3, line_end: 3, severity: "high", category: "correctness", title: "get() returns expired entries",
	titles: [], reviewerSpecs: ["p/m"], consensus: false,
	members: [{
		spec: "p/m", severity: "high", line_start: 3, line_end: 3,
		comment: "get() returns expired entries\nEvidence (traced): this is clearly wrong because I am sure\nRepro: set k ttl 1; wait; get k",
		parts: { core: "get() returns expired entries", evidence: "this is clearly wrong because I am sure", repro: "set k ttl 1; wait; get k", evidenceKind: "traced" },
	}],
	...over,
});

test("verifiers get the claim and its repro, not the reviewer's argument", () => {
	const prompt = buildVerifyPrompt("BASE", [group()]);
	assert.match(prompt, /Claim 1: get\(\) returns expired entries/);
	assert.match(prompt, /Repro 1: set k ttl 1; wait; get k/);
	assert.doesNotMatch(prompt, /clearly wrong because I am sure/);
});

test("the verify prompt asks for a refutation first and executed or traced confirmations", () => {
	assert.match(VERIFY_SYSTEM_PROMPT, /try to refute each finding first/);
	assert.match(VERIFY_SYSTEM_PROMPT, /Plausible is not confirmed/);
	assert.match(VERIFY_SYSTEM_PROMPT, /"evidence_kind"/);
});

test("verdicts carry how the verifier knows", () => {
	const v = parseVerificationJson('[{"id":"g1","verdict":"confirmed","evidence_kind":"executed","evidence":"node t.js -> undefined"}]', new Set(["g1"]));
	assert.deepEqual(v.get("g1"), { verdict: "confirmed", evidence: "node t.js -> undefined", evidenceKind: "executed" });
});

test("one refutation with evidence is a veto, whatever the majority says", () => {
	const v = (verdict: Verification["verdict"], evidence: string): Verification => ({ spec: "p/x", verdict, evidence });
	assert.equal(vetoes(group({ verifications: [v("confirmed", "traced it fine, real bug here"), v("confirmed", "yes"), v("refuted", "cache.ts:12 checks expiry before returning")] })).length, 1);
	assert.equal(vetoes(group({ verifications: [v("refuted", "(no evidence given)"), v("refuted", "nope")] })).length, 0);
	assert.equal(vetoes(group({ verifications: [v("confirmed", "node t.js -> undefined, expected v")] })).length, 0);
});

test("a short refutation that cites the code keeps its veto", () => {
	const v = (evidence: string): Verification => ({ spec: "p/x", verdict: "refuted", evidence });
	assert.equal(vetoes(group({ verifications: [v("a.ts:3 guards null")] })).length, 1);
	assert.equal(vetoes(group({ verifications: [v("src/cache.ts:12")] })).length, 1);
	assert.equal(vetoes(group({ verifications: [v("not a bug")] })).length, 0);
});

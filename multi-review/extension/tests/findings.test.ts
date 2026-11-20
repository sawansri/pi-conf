import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewerJson } from "../src/findings.ts";

const finding = (extra: Record<string, unknown>) => JSON.stringify([{ file: "a.ts", line_start: 3, severity: "high", title: "t", comment: "c", evidence: "ran it", ...extra }]);

test("evidence_kind is parsed, normalized, and shown with the evidence", () => {
	const [f] = parseReviewerJson(finding({ evidence_kind: "executed" }));
	assert.equal(f.parts?.evidenceKind, "executed");
	assert.match(f.comment, /\nEvidence \(executed\): ran it/);
	assert.equal(parseReviewerJson(finding({ evidence_kind: "Traced" }))[0].parts?.evidenceKind, "traced");
	assert.equal(parseReviewerJson(finding({ evidenceKind: "suspected" }))[0].parts?.evidenceKind, "inferred");
});

test("a missing or unknown evidence_kind is left out", () => {
	for (const extra of [{}, { evidence_kind: "vibes" }]) {
		const [f] = parseReviewerJson(finding(extra));
		assert.equal(f.parts?.evidenceKind, undefined);
		assert.match(f.comment, /\nEvidence: ran it/);
	}
});

test("origin is parsed, and only a pre-existing one is spelled out in the comment", () => {
	const [pre] = parseReviewerJson(finding({ origin: "Pre-existing" }));
	assert.equal(pre.parts?.origin, "pre-existing");
	assert.match(pre.comment, /\nOrigin: pre-existing$/);
	const [intro] = parseReviewerJson(finding({ origin: "introduced" }));
	assert.equal(intro.parts?.origin, "introduced");
	assert.doesNotMatch(intro.comment, /Origin/);
	assert.equal(parseReviewerJson(finding({ origin: "dunno" }))[0].parts?.origin, undefined);
});

test("fix_scope is parsed, and a fix that needs new machinery says so", () => {
	const [big] = parseReviewerJson(finding({ suggestion: "add a worker", fix_scope: "new-machinery" }));
	assert.equal(big.parts?.fixScope, "new-machinery");
	assert.match(big.comment, /\nSuggestion \(needs new machinery\): add a worker/);
	const [small] = parseReviewerJson(finding({ suggestion: "check null", fix_scope: "Local" }));
	assert.equal(small.parts?.fixScope, "local");
	assert.match(small.comment, /\nSuggestion: check null/);
});

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

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MIN_TRACK_RECORD, type OutcomeRecord, readOutcomes, recordOutcomes, trackRecordLines, trackRecords } from "../src/outcomes.ts";

function runDir(groups: unknown[], buckets: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-outcomes-"));
	fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ok: true, details: { scope: "uncommitted changes", groups } }));
	fs.writeFileSync(path.join(dir, "outcomes.json"), JSON.stringify(buckets));
	return dir;
}
const member = (spec: string, extra: object = {}) => ({ spec, severity: "high", comment: "c", line_start: 1, line_end: 1, ...extra });
const GROUPS = [
	{ id: "g1", category: "correctness", members: [member("p/opus", { parts: { core: "c", evidenceKind: "executed" } }), member("p/sonnet", { pass: 2 })], verifications: [{ spec: "p/kimi", verdict: "refuted", evidence: "a.ts:3 guards against it already" }] },
	{ id: "g2", category: "design", members: [member("p/kimi")] },
	{ id: "g3", category: "suspicion", members: [] },
	{ id: "g4", category: "tests", members: [member("p/opus")] },
];

test("a run's verdicts are recorded once per finding, joined with how it was raised and verified", () => {
	const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mr-log-")), "outcomes.jsonl");
	const dir = runDir(GROUPS, { g1: "Act On", g2: "dismissed", g3: "act_on" });
	const out = recordOutcomes(dir, log, new Date("2026-11-10T00:00:00Z"));
	assert.deepEqual(out, { recorded: 3, skipped: ["g4"] });
	const records = readOutcomes(log);
	assert.deepEqual(records.map((r) => [r.group, r.spec, r.pass, r.bucket, r.evidenceKind, r.vetoed, r.verification]), [
		["g1", "p/opus", undefined, "act_on", "executed", true, "✓0 ✗1 ?0"],
		["g1", "p/sonnet", 2, "act_on", undefined, true, "✓0 ✗1 ?0"],
		["g2", "p/kimi", undefined, "dismissed", undefined, false, ""],
	]);
	assert.match(String((recordOutcomes(dir, log) as { error: string }).error), /already recorded/);
	assert.equal(readOutcomes(log).length, 3);
});

test("a run without outcomes.json or review groups is an error, and records nothing", () => {
	const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mr-log-")), "outcomes.jsonl");
	const dir = runDir(GROUPS, {});
	fs.rmSync(path.join(dir, "outcomes.json"));
	assert.match(String((recordOutcomes(dir, log) as { error: string }).error), /outcomes\.json/);
	const socratic = runDir([], {});
	fs.writeFileSync(path.join(socratic, "result.json"), JSON.stringify({ ok: true, details: { socratic: {} } }));
	assert.match(String((recordOutcomes(socratic, log) as { error: string }).error), /no review groups/);
	assert.equal(fs.existsSync(log), false);
});

const rec = (spec: string, bucket: OutcomeRecord["bucket"], category = "correctness", evidenceKind?: OutcomeRecord["evidenceKind"]): OutcomeRecord =>
	({ t: "", run: "r", scope: "", group: "g", spec, category, severity: "high", verification: "", vetoed: false, bucket, ...(evidenceKind ? { evidenceKind } : {}) });

test("a model's track record shows once it has enough judged findings", () => {
	const kimi = [...Array(6).fill(rec("p/kimi", "dismissed", "design")), ...Array(4).fill(rec("p/kimi", "act_on", "correctness", "executed"))];
	const opus = Array(MIN_TRACK_RECORD - 1).fill(rec("p/opus", "act_on"));
	const [t, ...rest] = trackRecords([...kimi, ...opus], ["p/kimi", "p/opus"]);
	assert.deepEqual(rest, []);
	assert.deepEqual([t.spec, t.n, t.actOn, t.dismissed], ["p/kimi", 10, 4, 6]);
	assert.deepEqual(t.categories, [{ category: "design", n: 6, dismissed: 6 }]);
	const lines = trackRecordLines([...kimi, ...opus], ["p/kimi", "p/opus"]).join("\n");
	assert.match(lines, /kimi: 10 findings judged, 40% acted on, 60% dismissed · most dismissed: design 100% of 6 · act on by evidence: executed 100% of 4/);
	assert.match(lines, /not a filter/);
	assert.deepEqual(trackRecordLines(opus, ["p/opus"]), []);
});

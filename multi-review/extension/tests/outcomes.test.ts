import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MIN_TRACK_RECORD, type OutcomeRecord, newRunDir, outcomesPath, readOutcomes, recordOutcomes, runsHome, trackRecordLines, trackRecords } from "../src/outcomes.ts";

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
	assert.deepEqual(out, { recorded: 3, skipped: ["g4"], already: [] });
	const records = readOutcomes(log);
	assert.deepEqual(records.map((r) => [r.group, r.spec, r.pass, r.bucket, r.evidenceKind, r.vetoed, r.verification]), [
		["g1", "p/opus", undefined, "act_on", "executed", true, "✓0 ✗1 ?0"],
		["g1", "p/sonnet", 2, "act_on", undefined, true, "✓0 ✗1 ?0"],
		["g2", "p/kimi", undefined, "dismissed", undefined, false, ""],
	]);
	assert.deepEqual(recordOutcomes(dir, log), { recorded: 0, skipped: ["g4"], already: ["g1", "g2"] });
	assert.equal(readOutcomes(log).length, 3);
	// bucketing the rest later records just that
	fs.writeFileSync(path.join(dir, "outcomes.json"), JSON.stringify({ g1: "act_on", g2: "dismissed", g4: "noted" }));
	assert.deepEqual(recordOutcomes(dir, log), { recorded: 1, skipped: [], already: ["g1", "g2"] });
	assert.deepEqual(readOutcomes(log).map((r) => r.group), ["g1", "g1", "g2", "g4"]);
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

let nextGroup = 0;
const rec = (spec: string, bucket: OutcomeRecord["bucket"], category = "correctness", evidenceKind?: OutcomeRecord["evidenceKind"]): OutcomeRecord =>
	({ t: "", run: "r", scope: "", group: `g${nextGroup++}`, spec, category, severity: "high", verification: "", vetoed: false, bucket, ...(evidenceKind ? { evidenceKind } : {}) });

test("a model's track record shows once it has enough judged findings", () => {
	const kimi = [...Array.from({ length: 6 }, () => rec("p/kimi", "dismissed", "design")), ...Array.from({ length: 4 }, () => rec("p/kimi", "act_on", "correctness", "executed"))];
	const opus = Array.from({ length: MIN_TRACK_RECORD - 1 }, () => rec("p/opus", "act_on"));
	const [t, ...rest] = trackRecords([...kimi, ...opus], ["p/kimi", "p/opus"]);
	assert.deepEqual(rest, []);
	assert.deepEqual([t.spec, t.n, t.actOn, t.dismissed], ["p/kimi", 10, 4, 6]);
	assert.deepEqual(t.categories, [{ category: "design", n: 6, dismissed: 6 }]);
	const lines = trackRecordLines([...kimi, ...opus], ["p/kimi", "p/opus"]).join("\n");
	assert.match(lines, /kimi: 10 findings judged, 40% acted on, 60% dismissed · most dismissed: design 100% of 6 · act on by evidence: executed 100% of 4/);
	assert.match(lines, /not a filter/);
	assert.deepEqual(trackRecordLines(opus, ["p/opus"]), []);
});

test("an issue both of a model's passes raised is one finding in its track record", () => {
	const both = [...Array(MIN_TRACK_RECORD)].flatMap((_, i) => [{ ...rec("p/sonnet", "act_on"), group: `g${i}` }, { ...rec("p/sonnet", "act_on"), group: `g${i}`, pass: 2 }]);
	assert.equal(trackRecords(both, ["p/sonnet"])[0].n, MIN_TRACK_RECORD);
	assert.deepEqual(trackRecords(both.slice(0, MIN_TRACK_RECORD + 2), ["p/sonnet"]), []);
});

test("runs are kept with the outcomes log, not in /tmp, which a reboot clears", () => {
	const saved = process.env.XDG_DATA_HOME;
	try {
		delete process.env.XDG_DATA_HOME;
		assert.equal(runsHome(), path.join(os.homedir(), ".local", "share", "multi-review", "runs"));
		const data = fs.mkdtempSync(path.join(os.tmpdir(), "mr-data-"));
		process.env.XDG_DATA_HOME = data;
		assert.equal(runsHome(), path.join(data, "multi-review", "runs"));
		assert.equal(path.dirname(runsHome()), path.dirname(outcomesPath()));
	} finally {
		if (saved === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = saved;
	}
});

test("each run gets its own directory, named so they sort by start time", () => {
	const saved = process.env.XDG_DATA_HOME;
	try {
		process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mr-data-"));
		const a = newRunDir(new Date(2026, 10, 12, 9, 5, 7));
		const b = newRunDir(new Date(2026, 10, 12, 9, 5, 7));
		assert.notEqual(a, b);
		assert.equal(path.dirname(a), runsHome());
		assert.match(path.basename(a), /^20261112-090507-/);
		assert.ok(fs.statSync(a).isDirectory());
	} finally {
		if (saved === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = saved;
	}
});

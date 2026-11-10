import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EvidenceKind } from "./findings.ts";
import type { DedupeGroup } from "./grouping.ts";
import { shortSpec } from "./progress.ts";
import { verificationTally, vetoes } from "./verdicts.ts";

/**
 * What became of each finding: the lead's bucket for its issue, joined with
 * who raised it and how it was verified. One line per finding in a local
 * JSONL log, so the lead view can show each model's track record (Greptile,
 * Uber's uReview and Google's AutoCommenter all filter on such history).
 * Volume is one user's reviews, so it's shown as a prior, never a filter.
 */

export const BUCKETS = ["act_on", "consider", "noted", "dismissed"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface OutcomeRecord {
	/** When it was recorded. */
	t: string;
	/** The run's directory: one record set per run. */
	run: string;
	scope: string;
	group: string;
	spec: string;
	pass?: number;
	category: string;
	severity: string;
	evidenceKind?: EvidenceKind;
	/** "✓1 ✗0 ?0", or empty when unverified. */
	verification: string;
	vetoed: boolean;
	bucket: Bucket;
}

export function outcomesPath(): string {
	const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	return path.join(data, "multi-review", "outcomes.jsonl");
}

export function readOutcomes(file = outcomesPath()): OutcomeRecord[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: OutcomeRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as OutcomeRecord);
		} catch {
			/* a torn line: skip it */
		}
	}
	return out;
}

function normalizeBucket(raw: unknown): Bucket | undefined {
	const v = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
	if (v === "acton" || v === "act") return "act_on";
	if (v === "consider") return "consider";
	if (v === "noted" || v === "note") return "noted";
	if (v === "dismissed" || v === "dismiss") return "dismissed";
	return undefined;
}

/**
 * Join `<dir>/result.json` (the review) with `<dir>/outcomes.json` (the
 * lead's `{ "g1": "act_on", … }`) and append one record per finding. An
 * issue already in the log is not recorded twice, so rerunning after adding
 * buckets records just the new ones.
 */
export function recordOutcomes(
	dir: string,
	file = outcomesPath(),
	now = new Date(),
): { recorded: number; skipped: string[]; already: string[] } | { error: string } {
	let result: { ok?: boolean; details?: { groups?: DedupeGroup[]; scope?: string } };
	let buckets: Record<string, unknown>;
	try {
		result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
	} catch (err) {
		return { error: `cannot read ${path.join(dir, "result.json")}: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		buckets = JSON.parse(fs.readFileSync(path.join(dir, "outcomes.json"), "utf8"));
	} catch (err) {
		return { error: `cannot read ${path.join(dir, "outcomes.json")}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const groups = result.details?.groups;
	if (!result.ok || !groups) return { error: "result.json has no review groups (failed run or Socratic discussion)" };
	const run = path.resolve(dir);
	const recordedGroups = new Set(readOutcomes(file).filter((r) => r.run === run).map((r) => r.group));
	const records: OutcomeRecord[] = [];
	const skipped: string[] = [];
	const already: string[] = [];
	for (const g of groups) {
		// Suspicions and PR claims are the lead's and others' claims, not a model's findings.
		if (g.category === "suspicion" || g.category === "pr-claim") continue;
		if (recordedGroups.has(g.id)) {
			already.push(g.id);
			continue;
		}
		const bucket = normalizeBucket(buckets[g.id]);
		if (!bucket) {
			skipped.push(g.id);
			continue;
		}
		for (const m of g.members) {
			records.push({
				t: now.toISOString(), run, scope: result.details?.scope ?? "", group: g.id,
				spec: m.spec, ...(m.pass ? { pass: m.pass } : {}),
				category: g.category, severity: m.severity,
				...(m.parts?.evidenceKind ? { evidenceKind: m.parts.evidenceKind } : {}),
				verification: verificationTally(g), vetoed: vetoes(g).length > 0, bucket,
			});
		}
	}
	if (records.length > 0) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
	}
	return { recorded: records.length, skipped, already };
}

/** Below this many judged findings, a model's record says too little to show. */
export const MIN_TRACK_RECORD = 10;

export interface TrackRecord {
	spec: string;
	n: number;
	actOn: number;
	dismissed: number;
	/** Categories with at least 5 findings, most dismissed first. */
	categories: Array<{ category: string; n: number; dismissed: number }>;
	/** By evidence_kind, where given. */
	byEvidence: Array<{ kind: EvidenceKind; n: number; actOn: number }>;
}

export function trackRecords(records: OutcomeRecord[], specs: string[]): TrackRecord[] {
	return specs.flatMap((spec) => {
		// One finding per issue: a model's two passes raising it is one finding.
		const seen = new Set<string>();
		const mine = records.filter((r) => {
			const key = `${r.run}\u0000${r.group}`;
			if (r.spec !== spec || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		if (mine.length < MIN_TRACK_RECORD) return [];
		const count = (rs: OutcomeRecord[], b: Bucket) => rs.filter((r) => r.bucket === b).length;
		const categories = [...new Set(mine.map((r) => r.category))]
			.map((category) => {
				const rs = mine.filter((r) => r.category === category);
				return { category, n: rs.length, dismissed: count(rs, "dismissed") };
			})
			.filter((c) => c.n >= 5)
			.sort((a, b) => b.dismissed / b.n - a.dismissed / a.n);
		const byEvidence = (["executed", "traced", "inferred"] as const)
			.map((kind) => {
				const rs = mine.filter((r) => r.evidenceKind === kind);
				return { kind, n: rs.length, actOn: count(rs, "act_on") };
			})
			.filter((e) => e.n > 0);
		return [{ spec, n: mine.length, actOn: count(mine, "act_on"), dismissed: count(mine, "dismissed"), categories, byEvidence }];
	});
}

const pct = (k: number, n: number) => `${Math.round((100 * k) / n)}%`;

/** The lead view's section: each model's history, as a prior. */
export function trackRecordLines(records: OutcomeRecord[], specs: string[]): string[] {
	const tracks = trackRecords(records, specs);
	if (tracks.length === 0) return [];
	const lines = [
		"## Reviewer track record",
		`From your past verdicts (${outcomesPath()}). A prior for how much to trust each model's findings, not a filter: judge each finding on its evidence.`,
	];
	for (const t of tracks) {
		const cats = t.categories.length ? ` · most dismissed: ${t.categories.slice(0, 2).map((c) => `${c.category} ${pct(c.dismissed, c.n)} of ${c.n}`).join(", ")}` : "";
		const ev = t.byEvidence.length ? ` · act on by evidence: ${t.byEvidence.map((e) => `${e.kind} ${pct(e.actOn, e.n)} of ${e.n}`).join(", ")}` : "";
		lines.push(`- ${shortSpec(t.spec)}: ${t.n} findings judged, ${pct(t.actOn, t.n)} acted on, ${pct(t.dismissed, t.n)} dismissed${cats}${ev}`);
	}
	lines.push("");
	return lines;
}

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Model, type ModelSpec, type MultiReviewConfig, type ThinkingLevelAlias, parseReviewerSpec } from "./config.ts";
import type { FindingParts, ReviewerFinding, ReviewerRunResult } from "./findings.ts";
import { callModel, findModel } from "./models.ts";
import { type MultiReviewProgressReporter, shortSpec } from "./progress.ts";
import { formatRange } from "./synthesis.ts";
import { withTimeout } from "./util.ts";

// ---------- dedupe & group ----------

const SEVERITY_RANK: Record<ReviewerFinding["severity"], number> = {
	critical: 5,
	high: 4,
	medium: 3,
	low: 2,
	info: 1,
	none: 0,
};

export interface DedupeGroup {
	id: string;
	file: string;
	line_start: number | null;
	line_end: number | null;
	severity: ReviewerFinding["severity"];
	category: string;
	title: string;
	titles: string[]; // every distinct title model used
	members: {
		spec: ModelSpec;
		comment: string;
		severity: ReviewerFinding["severity"];
		line_start: number | null;
		line_end: number | null;
		title?: string;
		parts?: FindingParts;
	}[];
	reviewerSpecs: ModelSpec[]; // unique specs that flagged this group
	consensus: boolean; // ≥ 2 distinct reviewers
	/** Cross-checks from reviewers who did NOT raise the finding (verify round). */
	verifications?: Verification[];
	/** Why a group got fewer verifiers than asked (e.g. every reviewer raised it). */
	verificationNote?: string;
	/** Verifiers assigned in the verify round (0 = every reviewer raised it). */
	verifiers?: number;
	/** Finding keys (`run:finding`) that formed this group, when grouped by the model. */
	keys?: FindingKey[];
	/** Extra verifier context for claim pseudo-groups (origin, original diff hunk). */
	context?: string;
}

/**
 * One of the lead's hypotheses, checked without showing it to reviewers:
 * did anyone raise it independently, and (with --verify) does it hold up?
 */
export interface SuspicionResult {
	id: string;
	text: string;
	/** Ids of groups that independently describe the same defect. */
	raisedBy: string[];
	verifications?: Verification[];
	verificationNote?: string;
}

export interface Verification {
	spec: ModelSpec;
	verdict: "confirmed" | "refuted" | "uncertain";
	evidence: string;
}

/** Models cite slightly different lines for the same issue; allow this much slack. */
const LINE_MATCH_SLACK = 2;
/**
 * Minimum word overlap (Jaccard over title+comment keywords) for two nearby
 * findings to count as one issue. Same category lowers the bar but never to
 * zero: adjacent "spec" findings are usually different requirements.
 */
const TEXT_MATCH_JACCARD = 0.2;
const TEXT_MATCH_JACCARD_SAME_CATEGORY = 0.08;

function normalizedRange(start: number | null, end: number | null): [number, number] | null {
	if (start === null && end === null) return null;
	const a = start ?? end!;
	const b = end ?? start!;
	return a <= b ? [a, b] : [b, a];
}

const STOPWORDS = new Set(["this", "that", "with", "from", "when", "then", "than", "into", "which", "will", "would", "should", "could", "there", "their", "because", "returns", "return", "value", "code", "line", "lines", "function", "method", "call", "calls"]);

export function keywords(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
}

interface GroupMemberFinding {
	finding: ReviewerFinding;
	words: Set<string>;
}

/**
 * Same file, near some member's own lines (never a widened union — that
 * chains unrelated findings across small files), and the same issue:
 * enough shared vocabulary, with a lower bar within one category. File-level findings only match
 * file-level findings, so one vague comment can't absorb a whole file.
 */
function sameIssue(members: GroupMemberFinding[], f: ReviewerFinding, words: Set<string>): boolean {
	return members.some(({ finding: m, words: mw }) => {
		if (m.file !== f.file) return false;
		const g = normalizedRange(m.line_start, m.line_end);
		const r = normalizedRange(f.line_start, f.line_end);
		if ((g === null) !== (r === null)) return false;
		if (g && r && !(r[0] <= g[1] + LINE_MATCH_SLACK && g[0] <= r[1] + LINE_MATCH_SLACK)) return false;
		return jaccard(mw, words) >= (m.category === f.category ? TEXT_MATCH_JACCARD_SAME_CATEGORY : TEXT_MATCH_JACCARD);
	});
}

/**
 * Greedy O(N²) dedupe. N is small (a few dozen findings per reviewer ×
 * a handful of reviewers), so the quadratic cost is fine and the simple
 * match predicate is easier to audit than a hash-based strategy.
 *
 * Each reviewer contributes at most one finding per group: two findings
 * from the same model at nearby lines are that model saying "these are
 * different issues", so they stay separate. The displayed group range is
 * the union of its members; matching uses member ranges (see sameIssue).
 */
/** Stable id for one reviewer finding: `<run index>:<finding index>`. */
export type FindingKey = string;

function newGroup(spec: ModelSpec, finding: ReviewerFinding): DedupeGroup {
	return {
		id: "",
		file: finding.file,
		line_start: finding.line_start,
		line_end: finding.line_end,
		severity: finding.severity,
		category: finding.category,
		title: finding.title,
		titles: [finding.title],
		members: [memberOf(spec, finding)],
		reviewerSpecs: [spec],
		consensus: false,
	};
}

function memberOf(spec: ModelSpec, finding: ReviewerFinding): DedupeGroup["members"][number] {
	return {
		spec,
		comment: finding.comment,
		severity: finding.severity,
		line_start: finding.line_start,
		line_end: finding.line_end,
		title: finding.title,
		parts: finding.parts,
	};
}

function addToGroup(group: DedupeGroup, spec: ModelSpec, finding: ReviewerFinding): void {
	group.members.push(memberOf(spec, finding));
	group.reviewerSpecs.push(spec);
	group.consensus = true;
	if (!group.titles.includes(finding.title)) group.titles.push(finding.title);
	if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[group.severity]) group.severity = finding.severity;
	const g = normalizedRange(group.line_start, group.line_end);
	const f = normalizedRange(finding.line_start, finding.line_end);
	if (g && f) {
		group.line_start = Math.min(g[0], f[0]);
		group.line_end = Math.max(g[1], f[1]);
	}
}

function finalizeGroups(groups: DedupeGroup[]): DedupeGroup[] {
	// Sort by severity desc, consensus first, then file, then line_start.
	groups.sort((a, b) => {
		const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
		if (s !== 0) return s;
		const c = b.reviewerSpecs.length - a.reviewerSpecs.length;
		if (c !== 0) return c;
		const f = a.file.localeCompare(b.file);
		if (f !== 0) return f;
		return (a.line_start ?? -1) - (b.line_start ?? -1);
	});
	// Ids follow display order so verifier/judge references read naturally.
	groups.forEach((g, i) => { g.id = `g${i + 1}`; });
	return groups;
}

/**
 * Group findings into issues. With `clusters` (a validated partition from
 * clusterFindingsWithModel) the grouping is taken as given; otherwise a
 * lexical fallback matches on file, nearby lines, and distinctive words.
 */
export function dedupeReviewerFindings(results: ReviewerRunResult[], clusters?: FindingKey[][]): DedupeGroup[] {
	if (clusters) {
		const groups: DedupeGroup[] = [];
		for (const cluster of clusters) {
			let group: DedupeGroup | undefined;
			for (const key of cluster) {
				if (!/^\d+:\d+$/.test(key)) continue;
				const [ri, fi] = key.split(":").map(Number);
				const r = results[ri];
				const finding = r?.findings[fi];
				if (!r || !finding) continue;
				if (!group) group = newGroup(r.spec, finding);
				else addToGroup(group, r.spec, finding);
				(group.keys ??= []).push(key);
			}
			if (group) groups.push(group);
		}
		return finalizeGroups(groups);
	}

	const groups: DedupeGroup[] = [];
	const memberFindings: GroupMemberFinding[][] = [];
	// Words most findings share (the file's domain, "spec", quoted spec text)
	// say nothing about WHICH issue a finding is; drop them before matching.
	const allTexts = results.filter((r) => r?.ok).flatMap((r) => r.findings.map((f) => keywords(f.match_text ?? `${f.title} ${f.comment}`)));
	const docFreq = new Map<string, number>();
	for (const ws of allTexts) for (const w of ws) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
	const commonCutoff = Math.max(3, Math.ceil(allTexts.length * 0.4));
	const distinctive = (ws: Set<string>) => new Set([...ws].filter((w) => (docFreq.get(w) ?? 0) < commonCutoff));
	for (const r of results) {
		if (!r?.ok) continue;
		for (const finding of r.findings) {
			const words = distinctive(keywords(finding.match_text ?? `${finding.title} ${finding.comment}`));
			const gi = groups.findIndex((g, i) => !g.reviewerSpecs.includes(r.spec) && sameIssue(memberFindings[i], finding, words));
			if (gi >= 0) {
				addToGroup(groups[gi], r.spec, finding);
				memberFindings[gi].push({ finding, words });
			} else {
				groups.push(newGroup(r.spec, finding));
				memberFindings.push([{ finding, words }]);
			}
		}
	}
	return finalizeGroups(groups);
}

const CLUSTER_SYSTEM_PROMPT = `You group code-review findings from several independent reviewers into distinct issues.

Two findings belong together only if they describe the SAME underlying defect (same root cause, same fix) — not merely the same file, nearby lines, or the same spec. Different requirements, different bugs on adjacent lines, and a bug vs. a missing test are separate issues.

Ids starting with "S:" or "P:" are NOT findings but claims from elsewhere (the lead reviewer's hypotheses, or existing PR review comments). Put each claim in the cluster of the finding(s) describing the same defect, or leave it alone in its own cluster if no finding matches. Match on the defect, not the topic. Never put two claims in one cluster.

Output ONLY a JSON array of clusters; each cluster is an array of ids, e.g. [["0:1","2:0","S:0"],["1:3"],["S:1"]].
- Every id appears in exactly one cluster.
- Never put two findings from the same reviewer (same prefix before the colon) in one cluster.
- Singletons are fine.`;

/**
 * Semantic grouping: one cheap model call that partitions findings into
 * issues. Consensus counts are the main signal this tool produces, and
 * lexical matching can't tell "same bug" from "different bug two lines
 * down". The model's answer is validated into a strict partition (each id
 * once, ≤1 finding per reviewer per cluster); anything invalid → null and
 * the caller falls back to lexical grouping.
 */
async function clusterFindingsWithModel(
	ctx: ExtensionContext,
	model: Model,
	thinking: ThinkingLevelAlias,
	results: ReviewerRunResult[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
	hidden: HiddenClaim[] = [],
): Promise<{ clusters: FindingKey[][] } | { error: string }> {
	const items: string[] = [];
	const known = new Set<FindingKey>();
	for (const h of hidden) {
		known.add(h.key);
		items.push(`- id ${h.key} | ${h.label} (not a finding) | ${h.text.replace(/\s+/g, " ").slice(0, 500)}`);
	}
	results.forEach((r, ri) => {
		if (!r?.ok) return;
		r.findings.forEach((f, fi) => {
			const key = `${ri}:${fi}`;
			known.add(key);
			const core = (f.match_text ?? f.comment).replace(/\s+/g, " ").slice(0, 500);
			items.push(`- id ${key} | ${f.file}:${formatRange(f.line_start, f.line_end)} | ${f.category} | ${f.title} — ${core}`);
		});
	});
	if (known.size - hidden.length === 0 || known.size < 2) return { clusters: [...known].map((k) => [k]) };
	const call = await callModel(ctx, model, CLUSTER_SYSTEM_PROMPT, `## Findings\n${items.join("\n")}`, {
		thinking,
		temperature: 0,
		signal: withTimeout(signal, timeoutMs),
		maxTokens: 8_000,
	});
	if (call.errorMessage) return { error: call.errorMessage };
	let parsed: unknown;
	try {
		const start = call.text.indexOf("[");
		const end = call.text.lastIndexOf("]");
		parsed = JSON.parse(call.text.slice(start, end + 1));
	} catch (err) {
		return { error: `cluster JSON: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!Array.isArray(parsed)) return { error: "cluster reply is not an array" };
	const seen = new Set<FindingKey>();
	const clusters: FindingKey[][] = [];
	for (const raw of parsed) {
		if (!Array.isArray(raw)) continue;
		const cluster: FindingKey[] = [];
		const reviewers = new Set<string>();
		for (const id of raw) {
			const key = String(id);
			if (!known.has(key) || seen.has(key)) continue;
			const reviewer = key.split(":")[0];
			seen.add(key);
			// A same-reviewer collision means the model merged two of one
			// reviewer's distinct findings; split it out rather than trust it.
			if (reviewers.has(reviewer)) clusters.push([key]);
			else {
				reviewers.add(reviewer);
				cluster.push(key);
			}
		}
		if (cluster.length > 0) clusters.push(cluster);
	}
	for (const key of known) if (!seen.has(key)) clusters.push([key]);
	return { clusters };
}

/** A claim checked against independent findings without being shown to reviewers. */
export interface HiddenClaim {
	/** "S:<i>" for lead suspicions, "P:<i>" for PR comment claims. */
	key: string;
	label: string;
	text: string;
}

/**
 * Semantic grouping with lexical fallback; never fails the run. Also maps
 * each hidden claim (lead suspicion, PR comment) to the groups that
 * independently describe it.
 */
export async function groupFindings(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	results: ReviewerRunResult[],
	signal: AbortSignal | undefined,
	progress?: MultiReviewProgressReporter,
	hidden: HiddenClaim[] = [],
): Promise<{ groups: DedupeGroup[]; matches: Map<string, string[]> }> {
	const lexical = () => {
		const groups = dedupeReviewerFindings(results);
		return { groups, matches: new Map(hidden.map((h) => [h.key, matchSuspicionLexically(h.text, groups)])) };
	};
	if (cfg.dedupeModel === "lexical") return lexical();
	const parsedSpec = parseReviewerSpec(cfg.dedupeModel ?? cfg.judge, "low");
	const model = parsedSpec ? findModel(ctx, parsedSpec.spec) : null;
	if (!parsedSpec || !model) return lexical();
	progress?.update({ phase: `grouping findings (${shortSpec(parsedSpec.spec)})`, done: undefined, total: undefined });
	const out = await clusterFindingsWithModel(ctx, model, parsedSpec.thinking, results, signal, 120_000, hidden);
	if ("error" in out) {
		progress?.update({ phase: "grouping fell back to lexical", latest: `grouping model failed: ${out.error.slice(0, 120)}` });
		return lexical();
	}
	const groups = dedupeReviewerFindings(results, out.clusters);
	const groupOfKey = new Map<FindingKey, string>();
	for (const g of groups) for (const k of g.keys ?? []) groupOfKey.set(k, g.id);
	const matches = new Map(hidden.map((h) => {
		const cluster = out.clusters.find((c) => c.includes(h.key)) ?? [];
		return [h.key, [...new Set(cluster.map((k) => groupOfKey.get(k)).filter((id): id is string => Boolean(id)))]];
	}));
	return { groups, matches };
}

/** Fallback suspicion matching: shared distinctive vocabulary with a group's text. */
function matchSuspicionLexically(text: string, groups: DedupeGroup[]): string[] {
	const words = keywords(text);
	return groups
		.filter((g) => jaccard(words, keywords(`${g.titles.join(" ")} ${g.members.map((m) => m.comment).join(" ")}`)) >= 0.12)
		.map((g) => g.id);
}

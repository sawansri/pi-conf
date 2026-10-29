import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewerSpec, formatReviewerSpec } from "./config.ts";
import { parseJsonLenient, pickText } from "./findings.ts";
import type { DedupeGroup, Verification } from "./grouping.ts";
import { type MultiReviewProgressReporter, shortSpec } from "./progress.ts";
import { type ReviewerRunOptions, runReviewer, throwIfAborted } from "./reviewers.ts";
import { formatRange } from "./synthesis.ts";
import { mapWithConcurrency } from "./util.ts";

// ---------- verification round ----------

/**
 * Assign each group to `k` verifiers who did not raise it, balancing load
 * (least-loaded first, pool order breaks ties). Verifying your own finding
 * is not independent evidence, so raisers are never assigned; a group
 * every reviewer raised gets a note instead.
 */
export function assignVerifiers(groups: DedupeGroup[], pool: ModelSpec[], k: number): Map<ModelSpec, string[]> {
	const load = new Map<ModelSpec, string[]>(pool.map((spec) => [spec, []]));
	for (const g of groups) {
		const candidates = pool
			.filter((spec) => !g.reviewerSpecs.includes(spec))
			.sort((a, b) => load.get(a)!.length - load.get(b)!.length || pool.indexOf(a) - pool.indexOf(b))
			.slice(0, k);
		for (const spec of candidates) load.get(spec)!.push(g.id);
		g.verifiers = candidates.length;
		if (candidates.length === 0) g.verificationNote = "raised by every reviewer — no independent verifier";
		else if (candidates.length < k) g.verificationNote = `only ${candidates.length} independent verifier${candidates.length === 1 ? "" : "s"} available`;
	}
	for (const [spec, ids] of load) if (ids.length === 0) load.delete(spec);
	return load;
}

const VERIFY_SYSTEM_PROMPT = `You are verifying findings that OTHER reviewers raised about a code change. You did not raise them; judge them on the code alone.

For each finding, establish whether it is real:
- "confirmed": you traced it in the code and it is a real problem as described (or worse).
- "refuted": you can show it is wrong — e.g. an upstream guard or the type system prevents it, the reviewer misread the hunk, the code isn't touched by the change, or the spec doesn't require it. Cite the code that disproves it.
- "uncertain": you can't establish it either way; say what's missing.

Be skeptical in both directions: a confident wrong "confirmed" is as harmful as a wrong "refuted". Severity is not your call.

Output ONLY a JSON array, one entry per finding:
[{"id": "g1", "verdict": "confirmed"|"refuted"|"uncertain", "evidence": "<file:line facts that decide it, ≤400 chars>"}]`;

function buildVerifyPrompt(basePrompt: string, groups: DedupeGroup[]): string {
	const lines = [basePrompt, "", "## Findings to verify"];
	for (const g of groups) {
		if (g.category === "suspicion") {
			lines.push(`### ${g.id} — unconfirmed hypothesis (no location given; find it yourself)`);
			lines.push(`Claim: ${g.title}`);
			lines.push("");
			continue;
		}
		if (g.category === "pr-claim") {
			lines.push(`### ${g.id} — claim from an existing PR review comment · ${g.file}${g.line_start !== null ? `:${g.line_start}` : ""} (line may have moved; verify against the current code)`);
			lines.push(`Claim: ${g.title}`);
			if (g.context) lines.push(g.context);
			lines.push("");
			continue;
		}
		lines.push(`### ${g.id} — ${g.severity.toUpperCase()} · ${g.category} · ${g.file}:${formatRange(g.line_start, g.line_end)}`);
		lines.push(`Title: ${g.title}`);
		g.members.forEach((m, i) => lines.push(`Reviewer ${i + 1}: ${m.comment.replace(/\n/g, " ")}`));
		lines.push("");
	}
	lines.push("Output ONLY the JSON array of verdicts per the system prompt.");
	return lines.join("\n");
}

function parseVerificationJson(rawText: string, expected: Set<string>): Map<string, Omit<Verification, "spec">> {
	const out = new Map<string, Omit<Verification, "spec">>();
	const start = rawText.indexOf("[");
	const end = rawText.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error(`no JSON array in verifier reply: ${JSON.stringify(rawText.slice(0, 120))}`);
	const parsed = parseJsonLenient(rawText.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("verifier reply is not an array");
	for (const item of parsed) {
		const rec = (item ?? {}) as Record<string, unknown>;
		const id = pickText(rec, ["id", "group_id", "finding_id", "target_finding_id"]);
		const verdict = normalizeVerdict(pickText(rec, ["verdict", "status", "result"]));
		if (!expected.has(id) || !verdict) continue;
		const evidence = pickText(rec, ["evidence", "reason", "reasoning", "explanation", "justification", "comment"]);
		out.set(id, { verdict, evidence: (evidence || "(no evidence given)").slice(0, 800) });
	}
	// Verdicts that match none of the assigned ids are a protocol failure,
	// not "nothing to say" — never let a verifier silently drop out.
	if (out.size === 0 && expected.size > 0) {
		throw new Error(`no usable verdicts for ${[...expected].join(",")} in reply: ${JSON.stringify(rawText.slice(0, 200))}`);
	}
	return out;
}

function normalizeVerdict(raw: string): Verification["verdict"] | undefined {
	const v = raw.toLowerCase().replace(/[^a-z_]/g, "");
	if (["confirmed", "confirm", "valid", "real", "true", "true_positive", "agree"].includes(v)) return "confirmed";
	if (["refuted", "refute", "invalid", "false", "false_positive", "disagree", "rejected"].includes(v)) return "refuted";
	if (["uncertain", "unsure", "unknown", "inconclusive", "unclear"].includes(v)) return "uncertain";
	return undefined;
}

/**
 * Verification round: each group is cross-checked by reviewers who didn't
 * raise it, each verifier handling all its assigned groups in one session
 * (with tools unless the run is quick). Verdicts are attached to the
 * groups; a verifier failure leaves its groups unverified, never refuted.
 */
export async function runVerification(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	rows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	groups: DedupeGroup[],
	basePrompt: string,
	runOpts: ReviewerRunOptions,
	signal: AbortSignal | undefined,
	progress?: MultiReviewProgressReporter,
): Promise<{ failures: string[] }> {
	// Every reviewer can verify — including ones whose own review failed:
	// having raised nothing, they're the most independent checkers. `rows`
	// also carries the verify-only models, after the reviewers.
	const pool = rows.map((r) => r.rs.spec);
	const assignments = [...assignVerifiers(groups, pool, cfg.verifiersPerFinding)];
	const byId = new Map(groups.map((g) => [g.id, g]));
	const failures: string[] = [];
	let done = 0;
	progress?.update({ phase: "verifying findings", done: 0, total: assignments.length });
	await mapWithConcurrency(assignments, cfg.concurrency, async ([spec, ids]) => {
		const row = rows.find((r) => r.rs.spec === spec);
		if (!row) return;
		const assigned = ids.map((id) => byId.get(id)!).filter(Boolean);
		const run = await runReviewer(row.model, row.rs, ctx, VERIFY_SYSTEM_PROMPT, buildVerifyPrompt(basePrompt, assigned), cfg.temperature, signal, { ...runOpts, tracePhase: "verify" }, () => []);
		let verdicts = new Map<string, Omit<Verification, "spec">>();
		let error = run.errorMessage;
		if (!error) {
			try {
				verdicts = parseVerificationJson(run.rawText, new Set(ids));
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}
		}
		if (error) failures.push(`${formatReviewerSpec(row.rs)}: ${error.slice(0, 160)}`);
		for (const [id, v] of verdicts) {
			const g = byId.get(id)!;
			(g.verifications ??= []).push({ spec, ...v });
		}
		done++;
		const tally = [...verdicts.values()].reduce((acc, v) => ({ ...acc, [v.verdict]: (acc[v.verdict] ?? 0) + 1 }), {} as Record<string, number>);
		progress?.update({
			phase: "verifying findings",
			done,
			total: assignments.length,
			latest: `${error ? "✗" : "✓"} ${shortSpec(formatReviewerSpec(row.rs))} verified ${verdicts.size}/${ids.length}` +
				(error ? ` — ${error.slice(0, 80)}` : ` (${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ")})`) +
				`, ${(run.durationMs / 1000).toFixed(1)}s`,
		});
	});
	throwIfAborted(signal);
	return { failures };
}

/** One-line verification summary for a group, e.g. "✓2 ✗1 ?0". */
export function verificationTally(g: DedupeGroup): string {
	if (!g.verifications?.length) {
		if (!g.verificationNote) return "";
		return g.verifiers === 0 ? "unanimous" : "unverified";
	}
	const n = (v: Verification["verdict"]) => g.verifications!.filter((x) => x.verdict === v).length;
	return `✓${n("confirmed")} ✗${n("refuted")} ?${n("uncertain")}`;
}

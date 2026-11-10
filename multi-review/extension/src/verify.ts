import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewerSpec, formatReviewerSpec } from "./config.ts";
import type { DedupeGroup, Verification } from "./grouping.ts";
import { type MultiReviewProgressReporter, shortSpec } from "./progress.ts";
import { type ReviewerRunOptions, runReviewer, throwIfAborted } from "./reviewers.ts";
import { VERIFY_SYSTEM_PROMPT, buildVerifyPrompt, parseVerificationJson } from "./verdicts.ts";
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

export { verificationTally, vetoes } from "./verdicts.ts";

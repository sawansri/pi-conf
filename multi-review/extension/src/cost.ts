/**
 * Token and cost accounting for a whole run.
 *
 * Nested reviewer/verifier sessions are created in memory
 * (`SessionManager.inMemory`), so their spend never reaches pi's own
 * `/cost` totals: without a roll-up here a run's real price is invisible.
 * Costs come from `models.json`, which mirrors the AMD gateway catalog, and
 * the gateway's billed `total_cost` matches those rates exactly.
 *
 * Pure, so tests can load it without pi.
 */

export interface ModelUsage {
	/** Uncached input tokens. */
	input: number;
	output: number;
	/** input + output + cacheRead + cacheWrite, as the provider reports it. */
	total: number;
	cost: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/**
 * The gateway's real cache multipliers, relative to a model's input rate.
 * Measured directly against `llm-api.amd.com` rather than read from
 * `models.json`, whose `cacheRead`/`cacheWrite` are both 0 — which silently
 * treats cached tokens as free and under-reports a cached run by ~1.7x.
 * Anthropic-style caching bills a write at 1.25x input and a read at 0.05x.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.05;

/**
 * What the gateway actually bills for `usage`: the catalog cost plus the cache
 * tokens it prices at $0, at the real multipliers. Without the model's input
 * rate there is nothing to price them with, so the catalog cost stands.
 */
export function billedCost(usage: ModelUsage, inputPerMillion: number | undefined): number {
	if (!inputPerMillion) return usage.cost;
	const cached = (usage.cacheRead ?? 0) * CACHE_READ_MULTIPLIER + (usage.cacheWrite ?? 0) * CACHE_WRITE_MULTIPLIER;
	return usage.cost + (cached * inputPerMillion) / 1e6;
}

/**
 * Share of the prompt billed as a cache read, 0–1. Undefined when the
 * provider reported no cache activity at all (nothing to say).
 */
export function cacheHitRate(usage: ModelUsage): number | undefined {
	const read = usage.cacheRead ?? 0;
	const write = usage.cacheWrite ?? 0;
	const prompt = usage.input + read + write;
	if (prompt === 0 || read + write === 0) return undefined;
	return read / prompt;
}

export const EMPTY_USAGE: ModelUsage = { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };

/** Running total, optionally split per model spec. */
export interface RunCost {
	calls: number;
	usage: ModelUsage;
	/** Cost and tokens per model, in first-seen order. */
	bySpec: Array<{ spec: string; calls: number; usage: ModelUsage }>;
}

export function emptyRunCost(): RunCost {
	return { calls: 0, usage: { ...EMPTY_USAGE }, bySpec: [] };
}

function addInto(into: ModelUsage, usage: ModelUsage): ModelUsage {
	return {
		input: into.input + usage.input,
		output: into.output + usage.output,
		total: into.total + usage.total,
		cost: into.cost + usage.cost,
		cacheRead: (into.cacheRead ?? 0) + (usage.cacheRead ?? 0),
		cacheWrite: (into.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
	};
}

/**
 * Fold one call into the run total. `calls` counts calls, not tokens, so a
 * run's shape (how many model invocations it needed) stays visible.
 */
export function addUsage(run: RunCost, spec: string, usage: ModelUsage | undefined): RunCost {
	if (!usage) return run;
	run.calls += 1;
	run.usage = addInto(run.usage, usage);
	const row = run.bySpec.find((r) => r.spec === spec);
	if (row) {
		row.calls += 1;
		row.usage = addInto(row.usage, usage);
	} else {
		run.bySpec.push({ spec, calls: 1, usage: { ...usage } });
	}
	return run;
}

export function mergeRunCost(into: RunCost, other: RunCost): RunCost {
	into.calls += other.calls;
	into.usage = addInto(into.usage, other.usage);
	for (const row of other.bySpec) {
		// Re-run addUsage semantics without double-counting `calls`.
		const existing = into.bySpec.find((r) => r.spec === row.spec);
		if (existing) {
			existing.calls += row.calls;
			existing.usage = addInto(existing.usage, row.usage);
		} else {
			into.bySpec.push({ spec: row.spec, calls: row.calls, usage: { ...row.usage } });
		}
	}
	return into;
}

/** 1234 → "1.2k", 1_234_567 → "1.2M". Token counts are read at a glance. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "$0.0731" — never "$0.00" for a run that did spend something. */
export function formatCost(usd: number): string {
	if (!usd) return "$0";
	// Below a hundredth of a cent, a rounded "$0.0000" would read as free.
	if (usd < 0.0001) return "<$0.0001";
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	if (usd < 10) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/** One line for the run summary: totals, then cache savings when present. */
export function formatRunCost(run: RunCost): string {
	const u = run.usage;
	const read = u.cacheRead ?? 0;
	const write = u.cacheWrite ?? 0;
	// Cache tokens are billed separately and dominate long runs, so they get
	// their own slot rather than being folded into the input count.
	const hit = cacheHitRate(u);
	const cache = read + write > 0
		? `, ${formatTokens(read)} cached${write > 0 ? ` + ${formatTokens(write)} written` : ""}${hit === undefined ? "" : ` (${Math.round(hit * 100)}% of prompt)`}`
		: "";
	return `${formatCost(u.cost)} · ${formatTokens(u.input)} in / ${formatTokens(u.output)} out${cache} across ${run.calls} call${run.calls === 1 ? "" : "s"}`;
}

/**
 * The cost line appended to a review, so the lead sees what the run spent
 * without asking. Multiple runs on one diff (verify round included) stay
 * one line: the total is what a reader acts on.
 */
export function runCostLine(run: RunCost): string {
	if (run.calls === 0) return "";
	return `\n\n---\n**Run cost:** ${formatRunCost(run)}`;
}

/** Per-model breakdown, most expensive first — where to cut if it's too much. */
export function runCostBreakdown(run: RunCost): string[] {
	return [...run.bySpec]
		.sort((a, b) => b.usage.cost - a.usage.cost)
		.map((r) => `- \`${r.spec.split("/").pop()}\` — ${formatCost(r.usage.cost)} · ${formatTokens(r.usage.input)} in / ${formatTokens(r.usage.output)} out · ${r.calls} call${r.calls === 1 ? "" : "s"}`);
}

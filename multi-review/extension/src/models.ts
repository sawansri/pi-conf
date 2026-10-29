import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewerSpec, type ThinkingLevelAlias, parseReviewerSpec } from "./config.ts";
import { abortable } from "./util.ts";

/**
 * Convert "provider/id" into a Model via the live registry. Useful because
 * the registry is the single source of truth for what the user actually has
 * configured (with API keys, etc.) — it already accounts for models.json
 * overrides, OAuth sessions, and absent credentials. We deliberately do NOT
 * add new entries to the registry here (per the design constraint).
 */
export function findModel(ctx: ExtensionContext, spec: ModelSpec): Model | null {
	const slash = spec.indexOf("/");
	if (slash <= 0) return null;
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	return ctx.modelRegistry.find(provider, id) ?? null;
}

/**
 * True when the provider won't run `level` as requested. Mirrors pi-ai's
 * getSupportedThinkingLevels: a `null` map entry marks a level unsupported,
 * and xhigh/max are only supported when the map defines them explicitly.
 */
export function isThinkingLevelClamped(model: Model, level: ThinkingLevelAlias): boolean {
	if (!model.reasoning || level === "off") return false;
	const map = (model.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
	if (map[level] === null) return true;
	if ((level === "xhigh" || level === "max") && map[level] === undefined) return true;
	return false;
}

/**
 * Resolve the configured reviewer pool against the live ModelRegistry with
 * per-reviewer thinking. Returns parsed spec + resolved Model + a flag
 * indicating whether the spec's thinking got clamped for the model (so the
 * notify can surface it). Drops spec strings that don't resolve at all.
 */
export async function resolveReviewerPoolStructured(
	ctx: ExtensionContext,
	rawReviewers: string[],
): Promise<{ entries: Array<{ raw: string; rs: ReviewerSpec; model: Model; clamped: boolean }>; missing: string[] }> {
	const available: Model[] = await ctx.modelRegistry.getAvailable();
	const byKey = new Map<string, Model>();
	for (const m of available) byKey.set(`${m.provider}/${m.id}`, m);

	const entries: Array<{ raw: string; rs: ReviewerSpec; model: Model; clamped: boolean }> = [];
	const missing: string[] = [];
	for (const raw of rawReviewers) {
		const parsed = parseReviewerSpec(raw);
		if (!parsed) {
			missing.push(raw);
			continue;
		}
		const model = byKey.get(parsed.spec);
		if (!model) {
			missing.push(raw);
			continue;
		}
		entries.push({ raw, rs: parsed, model, clamped: isThinkingLevelClamped(model, parsed.thinking) });
	}
	return { entries, missing };
}

/**
 * Resolve the configured judge model. Returns null when missing; refrains
 * from falling back to any other model because the user picked that one
 * specifically in the defaults file.
 */
export function resolveJudge(ctx: ExtensionContext, cfg: MultiReviewConfig): Model | null {
	return findModel(ctx, cfg.judge);
}

export function describePool(cfg: MultiReviewConfig): string {
	if (cfg.reviewers.length === 0)
		return "no reviewers configured (set multi-review.reviewers in ~/.pi/agent/multi-review.json)";
	const sample = cfg.reviewers.slice(0, 3).join(", ");
	const tail = cfg.reviewers.length > 3 ? `, +${cfg.reviewers.length - 3} more` : "";
	return `pool: ${cfg.reviewers.length} (${sample}${tail})`;
}

export function describeResolved(resolved: { spec: ModelSpec }[], missing: ModelSpec[]): string {
	const lines: string[] = [];
	if (resolved.length > 0) {
		lines.push(`resolved ${resolved.length} reviewer${resolved.length === 1 ? "" : "s"}:`);
		for (const r of resolved) lines.push(`  ✓ ${r.spec}`);
	}
	if (missing.length > 0) {
		lines.push(`skipped ${missing.length} (not in registry / missing API key):`);
		for (const m of missing) lines.push(`  – ${m}`);
		lines.push("");
		lines.push("Add the missing model to ~/.pi/agent/models.json (per the design");
		lines.push("constraint, this extension does NOT edit models.json), or remove it");
		lines.push("from multi-review.reviewers, or log in via /login.");
	}
	return lines.join("\n");
}

export interface ModelCallResult {
	text: string;
	stopReason: string;
	/** Set when the call failed outright (auth, HTTP, abort) or was truncated. */
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	/** Tool calls made, for agentic reviewers. */
	toolCalls?: number;
	durationMs: number;
}

/**
 * Single choke point for every nested model call.
 *
 *  - Goes through ctx.modelRegistry so request-time auth from models.json
 *    (literal apiKey + custom headers) is applied. The compat
 *    `completeSimple` only reads env-var keys, so gateway-configured models
 *    fail auth through it.
 *  - The registry resolves (never rejects) on provider failure, with
 *    stopReason "error"/"aborted". Those are surfaced as errorMessage so a
 *    failed reviewer can't masquerade as a clean "no findings" review.
 *  - Temperature is dropped when reasoning is on: reasoning endpoints
 *    (OpenAI responses, Anthropic thinking) reject or ignore it.
 *  - maxTokens defaults high because reasoning tokens count against it on
 *    several providers; a 4k cap truncates xhigh reviewers to nothing.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export async function callModel(
	ctx: ExtensionContext,
	model: Model,
	systemPrompt: string,
	userPrompt: string,
	opts: { thinking: ThinkingLevelAlias; temperature: number; signal: AbortSignal | undefined; maxTokens?: number },
): Promise<ModelCallResult> {
	const started = Date.now();
	const reasoning = model.reasoning && opts.thinking !== "off" ? opts.thinking : undefined;
	const maxTokens = Math.min(opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, model.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS);
	try {
		const response = await abortable(ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }] },
				{
					signal: opts.signal,
					maxTokens,
					...(reasoning !== undefined ? { reasoning } : { temperature: opts.temperature }),
				},
			)
			.result(), opts.signal, () => {
				throw new Error(`aborted: ${String(opts.signal?.reason ?? "cancelled")}`);
			});
		const text = response.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("");
		let errorMessage: string | undefined;
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			errorMessage = `${response.stopReason}: ${response.errorMessage ?? "(no message)"}`;
		} else if (response.stopReason === "length" && !text.trim()) {
			errorMessage = `truncated: hit maxTokens=${maxTokens} before producing output (reasoning budget exhausted?)`;
		}
		return {
			text,
			stopReason: response.stopReason,
			errorMessage,
			usage: response.usage
				? {
					input: response.usage.input,
					output: response.usage.output,
					total: response.usage.totalTokens,
					cost: response.usage.cost?.total ?? 0,
				}
				: undefined,
			durationMs: Date.now() - started,
		};
	} catch (err) {
		return {
			text: "",
			stopReason: "error",
			errorMessage: err instanceof Error ? err.message : String(err),
			durationMs: Date.now() - started,
		};
	}
}

/**
 * Multi-Review — fan-out code reviewer (DESIGN: ../README.md)
 *
 * Commands registered (planned, will land in subsequent commits):
 *   /multi-review [pr-number | free-text focus]
 *
 * Persistent defaults: reads $PI_CODING_AGENT_DIR/multi-review.json once on
 * first access. Unknown fields, bad JSON, or missing file all fall back to
 * in-code defaults silently.
 *
 * Status + display: every session_start notifies with the resolved reviewer
 * pool size so it's obvious the plugin picked up your config.
 *
 * This commit (scaffold): registers the empty command and the session_start
 * notify. Reviews themselves require subsequent commits (model pool, scope
 * resolution, parallel fan-out, dedupe, judge, render).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** Provider/model-id pair as written in the defaults file and the picker. */
export type ModelSpec = `${string}/${string}`;

/** Per-reviewer input that survives a /reload (saved via pi.appendEntry). */
export interface MultiReviewConfig {
	reviewers: ModelSpec[];
	judge: ModelSpec;
	judgeThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	concurrency: number;
	temperature: number;
}

const DEFAULTS: MultiReviewConfig = {
	reviewers: [],
	judge: "fireworks/accounts/fireworks/models/glm-5p2",
	judgeThinking: "high",
	concurrency: 4,
	temperature: 0.2,
};

const STATUS_KEY = "multi-review";

/**
 * Read $PI_CODING_AGENT_DIR/multi-review.json once and cache. Unknown keys,
 * missing file, or malformed JSON → silent fallback to in-code defaults.
 * This intentionally mirrors the tdd-pipeline-extension convention so
 * users have one mental model across extensions in this repo.
 */
let cachedConfig: MultiReviewConfig | null = null;
function loadConfig(): MultiReviewConfig {
	if (cachedConfig !== null) return cachedConfig;
	cachedConfig = { ...DEFAULTS };
	try {
		const configPath = path.join(getAgentDir(), "multi-review.json");
		if (!fs.existsSync(configPath)) return cachedConfig;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return cachedConfig;
		if (Array.isArray(parsed.reviewers)) {
			cachedConfig.reviewers = parsed.reviewers.filter(
				(x): x is ModelSpec => typeof x === "string" && x.includes("/"),
			);
		}
		if (typeof parsed.judge === "string" && parsed.judge.includes("/")) {
			cachedConfig.judge = parsed.judge as ModelSpec;
		}
		const tk: MultiReviewConfig["judgeThinking"] = parsed.judgeThinking;
		if (typeof tk === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(tk)) {
			cachedConfig.judgeThinking = tk;
		}
		if (typeof parsed.concurrency === "number" && parsed.concurrency > 0 && parsed.concurrency <= 16) {
			cachedConfig.concurrency = Math.floor(parsed.concurrency);
		}
		if (typeof parsed.temperature === "number" && parsed.temperature >= 0 && parsed.temperature <= 2) {
			cachedConfig.temperature = parsed.temperature;
		}
	} catch {
		cachedConfig = { ...DEFAULTS };
	}
	return cachedConfig;
}

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
	return ctx.modelRegistry.find(provider, id);
}

/**
 * Resolve the configured reviewer pool against the live ModelRegistry.
 * Returns the resolved Models plus any spec strings that failed to resolve
 * (so the caller can surface them to the user). Returns null when the
 * resolved pool is empty — never invent reviewers, never fall back to a
 * "default" model, because doing so silently changes the user's intent.
 */
export async function resolveReviewerPool(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
): Promise<{ resolved: { spec: ModelSpec; model: Model }[]; missing: ModelSpec[] } | null> {
	const available: Model[] = await ctx.modelRegistry.getAvailable();
	const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));

	const resolved: { spec: ModelSpec; model: Model }[] = [];
	const missing: ModelSpec[] = [];
	for (const spec of cfg.reviewers) {
		if (!availableKeys.has(spec)) {
			missing.push(spec);
			continue;
		}
		const model = findModel(ctx, spec)!;
		resolved.push({ spec, model });
	}

	if (resolved.length === 0) return null;
	return { resolved, missing };
}

/**
 * Resolve the configured judge model. Returns null when missing; refrains
 * from falling back to any other model because the user picked that one
 * specifically in the defaults file.
 */
export function resolveJudge(ctx: ExtensionContext, cfg: MultiReviewConfig): Model | null {
	return findModel(ctx, cfg.judge);
}

function describePool(cfg: MultiReviewConfig): string {
	if (cfg.reviewers.length === 0)
		return "no reviewers configured (set multi-review.reviewers in ~/.pi/agent/multi-review.json)";
	const sample = cfg.reviewers.slice(0, 3).join(", ");
	const tail = cfg.reviewers.length > 3 ? `, +${cfg.reviewers.length - 3} more` : "";
	return `pool: ${cfg.reviewers.length} (${sample}${tail})`;
}

function describeResolved(resolved: { spec: ModelSpec }[], missing: ModelSpec[]): string {
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

function setStatus(text: string | undefined, ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, text);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		setStatus(`multi-review · ${describePool(cfg)}`, ctx);
		ctx.ui.notify(`multi-review loaded · ${describePool(cfg)}`, "info");
	});

	pi.registerCommand("multi-review", {
		description:
			"Fan-out code review across configured models. Usage: " +
			"/multi-review [PR-number | free-text focus]. " +
			"Subsequent commits (scope, fan-out, dedupe, judge) wire in the rest.",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const judge = resolveJudge(ctx, cfg);
			setStatus(
				`multi-review · ${cfg.reviewers.length} cfg / ${judge ? "judge=ok" : "judge=MISSING"}`,
				ctx,
			);

			if (cfg.reviewers.length === 0) {
				ctx.ui.notify(
					"multi-review: no reviewers configured.\n\n" +
						`Drop a "$PI_CODING_AGENT_DIR/multi-review.json" like:\n` +
						`  { "reviewers": ["fireworks/.../model-a", "fireworks/.../model-b"], "judge": "fireworks/.../judge" }\n` +
						`Then /reload.\n\nArgs: ${args.trim() || "(none)"}`,
					"warning",
				);
				return;
			}

			const pool = await resolveReviewerPool(ctx, cfg);
			if (!pool) {
				ctx.ui.notify(
					`multi-review: none of the configured reviewers resolved.\n` +
						describeResolved([], cfg.reviewers) +
						`\nArgs: ${args.trim() || "(none)"}`,
					"error",
				);
				return;
			}

			ctx.ui.notify(
				`multi-review (STUB)\n` +
					describeResolved(pool.resolved.map((r) => ({ spec: r.spec })), pool.missing) +
					`\njudge: ${cfg.judge}${judge ? "" : " (MISSING)"}\n\n` +
					`Scope resolution + parallel fan-out land in commit 4+.\n` +
					`Args: ${args.trim() || "(none)"}`,
				pool.missing.length > 0 ? "warning" : "info",
			);
		},
	});
}

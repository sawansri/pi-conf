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
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

function describePool(cfg: MultiReviewConfig): string {
	if (cfg.reviewers.length === 0) return "no reviewers configured (set multi-review.reviewers in ~/.pi/agent/multi-review.json)";
	const sample = cfg.reviewers.slice(0, 3).join(", ");
	const tail = cfg.reviewers.length > 3 ? `, +${cfg.reviewers.length - 3} more` : "";
	return `pool: ${cfg.reviewers.length} (${sample}${tail})`;
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
			"Sets up later commits (model pool, scope, fan-out, dedupe, judge).",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			ctx.ui.notify(
				`multi-review (STUB)\n${describePool(cfg)}\n\n` +
					`Subsequent commits add: scope resolution, parallel fan-out, dedupe, judge.\n` +
					`Args: ${args.trim() || "(none)"}`,
				"info",
			);
		},
	});
}

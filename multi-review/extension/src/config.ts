import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Api, Model as PiModel } from "@mariozechner/pi-ai";
import type { ReviewerRunOptions } from "./reviewers.ts";

export type Model = PiModel<Api>;

/** Provider/model-id pair as written in the defaults file and the picker. */
export type ModelSpec = `${string}/${string}`;

/**
 * Per-reviewer entry parsed out of the raw `provider/id[@level]` form.
 * Storage form in MultiReviewConfig.reviewers stays stringly-typed so JSON
 * keeps bare (`amd-gateway/Grok-4.7`) and suffixed
 * (`amd-gateway/Grok-4.7@xhigh`) forms in the same field. Parsing
 * happens at load + at request time; clamping happens per-model.
 */
export interface ReviewerSpec {
	spec: ModelSpec;
	thinking: ThinkingLevelAlias;
}

export const THINKING_LEVEL_ALIASES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelAlias = (typeof THINKING_LEVEL_ALIASES)[number];

/**
 * Parse a `provider/id[@level]` raw string into a ReviewerSpec. Returns
 * null for malformed entries (no '/' separator). The level suffix is
 * accepted ONLY when it matches a known alias — anything not in the
 * allowlist is treated as part of the spec, so a typo like
 * `amd-gateway/Grok-4.7@HIGH` falls back gracefully instead of crashing.
 */
export function parseReviewerSpec(raw: string, fallbackThinking: ThinkingLevelAlias = "medium"): ReviewerSpec | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const atIdx = trimmed.lastIndexOf("@");
	let specPart: string;
	let thinking: ThinkingLevelAlias;
	if (atIdx > 0 && atIdx < trimmed.length - 1) {
		const maybeLevel = trimmed.slice(atIdx + 1);
		if ((THINKING_LEVEL_ALIASES as readonly string[]).includes(maybeLevel)) {
			specPart = trimmed.slice(0, atIdx);
			thinking = maybeLevel as ThinkingLevelAlias;
		} else {
			specPart = trimmed;
			thinking = fallbackThinking;
		}
	} else {
		specPart = trimmed;
		thinking = fallbackThinking;
	}
	if (!specPart.includes("/")) return null;
	return { spec: specPart as ModelSpec, thinking };
}

export function formatReviewerSpec(rs: ReviewerSpec): string {
	// Collapse the common case (default medium thinking) for legibility.
	if (rs.thinking === "medium") return rs.spec;
	return `${rs.spec}@${rs.thinking}`;
}

/** Per-reviewer input that survives a /reload (saved via pi.appendEntry). */
export interface MultiReviewConfig {
	/**
	 * Reviewer specs as the user wrote them. Each entry is `provider/id` or
	 * `provider/id@level` (e.g. `amd-gateway/gpt-6-astra@xhigh`). Parsing
	 * happens lazily via parseReviewerSpec.
	 */
	reviewers: string[];
	judge: ModelSpec;
	judgeThinking: ThinkingLevelAlias;
	concurrency: number;
	temperature: number;
	/** Run the verification round by default (`--verify` per run). */
	verify: boolean;
	/** Independent verifiers per finding in the verification round. */
	verifiersPerFinding: number;
	/**
	 * Models that never review, only verify: they join the verification
	 * pool (with tools) but skip the fan-out. Unused in `--quick` runs.
	 */
	verifyOnly: string[];
	/** Fast pool for `--quick` runs: single completions, no tools. */
	quickReviewers: string[];
	/** Run finding reviewers as nested agents with read-only repo tools. */
	reviewerTools: boolean;
	/** Per-reviewer wall-clock limit; a reviewer past it is reported as failed. */
	reviewerTimeoutSec: number;
	/**
	 * Let the brief's `checks` and the verifiers' `run` tool execute code in a
	 * nono (Landlock) sandbox: repo read-only, no network. Off, or no working
	 * nono, means neither runs.
	 */
	sandbox: boolean;
	/** Total time for the brief's checks, run once before the fan-out. */
	checkTimeoutSec: number;
	/** $HOME paths (toolchains) readable in the sandbox; the rest of $HOME is not. */
	sandboxHomeDirs: string[];
	/** Add built-in checks for the change's languages (C/C++: mr-cxx-check) when the sandbox works. */
	autoChecks: boolean;
	/**
	 * A reviewer answering [] after fewer tool calls than this (progress
	 * calls excluded) is nudged once to keep looking. 0 disables.
	 */
	minReviewToolCalls: number;
	/** Reviewers and verifiers may search the web (sparingly; see web-search.ts). */
	webSearch: boolean;
	/** Answers web searches for models without native search (an anthropic-messages model). */
	webSearchProxyModel: string;
	/** Model APIs that search natively on this gateway; other models use the proxy. */
	webSearchNativeApis: string[];
	/**
	 * Model (`provider/id[@level]`) that groups findings into issues; defaults
	 * to the judge at low thinking. "lexical" skips the model call.
	 */
	dedupeModel?: string;
}

/**
 * Run-shape switches. `verify` adds a cross-check round; `quick` swaps in
 * the fast reviewer pool without tools. Everything else (who judges) is
 * decided by the surface: the main agent via the tool, or --direct's judge.
 */
export interface ReviewFlags {
	verify: boolean;
	quick: boolean;
}

export function describeFlags(flags: ReviewFlags): string {
	return [flags.quick ? "quick" : "balanced", flags.verify ? "verify" : ""].filter(Boolean).join("+");
}

/**
 * Defaults track the models in ~/.pi/agent/models.json, chosen by an
 * internal benchmark (10 known bugs in a 3.3k-line file, 2 runs each, Opus
 * grading; see README "Model choice"): Sonnet 5.5 had the best recall with
 * zero dubious findings and was the fastest; gpt-6-sol adds the most valid
 * extras per minute; gpt-6-luna is precise (zero dubious) and fast.
 * Gemini 4 Argon was added after the benchmark as a frontier model from a
 * third family (Google), for diversity of blind spots; at @medium, since
 * @high (~350s on a narrow area review) ran past the straggler cutoff. As a
 * reviewer it returned 0 findings on every run (one timed out) while its
 * verifier verdicts cited concrete code, so it now only verifies.
 * gpt-6.1-sol@high replaced gpt-6-sol@xhigh: about as fast (153s vs 125s on
 * a narrow area review) and it caught both models' unique findings; at
 * @xhigh it took 386s. Grok-4.7 and GLM-5.3-Flash were too slow (900s
 * timeouts; GLM@high 777s). DeepSeek V4.1 Flash was tried too: tools and thinking work, but @high
 * was cut as a straggler and @max timed out at 900s. Gemini 3.8 Flash
 * was dropped from the main pool: on this gateway it routinely ran past the
 * straggler cutoff even at @medium, adding delay and no findings. Raising
 * reasoning to max didn't improve any model, so levels stay moderate for
 * responsiveness. Specs that don't resolve are skipped with a notice,
 * never substituted.
 */
export const DEFAULTS: MultiReviewConfig = {
	reviewers: [
		"amd-gateway-anthropic/Claude-Sonnet-5.5@high",
		"amd-gateway/gpt-6.1-sol@high",
		"amd-gateway/gpt-6-luna@high",
	],
	judge: "amd-gateway-anthropic/Claude-Opus-5.5",
	judgeThinking: "high",
	concurrency: 5,
	temperature: 0.2,
	verify: false,
	verifiersPerFinding: 2,
	verifyOnly: ["amd-gateway/gemini-4-argon@medium"],
	quickReviewers: [
		"amd-gateway/gpt-6-luna@low",
		"amd-gateway-anthropic/Claude-Haiku-5.5",
		"amd-gateway/gemini-3.8-flash@low",
	],
	reviewerTools: true,
	reviewerTimeoutSec: 420,
	sandbox: true,
	checkTimeoutSec: 120,
	// Not all of ~/.cargo: it holds credentials.toml.
	sandboxHomeDirs: [".nvm", ".cargo/bin", ".cargo/registry", ".cargo/git", ".rustup", ".pyenv", ".bun", ".deno", ".volta", "go", ".local/bin", ".local/lib"],
	autoChecks: true,
	minReviewToolCalls: 10,
	webSearch: true,
	webSearchProxyModel: "amd-gateway-anthropic/Claude-Haiku-5.5",
	webSearchNativeApis: ["anthropic-messages"],
};

export function reviewerRunOptions(cfg: MultiReviewConfig): ReviewerRunOptions {
	return { useTools: cfg.reviewerTools, timeoutMs: cfg.reviewerTimeoutSec * 1000, sandboxHomeDirs: cfg.sandboxHomeDirs, minToolCalls: cfg.minReviewToolCalls };
}

/**
 * Read $PI_CODING_AGENT_DIR/multi-review.json once and cache. Unknown keys,
 * missing file, or malformed JSON → silent fallback to in-code defaults.
 * This intentionally mirrors the tdd-pipeline-extension convention so
 * users have one mental model across extensions in this repo.
 */
let cachedConfig: MultiReviewConfig | null = null;
export function cacheConfigForFreshRead(): void {
	cachedConfig = null;
}
export function loadConfig(): MultiReviewConfig {
	if (cachedConfig !== null) return cachedConfig;
	cachedConfig = { ...DEFAULTS };
	try {
		const configPath = path.join(getAgentDir(), "multi-review.json");
		if (!fs.existsSync(configPath)) return cachedConfig;
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return cachedConfig;
		if (Array.isArray(parsed.reviewers)) {
			cachedConfig.reviewers = parsed.reviewers.filter(
				(x): x is string => typeof x === "string" && x.includes("/"),
			);
		}
		if (typeof parsed.judge === "string" && parsed.judge.includes("/")) {
			cachedConfig.judge = parsed.judge as ModelSpec;
		}
		const tk: MultiReviewConfig["judgeThinking"] = parsed.judgeThinking;
		if (typeof tk === "string" && (THINKING_LEVEL_ALIASES as readonly string[]).includes(tk)) {
			cachedConfig.judgeThinking = tk;
		}
		if (typeof parsed.concurrency === "number" && parsed.concurrency > 0 && parsed.concurrency <= 16) {
			cachedConfig.concurrency = Math.floor(parsed.concurrency);
		}
		if (typeof parsed.temperature === "number" && parsed.temperature >= 0 && parsed.temperature <= 2) {
			cachedConfig.temperature = parsed.temperature;
		}
		if (typeof parsed.verify === "boolean") cachedConfig.verify = parsed.verify;
		// Legacy: "mode": "council" was the old cross-examination mode.
		if (parsed.mode === "council") cachedConfig.verify = true;
		if (typeof parsed.verifiersPerFinding === "number" && parsed.verifiersPerFinding >= 1 && parsed.verifiersPerFinding <= 8) {
			cachedConfig.verifiersPerFinding = Math.floor(parsed.verifiersPerFinding);
		}
		if (Array.isArray(parsed.verifyOnly)) {
			cachedConfig.verifyOnly = parsed.verifyOnly.filter((x: unknown): x is string => typeof x === "string" && x.includes("/"));
		}
		if (Array.isArray(parsed.quickReviewers)) {
			cachedConfig.quickReviewers = parsed.quickReviewers.filter((x: unknown): x is string => typeof x === "string" && x.includes("/"));
		}
		if (typeof parsed.reviewerTools === "boolean") cachedConfig.reviewerTools = parsed.reviewerTools;
		if (typeof parsed.dedupeModel === "string" && (parsed.dedupeModel === "lexical" || parsed.dedupeModel.includes("/"))) {
			cachedConfig.dedupeModel = parsed.dedupeModel;
		}
		if (typeof parsed.reviewerTimeoutSec === "number" && parsed.reviewerTimeoutSec >= 10 && parsed.reviewerTimeoutSec <= 3600) {
			cachedConfig.reviewerTimeoutSec = Math.floor(parsed.reviewerTimeoutSec);
		}
		if (typeof parsed.sandbox === "boolean") cachedConfig.sandbox = parsed.sandbox;
		if (typeof parsed.autoChecks === "boolean") cachedConfig.autoChecks = parsed.autoChecks;
		if (typeof parsed.webSearch === "boolean") cachedConfig.webSearch = parsed.webSearch;
		if (typeof parsed.webSearchProxyModel === "string" && parsed.webSearchProxyModel.includes("/")) cachedConfig.webSearchProxyModel = parsed.webSearchProxyModel;
		if (Array.isArray(parsed.webSearchNativeApis)) cachedConfig.webSearchNativeApis = parsed.webSearchNativeApis.filter((x: unknown): x is string => typeof x === "string");
		if (typeof parsed.checkTimeoutSec === "number" && parsed.checkTimeoutSec >= 10 && parsed.checkTimeoutSec <= 1800) {
			cachedConfig.checkTimeoutSec = Math.floor(parsed.checkTimeoutSec);
		}
		if (Array.isArray(parsed.sandboxHomeDirs)) {
			cachedConfig.sandboxHomeDirs = parsed.sandboxHomeDirs.filter((x: unknown): x is string => typeof x === "string" && x.length > 0 && !path.isAbsolute(x) && !x.split("/").includes(".."));
		}
		if (typeof parsed.minReviewToolCalls === "number" && parsed.minReviewToolCalls >= 0 && parsed.minReviewToolCalls <= 100) {
			cachedConfig.minReviewToolCalls = Math.floor(parsed.minReviewToolCalls);
		}
	} catch {
		cachedConfig = { ...DEFAULTS };
	}
	return cachedConfig;
}

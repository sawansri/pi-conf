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
	/**
	 * Reviewers (by provider/id) that review twice, the second pass with the
	 * diff's files in reverse order. Runs of one model vary a lot, and
	 * combining them raised F1 by up to 44% on SWR-Bench; agreement between
	 * a model's two passes doesn't count as consensus.
	 */
	secondPass: string[];
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
	/** Default GitHub author filter for PR comments/reviews when none is passed per-run. */
	commentAuthors?: string[];
}

/**
 * Run-shape switches. `verify` adds a cross-check round; `quick` swaps in
 * the fast reviewer pool without tools. Everything else (who judges) is
 * decided by the surface: the main agent via the tool, or --direct's judge.
 */
export interface ReviewFlags {
	verify: boolean;
	quick: boolean;
	authors?: string[];
}

export function describeFlags(flags: ReviewFlags): string {
	return [flags.quick ? "quick" : "balanced", flags.verify ? "verify" : ""].filter(Boolean).join("+");
}

/**
 * Defaults track the models in ~/.pi/agent/models.json, chosen by an
 * internal benchmark (10 known bugs in a 3.3k-line file, 2 runs each, Opus
 * grading; see README "Model choice"): Sonnet 5.5 had the best recall with
 * zero dubious findings and was the fastest; gpt-6-sol adds the most valid
 * extras per minute.
 * Gemini 4 Argon was added after the benchmark as a frontier model from a
 * third family (Google), for diversity of blind spots; at @medium, since
 * @high (~350s on a narrow area review) ran past the straggler cutoff. It
 * spent a while as verify-only after returning 0 findings in two real
 * reviews, but those runs predate minReviewToolCalls: it stopped after 6-11
 * tool calls with `[]`. Retried with the nudge on PR #4041 it took 203s
 * @medium (inside gpt-6.1-sol's 215s, so no added wall time), agreed with
 * the pool on two findings and raised a real one no one else did. @low was
 * no faster (313s, more tool calls), so it reviews at @medium.
 * Kimi K3.1 Pro@high replaced gpt-6-luna@high: over 45 real reviews luna
 * raised half as many findings as gpt-6.1-sol (56 vs 107, 14 vs 34 uniquely
 * confirmed) and failed or timed out in 8; head to head on PR #4041 luna
 * timed out at 344s while Kimi finished first (121s, 3 of 4 findings
 * confirmed, one high-severity bug no other reviewer found) and verified
 * 6/6 in 59s. It is also a third model family next to Claude and GPT.
 * Opus 5.5@high joined the pool as a fifth reviewer so reviews and Socratic
 * discussions also hear from the strongest Claude model, not only from the
 * judge synthesizing everyone else.
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
		"amd-gateway-anthropic/Claude-Opus-5.5@high",
		"amd-gateway-anthropic/Claude-Sonnet-5.5@high",
		"amd-gateway/gpt-6.1-sol@high",
		"amd-gateway/Kimi-K3.1-Pro@high",
		"amd-gateway/gemini-4-argon@medium",
	],
	judge: "amd-gateway-anthropic/Claude-Opus-5.5",
	judgeThinking: "high",
	// The 5 reviewers plus Sonnet's second pass, all at once.
	concurrency: 6,
	temperature: 0.2,
	verify: false,
	verifiersPerFinding: 2,
	verifyOnly: [],
	// Sonnet: the best recall per second in the pool.
	secondPass: ["amd-gateway-anthropic/Claude-Sonnet-5.5"],
	quickReviewers: [
		"amd-gateway/gpt-6-luna@low",
		"amd-gateway-anthropic/Claude-Haiku-5.5",
		"amd-gateway/gemini-3.8-flash@low",
	],
	reviewerTools: true,
	reviewerTimeoutSec: 600,
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
		if (Array.isArray(parsed.secondPass)) {
			cachedConfig.secondPass = parsed.secondPass.filter((x: unknown): x is string => typeof x === "string" && x.includes("/"));
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
		if (Array.isArray(parsed.commentAuthors)) {
			cachedConfig.commentAuthors = parsed.commentAuthors.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0);
		}
	} catch {
		cachedConfig = { ...DEFAULTS };
	}
	return cachedConfig;
}

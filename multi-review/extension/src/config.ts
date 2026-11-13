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
	/**
	 * Independent verifiers per finding in the verification round. 1 is the
	 * default: on a real run where the pool was saturated, the second slot
	 * returned zero verdicts for all 31 groups (both alternate verifiers timed
	 * out), so k=2 cost double and delivered exactly the one verdict k=1 would
	 * have. Raise it when the pool is healthy and false positives are costly.
	 */
	verifiersPerFinding: number;
	/**
	 * Models that never review, only verify: they join the verification
	 * pool (with tools) but skip the fan-out. Unused in `--quick` runs.
	 */
	verifyOnly: string[];
	/**
	 * Preferred verifiers (`provider/id`), in order. They take the verify
	 * round's work, balanced by load; other pool models verify only findings
	 * every preferred model raised itself. Empty balances over the whole pool.
	 * Kimi's verify session cost $1.22 in one run and Sonnet's $0.58, while
	 * gpt-6.1-sol caches its whole prefix and reviews for about $0.10.
	 */
	verifiers: string[];
	/**
	 * Also verify findings two or more distinct models raised independently.
	 * Off: over 5 real runs no such finding was refuted, so its verifier
	 * bought nothing.
	 */
	verifyConsensus: boolean;
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
	 * calls excluded) is nudged once to keep looking. 0 disables. Scaled down
	 * for small diffs (see scaledMinToolCalls): a 20-line change has nothing to
	 * investigate for ten tool calls, and the nudge then costs a whole extra
	 * turn on every reviewer.
	 */
	minReviewToolCalls: number;
	/** Reviewers and verifiers may search the web (sparingly; see web-search.ts). */
	webSearch: boolean;
	/** Answers web searches for models without native search (an anthropic-messages model). */
	webSearchProxyModel: string;
	/** Model APIs that search natively on this gateway; other models use the proxy. */
	webSearchNativeApis: string[];
	/**
	 * Model (`provider/id[@level]`) that groups findings into issues. Defaults
	 * to `dedupeDefaultModel` (a cheap model: clustering is not discovery).
	 * "lexical" skips the model call.
	 */
	dedupeModel?: string;
	/** Who groups findings when `dedupeModel` is unset; null keeps the old behaviour (the judge). */
	dedupeDefaultModel?: string | null;
	/**
	 * Thinking level verifiers run at, overriding their spec's level. Verifying
	 * is confirm/refute against code the reviewer already read; the pool's
	 * benchmark found raising reasoning bought nothing but latency. null keeps
	 * each verifier's own level.
	 */
	verifierThinking?: ThinkingLevelAlias | null;
	/**
	 * Wall-clock limit for one verifier session. Always applied as
	 * `min(this, reviewerTimeoutSec)` and further shrunk by a headless run's
	 * deadline, so raising it above `reviewerTimeoutSec` has no effect.
	 */
	verifierTimeoutSec: number;
	/** Output-token cap for the judge (its synthesis is a few thousand tokens); 0 = pi's default. */
	judgeMaxTokens: number;
	/**
	 * Cap on a single `read`/`grep` result in reviewer/verifier sessions, in
	 * characters. 0 leaves pi's default (2000 lines / 50KB) in place.
	 *
	 * This is the biggest cost lever on a large review. Re-sent history is
	 * cached and free on this gateway, but every tool result enters the context
	 * as FRESH input exactly once and is billed at full price. A real $2.90
	 * run (272 tool calls) spent ~90% of its bill that way, at ~3.5k fresh
	 * tokens per call. Capping read output at 24k chars (~400 lines) cut fresh
	 * input 19% on the benchmark with no loss of findings.
	 */
	readMaxChars: number;
	/**
	 * Per-model overrides for `readMaxChars`, keyed by `provider/id` (the
	 * `@level` suffix is ignored). A model that ranges over the tree and
	 * re-reads files gets a tighter cap than the pool default; a model whose
	 * value is precise slicing gets a looser one. Longest matching key wins,
	 * so `"p/id"` and `"@high"` forms both work.
	 */
	readMaxCharsByModel: Record<string, number>;
	/**
	 * Spend cap for one reviewer or verifier session, in USD at the gateway's
	 * billed rates (cache included); 0 disables it. A session that reaches it
	 * is cut and harvested like one that ran out of time, so its findings are
	 * kept. The time budget alone does not bound spend: the fastest model
	 * makes the most tool calls in it. Kimi K3.1 Pro spent $3.14 on one
	 * review, where Sonnet spent $1.18 on the same change.
	 */
	sessionMaxCostUsd: number;
	/**
	 * Models (`provider/id`) whose reviewer and verifier requests carry a
	 * per-session `prompt_cache_key`, which keeps a session's requests on the
	 * backend that holds its cached prefix. pi sends one only to
	 * api.openai.com. Kimi K3.1 Pro was billed 1.1M fresh input tokens in one
	 * review for a context that ended near 310k.
	 */
	promptCacheKeyModels: string[];
	/**
	 * Send only the hunks a verifier needs (its findings' files' diff, plus
	 * intent and requirements) instead of the whole reviewer brief; falls back
	 * to the full brief when no diff is available.
	 *
	 * Off by default because prompt size is not what costs money here: the
	 * gateway bills cache reads and writes at $0, so the full brief re-sent to
	 * every verifier is nearly free, while a verifier that is missing the diff
	 * runs 1.5-2x more tool calls and those calls' OUTPUT is billed. Measured
	 * +18% on real runs with it on. Turn it on when the brief itself is large
	 * enough to strain a verifier's context window, not to save money.
	 */
	verifyNarrowContext: boolean;
	/**
	 * Run a `secondPass` model only when the diff has at least this many
	 * changed lines. 0 always runs the second pass.
	 */
	secondPassMinLines: number;
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
 * Opus 5.5@high was a fifth reviewer for a while, so reviews and Socratic
 * discussions also heard from the strongest Claude model directly, not only
 * from the judge synthesizing everyone else. It was dropped again: as the
 * judge (and your main model) it writes the synthesis and weighs every
 * finding anyway, so its review pass mostly restated findings the other four
 * already raised, at the cost of the slowest seat in the pool. It still
 * judges, groups and answers web searches.
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
		"amd-gateway/Kimi-K3.1-Pro@high",
		"amd-gateway/gemini-4-argon@medium",
	],
	judge: "amd-gateway-anthropic/Claude-Opus-5.5",
	judgeThinking: "high",
	// The 4 reviewers plus Sonnet's second pass, all at once.
	concurrency: 5,
	temperature: 0.2,
	verify: false,
	verifiersPerFinding: 1,
	verifyOnly: [],
	verifiers: ["amd-gateway/gpt-6.1-sol", "amd-gateway-anthropic/Claude-Sonnet-5.5"],
	verifyConsensus: false,
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
	// Clustering findings is a cheap semantic task, not discovery. Opus is 40x
	// Haiku's input price and the answer is validated into a partition either
	// way, so paying a frontier price here bought nothing.
	dedupeDefaultModel: "amd-gateway-anthropic/Claude-Haiku-5.5",
	// No reviewer leaf in the benchmark table, so verifiers default to the
	// model's own level; set e.g. "low" to cut thinking tokens outright.
	verifierThinking: null,
	verifierTimeoutSec: 180,
	judgeMaxTokens: 8_000,
	readMaxChars: 24_000,
	// Kimi ranges over the tree: 194 tool calls against Sonnet's 64 in one real
	// review, re-reading the same files up to 6 times. Same list price, 8x the
	// bill, so its reads are capped harder than the pool default.
	readMaxCharsByModel: { "amd-gateway/Kimi-K3.1-Pro": 12_000 },
	// Above Sonnet's $1.18 on a large lemonade PR, under half of Kimi's $3.14.
	sessionMaxCostUsd: 1.5,
	// Off until a probe shows the gateway's Kimi backend accepts the key: one
	// that rejects unknown parameters would fail every Kimi session.
	// tests/bench/cache-growth-probe.py measures it.
	promptCacheKeyModels: [],
	verifyNarrowContext: false,
	secondPassMinLines: 0,
};

/**
 * The read cap for one model: its own entry in `readMaxCharsByModel`, else the
 * pool default. Keys are matched after stripping `@level`, so a single entry
 * covers a model whether it reviews, reviews a second pass, or verifies.
 */
export function readMaxCharsFor(cfg: MultiReviewConfig, spec: string): number {
	const bare = spec
		.replace(/\s*\(verify\)$/, "")
		.replace(/\s*#\d+$/, "")
		.replace(/@[a-z]+$/, "");
	const byModel = cfg.readMaxCharsByModel[bare];
	return byModel === undefined ? cfg.readMaxChars : byModel;
}

export function reviewerRunOptions(cfg: MultiReviewConfig, spec?: string): ReviewerRunOptions {
	return {
		useTools: cfg.reviewerTools,
		timeoutMs: cfg.reviewerTimeoutSec * 1000,
		sandboxHomeDirs: cfg.sandboxHomeDirs,
		minToolCalls: cfg.minReviewToolCalls,
		maxCostUsd: cfg.sessionMaxCostUsd,
		promptCacheKeyModels: cfg.promptCacheKeyModels,
		readMaxChars: spec === undefined ? cfg.readMaxChars : readMaxCharsFor(cfg, spec),
	};
}

/**
 * The tool-call floor a run of this size deserves. The floor exists because a
 * reviewer that stops early usually stops looking, not because the change is
 * clean. How much looking a change needs scales with its size, so a one-file
 * 20-line diff gets a floor of 2 rather than 10: past that, the nudge buys an
 * extra turn per reviewer and nothing else.
 *
 * Two guards keep this from doing more than it says. A run with no diff (a
 * file-scope or free-text review) keeps the configured floor: there is no
 * size signal, and those reviews are broad by nature. And the result never
 * exceeds `configured`, so scaling can lower a user's threshold but never
 * raise it.
 */
export function scaledMinToolCalls(configured: number, changedLines: number): number {
	if (configured <= 0) return 0;
	if (changedLines <= 0) return configured;
	const bySize = Math.max(2, Math.ceil(changedLines / 20));
	return Math.min(configured, bySize);
}

/**
 * The model that groups findings: the run's `dedupeModel`, else
 * `dedupeDefaultModel`, else the judge.
 *
 * Returns null for `dedupeModel: "lexical"`, which is a switch, not a model:
 * grouping is then done lexically and callers that need a real model (the
 * PR-comment classifier) must supply one instead of trying to resolve
 * "lexical" as a spec.
 */
export function dedupeTarget(cfg: MultiReviewConfig): string | null {
	if (cfg.dedupeModel === "lexical") return null;
	if (cfg.dedupeModel) return cfg.dedupeModel;
	return cfg.dedupeDefaultModel ?? cfg.judge;
}

/** The model for tasks that need one regardless of how grouping is done. */
export function classifierTarget(cfg: MultiReviewConfig): string {
	return dedupeTarget(cfg) ?? cfg.judge;
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
		if (Array.isArray(parsed.verifiers)) {
			// Bare provider/id: the pool is matched by model, whatever its level.
			cachedConfig.verifiers = parsed.verifiers
				.filter((x: unknown): x is string => typeof x === "string" && x.includes("/"))
				.map((x: string) => x.replace(/@[a-z]+$/, ""));
		}
		if (typeof parsed.verifyConsensus === "boolean") cachedConfig.verifyConsensus = parsed.verifyConsensus;
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
		if (parsed.dedupeDefaultModel === null) cachedConfig.dedupeDefaultModel = null;
		else if (typeof parsed.dedupeDefaultModel === "string" && parsed.dedupeDefaultModel.includes("/")) cachedConfig.dedupeDefaultModel = parsed.dedupeDefaultModel;
		if (parsed.verifierThinking === null) cachedConfig.verifierThinking = null;
		else if (typeof parsed.verifierThinking === "string" && (THINKING_LEVEL_ALIASES as readonly string[]).includes(parsed.verifierThinking)) {
			cachedConfig.verifierThinking = parsed.verifierThinking as ThinkingLevelAlias;
		}
		if (typeof parsed.verifierTimeoutSec === "number" && parsed.verifierTimeoutSec >= 10 && parsed.verifierTimeoutSec <= 3600) {
			cachedConfig.verifierTimeoutSec = Math.floor(parsed.verifierTimeoutSec);
		}
		if (typeof parsed.judgeMaxTokens === "number" && parsed.judgeMaxTokens >= 0 && parsed.judgeMaxTokens <= 200_000) {
			cachedConfig.judgeMaxTokens = Math.floor(parsed.judgeMaxTokens);
		}
		if (typeof parsed.readMaxChars === "number" && parsed.readMaxChars >= 0 && parsed.readMaxChars <= 400_000) {
			cachedConfig.readMaxChars = Math.floor(parsed.readMaxChars);
		}
		if (parsed.readMaxCharsByModel && typeof parsed.readMaxCharsByModel === "object" && !Array.isArray(parsed.readMaxCharsByModel)) {
			const map: Record<string, number> = {};
			for (const [key, value] of Object.entries(parsed.readMaxCharsByModel)) {
				if (typeof key !== "string" || !key.trim()) continue;
				if (typeof value !== "number" || value < 0 || value > 400_000) continue;
				// Keys may be bare (`p/id`) or use one of the names formattedSpec
				// produces (`p/id@high`, `p/id #2`, `p/id (verify)`); normalize to
				// the bare provider/id so one entry covers a model's every run.
				map[key.replace(/\s*#\d+$/, "").replace(/\s*\(verify\)$/, "").replace(/@[a-z]+$/, "").trim()] = Math.floor(value);
			}
			cachedConfig.readMaxCharsByModel = map;
		}
		if (Array.isArray(parsed.promptCacheKeyModels)) {
			cachedConfig.promptCacheKeyModels = parsed.promptCacheKeyModels
				.filter((x: unknown): x is string => typeof x === "string" && x.includes("/"))
				.map((x: string) => x.replace(/@[a-z]+$/, ""));
		}
		if (typeof parsed.sessionMaxCostUsd === "number" && parsed.sessionMaxCostUsd >= 0) {
			cachedConfig.sessionMaxCostUsd = parsed.sessionMaxCostUsd;
		}
		if (typeof parsed.verifyNarrowContext === "boolean") cachedConfig.verifyNarrowContext = parsed.verifyNarrowContext;
		if (typeof parsed.secondPassMinLines === "number" && parsed.secondPassMinLines >= 0) {
			cachedConfig.secondPassMinLines = Math.floor(parsed.secondPassMinLines);
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

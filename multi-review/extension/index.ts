/**
 * Multi-Review — multi-model code review led by the main agent (DESIGN: ../README.md · ../install.md)
 *
 * Surfaces:
 *   /multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number | focus]
 *     → hands off to the main agent (buildHandoffPrompt), which drafts the
 *       reviewer brief and calls the tool; --direct / print / RPC run the
 *       pipeline here with an external judge instead.
 *   multi_review (tool) — brief params (intent, spec_path, requirements,
 *     context_files, focus, scope) + verify/quick; returns findings +
 *     lead-judgment instructions to the agent.
 *
 * Pipeline:
 *   buildReviewTarget (PR / working-tree diff / area) + buildBrief
 *     → runAllReviewers (nested read-only agents or registry calls, per-reviewer timeout)
 *     → groupFindings (semantic clustering, lexical fallback)
 *     → runVerification (--verify: non-raisers confirm/refute each issue)
 *     → agent lead judgment (tool result) | runJudge (direct mode)
 *     → render via the multi-review renderer (tool result or custom message)
 *
 * Persistent defaults: $PI_CODING_AGENT_DIR/multi-review.json loaded once,
 * unknown keys / bad JSON / missing file → silent in-code defaults.
 *
 * Constraint enforced throughout: this extension never writes to
 * ~/.pi/agent/models.json. It only reads ctx.modelRegistry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ExecResult } from "@mariozechner/pi-coding-agent";
import type { Api, Model as PiModel } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, getMarkdownTheme, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

type Model = PiModel<Api>;

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

/**
 * Output of runMultiReviewFromArgs. Tool surface returns it; slash command
 * uses notify unless explicitly told to stay silent (we don't, today).
 */
export interface MultiReviewRunResult {
	kind: "inject" | "notify";
	notifyMessage: string;
	notifyLevel: "info" | "warning" | "error";
	injectMessage?: {
		customType: "multi-review";
		content: string;
		details: MultiReviewDetails;
	};
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
	/** Fast pool for `--quick` runs: single completions, no tools. */
	quickReviewers: string[];
	/** Run finding reviewers as nested agents with read-only repo tools. */
	reviewerTools: boolean;
	/** Per-reviewer wall-clock limit; a reviewer past it is reported as failed. */
	reviewerTimeoutSec: number;
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
 * Gemini 3.8 Flash was dropped: on this gateway it routinely ran past the
 * straggler cutoff even at @medium, adding delay and no findings. Raising
 * reasoning to max didn't improve any model, so levels stay moderate for
 * responsiveness. Specs that don't resolve are skipped with a notice,
 * never substituted.
 */
const DEFAULTS: MultiReviewConfig = {
	reviewers: [
		"amd-gateway-anthropic/Claude-Sonnet-5.5@high",
		"amd-gateway/gpt-6-sol@xhigh",
		"amd-gateway/gpt-6-luna@high",
	],
	judge: "amd-gateway-anthropic/Claude-Opus-5.5",
	judgeThinking: "high",
	concurrency: 5,
	temperature: 0.2,
	verify: false,
	verifiersPerFinding: 2,
	quickReviewers: [
		"amd-gateway/gpt-6-luna@low",
		"amd-gateway-anthropic/Claude-Haiku-5.5",
		"amd-gateway/gemini-3.8-flash@low",
	],
	reviewerTools: true,
	reviewerTimeoutSec: 420,
};

function reviewerRunOptions(cfg: MultiReviewConfig): ReviewerRunOptions {
	return { useTools: cfg.reviewerTools, timeoutMs: cfg.reviewerTimeoutSec * 1000 };
}

/**
 * Pull `--verify` / `--quick` (and legacy `--mode=…`) out of the args.
 * Legacy modes map onto the flags: council → verify, triage → quick,
 * balanced/light → defaults (agent-led balanced subsumes both).
 */
export function parseReviewFlags(rawArgs: string, defaults: ReviewFlags): { flags: ReviewFlags; rest: string } {
	const flags = { ...defaults };
	let rest = rawArgs;
	const verify = parseBoolFlag(rest, "verify");
	rest = verify.rest;
	if (verify.present) flags.verify = true;
	const quick = parseBoolFlag(rest, "quick");
	rest = quick.rest;
	if (quick.present) flags.quick = true;
	const legacy = parseValueFlag(rest, "mode");
	rest = legacy.rest;
	if (legacy.value?.toLowerCase() === "council") flags.verify = true;
	if (legacy.value?.toLowerCase() === "triage") flags.quick = true;
	return { flags, rest };
}

/** Extract a `--name=value` flag (value without spaces) anywhere in the args. */
export function parseValueFlag(rawArgs: string, name: string): { value?: string; rest: string } {
	const re = new RegExp(`(^|\\s)--${name}=(\\S+)(?=\\s|$)`);
	const m = rawArgs.match(re);
	if (!m) return { rest: rawArgs };
	return { value: m[2], rest: rawArgs.replace(re, "$1").replace(/\s+/g, " ").trim() };
}

/** Extract a bare `--name` switch anywhere in the args. */
export function parseBoolFlag(rawArgs: string, name: string): { present: boolean; rest: string } {
	const re = new RegExp(`(^|\\s)--${name}(?=\\s|$)`);
	if (!re.test(rawArgs)) return { present: false, rest: rawArgs };
	return { present: true, rest: rawArgs.replace(re, "$1").replace(/\s+/g, " ").trim() };
}

/** Raw brief fields as they arrive from the tool call (or the --spec flag). */
export interface BriefInput {
	intent?: string;
	requirements?: string[];
	suspicions?: string[];
	specPath?: string;
	contextFiles?: string[];
}

function hasBriefInput(b: BriefInput): boolean {
	return Boolean(b.intent?.trim() || b.specPath || b.requirements?.length || b.contextFiles?.length || b.suspicions?.length);
}


const STATUS_KEY = "multi-review";

/**
 * Read $PI_CODING_AGENT_DIR/multi-review.json once and cache. Unknown keys,
 * missing file, or malformed JSON → silent fallback to in-code defaults.
 * This intentionally mirrors the tdd-pipeline-extension convention so
 * users have one mental model across extensions in this repo.
 */
let cachedConfig: MultiReviewConfig | null = null;
function cacheConfigForFreshRead(): void {
	cachedConfig = null;
}
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

// ---------- progress surface ----------

const PROGRESS_WIDGET_KEY = "multi-review-progress";

type ToolUpdateFn = AgentToolUpdateCallback<any> | undefined;

interface MultiReviewProgressPatch {
	phase: string;
	done?: number;
	total?: number;
	latest?: string;
}

interface MultiReviewProgressReporter {
	update(patch: MultiReviewProgressPatch): void;
	finish(summary: string): void;
	clear(): void;
}

function shortSpec(spec: string): string {
	return spec.split("/").pop() || spec;
}

function formatReviewerProgressLine(done: number, total: number, latest: ReviewerRunResult): string {
	const verdict = latest.ok ? "✓" : "✗";
	const findings = latest.ok ? `${latest.findings.length} finding${latest.findings.length === 1 ? "" : "s"}` : (latest.errorMessage ?? "error");
	const cost = latest.usage?.cost ? `, $${latest.usage.cost.toFixed(4)}` : "";
	const tools = latest.toolCalls ? `, ${latest.toolCalls} tool call${latest.toolCalls === 1 ? "" : "s"}` : "";
	const clamped = latest.clamped ? " [thinking clamped]" : "";
	return `${verdict} ${shortSpec(latest.formattedSpec)}${clamped} (${done}/${total}) — ${findings}, ${(latest.durationMs / 1000).toFixed(1)}s${tools}${cost}`;
}

function createProgressReporter(ctx: ExtensionContext, mode: string, onUpdate?: ToolUpdateFn): MultiReviewProgressReporter {
	const startedAt = Date.now();
	const events: string[] = [];
	let state: Required<Pick<MultiReviewProgressPatch, "phase">> & Omit<MultiReviewProgressPatch, "phase"> = {
		phase: "starting",
	};
	let clearTimer: ReturnType<typeof setTimeout> | undefined;

	function renderLines(theme: { fg: (color: string, text: string) => string }, width: number): string[] {
		const elapsed = `${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s`;
		const progress = state.done !== undefined && state.total !== undefined
			? ` ${state.done}/${state.total}`
			: "";
		const pct = state.done !== undefined && state.total
			? Math.max(0, Math.min(1, state.done / state.total))
			: 0;
		const barWidth = 12;
		const filled = Math.round(pct * barWidth);
		const bar = state.done !== undefined && state.total !== undefined
			? ` ${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`
			: "";
		const lines = [
			truncateToWidth(theme.fg("accent", `multi-review · ${mode}`) + theme.fg("text", ` · ${state.phase}${progress}${bar} · ${elapsed}`), width),
		];
		if (state.latest) lines.push(truncateToWidth(theme.fg("dim", `latest: ${state.latest}`), width));
		for (const ev of events.slice(-3)) lines.push(truncateToWidth(theme.fg("muted", `  ${ev}`), width));
		return lines;
	}

	function publish(): void {
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = undefined;
		}
		const statusLine = `multi-review · mode=${mode} · ${state.phase}${state.done !== undefined && state.total !== undefined ? ` (${state.done}/${state.total})` : ""}`;
		// Print/RPC modes have no widget; this is the only way to watch a run there.
		if (process.env.MULTI_REVIEW_DEBUG) console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${statusLine}${state.latest ? ` · ${state.latest}` : ""}`);
		setStatus(statusLine, ctx);
		if (ctx.hasUI) {
			ctx.ui.setWidget(PROGRESS_WIDGET_KEY, (_tui, theme) => ({
				render: (width: number) => renderLines(theme, width),
				invalidate: () => {},
			}), { placement: "belowEditor" });
		}
		onUpdate?.({
			content: [{ type: "text", text: `multi-review · ${mode} · ${state.phase}${state.done !== undefined && state.total !== undefined ? ` (${state.done}/${state.total})` : ""}${state.latest ? `\n${state.latest}` : ""}` }],
			details: { phase: state.phase, done: state.done, total: state.total, latest: state.latest, mode },
		});
	}

	return {
		update(patch: MultiReviewProgressPatch): void {
			state = { ...state, ...patch };
			if (patch.latest) events.push(patch.latest);
			publish();
		},
		finish(summary: string): void {
			state = { ...state, phase: summary, latest: undefined };
			publish();
			clearTimer = setTimeout(() => this.clear(), 4000);
			clearTimer.unref?.();
		},
		clear(): void {
			if (clearTimer) clearTimeout(clearTimer);
			clearTimer = undefined;
			// Runs from a timer: the session may have been replaced/reloaded or
			// pi may be exiting, and a stale-ctx throw here is uncaught (kills pi).
			try {
				ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
			} catch {
				/* stale ctx — nothing left to clear */
			}
		},
	};
}

// ---------- scope resolution ----------

/**
 * Parsed /multi-review argument. Three shapes:
 *   - `pr`         : /multi-review 4321      → PR #4321
 *   - `pr`         : /multi-review #4321    → same
 *   - `pr`         : /multi-review #4321 https://github.com/owner/repo/pull/4321
 *   - `text`       : /multi-review focus the auth/ subdirectory
 *   - `default`    : bare /multi-review       → whatever the cwd implies
 */
export type ParsedReviewArgs =
	| { kind: "pr"; number: number; raw: string }
	| { kind: "text"; value: string }
	| { kind: "default" };

export function parseReviewArgs(raw: string): ParsedReviewArgs {
	const trimmed = raw.trim();
	if (!trimmed) return { kind: "default" };
	// Pull-style refs like #1234 or gh-style URLs.
	const hashMatch = trimmed.match(/(?:^|\s)#(\d{1,7})\b/);
	if (hashMatch) {
		const number = Number(hashMatch[1]);
		if (Number.isFinite(number) && number > 0) {
			return { kind: "pr", number, raw: trimmed.replace(/(?:^|\s)#\d{1,7}\b/, "").trim() };
		}
	}
	const urlMatch = trimmed.match(/\/pull\/(\d{1,7})(?:$|\D)/);
	if (urlMatch) {
		const number = Number(urlMatch[1]);
		if (Number.isFinite(number) && number > 0) {
			const leftover = trimmed.replace(urlMatch[0], "").trim();
			return { kind: "pr", number, raw: leftover };
		}
	}
	// Plain digits with nothing else (or a branch hint trailing).
	const firstToken = trimmed.split(/\s+/)[0];
	if (/^\d{1,7}$/.test(firstToken)) {
		const leftover = trimmed.slice(firstToken.length).trim();
		return { kind: "pr", number: Number(firstToken), raw: leftover };
	}
	return { kind: "text", value: trimmed };
}

/**
 * The fully-resolved target that reviewers get fed. Built by trying several
 * sources; warnings collect every partial failure so the final notify can
 * surface them and the user knows why their diff looks thin.
 */
export interface ReviewTarget {
	kind: "pr" | "default" | "text";
	label: string;
	focusHint: string;
	files: { path: string; lines: number }[];
	diffText: string;
	metaLines: string[];
	warnings: string[];
	/** Reviewer brief, usually drafted by the main agent. Empty for bare runs. */
	brief?: ReviewBrief;
}

/**
 * What reviewers are told about the change beyond the diff. The main agent
 * drafts this (it has the conversation context the reviewers lack); the
 * spec, when given, is passed through verbatim as the source of truth.
 */
export interface ReviewBrief {
	intent: string;
	requirements: string[];
	/** The lead's own bug hypotheses. Never shown to finding reviewers (anchoring); see SuspicionResult. */
	suspicions: string[];
	spec?: { path: string; text: string };
	contextFiles: { path: string; text: string }[];
}

const SPEC_BUDGET_CHARS = 60_000;
const CONTEXT_FILE_BUDGET_CHARS = 40_000;
const CONTEXT_TOTAL_BUDGET_CHARS = 150_000;
const MAX_CONTEXT_FILES = 12;
const MAX_SUSPICIONS = 20;

function clip(text: string, budget: number, label: string): string {
	if (text.length <= budget) return text;
	return text.slice(0, budget) + `\n…(${label} truncated to ${budget} chars; ${text.length} total)\n`;
}

/**
 * Resolve a spec path relative to cwd and read it. Returns an error string
 * instead of throwing so callers can surface it as a notify.
 */
export function readSpecFile(cwd: string, specPath: string): { path: string; text: string } | { error: string } {
	const abs = path.resolve(cwd, specPath);
	try {
		const text = fs.readFileSync(abs, "utf8");
		if (!text.trim()) return { error: `spec file is empty: ${specPath}` };
		return { path: path.relative(cwd, abs) || specPath, text: clip(text, SPEC_BUDGET_CHARS, "spec") };
	} catch (err) {
		return { error: `cannot read spec ${specPath}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Read the files the brief asks reviewers to see in full; unreadable ones become warnings. */
export function buildBrief(
	cwd: string,
	input: BriefInput,
	warnings: string[],
): ReviewBrief {
	const brief: ReviewBrief = {
		intent: input.intent?.trim() ?? "",
		requirements: (input.requirements ?? []).map((r) => r.trim()).filter(Boolean),
		suspicions: (input.suspicions ?? []).map((r) => r.trim()).filter(Boolean).slice(0, MAX_SUSPICIONS),
		contextFiles: [],
	};
	if (input.specPath) {
		const spec = readSpecFile(cwd, input.specPath);
		if ("error" in spec) warnings.push(spec.error);
		else brief.spec = spec;
	}
	let total = 0;
	for (const rel of (input.contextFiles ?? []).slice(0, MAX_CONTEXT_FILES)) {
		try {
			const text = clip(fs.readFileSync(path.resolve(cwd, rel), "utf8"), CONTEXT_FILE_BUDGET_CHARS, rel);
			if (total + text.length > CONTEXT_TOTAL_BUDGET_CHARS) {
				warnings.push(`context file skipped (total budget): ${rel}`);
				continue;
			}
			total += text.length;
			brief.contextFiles.push({ path: rel, text });
		} catch (err) {
			warnings.push(`context file unreadable: ${rel} (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return brief;
}

async function exec(pi: ExtensionAPI, command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> {
	return pi.exec(command, args, { cwd, timeout: timeoutMs });
}

/**
 * Extract a list of "path  +/-N lines" pairs from a unified diff. Used by
 * buildReviewTarget to give reviewers a heads-up about size without forcing
 * them to re-parse the diff token stream.
 */
function summarizeDiff(diff: string): { files: { path: string; lines: number }[] } {
	const out: { path: string; lines: number }[] = [];
	let current: { path: string; lines: number } | null = null;
	for (const line of diff.split("\n")) {
		const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (m) {
			if (current) out.push(current);
			current = { path: m[2], lines: 0 };
			continue;
		}
		// Approximate changed lines: count + and - prefixes but not --/++ headers.
		if (current && /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) current.lines++;
	}
	if (current) out.push(current);
	return { files: out };
}

/**
 * Resolve a PR target using whatever is locally available:
 *   1. `gh pr view` + `gh pr diff` (preferred; carries metadata)
 *   2. `git fetch origin pull/<n>/head:pr-<n>` + `git diff` (works without gh)
 *   3. Refuse politely if both fail.
 */
async function buildPrTarget(pi: ExtensionAPI, parsed: { number: number; raw: string }, cwd: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "pr",
		label: `PR #${parsed.number}`,
		focusHint: parsed.raw,
		files: [],
		diffText: "",
		metaLines: [],
		warnings: [],
	};

	// Try `gh` first.
	// No `-q`: a jq projection prints raw strings, which JSON.parse can't read.
	const ghView = await exec(pi, "gh", ["pr", "view", String(parsed.number), "--json",
		"title,body,baseRefName,headRefName,url"
	], cwd, 15_000);
	if (ghView.code === 0 && ghView.stdout.trim()) {
		try {
			const view = JSON.parse(ghView.stdout);
			if (view.title) target.metaLines.push(`title: ${view.title}`);
			if (view.url) target.metaLines.push(`url: ${view.url}`);
			if (view.baseRefName && view.headRefName) target.metaLines.push(`base: ${view.baseRefName} ← head: ${view.headRefName}`);
			if (view.body) {
				const body = String(view.body).trim();
				if (body) target.metaLines.push("body:", "", body.split("\n").slice(0, 40).map((l: string) => `  ${l}`).join("\n"));
			}
		} catch {
			target.warnings.push(`gh pr view JSON parse failed: ${ghView.stdout.slice(0, 200)}`);
		}
		const ghDiff = await exec(pi, "gh", ["pr", "diff", String(parsed.number)], cwd, 30_000);
		if (ghDiff.code === 0) {
			target.diffText = ghDiff.stdout;
			const summary = summarizeDiff(ghDiff.stdout);
			target.files = summary.files;
			return target;
		}
		target.warnings.push(`gh pr diff failed (exit ${ghDiff.code}); falling back to git fetch`);
	} else {
		target.warnings.push(`gh pr view failed (exit ${ghView.code}); falling back to git fetch`);
	}

	// Fallback: pull/<N>/head refspec.
	const refName = `pr-${parsed.number}`;
	const fetch = await exec(pi, "git", ["fetch", "--no-tags", "origin", `pull/${parsed.number}/head:${refName}`], cwd, 60_000);
	if (fetch.code !== 0) {
		target.warnings.push(`git fetch origin pull/${parsed.number}/head failed (exit ${fetch.code}, stderr: ${fetch.stderr.slice(0, 200)})`);
		return target;
	}
	// The PR's changes are base...head. Prefer the remote default branch as the
	// base; HEAD is only a last resort (it's whatever the user has checked out).
	let base = "HEAD";
	const originHead = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd, 5_000);
	if (originHead.code === 0 && originHead.stdout.trim()) base = originHead.stdout.trim();
	const diff = await exec(pi, "git", ["diff", `${base}...${refName}`], cwd, 30_000);
	if (diff.code !== 0) {
		target.warnings.push(`git diff ${base}...${refName} failed (exit ${diff.code}, stderr: ${diff.stderr.slice(0, 200)})`);
		return target;
	}
	target.diffText = diff.stdout;
	target.metaLines.push(`(fallback: fetched origin/pull/${parsed.number}/head as ${refName}; diff ${base}...${refName})`);
	target.files = summarizeDiff(diff.stdout).files;
	return target;
}

/**
 * Default target: try several common "diff vs base" strategies in order so
 * bare `/multi-review` does something useful without args in most repos.
 */
async function buildDefaultTarget(pi: ExtensionAPI, cwd: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "default",
		label: "cwd diff vs default base",
		focusHint: "",
		files: [],
		diffText: "",
		metaLines: [],
		warnings: [],
	};

	// Step 1: figure out the current branch + upstream.
	const branch = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, 5_000);
	const upstream = await exec(pi, "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd, 5_000);
	const baseCandidates: string[] = [];
	const defaultBranches = ["main", "master", "develop"];
	const current = branch.stdout.trim();
	const upstreamRef = upstream.code === 0 ? upstream.stdout.trim() : "";
	// A feature branch tracking its own remote copy (origin/feature) is not a
	// base: diffing against it hides everything already pushed. Only trust
	// the upstream for default branches, where it means "not yet pushed".
	const upstreamIsOwnCopy = upstreamRef.split("/").slice(1).join("/") === current && !defaultBranches.includes(current);
	if (upstreamRef && !upstreamIsOwnCopy) baseCandidates.push(upstreamRef);
	for (const candidate of [...defaultBranches, "origin/main", "origin/master"]) {
		if (!baseCandidates.includes(candidate)) baseCandidates.push(candidate);
	}

	for (const base of baseCandidates) {
		const mergeBase = await exec(pi, "git", ["merge-base", base, "HEAD"], cwd, 5_000);
		if (mergeBase.code !== 0 || !mergeBase.stdout.trim()) continue;
		// Diff the working tree (not HEAD) against the merge-base so committed,
		// staged, and unstaged changes are all in scope.
		const diff = await exec(pi, "git", ["diff", mergeBase.stdout.trim()], cwd, 30_000);
		if (diff.code === 0 && diff.stdout.trim()) {
			target.label = `cwd diff vs ${base} (incl. uncommitted)`;
			target.metaLines.push(`branch: ${branch.stdout.trim() || "(unknown)"}`);
			target.metaLines.push(`base: ${base}`);
			target.diffText = diff.stdout;
			target.files = summarizeDiff(diff.stdout).files;
			return target;
		}
	}

	// Step 2: last commit's diff (works in shallow/no-upstream setups).
	// `--stat` alone would replace the patch with a summary; `--patch` keeps both.
	const last = await exec(pi, "git", ["show", "--unified=3", "--stat", "--patch", "HEAD"], cwd, 15_000);
	if (last.code === 0 && last.stdout.trim()) {
		target.label = "last commit (HEAD)";
		target.metaLines.push(`branch: ${branch.stdout.trim() || "(unknown)"}`);
		target.metaLines.push("(no upstream diff found; using last commit)");
		target.diffText = last.stdout;
		target.files = summarizeDiff(last.stdout).files;
		return target;
	}

	target.warnings.push("Not a git repo, or no diffs available; reviewers will only see focus text + a directory listing.");
	return target;
}

/**
 * Free-text focus: no diff. We list source files in cwd so reviewers at
 * least have a directory map when the user-supplied hint references places.
 */
async function buildTextTarget(pi: ExtensionAPI, cwd: string, hint: string): Promise<ReviewTarget> {
	const target: ReviewTarget = {
		kind: "text",
		label: `free-text: ${hint.slice(0, 60)}${hint.length > 60 ? "…" : ""}`,
		focusHint: hint,
		files: [],
		diffText: "",
		metaLines: ["no diff available — reviewers receive your hint plus a directory listing"],
		warnings: [],
	};

	const result = await discoverSourceFiles(pi, cwd);
	if (result.files.length > 0) {
		const capped = result.files.slice(0, 200);
		target.files = capped.map((path) => ({ path, lines: 0 }));
		target.metaLines.push(
			`directory listing: ${result.files.length} file${result.files.length === 1 ? "" : "s"} ` +
				`(strategy: ${result.strategy}${result.files.length > 200 ? ", capped at 200" : ""})`,
		);
	} else {
		target.warnings.push(
			result.error
				? `directory scan failed (${result.error}); reviewers will only see your text hint`
				: `directory scan found no files; reviewers will only see your text hint`,
		);
	}
	return target;
}

export async function buildReviewTarget(pi: ExtensionAPI, parsed: ParsedReviewArgs, cwd: string): Promise<ReviewTarget> {
	if (parsed.kind === "pr") return buildPrTarget(pi, parsed, cwd);
	if (parsed.kind === "default") return buildDefaultTarget(pi, cwd);
	return buildTextTarget(pi, cwd, parsed.value);
}

// ---------- gitignore-aware directory scan ----------

interface GitignorePattern {
	/** True if pattern starts with '/' — anchored to the .gitignore file's directory. */
	anchored: boolean;
	/** True if pattern ends with '/' — only matches directories. */
	dirOnly: boolean;
	/** True if pattern starts with '!'. */
	negated: boolean;
	/** The pattern body to test (anchored and dirOnly stripped). */
	pattern: string;
}

interface DiscoverResult {
	files: string[];
	strategy: "git-ls-files" | "gitignore-walk";
	truncated: boolean;
	error?: string;
}

/**
 * Parse one .gitignore file's content into a list of pattern descriptors.
 * Lines starting with `#` (with optional leading whitespace) are comments;
 * empty lines are skipped. We keep the pattern body verbatim — glob-to-regex
 * conversion happens at match time so we don't bake invalid assumptions
 * about separators into the AST.
 */
function parseGitignore(content: string): GitignorePattern[] {
	const out: GitignorePattern[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const hashIdx = rawLine.indexOf("#");
		const line = (hashIdx >= 0 ? rawLine.slice(0, hashIdx) : rawLine).trim();
		if (!line) continue;
		let working = line;
		let negated = false;
		if (working.startsWith("!")) {
			negated = true;
			working = working.slice(1);
		}
		// Escape leading '\' (rare; we only handle the simple case).
		if (working.startsWith("\\")) working = working.slice(1);
		const anchored = working.startsWith("/");
		if (anchored) working = working.slice(1);
		const dirOnly = working.endsWith("/");
		if (dirOnly) working = working.slice(0, -1);
		out.push({ anchored, dirOnly, negated, pattern: working });
	}
	return out;
}

/**
 * Adapt a parsed gitignore pattern into the string we feed to the regex
 * compiler. Unanchored patterns with no internal '/' behave like
 * a globstar-prefix form (match at any depth); anchored patterns stay as-is.
 */
function patternSemanticsFor(p: GitignorePattern): { candidate: string; anchored: boolean } {
	let body = p.pattern;
	const anchored = p.anchored;
	if (!anchored && !body.includes("/")) {
		body = `**/${body}`;
	}
	return { candidate: body, anchored };
}

/**
 * Compile a single gitignore pattern body into a RegExp.
 *
 * Supports:
 *   `*`   any chars except '/'
 *   `?`   any single char except '/'
 *   `[abc]` character class (uses JS regex semantics, including ranges)
 *   `**`  any chars including '/' (only meaningful when paired with `/`,
 *         either as a globstar prefix or suffix)
 *
 * Limitations (documented):
 * - No alternation `{a,b}` and no extglob `+(a|b)`.
 * - Trailing `/` on the candidate path is appended to also handle the
 *   directory case from a parent gitignore when evaluating the child.
 */
function gitignorePatternToRegex(glob: string, anchored: boolean): RegExp {
	let out = "^";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const before = i > 0 ? glob[i - 1] : "";
				const after = glob[i + 2];
				if (after === "/") {
					// `**/x` — any depth; treat `**/` as zero or more dirs.
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				if (i > 0 && before === "/" && (i + 2 === glob.length)) {
					// `x/**` — anything after x. The next iteration's chars
					// are appended after `.*` for the trailing '/' design.
					out += ".*";
					i += 2;
					continue;
				}
				out += "[^/]*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i += 1;
			continue;
		}
		if (/[.+^$(){}|\\\[\]]/.test(ch)) {
			out += "\\" + ch;
			i += 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	if (anchored) {
		out += "(?:/.*)?$";
	} else {
		out += "$";
	}
	return new RegExp(out);
}

/**
 * Walk a .gitignore stack to decide whether `relPath` is ignored. Last
 * match wins within a single .gitignore; we accumulate across ancestry.
 * For each ancestor .gitignore, candidate path is re-expressed relative
 * to that ancestor's directory before pattern matching.
 */
function pathIsIgnoredByStack(
	relPath: string,
	isDir: boolean,
	gitignores: Array<{ dir: string; patterns: GitignorePattern[] }>,
): boolean {
	let result = false;
	const sorted = [...gitignores].sort((a, b) => a.dir.length - b.dir.length);
	for (const gi of sorted) {
		const dirRel = gi.dir;
		// The gitignore applies to files at-or-below dirRel.
		if (dirRel !== "" && !relPath.startsWith(dirRel + "/")) continue;
		const within = dirRel === "" ? relPath : relPath.slice(dirRel.length + 1);
		for (const p of gi.patterns) {
			if (p.dirOnly && !isDir) continue;
			const sem = patternSemanticsFor(p);
			const re = gitignorePatternToRegex(sem.candidate, sem.anchored);
			if (re.test(within) || re.test(within + "/")) {
				result = p.negated ? false : true;
			}
		}
	}
	return result;
}

/**
 * Iterative DFS through `root` collecting files (paths relative to root)
 * and every .gitignore it finds along with the relative directory each
 * applies to. Hard-excludes the usual heavy directories irrespective of
 * gitignore (so a project missing `.gitignore` still gets a sensible
 * listing).
 *
 * Symlinks are listed but never followed (no recursion into loops).
 */
async function walkAndCollectGitignores(
	root: string,
): Promise<{ files: string[]; gitignores: Array<{ dir: string; patterns: GitignorePattern[] }>; error?: string }> {
	const files: string[] = [];
	const gitignores: Array<{ dir: string; patterns: GitignorePattern[] }> = [];

	const HARD_EXCLUDE_DIRS = new Set([
		".git", "node_modules", "dist", "build", ".next", "target",
		".cache", ".turbo", "coverage", ".venv", "__pycache__",
	]);
	const MAX_DEPTH = 12;
	const MAX_ENTRIES = 200_000;

	type Stack = { abs: string; relDir: string; depth: number };
	const stack: Stack[] = [{ abs: root, relDir: "", depth: 0 }];
	let entries = 0;

	try {
		while (stack.length > 0) {
			if (entries++ > MAX_ENTRIES) {
				return { files, gitignores, error: "max-entry-walk-cap-exceeded" };
			}
			const node = stack.pop()!;
			if (node.depth > MAX_DEPTH) continue;
			let listing: fs.Dirent[];
			try {
				listing = fs.readdirSync(node.abs, { withFileTypes: true });
			} catch {
				continue;
			}
			listing.sort((a, b) => a.name.localeCompare(b.name));
			for (const dirent of listing) {
				const childAbs = path.join(node.abs, dirent.name);
				const childRel = node.relDir === "" ? dirent.name : `${node.relDir}/${dirent.name}`;
				if (dirent.isDirectory()) {
					if (HARD_EXCLUDE_DIRS.has(dirent.name)) continue;
					stack.push({ abs: childAbs, relDir: childRel, depth: node.depth + 1 });
				} else if (dirent.isFile() || dirent.isSymbolicLink()) {
					files.push(childRel);
					if (dirent.name === ".gitignore") {
						try {
							const content = fs.readFileSync(childAbs, "utf8");
							gitignores.push({ dir: node.relDir, patterns: parseGitignore(content) });
						} catch {
							/* malformed file — skip silently */
						}
					}
				}
			}
		}
	} catch (err) {
		return {
			files,
			gitignores,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	return { files, gitignores };
}

/**
 * Public entry point. Tries `git ls-files --cached --others
 * --exclude-standard` first (handles gitignore natively for git repos).
 * If git isn't available, the cwd isn't a repo, or the result is empty,
 * falls back to a managed walker that respects .gitignore explicitly.
 *
 * The result excludes .gitignore itself, configs in .gitignore'd dirs,
 * and binary/lockfile outputs. Intended use is "what range of files
 * should reviewers see when given a free-text focus hint".
 */
async function discoverSourceFiles(pi: ExtensionAPI, cwd: string): Promise<DiscoverResult> {
	// Strategy 1: git ls-files. Single call covers tracked + untracked-non-ignored.
	const lsFiles = await exec(
		pi,
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		cwd,
		20_000,
	);
	if (lsFiles.code === 0) {
		const files = lsFiles.stdout
			.split("\0")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		if (files.length > 0) {
			return { files, strategy: "git-ls-files", truncated: false };
		}
	}

	// Strategy 2: filesystem walk + gitignore parser.
	const walked = await walkAndCollectGitignores(cwd);
	if (walked.error) {
		return { files: [], strategy: "gitignore-walk", truncated: false, error: walked.error };
	}
	const filtered: string[] = [];
	for (const file of walked.files) {
		const fileDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
		const stack: Array<{ dir: string; patterns: GitignorePattern[] }> = [];
		for (const gi of walked.gitignores) {
			if (gi.dir === fileDir || (gi.dir !== "" && fileDir.startsWith(gi.dir + "/"))) {
				stack.push(gi);
			}
		}
		if (!pathIsIgnoredByStack(file, false, stack)) filtered.push(file);
	}
	return { files: filtered, strategy: "gitignore-walk", truncated: false };
}

// ---------- parallel fan-out ----------

/**
 * One finding produced by a single reviewer. The fields are deliberately
 * permissive (line_start/line_end are nullable when the model picks a wider
 * area than a single hunk) so a future free-form finding doesn't blow up
 * the parser. Categories are free-form short labels (correctness / security /
 * perf / style / docs / api-design) so the dedupe pass can group without
 * caring about taxonomy.
 */
export interface ReviewerFinding {
	file: string;
	line_start: number | null;
	line_end: number | null;
	severity: "critical" | "high" | "medium" | "low" | "info" | "none";
	category: string;
	title: string;
	comment: string;
	/** Title + core comment (no evidence/suggestion), used for dedupe matching. */
	match_text?: string;
}

export interface ReviewerRunResult {
	/** The spec as the user wrote it — with the @level suffix when present. */
	formattedSpec: string;
	spec: ModelSpec;
	thinking: ThinkingLevelAlias;
	/** True when Model.thinkingLevelMap clamped the requested level to a softer value. */
	clamped: boolean;
	model: Model;
	ok: boolean;
	findings: ReviewerFinding[];
	rawText: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	toolCalls?: number;
	durationMs: number;
}

const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code reviewer. Find real problems in the change: bugs, security holes, design flaws, maintainability risks, and — when a spec is provided — places where the implementation does not meet it. You are not here to be encouraging. Do not praise the code or restate what it does.

You may be given an intent statement and a spec. Assume the goal is correct and challenge the execution: does the code actually achieve it?

Evidence rules:
- Reference specific code. "This could be null" is only a finding if you show the path that makes it null.
- For security findings, trace the input from its source to the dangerous sink.
- Distinguish "this is broken" from "I would have done it differently". The second is not a finding unless you show a concrete problem.
- Don't inflate nits to fill the review. An empty review is a valid outcome.

Output ONLY a JSON array:
[
  {
    "file": "relative/path/from/repo/root",
    "line_start": <int|null>,
    "line_end": <int|null>,
    "severity": "critical"|"high"|"medium"|"low"|"info",
    "category": "correctness"|"security"|"spec"|"design"|"perf"|"tests"|"<short label>",
    "title": "<≤80 chars>",
    "comment": "<what is wrong, ≤400 chars>",
    "evidence": "<the execution path / spec clause / lines that prove it, ≤400 chars>",
    "suggestion": "<optional concrete fix, ≤200 chars>"
  }
]

Rules:
- If you find nothing wrong, output []. Nothing else counts as "no findings".
- One finding per concrete issue.
- line_start/line_end are post-change line numbers in the new file. Use null for file-level findings.
- category "spec": a requirement that is missing, partially implemented, or contradicted. Quote the requirement in evidence.
- Severity: critical (security hole, data loss, spec requirement fundamentally unmet), high (correctness bug, race, broken edge case), medium (perf cliff, fragile design that will bite soon), low (minor correctness/maintainability), info (style, docs).`;

/** Appended when the reviewer runs as a nested agent with read-only tools. */
const REVIEWER_TOOLS_ADDENDUM = `

You have read-only tools (read, grep, find, ls) on the repository. Use them to trace callers, types, and tests before asserting a finding — a diff alone hides most cross-file bugs. Stay focused: investigate what the change touches, not the whole repo. Your FINAL message must be only the JSON array.`;

/**
 * Build the reviewer-side user prompt from a target. We truncate the diff
 * conservatively because some reviewers have short context managers — the
 * prompt keeps the head of the diff where hunk headers live and ditches the
 * rest after a generous budget. Reviewers with larger windows still see the
 * full diff.
 */
const DIFF_BUDGET_CHARS = 200_000; // ~50k tokens worst case
function budgetDiff(diffText: string): string {
	if (diffText.length <= DIFF_BUDGET_CHARS) return diffText;
	return diffText.slice(0, DIFF_BUDGET_CHARS) +
		`\n…(diff truncated to ${DIFF_BUDGET_CHARS} chars; ${diffText.length} total)\n`;
}

function buildReviewUserPrompt(target: ReviewTarget): string {
	const chunks: string[] = [];
	const brief = target.brief;
	if (brief?.intent) {
		chunks.push("## Intent (from the author)");
		chunks.push(brief.intent);
		chunks.push("");
	}
	if (brief?.spec) {
		chunks.push(`## Spec — source of truth (${brief.spec.path})`);
		chunks.push(brief.spec.text);
		chunks.push("");
	}
	if (brief && brief.requirements.length > 0) {
		chunks.push("## Requirements to verify");
		chunks.push("Check each one against the implementation; report unmet or contradicted ones as category \"spec\".");
		brief.requirements.forEach((r, i) => chunks.push(`${i + 1}. ${r}`));
		chunks.push("");
	}
	if (target.metaLines.length > 0) {
		chunks.push("## Context");
		chunks.push(...target.metaLines);
		chunks.push("");
	}
	if (target.diffText) {
		chunks.push("## Diff");
		chunks.push(budgetDiff(target.diffText));
		chunks.push("");
	} else if (target.files.length > 0) {
		chunks.push("## Files in scope (no diff; review at the file level)");
		for (const f of target.files) chunks.push(`- ${f.path}`);
		chunks.push("");
	}
	if (brief && brief.contextFiles.length > 0) {
		chunks.push("## Related files (full contents)");
		for (const f of brief.contextFiles) {
			chunks.push(`### ${f.path}`);
			chunks.push("```");
			chunks.push(f.text);
			chunks.push("```");
		}
		chunks.push("");
	}
	if (target.focusHint) {
		chunks.push("## Focus");
		chunks.push(target.focusHint);
		chunks.push("");
	}
	chunks.push("Reminder: output ONLY the JSON array per the schema in the system prompt.");
	return chunks.join("\n");
}

/**
 * Strip a JSON-array-shaped response from any junk the model wraps around it.
 * Some models — especially Fireworks-hosted ones — sometimes honor the
 * 'ONLY JSON' rule by wrapping in a ```json fence. This is tolerant of both.
 */
/**
 * JSON.parse, retrying once on a repaired copy. Review comments quote code,
 * so models routinely emit raw backslashes (`\d`), raw newlines, and bare
 * quotes (`uses "-q"`) inside JSON strings — one bad character shouldn't
 * discard a reviewer's whole output.
 */
export function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		const repaired = repairJsonText(text);
		if (repaired === text) throw err;
		return JSON.parse(repaired);
	}
}

/**
 * String-aware repair scan. Inside strings: escape raw control characters,
 * double backslashes that don't start a valid escape, and escape a quote
 * unless the next non-space character could legally follow a string
 * (`,` `}` `]` `:`), which marks it as the real closing quote.
 */
export function repairJsonText(text: string): string {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (!inString) {
			if (ch === '"') inString = true;
			out += ch;
			continue;
		}
		if (ch === "\\") {
			const next = text[i + 1] ?? "";
			if (/["\\/bfnrt]/.test(next)) {
				out += ch + next;
				i++;
			} else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
				out += text.slice(i, i + 6);
				i += 5;
			} else {
				out += "\\\\";
			}
			continue;
		}
		if (ch === '"') {
			const rest = text.slice(i + 1).match(/^\s*(.)/);
			if (!rest || /[,}\]:]/.test(rest[1])) {
				inString = false;
				out += ch;
			} else {
				out += '\\"';
			}
			continue;
		}
		if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else out += ch;
	}
	return out;
}

/** First non-empty string among `keys` (trimmed), or "". */
function pickText(obj: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/** Map schema and common off-schema severity words onto the ladder; unknown → info. */
function normalizeSeverity(raw: string): ReviewerFinding["severity"] {
	const v = raw.toLowerCase().trim();
	if (["critical", "high", "medium", "low", "info", "none"].includes(v)) return v as ReviewerFinding["severity"];
	if (["blocker", "severe", "fatal"].includes(v)) return "critical";
	if (["error", "major", "bug"].includes(v)) return "high";
	if (["warning", "warn", "moderate"].includes(v)) return "medium";
	if (["minor", "nit", "nitpick", "suggestion", "style"].includes(v)) return v === "minor" ? "low" : "info";
	return "info";
}

export function parseReviewerJson(rawText: string): ReviewerFinding[] {
	const text = rawText.trim();
	// Strip leading/trailing fences if present.
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	const inner = fenceMatch ? fenceMatch[1] : text;
	// Find first '[' and last ']' to ignore any wrapper text. A reply with no
	// array at all is a protocol failure, not "no findings" — only an explicit
	// [] means clean.
	const start = inner.indexOf("[");
	const end = inner.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`no JSON array in reply: ${JSON.stringify(text.slice(0, 120))}`);
	}
	let parsed = parseJsonLenient(inner.slice(start, end + 1)) as any;
	// Tolerate {"findings": [...]} wrappers some models emit despite the schema.
	if (!Array.isArray(parsed) && Array.isArray(parsed?.findings)) parsed = parsed.findings;
	if (!Array.isArray(parsed)) throw new Error("reply JSON is not an array");
	const findings: ReviewerFinding[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const f = item as Partial<ReviewerFinding>;
		const rec = item as Record<string, unknown>;
		const num = (...keys: string[]): number | null => {
			for (const k of keys) {
				const v = typeof rec[k] === "string" ? Number(rec[k]) : rec[k];
				if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
			}
			return null;
		};
		const lineStart = num("line_start", "start_line", "line");
		const lineEnd = num("line_end", "end_line") ?? lineStart;
		const severity = normalizeSeverity(pickText(rec, ["severity", "level", "priority"]));
		const category = String(f.category ?? "general").slice(0, 32).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "general";
		const raw = item as Record<string, unknown>;
		// Models drift from the schema's field names; accept the common synonyms
		// so a finding never arrives as an empty "(untitled)" shell.
		const core = pickText(raw, ["comment", "description", "issue", "problem", "message", "details", "explanation"]);
		const title = (pickText(raw, ["title", "summary", "name", "headline"]) || core.slice(0, 80) || "(untitled)").slice(0, 200);
		const evidenceText = pickText(raw, ["evidence", "reasoning", "justification", "trace", "proof"]);
		const suggestionText = pickText(raw, ["suggestion", "fix", "recommendation", "remediation"]);
		const evidence = evidenceText ? `\nEvidence: ${evidenceText}` : "";
		const suggestion = suggestionText ? `\nSuggestion: ${suggestionText}` : "";
		const comment = (core + evidence + suggestion).slice(0, 2400);
		const filePath = pickText(raw, ["file", "path", "filename", "file_path"]);
		if (!filePath) continue;
		findings.push({
			file: filePath, line_start: lineStart, line_end: lineEnd, severity, category, title, comment,
			match_text: `${title} ${core}`,
		});
	}
	// Entries existed but none was usable: a protocol failure, not a clean review.
	if (parsed.length > 0 && findings.length === 0) {
		throw new Error(`${parsed.length} finding(s) in reply but none had a file: ${JSON.stringify(JSON.stringify(parsed[0]).slice(0, 120))}`);
	}
	return findings;
}

interface ModelCallResult {
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

async function callModel(
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

/**
 * Run a reviewer as a nested pi agent with read-only tools so it can follow
 * callers, types, and tests instead of guessing from the diff. The child
 * session loads no extensions/skills/context files (no recursion into
 * multi-review, no project prompt drift) and lives in memory only.
 */
async function runAgenticReviewer(
	ctx: ExtensionContext,
	model: Model,
	thinking: ThinkingLevelAlias,
	systemPrompt: string,
	userPrompt: string,
	signal: AbortSignal,
): Promise<ModelCallResult> {
	const started = Date.now();
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model,
		thinkingLevel: thinking,
		tools: ["read", "grep", "find", "ls"],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(ctx.cwd),
	});
	const onAbort = () => void session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		if (signal.aborted) throw new Error("aborted before start");
		const aborted = new Error("aborted");
		const prompt = (text: string) => abortable(session.prompt(text), signal, () => { throw aborted; });
		await prompt(userPrompt);
		// Agent turns sometimes end on a tool result or thinking with no final
		// answer; one in-session nudge recovers it with the context intact.
		if (!signal.aborted && !(session.getLastAssistantText() ?? "").includes("[")) {
			await prompt("Your final message must be ONLY the JSON array described in the system prompt. Output it now.");
		}
		const stats = session.getSessionStats();
		const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		const stopReason = last?.stopReason ?? "stop";
		let errorMessage: string | undefined;
		if (signal.aborted) errorMessage = `aborted: ${String(signal.reason ?? "cancelled")}`;
		else if (stopReason === "error" || stopReason === "aborted") errorMessage = `${stopReason}: ${last?.errorMessage ?? "(no message)"}`;
		return {
			text: session.getLastAssistantText() ?? "",
			stopReason,
			errorMessage,
			usage: { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total, cost: stats.cost },
			toolCalls: stats.toolCalls,
			durationMs: Date.now() - started,
		};
	} catch (err) {
		return {
			text: "",
			stopReason: "error",
			errorMessage: signal.aborted ? `aborted: ${String(signal.reason ?? "cancelled")}` : (err instanceof Error ? err.message : String(err)),
			durationMs: Date.now() - started,
		};
	} finally {
		signal.removeEventListener("abort", onAbort);
		session.dispose();
	}
}

const JSON_REPAIR_PROMPT = `The text below should contain a JSON array of code-review findings but fails to parse. Output ONLY the corrected JSON array with the same findings and wording — escape quotes, backslashes, and newlines inside strings. Do not add, drop, or change findings.`;

/**
 * Settle with `onAbort()` as soon as `signal` fires, even if `promise` never
 * does. Provider streams don't always honour abort (hung on-prem endpoints
 * ran for 45+ minutes past their abort in testing), and a timeout that
 * doesn't actually return is not a timeout.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => T): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		// onAbort may throw; route that into the promise, never into the event dispatcher.
		const settle = () => {
			try {
				resolve(onAbort());
			} catch (e) {
				reject(e);
			}
		};
		if (signal.aborted) return settle();
		const listener = settle;
		signal.addEventListener("abort", listener, { once: true });
		promise.then(
			(v) => { signal.removeEventListener("abort", listener); resolve(v); },
			(e) => { signal.removeEventListener("abort", listener); reject(e); },
		);
	});
}

/** Caller's signal plus a per-reviewer deadline, so one hung model can't stall the run. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface ReviewerRunOptions {
	/** Nested agent with read-only repo tools instead of a single completion. */
	useTools: boolean;
	timeoutMs: number;
}

async function runReviewer(
	model: Model,
	reviewerSpec: ReviewerSpec,
	ctx: ExtensionContext,
	systemPrompt: string,
	userPrompt: string,
	temperature: number,
	abortSignal: AbortSignal | undefined,
	runOpts: ReviewerRunOptions,
	parse: (text: string) => ReviewerFinding[] = parseReviewerJson,
): Promise<Omit<ReviewerRunResult, "formattedSpec" | "spec" | "thinking" | "clamped">> {
	const signal = withTimeout(abortSignal, runOpts.timeoutMs);
	const call = runOpts.useTools
		? await runAgenticReviewer(ctx, model, reviewerSpec.thinking, systemPrompt + REVIEWER_TOOLS_ADDENDUM, userPrompt, signal)
		: await callModel(ctx, model, systemPrompt, userPrompt, {
			thinking: reviewerSpec.thinking,
			temperature,
			signal,
		});
	if (call.errorMessage && signal.aborted && !abortSignal?.aborted) {
		call.errorMessage = `timed out after ${Math.round(runOpts.timeoutMs / 1000)}s`;
	}
	if (process.env.MULTI_REVIEW_DEBUG === "2") console.error(`[raw ${formatReviewerSpec(reviewerSpec)}] ${call.text.slice(0, 4000)}`);
	let findings: ReviewerFinding[] = [];
	let errorMessage = call.errorMessage;
	if (!errorMessage) {
		try {
			findings = parse(call.text);
		} catch (err) {
			const first = err instanceof Error ? err.message : String(err);
			// Minutes of review shouldn't be lost to one malformed character the
			// repair scan couldn't fix: ask the same model to re-emit valid JSON.
			const fixed = call.text.includes("[") && !signal.aborted
				? await callModel(ctx, model, JSON_REPAIR_PROMPT, `Parse error: ${first}\n\n${call.text}`, {
					thinking: "low",
					temperature: 0,
					signal,
				})
				: undefined;
			try {
				if (!fixed || fixed.errorMessage) throw err;
				findings = parse(fixed.text);
			} catch {
				const truncated = call.stopReason === "length" ? " (output truncated at maxTokens)" : "";
				errorMessage = `json-parse${truncated}: ${first}`;
			}
		}
	}
	return {
		model,
		ok: errorMessage === undefined,
		findings,
		rawText: call.text,
		stopReason: call.stopReason,
		errorMessage,
		usage: call.usage,
		toolCalls: call.toolCalls,
		durationMs: call.durationMs,
	};
}

const MAX_PARALLEL = 16;

/** Workers bail early on abort, leaving holes in result arrays; never let those flow downstream. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("multi-review aborted");
}

/**
 * When no reviewer produced usable output, the run has no signal at all —
 * report the failures instead of publishing an empty "clean" review.
 */
function allReviewersFailedResult(runs: ReviewerRunResult[], mode: string): MultiReviewRunResult | null {
	if (runs.length === 0 || runs.some((r) => r.ok)) return null;
	return {
		kind: "notify",
		notifyMessage:
			`multi-review · mode=${mode} · all ${runs.length} reviewers failed — no review produced:\n` +
			runs.map((r) => `  ✗ ${r.formattedSpec}: ${r.errorMessage?.slice(0, 200) ?? "unknown error"}`).join("\n"),
		notifyLevel: "error",
	};
}

/**
 * Run every reviewer model against the same prompt with a concurrency cap.
 * Use fail-soft: a single model crashing or producing unparseable JSON
 * never aborts the rest of the fan-out. The Promise.all over per-slot promise
 * arrays gives us the cap without a custom queue.
 */
async function runAllReviewers(
	resolved: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	systemPrompt: string,
	userPrompt: string,
	concurrency: number,
	temperature: number,
	abortSignal: AbortSignal | undefined,
	ctx: ExtensionContext,
	runOpts: ReviewerRunOptions,
	onProgress?: (done: number, total: number, latest: ReviewerRunResult) => void,
): Promise<ReviewerRunResult[]> {
	const cap = Math.max(1, Math.min(MAX_PARALLEL, concurrency, resolved.length));
	const results: ReviewerRunResult[] = [];
	let cursor = 0;
	let done = 0;
	const total = resolved.length;

	// Straggler cutoff: once a quorum has answered, the rest get half as long
	// again as the quorum took (min STRAGGLER_MIN_GRACE_MS). A degraded endpoint
	// otherwise holds the whole review hostage until its full timeout.
	const started = Date.now();
	const quorum = stragglerQuorum(total);
	const straggler = new AbortController();
	const reviewerSignal = abortSignal ? AbortSignal.any([abortSignal, straggler.signal]) : straggler.signal;
	let okCount = 0;
	let stragglerTimer: ReturnType<typeof setTimeout> | undefined;
	const noteFinished = (ok: boolean) => {
		if (ok) okCount++;
		if (stragglerTimer || okCount < quorum || done >= total) return;
		const quorumMs = Date.now() - started;
		const graceMs = Math.max(STRAGGLER_MIN_GRACE_MS, quorumMs * STRAGGLER_GRACE_FACTOR);
		stragglerTimer = setTimeout(() => {
			straggler.abort(`cut as straggler: ${quorum}/${total} reviewers finished in ${Math.round(quorumMs / 1000)}s, waited ${Math.round(graceMs / 1000)}s more`);
		}, graceMs);
		stragglerTimer.unref?.();
	};

	// Worker slot: pulls next reviewer, runs, stores result. We launch `cap`
	// workers up front; each races to grab via the shared cursor.
	const worker = async (): Promise<void> => {
		while (true) {
			if (abortSignal?.aborted) return;
			const idx = cursor++;
			if (idx >= resolved.length) return;
			const slot = resolved[idx];
			try {
				const partial = await runReviewer(slot.model, slot.rs, ctx, systemPrompt, userPrompt, temperature, reviewerSignal, runOpts);
				const full: ReviewerRunResult = {
					formattedSpec: formatReviewerSpec(slot.rs),
					spec: slot.rs.spec,
					thinking: slot.rs.thinking,
					clamped: slot.clamped,
					...partial,
				};
				results[idx] = full;
				done++;
				noteFinished(full.ok);
				onProgress?.(done, total, full);
			} catch (err) {
				const full: ReviewerRunResult = {
					formattedSpec: formatReviewerSpec(slot.rs),
					spec: slot.rs.spec,
					thinking: slot.rs.thinking,
					clamped: slot.clamped,
					model: slot.model,
					ok: false,
					findings: [],
					rawText: "",
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					durationMs: 0,
				};
				results[idx] = full;
				done++;
				noteFinished(false);
				onProgress?.(done, total, full);
			}
		}
	};

	await Promise.all(Array.from({ length: cap }, () => worker()));
	if (stragglerTimer) clearTimeout(stragglerTimer);
	throwIfAborted(abortSignal);
	return results;
}

const STRAGGLER_MIN_GRACE_MS = 45_000;

/** Time-budget reserves for deadline-capped (headless) runs. */
const MIN_PHASE_MS = 45_000;
const GROUPING_RESERVE_MS = 30_000;
const VERIFY_RESERVE_MS = 150_000;
const FINAL_RESERVE_MS = 20_000;
const STRAGGLER_GRACE_FACTOR = 0.5;

/** Successful answers needed before stragglers get a deadline; pools of ≤2 always wait for everyone. */
export function stragglerQuorum(total: number): number {
	if (total <= 2) return Number.POSITIVE_INFINITY;
	return Math.max(2, Math.ceil((total * 2) / 3));
}

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
	members: { spec: ModelSpec; comment: string; severity: ReviewerFinding["severity"]; line_start: number | null; line_end: number | null }[];
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

function keywords(text: string): Set<string> {
	return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
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
	return { spec, comment: finding.comment, severity: finding.severity, line_start: finding.line_start, line_end: finding.line_end };
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
				if (key.startsWith("S:")) continue;
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

Ids starting with "S:" are NOT findings but the lead reviewer's hypotheses. Put a hypothesis in the cluster of the finding(s) describing the same defect, or leave it alone in its own cluster if no finding matches. Match on the defect, not the topic.

Output ONLY a JSON array of clusters; each cluster is an array of ids, e.g. [["0:1","2:0","S:0"],["1:3"],["S:1"]].
- Every id appears in exactly one cluster.
- Never put two findings from the same reviewer (same number before the colon) in one cluster.
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
	suspicions: string[] = [],
): Promise<{ clusters: FindingKey[][] } | { error: string }> {
	const items: string[] = [];
	const known = new Set<FindingKey>();
	suspicions.forEach((text, i) => {
		known.add(`S:${i}`);
		items.push(`- id S:${i} | lead hypothesis (not a finding) | ${text.replace(/\s+/g, " ").slice(0, 500)}`);
	});
	results.forEach((r, ri) => {
		if (!r?.ok) return;
		r.findings.forEach((f, fi) => {
			const key = `${ri}:${fi}`;
			known.add(key);
			const core = (f.match_text ?? f.comment).replace(/\s+/g, " ").slice(0, 500);
			items.push(`- id ${key} | ${f.file}:${formatRange(f.line_start, f.line_end)} | ${f.category} | ${f.title} — ${core}`);
		});
	});
	if (known.size - suspicions.length === 0 || known.size < 2) return { clusters: [...known].map((k) => [k]) };
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

/**
 * Semantic grouping with lexical fallback; never fails the run. Also maps
 * each lead suspicion to the groups that independently describe it.
 */
async function groupFindings(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	results: ReviewerRunResult[],
	signal: AbortSignal | undefined,
	progress?: MultiReviewProgressReporter,
	suspicions: string[] = [],
): Promise<{ groups: DedupeGroup[]; suspicionMatches: string[][] }> {
	const lexical = () => {
		const groups = dedupeReviewerFindings(results);
		return { groups, suspicionMatches: suspicions.map((t) => matchSuspicionLexically(t, groups)) };
	};
	if (cfg.dedupeModel === "lexical") return lexical();
	const parsedSpec = parseReviewerSpec(cfg.dedupeModel ?? cfg.judge, "low");
	const model = parsedSpec ? findModel(ctx, parsedSpec.spec) : null;
	if (!parsedSpec || !model) return lexical();
	progress?.update({ phase: `grouping findings (${shortSpec(parsedSpec.spec)})`, done: undefined, total: undefined });
	const out = await clusterFindingsWithModel(ctx, model, parsedSpec.thinking, results, signal, 120_000, suspicions);
	if ("error" in out) {
		progress?.update({ phase: "grouping fell back to lexical", latest: `grouping model failed: ${out.error.slice(0, 120)}` });
		return lexical();
	}
	const groups = dedupeReviewerFindings(results, out.clusters);
	const groupOfKey = new Map<FindingKey, string>();
	for (const g of groups) for (const k of g.keys ?? []) groupOfKey.set(k, g.id);
	const suspicionMatches = suspicions.map((_, i) => {
		const cluster = out.clusters.find((c) => c.includes(`S:${i}`)) ?? [];
		return [...new Set(cluster.map((k) => groupOfKey.get(k)).filter((id): id is string => Boolean(id)))];
	});
	return { groups, suspicionMatches };
}

/** Fallback suspicion matching: shared distinctive vocabulary with a group's text. */
function matchSuspicionLexically(text: string, groups: DedupeGroup[]): string[] {
	const words = keywords(text);
	return groups
		.filter((g) => jaccard(words, keywords(`${g.titles.join(" ")} ${g.members.map((m) => m.comment).join(" ")}`)) >= 0.12)
		.map((g) => g.id);
}

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

/** Run `fn` over items with at most `cap` in flight; results keep input order. */
async function mapWithConcurrency<T, R>(items: T[], cap: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const i = cursor++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, worker));
	return results;
}

/**
 * Verification round: each group is cross-checked by reviewers who didn't
 * raise it, each verifier handling all its assigned groups in one session
 * (with tools unless the run is quick). Verdicts are attached to the
 * groups; a verifier failure leaves its groups unverified, never refuted.
 */
async function runVerification(
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
	// having raised nothing, they're the most independent checkers.
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
		const run = await runReviewer(row.model, row.rs, ctx, VERIFY_SYSTEM_PROMPT, buildVerifyPrompt(basePrompt, assigned), cfg.temperature, signal, runOpts, () => []);
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

function formatRange(start: number | null, end: number | null): string {
	if (start === null && end === null) return "file";
	if (start === null) return `…${end}`;
	if (end === null || end === start) return `L${start}`;
	return `L${start}-${end}`;
}

// ---------- judge pass ----------

/**
 * The judge sees the deduped groups with every per-model comment attached,
 * not a flattened list. The schema forces it to write a markdown summary
 * where each finding carries an attribution strip — that's the
 * 'per-model labels preserved' requirement from the design.
 */
const JUDGE_SYSTEM_PROMPT = `You are a senior engineering lead adjudicating multiple independent code reviews. You receive the deduplicated findings with every per-reviewer comment, plus the diff they reviewed. Your job is to decide which findings are real — reviewers hallucinate, misread hunks, and flag pre-existing code.

Output a markdown document with this exact shape:

# Multi-Model Code Review

## Summary
Two- to four-sentence overall assessment, then a one-line "Top risks" list ordered by severity (confirmed findings only).

## Findings
For each finding, in the order provided, write:

### <severity> · <title>
- **File:** <path>:<lines> (or "file" if line numbers null)
- **Category:** <category>
- **Raised by:** <reviewer-count> — <comma-separated short model names>
- **Verdict:** confirmed | plausible | false positive — <one sentence citing the specific diff lines that support or refute it>
- **Judge's take:** <one or two sentences: mechanics, root cause, or a concrete fix>

When reviewers frame the same finding differently, say so in the take — do not silently pick one.

After the findings, if any models errored or produced unparseable output, add a final '## Coverage' section listing missing reviewers.

Rules:
- Keep every finding in the output (mark false positives, never delete them). Do not invent new findings.
- Verify against the diff. A finding about code the diff doesn't touch is at most "plausible" unless the diff clearly breaks it.
- When independent verification is present, weigh it: a refutation with concrete code evidence usually makes a finding a false positive; confirmations from non-raisers are strong support. Say which way it went.
- You may adjust the displayed severity by one step when the evidence warrants; note the change in the take.
- Keep each finding ≤ 90 words. Do not paste reviewer comments verbatim; they are shown separately.
- Use file paths exactly as given — do not rewrite to absolute paths.
- Severity ladder is critical > high > medium > low > info > none.`;

interface JudgeResult {
	markdown: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	durationMs: number;
}

function renderGroupsForJudge(target: ReviewTarget, groups: DedupeGroup[]): string {
	const lines: string[] = [];
	lines.push("## Review target");
	lines.push(`kind: ${target.kind}`);
	lines.push(`label: ${target.label}`);
	if (target.metaLines.length > 0) {
		lines.push("");
		lines.push("metadata:");
		lines.push(...target.metaLines);
	}
	if (target.focusHint) {
		lines.push("");
		lines.push(`focus hint: ${target.focusHint}`);
	}
	if (target.brief?.intent) {
		lines.push("");
		lines.push(`intent: ${target.brief.intent}`);
	}
	if (target.brief?.spec) {
		lines.push("");
		lines.push(`## Spec (${target.brief.spec.path})`);
		lines.push(target.brief.spec.text);
	}
	if (target.brief && target.brief.requirements.length > 0) {
		lines.push("");
		lines.push("## Requirements");
		target.brief.requirements.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
	}
	lines.push("");
	lines.push("## Deduped findings (in severity order)");
	if (groups.length === 0) {
		lines.push("(no findings across reviewers)");
	} else {
		for (const g of groups) {
			const range = formatRange(g.line_start, g.line_end);
			lines.push(
				`- ${g.severity.toUpperCase()}  ${g.file}:${range}  consensus=${g.consensus ? "yes" : "no"} (${g.reviewerSpecs.length} reviewers)`,
			);
			lines.push(`    category: ${g.category}`);
			lines.push(`    titles:`);
			for (const t of g.titles) lines.push(`      - ${t}`);
			lines.push(`    per-reviewer:`);
			for (const m of g.members) {
				lines.push(`      - ${m.spec} (severity=${m.severity}):`);
				for (const cl of m.comment.split("\n")) lines.push(`          ${cl}`);
			}
			if (g.verifications?.length) {
				lines.push(`    independent verification (${verificationTally(g)}):`);
				for (const v of g.verifications) lines.push(`      - ${v.spec}: ${v.verdict} — ${v.evidence}`);
			} else if (g.verificationNote) {
				lines.push(`    verification: ${g.verificationNote}`);
			}
		}
	}
	if (target.diffText) {
		lines.push("");
		lines.push("## Diff under review");
		lines.push(budgetDiff(target.diffText));
	}
	return lines.join("\n");
}

/**
 * Light-mode markdown synthesis. Produces a structured markdown doc
 * directly from the deduped groups (no judge call) so the user sees
 * per-model attribution attached to every finding, sorted severity-desc.
 * Schema mirrors what the prompted judge produces so downstream tooling
 * doesn't need a separate light-mode branch.
 */
function verificationLines(g: DedupeGroup): string[] {
	if (!g.verifications?.length) return g.verificationNote ? [`- **Verification:** ${g.verificationNote}`] : [];
	const icon = { confirmed: "✓ confirmed", refuted: "✗ refuted", uncertain: "? uncertain" } as const;
	return [
		`- **Verification (${verificationTally(g)}):**`,
		...g.verifications.map((v) => `    - \`${v.spec}\` ${icon[v.verdict]}: ${v.evidence}`),
		...(g.verificationNote ? [`    - note: ${g.verificationNote}`] : []),
	];
}

/** A suspicion dressed as a group so the verify round can check it like any claim. */
function suspicionAsGroup(sus: SuspicionResult): DedupeGroup {
	return {
		id: sus.id,
		file: "(lead hypothesis)",
		line_start: null,
		line_end: null,
		severity: "info",
		category: "suspicion",
		title: sus.text,
		titles: [sus.text],
		members: [],
		reviewerSpecs: [],
		consensus: false,
	};
}

/**
 * The lead's suspicions vs. independent discovery. "Raised independently"
 * is the strong signal; "not raised" means either a wrong hypothesis or a
 * shared blind spot — verification (or the lead's own reading) decides.
 */
function suspicionMarkdown(suspicions: SuspicionResult[], groups: DedupeGroup[], verified: boolean): string[] {
	const byId = new Map(groups.map((g) => [g.id, g]));
	const lines = ["## Lead suspicions (hidden from reviewers)"];
	for (const sus of suspicions) {
		const raised = sus.raisedBy.map((id) => byId.get(id)).filter((g): g is DedupeGroup => Boolean(g));
		const status = raised.length > 0
			? `raised independently — ${raised.map((g) => `${g.id} "${g.title}" (×${g.reviewerSpecs.length})`).join("; ")}`
			: "not raised by any reviewer";
		lines.push(`- **${sus.id}:** ${sus.text}`);
		lines.push(`    - ${status}`);
		if (sus.verifications?.length) {
			const g = { verifications: sus.verifications } as DedupeGroup;
			lines.push(`    - verification (${verificationTally(g)}):`);
			for (const v of sus.verifications) lines.push(`        - \`${v.spec}\` ${v.verdict}: ${v.evidence}`);
		} else if (verified) {
			lines.push(`    - verification: ${sus.verificationNote ?? "no verdict returned"}`);
		}
	}
	lines.push("");
	return lines;
}

function warningLines(target: ReviewTarget): string[] {
	if (target.warnings.length === 0) return [];
	return ["## Warnings", ...target.warnings.map((w) => `- ${w}`), ""];
}

function synthesizeNoFindingsMarkdown(target: ReviewTarget, reviewerRuns: ReviewerRunResult[], modeLabel = "balanced"): string {
	const ok = reviewerRuns.filter((r) => r.ok);
	const failed = reviewerRuns.filter((r) => !r.ok);
	const lines: string[] = [];
	lines.push(`# Multi-Model Code Review (${modeLabel})`);
	lines.push("");
	lines.push("## Summary");
	lines.push(
		`Scope: \`${target.label}\`. No findings were reported by ${ok.length} reviewer${ok.length === 1 ? "" : "s"}. ` +
			"Nothing to adjudicate.",
	);
	lines.push("");
	lines.push("## Reviewer coverage");
	for (const r of reviewerRuns) {
		const status = r.ok ? "ok" : `failed: ${r.errorMessage?.slice(0, 160) ?? "unknown"}`;
		lines.push(`- \`${r.formattedSpec}\`${r.clamped ? " (thinking clamped by provider)" : ""} — ${status}; ${(r.durationMs / 1000).toFixed(1)}s`);
	}
	if (failed.length > 0) {
		lines.push("");
		lines.push("Note: failed reviewers are excluded from the no-findings assessment.");
	}
	if (target.warnings.length > 0) lines.push("", ...warningLines(target));
	return lines.join("\n");
}

function synthesizeMarkdownFromGroups(
	target: ReviewTarget,
	groups: DedupeGroup[],
	reviewerRuns: ReviewerRunResult[],
	modeLabel = "balanced",
): string {
	const lines: string[] = [];
	const failed = reviewerRuns.filter((r) => !r.ok);
	lines.push(`# Multi-Model Code Review (${modeLabel})`);
	lines.push("");
	lines.push("## Summary");
	const consensusCount = groups.filter((g) => g.consensus).length;
	const totalMembers = groups.reduce((s, g) => s + g.members.length, 0);
	const okCount = reviewerRuns.filter((r) => r.ok).length;
	lines.push(
		`Scope: \`${target.label}\`. ` +
			`${groups.length} deduplicated finding${groups.length === 1 ? "" : "s"} across ` +
			`${okCount} reviewer${okCount === 1 ? "" : "s"}; ` +
			`${consensusCount} consensus, ${totalMembers} raw finding${totalMembers === 1 ? "" : "s"}.`,
	);
	lines.push("");
	if (groups.length === 0) {
		lines.push("_No findings across reviewers; no deep-dive warranted._");
		lines.push("");
	} else {
		lines.push("## Findings");
		for (const g of groups) {
			const range = formatRange(g.line_start, g.line_end);
			const head = g.consensus
				? `### ${g.severity.toUpperCase()} · ${g.title}  [CONSENSUS ×${g.reviewerSpecs.length}]`
				: `### ${g.severity.toUpperCase()} · ${g.title}`;
			lines.push(head);
			lines.push(`- **File:** \`${g.file}:${range}\``);
			lines.push(`- **Category:** ${g.category}`);
			lines.push(`- **Reviewers (${g.reviewerSpecs.length}):**`);
			for (const m of g.members) {
				lines.push(`    - \`${m.spec}\`: ${m.comment}`);
			}
			lines.push(...verificationLines(g));
			lines.push("");
		}
	}
	lines.push(...warningLines(target));
	lines.push("## Reviewers");
	for (const r of reviewerRuns) {
		const status = r.ok
			? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`
			: `FAILED — ${r.errorMessage?.slice(0, 160) ?? "(unknown)"}`;
		const tools = r.toolCalls ? `, ${r.toolCalls} tool calls` : "";
		lines.push(`- \`${r.formattedSpec}\`${r.clamped ? " (thinking clamped)" : ""}: ${status} (${(r.durationMs / 1000).toFixed(1)}s${tools})`);
	}
	if (failed.length > 0) lines.push("", "Failed reviewers are excluded from consensus counts.");
	lines.push("");
	return lines.join("\n");
}

async function runJudge(
	judgeModel: Model,
	groups: DedupeGroup[],
	target: ReviewTarget,
	failedSpecs: ModelSpec[],
	ctx: ExtensionContext,
	abortSignal: AbortSignal | undefined,
	temperature: number,
	thinking: ThinkingLevelAlias,
): Promise<JudgeResult> {
	const groupsPayload = renderGroupsForJudge(target, groups);
	const coverage = failedSpecs.length > 0
		? `, missing: ${failedSpecs.join(", ")}`
		: "";
	const userPrompt = `${groupsPayload}\n\n## Coverage notes\nReviewers that didn't return usable output: ${failedSpecs.length}${coverage}\n\nNow produce the markdown per the schema in the system prompt. Output ONLY markdown — no preamble, no "Here's the review:" opener.`;
	const call = await callModel(ctx, judgeModel, JUDGE_SYSTEM_PROMPT, userPrompt, { thinking, temperature, signal: abortSignal });
	// A judge cut off at maxTokens drops findings silently; fall back to the
	// deterministic synthesis rather than publish a partial review.
	const truncated = call.stopReason === "length";
	return {
		markdown: call.errorMessage || truncated ? "" : call.text,
		stopReason: call.stopReason,
		errorMessage: call.errorMessage ?? (truncated ? "judge output truncated at maxTokens" : undefined),
		usage: call.usage,
		durationMs: call.durationMs,
	};
}

// ---------- chat render ----------

/**
 * Payload attached to the message's `details` so the renderer can rebuild
 * the structured layout without re-parsing the judge's markdown. The markdown
 * itself is in `content` so it's selectable in the TUI.
 */
export interface MultiReviewDetails {
	target: ReviewTarget;
	groups: DedupeGroup[];
	reviewerSpecs: ModelSpec[];
	failedSpecs: ModelSpec[];
	judge: string;
	judgeDurationMs: number;
	judgeUsage?: { input: number; output: number; total: number; cost: number };
	consensusCount: number;
	totalFindings: number;
	/** Review markdown, kept apart from tool-result text (which adds lead instructions). */
	markdown?: string;
	suspicions?: SuspicionResult[];
}

const SEVERITY_COLOR: Record<ReviewerFinding["severity"], "error" | "warning" | "accent" | "muted" | "dim"> = {
	critical: "error",
	high: "error",
	medium: "warning",
	low: "accent",
	info: "muted",
	none: "dim",
};

const SEVERITY_BAR: Record<ReviewerFinding["severity"], string> = {
	critical: "█████",
	high: "████░",
	medium: "███░░",
	low: "██░░░",
	info: "█░░░░",
	none: "░░░░░",
};

function renderMultiReviewMessage(
	message: { content: string; details?: unknown },
	options: { expanded: boolean },
	theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string },
	_ctx: unknown,
): unknown {
	const details = (message.details ?? null) as MultiReviewDetails | null;
	const container = new Container();
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(container);

	const headline = `${theme.fg("toolTitle", theme.bold("multi-review"))} · ${
		details ? `${details.groups.length} groups, ${details.consensusCount} consensus` : "(no payload)"
	}`;
	container.addChild(new Text(headline, 0, 0));

	if (!details) {
		// Fallback to plain markdown if we somehow got here without details.
		container.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
		return box;
	}

	// Severity tally
	const tally: Record<string, number> = {};
	for (const g of details.groups) tally[g.severity] = (tally[g.severity] ?? 0) + 1;
	const tallyStr = (["critical", "high", "medium", "low", "info", "none"] as const)
		.filter((s) => tally[s])
		.map((s) => `${SEVERITY_BAR[s]} ${s}=${tally[s]}`)
		.join("   ");
	if (tallyStr) container.addChild(new Text(theme.fg("dim", tallyStr), 0, 0));

	// Scope line
	container.addChild(new Text(theme.fg("dim", `${details.target.label} · ${details.target.kind}`), 0, 0));
	container.addChild(new Text(
		theme.fg("dim", `judge: ${details.judge} · ${(details.judgeDurationMs / 1000).toFixed(1)}s`),
		0, 0,
	));

	// Per-group brief (always shown)
	for (const g of details.groups) {
		container.addChild(new Spacer(1));
		const head = `${SEVERITY_BAR[g.severity]} ${theme.fg(SEVERITY_COLOR[g.severity], g.severity.toUpperCase())} · ${theme.bold(g.title)}`;
		const consensusTag = g.consensus ? theme.fg("accent", ` [CONSENSUS ×${g.reviewerSpecs.length}]`) : "";
		const tally = verificationTally(g);
		const refuted = g.verifications?.some((v) => v.verdict === "refuted");
		const verifyTag = tally ? theme.fg(refuted ? "warning" : "success", ` ${tally}`) : "";
		container.addChild(new Text(`${head}${consensusTag}${verifyTag}`, 0, 0));
		container.addChild(new Text(theme.fg("dim", `  ${g.file}:${formatRange(g.line_start, g.line_end)} · ${g.category}`), 0, 0));
		if (options.expanded) {
			for (const m of g.members) {
				const specShort = m.spec.split("/").pop() ?? m.spec;
				container.addChild(new Text(`    · ${theme.fg("muted", `${specShort}:`)} ${m.comment}`, 0, 0));
			}
			for (const v of g.verifications ?? []) {
				const specShort = v.spec.split("/").pop() ?? v.spec;
				const mark = v.verdict === "confirmed" ? "✓" : v.verdict === "refuted" ? "✗" : "?";
				const color = v.verdict === "confirmed" ? "success" : v.verdict === "refuted" ? "warning" : "dim";
				container.addChild(new Text(`    ${theme.fg(color, `${mark} ${specShort}:`)} ${v.evidence}`, 0, 0));
			}
		}
	}

	if (details.suspicions?.length) {
		container.addChild(new Spacer(1));
		const raised = details.suspicions.filter((x) => x.raisedBy.length > 0).length;
		container.addChild(new Text(theme.fg("muted", `lead suspicions: ${raised}/${details.suspicions.length} raised independently`), 0, 0));
		for (const sus of details.suspicions) {
			const tally = sus.verifications?.length ? ` ${verificationTally({ verifications: sus.verifications } as DedupeGroup)}` : "";
			const mark = sus.raisedBy.length > 0 ? theme.fg("success", `✓ ${sus.raisedBy.join(",")}`) : theme.fg("dim", "· not raised");
			const text = options.expanded ? sus.text : truncateToWidth(sus.text, 90);
			container.addChild(new Text(`  ${theme.fg("muted", `${sus.id}:`)} ${text} ${mark}${theme.fg("dim", tally)}`, 0, 0));
		}
	}

	// In expanded view, render the judge's full markdown.
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── judge markdown ───"), 0, 0));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
	} else {
		container.addChild(new Text(theme.fg("dim", "(Ctrl+O to expand for full judge markdown + per-reviewer comments)"), 0, 0));
	}

	return box;
}

// ---------- interactive reviewer picker ----------

interface PickerRow {
	kind: "provider-header" | "model";
	provider: string;
	spec?: ModelSpec;
	modelIndex?: number;
	description?: string;
}

/**
 * Build a flat row list grouped by provider. Mixed model sets render with
 * provider separators so the user can chunk pick by source. Empty
 * providers are skipped — happens with single-provider accounts.
 */
function buildPickerRows(models: Model[]): { rows: PickerRow[]; modelRowIndexToSpec: Map<number, ModelSpec> } {
	const byProvider = new Map<string, Model[]>();
	for (const m of models) {
		const arr = byProvider.get(m.provider) ?? [];
		arr.push(m);
		byProvider.set(m.provider, arr);
	}
	const providers = Array.from(byProvider.keys()).sort();
	const rows: PickerRow[] = [];
	const modelRowIndexToSpec = new Map<number, ModelSpec>();
	let modelIndex = 0;
	for (const provider of providers) {
		rows.push({ kind: "provider-header", provider });
		for (const m of byProvider.get(provider)!.sort((a, b) => a.id.localeCompare(b.id))) {
			rows.push({
				kind: "model",
				provider,
				spec: `${m.provider}/${m.id}`,
				modelIndex,
				description: m.name && m.name !== m.id ? m.name : undefined,
			});
			modelRowIndexToSpec.set(modelIndex, `${m.provider}/${m.id}`);
			modelIndex++;
		}
	}
	return { rows, modelRowIndexToSpec };
}

/**
 * Multi-select TUI picker for reviewer models. Returns the chosen specs
 * (deduped) or null on cancel. Falls back to a single confirm dialog
 * (limited UX, text-only, picking one model) when ctx.hasUI is false so
 * non-interactive modes don't block entirely.
 */
async function pickReviewersViaTUI(
	ctx: ExtensionContext,
	models: Model[],
	preSelect: string[] = [],
): Promise<ModelSpec[] | null> {
	if (!ctx.hasUI) {
		// Best-effort fallback for print/RPC modes: select first pre-existing
		// spec that resolves else fail cleanly. We keep the bare spec only
		// (drop any @level suffix from the storage form).
		const first = preSelect.find((s) => {
			const bare = parseReviewerSpec(s)?.spec ?? s;
			return models.some((m) => `${m.provider}/${m.id}` === bare);
		});
		if (!first) return null;
		const bare = parseReviewerSpec(first)?.spec ?? first;
		return [bare];
	}

	const { rows, modelRowIndexToSpec } = buildPickerRows(models);
	const specToModelIndex = new Map<ModelSpec, number>();
	for (const [idx, spec] of modelRowIndexToSpec) specToModelIndex.set(spec, idx);

	const preSelectedModelIndices = new Set<number>();
	for (const spec of preSelect) {
		const parsed = parseReviewerSpec(spec);
		const bareSpec = (parsed?.spec ?? spec) as ModelSpec;
		const idx = specToModelIndex.get(bareSpec);
		if (idx !== undefined) preSelectedModelIndices.add(idx);
	}

	const cursorToModelIndex: number[] = rows.map((r) => (r.kind === "model" ? (r.modelIndex ?? -1) : -1));
	const firstModelRow = rows.findIndex((r) => r.kind === "model");
	let cursor = firstModelRow >= 0 ? firstModelRow : 0;
	let scrollTop = 0;

	const result = await ctx.ui.custom<{ spec: ModelSpec }[] | null>((_tui, theme, _kb, done) => {
		const selected = new Set<number>(preSelectedModelIndices);
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;
		const visibleBodyRows = 16;

		function isModelRow(i: number): boolean {
			return i >= 0 && i < rows.length && rows[i].kind === "model";
		}

		function moveCursor(delta: number): void {
			if (rows.length === 0) return;
			let next = cursor;
			for (let n = 0; n < rows.length; n++) {
				next = (next + delta + rows.length) % rows.length;
				if (isModelRow(next)) {
					cursor = next;
					return;
				}
			}
		}

		function jumpModels(delta: number): void {
			const dir = delta < 0 ? -1 : 1;
			for (let i = 0; i < Math.abs(delta); i++) moveCursor(dir);
		}

		function adjustScroll(): void {
			if (cursor < scrollTop) scrollTop = cursor;
			if (cursor >= scrollTop + visibleBodyRows) scrollTop = cursor - visibleBodyRows + 1;
			scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - visibleBodyRows)));
		}

		function refresh() {
			cachedLines = undefined;
			cachedWidth = undefined;
			adjustScroll();
			_tui.requestRender();
		}

		function commit(cancelled: boolean) {
			if (cancelled) {
				done(null);
				return;
			}
			const specList: { spec: ModelSpec }[] = [];
			const seen = new Set<ModelSpec>();
			for (let i = 0; i < rows.length; i++) {
				const r = rows[i];
				if (r.kind !== "model" || r.modelIndex === undefined) continue;
				if (!selected.has(r.modelIndex)) continue;
				const spec = modelRowIndexToSpec.get(r.modelIndex)!;
				if (seen.has(spec)) continue;
				seen.add(spec);
				specList.push({ spec });
			}
			done(specList);
		}

		function toggleCursor(): void {
			const mi = cursorToModelIndex[cursor];
			if (mi < 0) return;
			if (selected.has(mi)) selected.delete(mi);
			else selected.add(mi);
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				commit(true);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				commit(false);
				return;
			}
			if (matchesKey(data, Key.up)) {
				moveCursor(-1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				moveCursor(1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				jumpModels(-10);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				jumpModels(10);
				refresh();
				return;
			}
			if (matchesKey(data, Key.home)) {
				cursor = firstModelRow >= 0 ? firstModelRow : 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.end)) {
				for (let i = rows.length - 1; i >= 0; i--) {
					if (isModelRow(i)) {
						cursor = i;
						break;
					}
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.space) || data === " ") {
				toggleCursor();
				refresh();
				return;
			}
			if (data === "a") {
				for (const idx of modelRowIndexToSpec.keys()) selected.add(idx);
				refresh();
				return;
			}
			if (data === "A") {
				selected.clear();
				refresh();
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			adjustScroll();
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));
			add(theme.fg("accent", "─".repeat(width)));
			add(theme.fg("text", theme.bold(" Pick reviewer models ")));
			add(theme.fg("dim", "Space toggles · ↑↓ moves · PgUp/PgDn jumps · a selects all · A clears · Enter confirms · Esc cancels"));
			lines.push("");

			const end = Math.min(rows.length, scrollTop + visibleBodyRows);
			if (scrollTop > 0) add(theme.fg("dim", ` … ${scrollTop} row${scrollTop === 1 ? "" : "s"} above`));
			for (let i = scrollTop; i < end; i++) {
				const r = rows[i];
				if (r.kind === "provider-header") {
					add(theme.fg("dim", ` ${r.provider}`));
					continue;
				}
				const isCursor = i === cursor;
				const mi = r.modelIndex ?? -1;
				const isSelected = selected.has(mi);
				const cursorMark = isCursor ? theme.fg("accent", "> ") : "  ";
				const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = theme.fg(isSelected ? "success" : "text", r.spec ?? "");
				const desc = r.description ? theme.fg("dim", ` — ${r.description}`) : "";
				add(`${cursorMark}${box} ${label}${desc}`);
			}
			if (end < rows.length) add(theme.fg("dim", ` … ${rows.length - end} row${rows.length - end === 1 ? "" : "s"} below`));

			lines.push("");
			const n = selected.size;
			add(theme.fg("muted", ` ${n} reviewer${n === 1 ? "" : "s"} selected · showing ${scrollTop + 1}-${end} of ${rows.length} rows.`));
			if (n === 0) add(theme.fg("warning", " Tip: space-toggle at least one to enable Enter."));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
				cachedWidth = undefined;
			},
			handleInput,
		};
	}, {
		overlay: true,
		overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%", anchor: "center" },
	});

	if (!result) return null;
	return result.map((r) => r.spec);
}

/**
 * Merge `chosen` into the currently-loaded config (in-memory) AND persist
 * to ~/.pi/agent/multi-review.json so the choice survives `/reload`.
 * Unknown keys in the file are preserved untouched; bad JSON triggers
 * a clean fresh write of the merged content.
 */
function persistReviewerChoices(chosen: ModelSpec[]): { ok: boolean; error?: string; path: string } {
	const path = `${getAgentDir()}/multi-review.json`;
	let next: Record<string, unknown> = {};
	try {
		if (fs.existsSync(path)) {
			const prev = JSON.parse(fs.readFileSync(path, "utf8"));
			if (prev && typeof prev === "object" && !Array.isArray(prev)) {
				next = { ...prev };
			}
		}
	} catch {
		next = {};
	}
	if (chosen.length > 0) next.reviewers = chosen;
	if (!("judge" in next)) next.judge = DEFAULTS.judge;
	try {
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
		return { ok: true, path };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), path };
	}
}

/**
 * Shared entry point used by both `/multi-review` and the `multi_review` tool.
 * Centralizes the ordering (pool → judge check → scope → fan-out → dedupe →
 * judge → inject/notify) so the only thing that differs between the two
 * surfaces is how the result surfaces.
 *
 * `signal`: pass `ctx.signal` when called from a tool execution (defined
 * during active turns) so that Ctrl+C and model_call aborts cancel all
 * in-flight reviewer and judge requests. Slash commands fire outside an
 * active turn so ctx.signal is undefined there — we degrade to no abort
 * instead of synthesizing a fake signal so the user gets to see partial
 * results rather than a recall race.
 */
/**
 * Single-shot override: when set, runMultiReviewFromArgs uses these
 * reviewers instead of cfg.reviewers. Cleared after each invocation.
 * Set ONLY by the picker fallback when the user opts not to persist.
 */
let TRANSIENT_REVIEWERS: ModelSpec[] | null = null;

/**
 * Turn a `/multi-review` invocation into a task for the main agent. The agent
 * has the conversation context the reviewers lack, so it drafts the brief
 * (intent, spec requirements, related files, focus) and calls multi_review,
 * then acts as lead reviewer on the results.
 */
export function buildHandoffPrompt(rawArgs: string, flags: ReviewFlags, specPath: string | undefined): string {
	const parsed = parseReviewArgs(rawArgs);
	const focus = parsed.kind === "text" ? parsed.value : parsed.kind === "pr" ? parsed.raw : "";
	const scope = parsed.kind === "pr"
		? `PR #${parsed.number} (\`gh pr view ${parsed.number}\` / \`gh pr diff ${parsed.number}\`)`
		: parsed.kind === "text"
			? "the area the user described below (no diff — reviewers get the focus text and the repo)"
			: "the working-tree diff against the default branch, committed and uncommitted (`git diff $(git merge-base origin/HEAD HEAD)` or similar)";
	const lines: string[] = [];
	lines.push(`The user ran \`/multi-review ${rawArgs.trim()}\`. You are the lead reviewer for a multi-model code review. Do not edit code during this task.`);
	lines.push("");
	lines.push(`1. **Scope.** Under review: ${scope}. Look at the change yourself so you understand it before briefing anyone.`);
	if (specPath) {
		lines.push(`2. **Spec.** Read \`${specPath}\` in full. It is the source of truth: the review checks the implementation against it.`);
	} else {
		lines.push("2. **Intent.** Work out what the change is supposed to do from this conversation, commit messages, and the PR description. If you genuinely can't tell, ask the user instead of calling the tool.");
	}
	lines.push("3. **Brief.** Call the `multi_review` tool once. Reviewers are other model families with read-only repo access; they do NOT see this conversation, so the brief must carry what they can't discover — but NOT where you think the bugs are. Independent discovery is the point: hypotheses in the brief anchor every reviewer on the same spots, turn \"consensus\" into an echo of your prompt, and copy your blind spots into theirs.");
	lines.push("   - `intent`: what the change must accomplish, plus facts reviewers can't find in the repo (external tool/API behaviour, deployment constraints, what's deliberately out of scope). State goals, not a narration of the implementation — reviewers should verify what the code does, not take your description of it as given. Reviewers challenge the execution, not the intent.");
	if (specPath) {
		lines.push("   - `requirements`: every concrete, checkable requirement / acceptance criterion in the spec, one per item, quoted or tightly paraphrased. Include the edge cases and error behaviour the spec pins down.");
		lines.push(`   - \`spec_path\`: "${specPath}" (the full spec is passed to reviewers verbatim).`);
	} else {
		lines.push("   - `requirements`: only if the user stated explicit acceptance criteria.");
	}
	lines.push("   - `context_files`: up to 8 repo paths reviewers should read in full beyond the diff — callers, types/interfaces, tests that pin the behaviour. Skip files the diff already shows whole.");
	lines.push(`   - \`focus\`: risk AREAS only (e.g. "API-key handling across agents", "config-file merge lifecycle", "test isolation"), never hypotheses ("does X compile?", "is Y null when Z?")${focus ? `, plus the user's request: "${focus}"` : ""}.`);
	lines.push("   - `suspicions`: your specific hypotheses about possible bugs, one per item. They are NOT shown to the reviewers; they're checked against what reviewers find independently (and cross-checked by verifiers when verify is on), so you learn which of your suspicions others reached on their own.");
	if (parsed.kind === "pr") lines.push(`   - \`pr_number\`: ${parsed.number}`);
	if (parsed.kind === "text") lines.push(`   - \`scope\`: "area" (and put the area description in \`focus\`)`);
	if (flags.verify) lines.push("   - `verify`: true (each finding is cross-checked by reviewers who didn't raise it)");
	if (flags.quick) lines.push("   - `quick`: true (fast reviewer pool, no tools)");
	lines.push("4. **Verdict.** When results return, follow the lead-judgment instructions in the tool result.");
	return lines.join("\n");
}

/** Appended to the tool result: the main agent is the final judge (pstack-style buckets). */
function leadJudgmentInstructions(hasSpec: boolean): string {
	const lines = [
		"---",
		"## Lead judgment (you)",
		"You are the lead reviewer, not an aggregator. Reviewers saw only your brief and the repo; you have the conversation and can read the code. Before putting a single-reviewer finding in Act On, verify it yourself. Findings raised independently by ≥2 models are the strongest signal, but check them too. Be slow to dismiss correctness and security findings.",
		"Dismiss: hypotheticals the call sites rule out, \"I would have done it differently\", findings about code the change didn't touch, and nits inflated to fill a review.",
		"If the result lists your suspicions: one raised independently is strong signal; one nobody raised is either wrong or a shared blind spot — read the code (or weigh its verification evidence) before deciding. Say which of your suspicions held up.",
		"If a finding has independent verification (✓ confirmed / ✗ refuted / ? uncertain by reviewers who did not raise it), weigh the evidence, not the vote: a refutation citing concrete code usually means Dismissed; a split verdict means read the code yourself.",
		"",
		"Reply to the user in this format:",
		"### Intent",
		"> the intent you briefed",
		"### Reviewers",
		"- model — N findings (or why it failed)",
	];
	if (hasSpec) {
		lines.push("### Spec conformance", "| Requirement | Status (met / partial / missing / contradicted) | Evidence (file:line) |");
	}
	lines.push(
		"### Act On",
		"Real issues that would block a PR: what, where (file:line), which models raised it, why it matters, the fix. Aim for ≤5; more means you aren't filtering hard enough.",
		"### Consider",
		"Legitimate but debatable now — state the tradeoff.",
		"### Noted",
		"Valid but not actionable; one line each.",
		"### Dismissed",
		"Each with a one-line reason, so the user can override you.",
		"### Agreement Map",
		"Where models agreed or diverged, and what that pattern suggests.",
		"",
		"Do not apply fixes unless the user asks.",
	);
	return lines.join("\n");
}

async function runMultiReviewFromArgs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawArgs: string,
	signal: AbortSignal | undefined,
	transientReviewers: ModelSpec[] | null = TRANSIENT_REVIEWERS,
	onUpdate?: ToolUpdateFn,
	runOptions: { agentLead?: boolean; brief?: BriefInput; focus?: string; flags?: Partial<ReviewFlags>; deadlineMs?: number } = {},
): Promise<MultiReviewRunResult> {
	const cfg = loadConfig();
	const agentLead = runOptions.agentLead ?? false;
	const parsedFlags = parseReviewFlags(rawArgs, { verify: cfg.verify, quick: false });
	const flags: ReviewFlags = { ...parsedFlags.flags, ...stripUndefined(runOptions.flags ?? {}) };
	const specFlag = parseValueFlag(parsedFlags.rest, "spec");
	rawArgs = specFlag.rest;
	const briefInput: BriefInput = { ...runOptions.brief };
	if (specFlag.value && !briefInput.specPath) briefInput.specPath = specFlag.value;
	if (briefInput.specPath) {
		// An explicitly requested spec that can't be read must not silently
		// degrade into a spec-less review.
		const spec = readSpecFile(ctx.cwd, briefInput.specPath);
		if ("error" in spec) return { kind: "notify", notifyMessage: `multi-review: ${spec.error}`, notifyLevel: "error" };
	}
	// A transient pool (picker, not persisted) overrides the configured one
	// for this run only; --quick swaps in the fast pool.
	const usingTransientReviewers = transientReviewers !== null && transientReviewers.length > 0;
	const poolName = usingTransientReviewers ? "transient" : flags.quick ? "quickReviewers" : "reviewers";
	const effectiveReviewerSpecs: string[] = usingTransientReviewers
		? transientReviewers
		: flags.quick ? cfg.quickReviewers : cfg.reviewers;
	if (usingTransientReviewers && transientReviewers === TRANSIENT_REVIEWERS) TRANSIENT_REVIEWERS = null;
	if (effectiveReviewerSpecs.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: no ${poolName} configured.\n\n` +
				`Drop a "$PI_CODING_AGENT_DIR/multi-review.json" like:\n` +
				`  { "reviewers": ["amd-gateway/gpt-6-astra", "amd-gateway/Grok-4.7"], "judge": "amd-gateway-anthropic/Claude-Opus-5.5" }\n` +
				`Or with per-reviewer thinking: "amd-gateway/gpt-6-astra@xhigh"\n` +
				`Then /reload.\n\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "warning",
		};
	}
	const resolved = (await resolveReviewerPoolStructured(ctx, effectiveReviewerSpecs)).entries;
	if (resolved.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: none of the ${poolName} resolved.\n` +
				describeResolved([], effectiveReviewerSpecs) +
				`\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "error",
		};
	}

	const label = describeFlags(flags);
	const progress = createProgressReporter(ctx, label, onUpdate);
	try {
		const parsed = parseReviewArgs(rawArgs);
		progress.update({ phase: "resolving scope" });
		const target = await buildReviewTarget(pi, parsed, ctx.cwd);
		// A focus hint narrows attention within the diff; it never replaces the diff.
		if (runOptions.focus?.trim()) {
			target.focusHint = target.focusHint ? `${target.focusHint}\n\n${runOptions.focus.trim()}` : runOptions.focus.trim();
		}
		if (hasBriefInput(briefInput)) target.brief = buildBrief(ctx.cwd, briefInput, target.warnings);
		const runOpts: ReviewerRunOptions = flags.quick
			? { useTools: false, timeoutMs: cfg.reviewerTimeoutSec * 1000 }
			: reviewerRunOptions(cfg);
		if (target.kind === "pr" && runOpts.useTools) {
			target.metaLines.push("(files on disk are the local checkout, not necessarily the PR head — the diff is authoritative)");
		}
		if (target.diffText.length > DIFF_BUDGET_CHARS) {
			target.warnings.push(`diff is ${target.diffText.length} chars; reviewers saw the first ${DIFF_BUDGET_CHARS}. Narrow the scope or use focus.`);
		}
		// The main agent replaces the external judge; --direct needs one, but
		// a missing judge degrades to deterministic synthesis, not an error.
		const judge = agentLead ? null : resolveJudge(ctx, cfg);
		if (!agentLead && !judge) target.warnings.push(`judge ${cfg.judge} not in registry; showing deterministic synthesis`);
		const resolvedRows = resolved.map((r) => ({ rs: r.rs, model: r.model, clamped: r.clamped }));
		const result = await runReviewPipeline(ctx, cfg, flags, target, resolvedRows, runOpts, judge, agentLead, signal, progress, runOptions.deadlineMs);
		progress.finish("done");
		return result;
	} catch (err) {
		progress.finish("failed");
		throw err;
	}
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The one review pipeline: fan-out → group → (verify) → synthesis.
 * Synthesis is deterministic markdown when the main agent leads (it judges
 * from the tool result) and the external judge's markdown under --direct.
 */
async function runReviewPipeline(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	flags: ReviewFlags,
	target: ReviewTarget,
	rows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	runOpts: ReviewerRunOptions,
	judge: Model | null,
	agentLead: boolean,
	signal: AbortSignal | undefined,
	progress: MultiReviewProgressReporter,
	deadlineMs?: number,
): Promise<MultiReviewRunResult> {
	const label = describeFlags(flags);
	const userPrompt = buildReviewUserPrompt(target);
	// With a deadline (headless callers inside a capped shell), each phase's
	// timeout shrinks to fit, keeping a reserve for the phases after it.
	const fit = (opts: ReviewerRunOptions, reserveMs: number): ReviewerRunOptions =>
		deadlineMs === undefined
			? opts
			: { ...opts, timeoutMs: Math.max(MIN_PHASE_MS, Math.min(opts.timeoutMs, deadlineMs - Date.now() - reserveMs)) };
	progress.update({ phase: `fanning out to ${rows.length} reviewers (cap ${cfg.concurrency})`, done: 0, total: rows.length });
	const runs = await runAllReviewers(
		rows,
		REVIEWER_SYSTEM_PROMPT,
		userPrompt,
		cfg.concurrency,
		cfg.temperature,
		signal,
		ctx,
		fit(runOpts, GROUPING_RESERVE_MS + (flags.verify ? VERIFY_RESERVE_MS : 0)),
		(done, total, latest) => progress.update({ phase: "reviewers running", done, total, latest: formatReviewerProgressLine(done, total, latest) }),
	);
	const failure = allReviewersFailedResult(runs, label);
	if (failure) return failure;

	const suspicionTexts = target.brief?.suspicions ?? [];
	const { groups, suspicionMatches } = await groupFindings(ctx, cfg, runs, signal, progress, suspicionTexts);
	// Grouping and judge calls turn an abort into an error + fallback; a
	// cancelled run must stop here, not publish a fallback review.
	throwIfAborted(signal);
	const suspicions: SuspicionResult[] = suspicionTexts.map((text, i) => ({ id: `s${i + 1}`, text, raisedBy: suspicionMatches[i] ?? [] }));
	// Suspicions ride the verify round as claims of their own: every reviewer
	// is eligible (none raised them), and they never touched discovery.
	const suspicionGroups = suspicions.map(suspicionAsGroup);
	const verifyTimeLeft = deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now() - FINAL_RESERVE_MS;
	if (flags.verify && verifyTimeLeft < MIN_PHASE_MS) {
		target.warnings.push(`verification skipped: only ${Math.max(0, Math.round(verifyTimeLeft / 1000))}s left of the run's time budget`);
	} else if (flags.verify && groups.length + suspicionGroups.length > 0) {
		const { failures } = await runVerification(ctx, cfg, rows, [...groups, ...suspicionGroups], userPrompt, fit(runOpts, FINAL_RESERVE_MS), signal, progress);
		for (const f of failures) target.warnings.push(`verifier failed (its findings stay unverified): ${f}`);
		suspicionGroups.forEach((g, i) => {
			suspicions[i].verifications = g.verifications;
			suspicions[i].verificationNote = g.verificationNote;
		});
	}

	let markdown: string;
	let judgeLabel = agentLead ? "(main agent)" : "(none)";
	let judgeDurationMs = 0;
	let judgeUsage: JudgeResult["usage"];
	if (groups.length === 0) {
		markdown = synthesizeNoFindingsMarkdown(target, runs, label);
	} else if (judge) {
		progress.update({ phase: `${groups.length} groups · invoking judge ${shortSpec(cfg.judge)}`, done: undefined, total: undefined });
		const jr = await runJudge(judge, groups, target, runs.filter((r) => !r.ok).map((r) => r.spec), ctx, signal, cfg.temperature, cfg.judgeThinking);
		throwIfAborted(signal);
		judgeLabel = cfg.judge;
		judgeDurationMs = jr.durationMs;
		judgeUsage = jr.usage;
		markdown = jr.markdown.trim()
			? jr.markdown
			: `# Multi-Model Code Review (judge returned nothing)\n\nJudge \`${cfg.judge}\` failed (${jr.errorMessage ?? `stopReason=${jr.stopReason}`}); deterministic synthesis follows.\n\n` +
				synthesizeMarkdownFromGroups(target, groups, runs, label);
	} else {
		markdown = synthesizeMarkdownFromGroups(target, groups, runs, agentLead ? `${label} · main agent judges` : label);
	}
	if (suspicions.length > 0) markdown += `\n\n${suspicionMarkdown(suspicions, groups, flags.verify).join("\n")}`;

	const details: MultiReviewDetails = {
		target,
		groups,
		reviewerSpecs: runs.map((r) => r.spec),
		failedSpecs: runs.filter((r) => !r.ok).map((r) => r.spec),
		judge: judgeLabel,
		judgeDurationMs,
		judgeUsage,
		consensusCount: groups.filter((g) => g.consensus).length,
		totalFindings: groups.reduce((s, g) => s + g.members.length, 0),
		suspicions: suspicions.length > 0 ? suspicions : undefined,
	};
	const verified = groups.filter((g) => g.verifications?.length).length;
	return {
		kind: "inject",
		notifyMessage:
			`multi-review · ${label} · done\n` +
			`scope: ${target.label}   files: ${target.files.length}   diff bytes: ${target.diffText.length}\n` +
			`reviewers: ${runs.length}   issues: ${groups.length}   consensus: ${details.consensusCount}` +
			(flags.verify ? `   verified: ${verified}/${groups.length}` : "") +
			(suspicions.length ? `   suspicions raised independently: ${suspicions.filter((x) => x.raisedBy.length).length}/${suspicions.length}` : "") +
			(target.warnings.length ? `\nwarnings: ${target.warnings.length} (see review)` : ""),
		notifyLevel: "info",
		injectMessage: { customType: "multi-review", content: markdown, details },
	};
}

/**
 * Brief fields shared by the multi_review tool and the headless
 * /multi-review-run command (snake_case, as the tool schema exposes them).
 */
export interface ReviewRequest {
	intent?: string;
	spec_path?: string;
	requirements?: string[];
	suspicions?: string[];
	context_files?: string[];
	focus?: string;
	scope?: "diff" | "area";
	pr_number?: number;
	verify?: boolean;
	quick?: boolean;
}

/**
 * Agent-led review: the caller (pi's main agent, or an external harness
 * such as Claude Code via /multi-review-run) wrote the brief and will judge
 * the results, so no external judge runs. Returns the findings markdown
 * plus lead-judgment instructions, or an error.
 */
async function runAgentLedReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: ReviewRequest,
	signal: AbortSignal | undefined,
	onUpdate?: ToolUpdateFn,
	deadlineMs?: number,
): Promise<{ text: string; markdown: string; details: MultiReviewDetails } | { error: string }> {
	const parts: string[] = [];
	const focus = typeof params.focus === "string" ? params.focus.trim() : "";
	if (typeof params.pr_number === "number") parts.push(String(params.pr_number));
	else if (params.scope === "area") {
		if (!focus) return { error: "multi_review: scope='area' needs `focus` describing the area to review." };
		parts.push(focus);
	}
	const result = await runMultiReviewFromArgs(pi, ctx, parts.join(" "), signal, TRANSIENT_REVIEWERS, onUpdate, {
		agentLead: true,
		brief: {
			intent: params.intent,
			specPath: params.spec_path,
			requirements: params.requirements,
			suspicions: params.suspicions,
			contextFiles: params.context_files,
		},
		focus: params.scope === "area" ? undefined : focus,
		flags: { verify: params.verify, quick: params.quick },
		deadlineMs,
	});
	if (!result.injectMessage) return { error: result.notifyMessage };
	const { content: markdown, details } = result.injectMessage;
	const hasSpec = Boolean(params.spec_path || params.requirements?.length);
	return { text: `${markdown}\n\n${leadJudgmentInstructions(hasSpec)}`, markdown, details };
}

/** Validate a brief file's JSON into a ReviewRequest; wrong-typed fields are errors, unknown keys ignored. */
export function parseReviewRequest(raw: unknown): ReviewRequest | { error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "brief must be a JSON object" };
	const o = raw as Record<string, unknown>;
	const req: ReviewRequest = {};
	const str = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (typeof o[k] !== "string") throw new Error(`"${k}" must be a string`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	const strs = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string")) throw new Error(`"${k}" must be an array of strings`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	const bool = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (typeof o[k] !== "boolean") throw new Error(`"${k}" must be true or false`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	try {
		// A list of focus areas is a harmless shape slip; join instead of failing the run.
		if (Array.isArray(o.focus) && o.focus.every((x) => typeof x === "string")) o.focus = (o.focus as string[]).join("; ");
		str("intent"); str("spec_path"); str("focus");
		strs("requirements"); strs("suspicions"); strs("context_files");
		bool("verify"); bool("quick");
		if (o.scope !== undefined) {
			if (o.scope !== "diff" && o.scope !== "area") throw new Error(`"scope" must be "diff" or "area"`);
			req.scope = o.scope;
		}
		if (o.pr_number !== undefined) {
			if (typeof o.pr_number !== "number" || !Number.isInteger(o.pr_number) || o.pr_number <= 0) throw new Error(`"pr_number" must be a positive integer`);
			req.pr_number = o.pr_number;
		}
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	return req;
}

/**
 * Headless entry for other harnesses:
 * `pi -p "/multi-review-run --brief=b.json [--out=r.json] [--max-seconds=540]" < /dev/null`.
 * The run fits its phases into --max-seconds (default 540: inside a 10-minute
 * shell cap) by shrinking reviewer/verifier timeouts and skipping
 * verification when too little time is left, never by overrunning.
 * Writes `{ok, text, markdown, details}` JSON plus a `.md` of `text` next to
 * it and sets a non-zero exit code on failure (with `{ok:false, error}`
 * written). Progress and the final `OK|FAILED <paths>` line go to stderr:
 * pi's print mode redirects stdout, so callers should pass --out and rely
 * on it plus the exit code.
 */
const HEADLESS_DEFAULT_MAX_SECONDS = 540;

async function runHeadless(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	process.env.MULTI_REVIEW_DEBUG ||= "1";
	const started = Date.now();
	const briefFlag = parseValueFlag(args, "brief");
	const outFlag = parseValueFlag(briefFlag.rest, "out");
	const maxFlag = parseValueFlag(outFlag.rest, "max-seconds");
	const maxSeconds = maxFlag.value ? Number(maxFlag.value) : HEADLESS_DEFAULT_MAX_SECONDS;
	const outPath = path.resolve(ctx.cwd, outFlag.value ?? path.join(os.tmpdir(), `multi-review-${Date.now()}.json`));
	const mdPath = outPath.replace(/\.json$/, "") + ".md";
	const fail = (error: string) => {
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify({ ok: false, error }, null, 2) + "\n");
		console.error(`multi-review-run: ${error}`);
		console.error(`FAILED ${outPath}`);
		process.exitCode = 1;
	};
	if (!briefFlag.value) return fail("missing --brief=<path to brief JSON>");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, briefFlag.value), "utf8"));
	} catch (err) {
		return fail(`cannot read brief ${briefFlag.value}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const req = parseReviewRequest(raw);
	if ("error" in req) return fail(`invalid brief: ${req.error}`);
	if (!Number.isFinite(maxSeconds) || maxSeconds < 60) return fail("--max-seconds must be a number ≥ 60");
	let out: Awaited<ReturnType<typeof runAgentLedReview>>;
	try {
		out = await runAgentLedReview(pi, ctx, req, undefined, undefined, started + maxSeconds * 1000);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	if ("error" in out) return fail(out.error);
	const { target, ...rest } = out.details;
	const details = { ...rest, scope: target.label, warnings: target.warnings };
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify({ ok: true, text: out.text, markdown: out.markdown, details }, null, 2) + "\n");
	fs.writeFileSync(mdPath, out.text + "\n");
	console.error(`OK ${mdPath} ${outPath}`);
}

const ARG_COMPLETIONS: Array<{ token: string; label: string; description: string }> = [
	{ token: "--spec=", label: "--spec=<path>", description: "review the implementation against a spec file" },
	{ token: "--verify", label: "--verify", description: "cross-check each finding with reviewers who didn't raise it" },
	{ token: "--quick", label: "--quick", description: "fast reviewer pool, no tools" },
	{ token: "--direct", label: "--direct", description: "skip the main agent; external judge synthesizes" },
	{ token: "#", label: "#<pr>", description: "review a PR by number" },
];

/**
 * Complete only the token being typed. The returned value replaces the whole
 * argument string, so it must carry everything before that token — a static
 * list (or an empty "(default)" item) would wipe typed args on Enter.
 */
export function completeReviewArgs(prefix: string): Array<{ value: string; label: string; description?: string }> | null {
	const lastSpace = prefix.lastIndexOf(" ");
	const head = prefix.slice(0, lastSpace + 1);
	const token = prefix.slice(lastSpace + 1);
	if (token && !token.startsWith("-") && !token.startsWith("#")) return null;
	const items = ARG_COMPLETIONS
		.filter((c) => c.token.startsWith(token) && c.token !== token)
		.map((c) => ({ value: head + c.token, label: c.label, description: c.description }));
	return items.length > 0 ? items : null;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const cfg = loadConfig();
		setStatus(`multi-review · ${describePool(cfg)}`, ctx);
		ctx.ui.notify(`multi-review loaded · ${describePool(cfg)}`, "info");
	});

	pi.registerMessageRenderer("multi-review", renderMultiReviewMessage as unknown as Parameters<ExtensionAPI["registerMessageRenderer"]>[1]);

	/**
	 * Run the full pipeline OR fall back to the picker when the pool is empty
	 * AND UI is available. Centralized so both `/multi-review` and the tool
	 * benefit from the same fallback behavior.
	 */
	async function runWithOptionalPicker(args: string, ctx: ExtensionContext): Promise<void> {
		const cfg = loadConfig();
		if (cfg.reviewers.length === 0 && ctx.hasUI) {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length > 0) {
				const open = await ctx.ui.confirm(
					"No reviewers configured — pick now?",
					"multi-review.json has no 'reviewers' array. Open the picker so you can select models from your registry? (cancellable; existing file is preserved except for the 'reviewers' key on save.)",
				);
				if (open) {
					ctx.ui.notify("multi-review: opening reviewer picker…", "info");
					const picked = await pickReviewersViaTUI(ctx, available, []);
					if (!picked || picked.length === 0) {
						ctx.ui.notify("multi-review: picker cancelled; nothing to do.", "warning");
						return;
					}
					const persist = await ctx.ui.confirm(
						"Save reviewers to multi-review.json?",
						`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json so future /multi-review invocations use this pool without the picker? ` +
							`(Pick "no" to use the selection for THIS run only without persisting.)`,
					);
					if (persist) {
						const result = persistReviewerChoices(picked);
						if (result.ok) {
							ctx.ui.notify(`multi-review · saved ${picked.length} reviewers to ${result.path}`, "info");
							cacheConfigForFreshRead();
						} else {
							ctx.ui.notify(`multi-review · could not save (${result.error}); proceeding for this run only`, "warning");
							TRANSIENT_REVIEWERS = picked;
						}
					} else {
						ctx.ui.notify("multi-review · using picked pool for this run only (not persisted)", "info");
						TRANSIENT_REVIEWERS = picked;
					}
				}
			}
		}
		// Hand off to the main agent unless asked not to, or there's no agent
		// turn to hand off to (print/RPC modes exit when the command returns).
		const direct = parseBoolFlag(args, "direct");
		args = direct.rest;
		if (!direct.present && ctx.hasUI && ctx.model) {
			const { flags, rest: afterFlags } = parseReviewFlags(args, { verify: cfg.verify, quick: false });
			const { value: specPath, rest } = parseValueFlag(afterFlags, "spec");
			if (specPath) {
				const spec = readSpecFile(ctx.cwd, specPath);
				if ("error" in spec) {
					ctx.ui.notify(`multi-review: ${spec.error}`, "error");
					return;
				}
			}
			const prompt = buildHandoffPrompt(rest, flags, specPath);
			if (ctx.isIdle()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			return;
		}
		const result = await runMultiReviewFromArgs(pi, ctx, args, undefined);
		ctx.ui.notify(result.notifyMessage, result.notifyLevel);
		if (result.injectMessage) {
			pi.sendMessage({ ...result.injectMessage, display: true });
		}
	}

	// Slash command — surface-level UI entry point.
	pi.registerCommand("multi-review", {
		description:
			"Fan-out code review across configured models. Usage: " +
			"/multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number | free-text focus]. " +
			"The main agent drafts the reviewer brief from your args (and spec), then judges the results. " +
			"--direct skips the agent and uses the configured judge.",
		// Argument autocomplete hints the call shape so users don't have to
		// remember to type '#' vs raw digits.
		getArgumentCompletions: (prefix) => completeReviewArgs(prefix),
		handler: async (args, ctx) => {
			// Slash commands fire outside active turns, so ctx.signal is
			// undefined; we pass undefined and accept that the user can't
			// hard-cancel mid-fan-out from here. The tool surface (next
			// sibling) does pass signal — ctrl+c in tool context works.
			await runWithOptionalPicker(args, ctx);
		},
	});

	// Headless entry for other harnesses (Claude Code etc.): brief in, findings out.
	pi.registerCommand("multi-review-run", {
		description:
			"Headless review for external harnesses: /multi-review-run --brief=<brief.json> [--out=<result.json>] [--max-seconds=540]. " +
			"Brief fields mirror the multi_review tool. Writes findings + lead instructions to <out> and <out>.md.",
		handler: async (args, ctx) => {
			await runHeadless(pi, args, ctx);
		},
	});

	// Slash command — picker entry point. Opens the multi-select TUI
	// directly without running the rest of the pipeline. Useful for
	// configuring the pool in advance without dragging scope into it.
	pi.registerCommand("multi-review-pick", {
		description:
			"Open the multi-select picker for reviewer models. " +
			"Saves selection to ~/.pi/agent/multi-review.json on confirm.",
		handler: async (_args, ctx) => {
			const available = await ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify(
					"multi-review-pick: no models in registry. Add them to ~/.pi/agent/models.json or /login first.",
					"error",
				);
				return;
			}
			const cfg = loadConfig();
			const picked = await pickReviewersViaTUI(ctx, available, cfg.reviewers);
			if (!picked || picked.length === 0) {
				ctx.ui.notify("multi-review-pick: cancelled.", "info");
				return;
			}
			const persist = await ctx.ui.confirm(
				"Save reviewers to multi-review.json?",
				`Persist ${picked.length} reviewer${picked.length === 1 ? "" : "s"} to ~/.pi/agent/multi-review.json? ` +
					`${
						cfg.judge
							? `(existing judge ${cfg.judge} will be preserved)`
							: `(existing judge ${DEFAULTS.judge} will be set as the default if missing)`
					}`,
			);
			if (!persist) {
				ctx.ui.notify("multi-review-pick: cancelled at persist step.", "info");
				return;
			}
			const result = persistReviewerChoices(picked);
			if (result.ok) {
				ctx.ui.notify(`multi-review-pick · saved ${picked.length} reviewers to ${result.path}`, "info");
				cacheConfigForFreshRead();
			} else {
				ctx.ui.notify(`multi-review-pick · save failed: ${result.error}`, "error");
			}
		},
	});

	// LLM-callable tool — the main agent briefs the reviewers and judges the results.
	pi.registerTool({
		name: "multi_review",
		label: "Multi-Model Code Review",
		description:
			"Send a code change to N reviewer models (other model families, each with read-only repo access) in parallel. " +
			"You write the brief: intent, optional spec + requirements, related files, focus. Returns deduplicated findings " +
			"with per-model attribution; you then act as lead reviewer and give the user a verdict. Read-only — never edits code.",
		promptSnippet:
			"Run a multi-model code review on the current change (PR, working-tree diff, or a described area), optionally against a spec.",
		promptGuidelines: [
			"Use multi_review when the user asks for a code review, a second opinion, or a check of an implementation against a spec.",
			"Before calling, understand the change yourself and write the brief: reviewers do not see the conversation. Give them what they can't discover, not where you think the bugs are — independent discovery is what makes their agreement meaningful.",
			"`intent`: goals plus facts reviewers can't find in the repo (external API behaviour, constraints, out-of-scope items) — not a narration of the implementation. With a spec, pass spec_path and list its checkable requirements.",
			"`focus`: risk areas only, never hypotheses. Put your specific bug hypotheses in `suspicions`; they are hidden from reviewers and checked against what they find on their own.",
			"`context_files` are repo paths reviewers should read in full (callers, types, tests) — not files already whole in the diff.",
			"Set verify=true for high-stakes changes (independent cross-check of every finding); quick=true for small diffs or a cheap first look.",
			"After results return, follow the lead-judgment instructions in the result. Do not apply fixes unless asked.",
		],
		parameters: Type.Object({
			intent: Type.Optional(Type.String({
				description: "One paragraph: what the change is supposed to accomplish and which constraints matter.",
				maxLength: 4000,
			})),
			spec_path: Type.Optional(Type.String({
				description: "Repo-relative path to a spec/design doc. Passed verbatim to reviewers as the source of truth.",
			})),
			requirements: Type.Optional(Type.Array(Type.String({ maxLength: 600 }), {
				description: "Concrete, checkable requirements (usually from the spec) reviewers must verify one by one.",
				maxItems: 40,
			})),
			suspicions: Type.Optional(Type.Array(Type.String({ maxLength: 600 }), {
				description:
					"Your own hypotheses about possible bugs. NOT shown to reviewers (they'd anchor on them); checked against " +
					"what reviewers find independently and, with verify, cross-checked by verifiers.",
				maxItems: 20,
			})),
			context_files: Type.Optional(Type.Array(Type.String(), {
				description: "Repo-relative paths reviewers should see in full beyond the diff (callers, types, tests). Max 12.",
				maxItems: 12,
			})),
			scope: Type.Optional(StringEnum(["diff", "area"] as const, {
				description:
					"'diff' (default): the working-tree diff vs the default branch, or the PR when pr_number is set. " +
					"'area': no diff — review the part of the codebase described in `focus` (reviewers explore it with tools).",
			})),
			pr_number: Type.Optional(Type.Number({
				description: "PR number to review (e.g. 4321 from a GitHub PR URL). Omit to review the working-tree diff.",
				minimum: 0,
			})),
			focus: Type.Optional(Type.String({
				description:
					"Risk AREAS to scrutinize (not hypotheses — use `suspicions`), or, with scope='area', the area to review. " +
					"Examples: 'the token refresh path', 'config-file merge lifecycle'.",
				maxLength: 2000,
			})),
			verify: Type.Optional(Type.Boolean({
				description:
					"Cross-check round: each finding goes to reviewers who did NOT raise it, who confirm or refute it with " +
					"evidence. Roughly doubles cost; use for high-stakes changes or when false positives are expensive.",
			})),
			quick: Type.Optional(Type.Boolean({
				description: "Fast reviewer pool, single completions without tools. For small diffs or a cheap first look.",
			})),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const out = await runAgentLedReview(pi, ctx, params, signal, onUpdate);
			if ("error" in out) throw new Error(out.error);
			return {
				content: [{ type: "text", text: out.text }],
				details: { ...out.details, markdown: out.markdown },
			};
		},
		renderResult(result, options, theme) {
			const details = result.details as MultiReviewDetails | undefined;
			if (options.isPartial || !details?.groups) {
				const text = result.content.find((c) => c.type === "text");
				return new Text(theme.fg("dim", text && "text" in text ? text.text : "multi-review running…"), 0, 0);
			}
			return renderMultiReviewMessage(
				{ content: details.markdown ?? "", details },
				{ expanded: options.expanded },
				theme as unknown as Parameters<typeof renderMultiReviewMessage>[2],
				undefined,
			) as ReturnType<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>;
		},
	});
}

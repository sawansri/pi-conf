import { type AgentSessionEvent, type ExtensionContext, createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { createGitTool, createProgressTool, createRunTool } from "./agent-tools.ts";
import { type LateSession, StragglerCutoff, armWarning, harvest, startDeadline } from "./deadline.ts";
import { type Model, type ReviewerSpec, type ThinkingLevelAlias, formatReviewerSpec } from "./config.ts";
import type { ModelUsage } from "./cost.ts";
import { type ReviewerFinding, type ReviewerRunResult, parseReviewerJson } from "./findings.ts";
import { type ModelCallResult, callModel } from "./models.ts";
import type { MultiReviewRunResult } from "./pipeline.ts";
import { REVIEWER_REPRO_ADDENDUM, REVIEWER_TOOLS_ADDENDUM, SOCRATIC_TOOLS_ADDENDUM, VERIFIER_RUN_ADDENDUM, XREF_ADDENDUM, checksRecitation, modelAddendum } from "./prompts.ts";
import { type SandboxExtras } from "./sandbox.ts";
import { createBudgetedReadTools } from "./session-tools.ts";
import { ReviewTrace, type ReviewerActivity } from "./trace.ts";
import { abortable, lastTurnAssistantText, retryOnError } from "./util.ts";
import { type WebSearchOptions, NO_WEB_ADDENDUM, createWebSearchTool, installNativeWebSearch, searchesNatively, webSearchAddendum, webSearchAvailable } from "./web-search.ts";
import { XrefService, createXrefTool } from "./xref.ts";

/** A bare `[]` (optionally fenced): the reviewer says there's nothing to report. */
export function isEmptyFindingsReply(text: string): boolean {
	return /^\s*(```(?:json)?\s*)?\[\s*\]\s*(```)?\s*$/.test(text);
}

/** The session's last assistant turn ended in a provider safety filter (finish_reason content_filter). */
export function endedInContentFilter(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
		if (m?.role !== "assistant") continue;
		return m.stopReason === "error" && (m.errorMessage ?? "").includes("content_filter");
	}
	return false;
}

export const CONTENT_FILTER_RETRIES = 1;

export const CONTENT_FILTER_RETRY_PROMPT =
	"Your last reply was blocked by the provider's content filter, most likely for quoting source code verbatim. " +
	"Continue from where you left off: you keep everything you have read. Describe code in your own words and cite file:line instead of quoting it; quote at most a few identifiers.";

/**
 * session.prompt that re-prompts the same session when a turn ends in
 * content_filter. Gemini's recitation check trips on quoted code, about 1 in
 * 4 of Argon's verifier runs, often after minutes of tool use; pi drops the
 * errored turn from the context, so the retry keeps every file read so far.
 */
export function promptWithFilterRetry(
	session: { prompt(text: string): Promise<void>; readonly messages: readonly unknown[] },
	signal: AbortSignal,
	onEvent?: (event: AgentSessionEvent) => void,
): (text: string) => Promise<void> {
	const aborted = new Error("aborted");
	const once = (text: string) => abortable(session.prompt(text), signal, () => { throw aborted; });
	let retries = CONTENT_FILTER_RETRIES;
	return async (text) => {
		await once(text);
		while (retries > 0 && !signal.aborted && endedInContentFilter(session.messages)) {
			retries--;
			onEvent?.({ type: "multi_review_filter_retry" } as unknown as AgentSessionEvent);
			await once(CONTENT_FILTER_RETRY_PROMPT);
		}
	};
}

export interface AgenticExtras {
	/** Directory for the sandboxed `run` tool; unset means no `run`. */
	runDir?: string;
	sandboxHomeDirs?: string[];
	sandboxExtras?: SandboxExtras;
	xref?: XrefService;
	webSearch?: WebSearchOptions;
	/** Nudge once when the reply is [] after fewer non-progress tool calls than this. */
	minToolCalls?: number;
	/** Warn, then harvest, a straggling session; see deadline.ts. */
	late?: LateSession;
	/** Cap on one read/grep result's text; see tool-budget.ts. 0 = pi's default. */
	readMaxChars?: number;
}

export interface ReviewerSession {
	promptTurn(
		userPrompt: string,
		signal: AbortSignal,
		onEvent?: (event: AgentSessionEvent) => void,
		nudgeIfEmptyPrompt?: string,
		late?: LateSession,
	): Promise<ModelCallResult>;
	dispose(): void;
}


/**
 * Create a nested pi agent session with the review toolset (read, grep, find,
 * ls, git, progress, plus xref, web_search, and sandboxed run when configured).
 * Can be prompted across multiple turns (used by Socratic discussions so
 * participants retain the files they read in Round 1 when cross-examining in
 * Round 2).
 */
export async function createReviewerSession(
	ctx: ExtensionContext,
	model: Model,
	thinking: ThinkingLevelAlias,
	systemPrompt: string,
	cwd: string = ctx.cwd,
	extras: AgenticExtras = {},
): Promise<ReviewerSession> {
	const progressState: NonNullable<Parameters<typeof createProgressTool>[0]> = { plan: [], done: 0, calls: 0 };
	const customTools: Array<ReturnType<typeof createProgressTool> | ReturnType<typeof createGitTool> | ReturnType<typeof createRunTool> | ReturnType<typeof createXrefTool> | ReturnType<typeof createWebSearchTool>> = [
		createProgressTool(progressState),
		createGitTool(cwd),
	];
	if (extras.runDir) customTools.push(createRunTool(extras.runDir, extras.sandboxHomeDirs ?? [], extras.sandboxExtras));
	if (extras.xref) customTools.push(createXrefTool(extras.xref));
	const ws = extras.webSearch;
	const nativeSearch = searchesNatively(model, ws);
	if (ws?.proxyModel && !nativeSearch) customTools.push(createWebSearchTool(ctx, ws.proxyModel));	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
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
		cwd,
		model,
		thinkingLevel: thinking,
		tools: ["read", "grep", "find", "ls", ...customTools.map((t) => t.name)],
		customTools: [...customTools, ...(extras.readMaxChars ? (createBudgetedReadTools(cwd, extras.readMaxChars) as never[]) : [])],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	let activeOnEvent: ((event: AgentSessionEvent) => void) | undefined;
	if (nativeSearch) installNativeWebSearch(session, (ev) => activeOnEvent?.(ev));

	return {
		async promptTurn(userPrompt, signal, onEvent, nudgeIfEmptyPrompt, late) {
			const started = Date.now();
			progressState.plan = [];
			progressState.done = 0;
			progressState.secondsLeft = undefined;
			const unwarn = armWarning(session, late, progressState, onEvent);
			const statsBefore = session.getSessionStats();
			const msgCountBefore = session.messages.length;
			// Cache tokens belong in the delta: dropping them reports a long
			// tool-using turn as tiny when most of it was a cached resend. Shared
			// by the normal and harvested returns so neither path loses them.
			const deltaUsage = (): ModelUsage => {
				const after = session.getSessionStats();
				const d = (k: "input" | "output" | "cacheRead" | "cacheWrite" | "total") =>
					Math.max(0, (after.tokens[k] ?? 0) - (statsBefore.tokens[k] ?? 0));
				return {
					input: d("input"),
					output: d("output"),
					total: d("total"),
					cost: Math.max(0, after.cost - statsBefore.cost),
					cacheRead: d("cacheRead"),
					cacheWrite: d("cacheWrite"),
				};
			};
			const turnResult = (text: string): ModelCallResult => {
				const statsAfter = session.getSessionStats();
				return {
					text,
					stopReason: "stop",
					usage: deltaUsage(),
					toolCalls: Math.max(0, statsAfter.toolCalls - statsBefore.toolCalls),
					durationMs: Date.now() - started,
				};
			};
			activeOnEvent = onEvent;
			const onAbort = () => void session.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
			try {
				if (signal.aborted) throw new Error("aborted before start");
				const prompt = promptWithFilterRetry(session, signal, onEvent);
				await prompt(userPrompt);
				let text = lastTurnAssistantText(session.messages.slice(msgCountBefore));
				if (!signal.aborted && !text.trim() && nudgeIfEmptyPrompt) {
					await prompt(nudgeIfEmptyPrompt);
					text = lastTurnAssistantText(session.messages.slice(msgCountBefore));
				}
				const statsAfter = session.getSessionStats();
				const turnMessages = session.messages.slice(msgCountBefore);
				const last = [...turnMessages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
					| { stopReason?: string; errorMessage?: string }
					| undefined;
				const stopReason = last?.stopReason ?? "stop";
				let errorMessage: string | undefined;
				if (signal.aborted) {
					const harvested = await harvest(session, late, onEvent, msgCountBefore);
					if (harvested) return { ...turnResult(harvested), partial: String(late!.deadline.cut.reason) };
					errorMessage = `aborted: ${String(signal.reason ?? "cancelled")}`;
				} else if (stopReason === "error" || stopReason === "aborted") errorMessage = `${stopReason}: ${last?.errorMessage ?? "(no message)"}`;
				else if (!text.trim()) errorMessage = "empty response";
				return {
					text,
					stopReason,
					errorMessage,
					usage: deltaUsage(),
					toolCalls: Math.max(0, statsAfter.toolCalls - statsBefore.toolCalls),
					durationMs: Date.now() - started,
				};
			} catch (err) {
				const harvested = signal.aborted ? await harvest(session, late, onEvent, msgCountBefore) : undefined;
				if (harvested) return { ...turnResult(harvested), partial: String(late!.deadline.cut.reason) };
				return {
					text: "",
					stopReason: "error",
					errorMessage: signal.aborted ? `aborted: ${String(signal.reason ?? "cancelled")}` : (err instanceof Error ? err.message : String(err)),
					durationMs: Date.now() - started,
				};
			} finally {
				unwarn();
				activeOnEvent = undefined;
				signal.removeEventListener("abort", onAbort);
				unsubscribe?.();
			}
		},
		dispose() {
			session.dispose();
		},
	};
}

/** The stats shape both `AgentSession`s and the test doubles expose. */
interface SessionStatsLike {
	tokens: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
	cost: number;
	toolCalls: number;
}

/**
 * Cache tokens matter for cost: on these providers a cache read bills at a
 * fraction of fresh input, so a run's price is not input+output alone.
 */
function sessionUsage(stats: SessionStatsLike): ModelUsage {
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		total: stats.tokens.total,
		cost: stats.cost,
		cacheRead: stats.tokens.cacheRead ?? 0,
		cacheWrite: stats.tokens.cacheWrite ?? 0,
	};
}

/** Tool instructions appended to the system prompt for tool-using sessions. */
export function buildToolPromptAddendum(model: Model, runOpts: ReviewerRunOptions, canRun: boolean, socratic = false): string {
	return (
		(socratic ? SOCRATIC_TOOLS_ADDENDUM : REVIEWER_TOOLS_ADDENDUM) +
		(runOpts.xref ? XREF_ADDENDUM : "") +
		(canRun ? VERIFIER_RUN_ADDENDUM : "") +
		(canRun && !socratic && runOpts.tracePhase !== "verify" ? REVIEWER_REPRO_ADDENDUM : "") +
		(webSearchAvailable(model, runOpts.webSearch) ? webSearchAddendum() : NO_WEB_ADDENDUM) +
		modelAddendum(model)
	);
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
	cwd: string = ctx.cwd,
	onEvent?: (event: AgentSessionEvent) => void,
	extras: AgenticExtras = {},
): Promise<ModelCallResult> {
	const started = Date.now();
	const progressState: NonNullable<Parameters<typeof createProgressTool>[0]> = { plan: [], done: 0, calls: 0 };
	const customTools: Array<ReturnType<typeof createProgressTool> | ReturnType<typeof createGitTool> | ReturnType<typeof createRunTool> | ReturnType<typeof createXrefTool> | ReturnType<typeof createWebSearchTool>> = [
		createProgressTool(progressState),
		createGitTool(cwd),
	];
	if (extras.runDir) customTools.push(createRunTool(extras.runDir, extras.sandboxHomeDirs ?? [], extras.sandboxExtras));
	if (extras.xref) customTools.push(createXrefTool(extras.xref));
	// Native search where the gateway serves it for this model's API, else the proxied tool.
	const ws = extras.webSearch;
	const nativeSearch = searchesNatively(model, ws);
	if (ws?.proxyModel && !nativeSearch) customTools.push(createWebSearchTool(ctx, ws.proxyModel));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
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
		cwd,
		model,
		thinkingLevel: thinking,
		tools: ["read", "grep", "find", "ls", ...customTools.map((t) => t.name)],
		customTools: [...customTools, ...(extras.readMaxChars ? (createBudgetedReadTools(cwd, extras.readMaxChars) as never[]) : [])],
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	if (nativeSearch) installNativeWebSearch(session, onEvent);
	const unwarn = armWarning(session, extras.late, progressState, onEvent);
	const onAbort = () => void session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
	try {
		if (signal.aborted) throw new Error("aborted before start");
		const prompt = promptWithFilterRetry(session, signal, onEvent);
		await prompt(userPrompt);
		// Agent turns sometimes end on a tool result or thinking with no final
		// answer; one in-session nudge recovers it with the context intact.
		if (!signal.aborted && !(session.getLastAssistantText() ?? "").includes("[")) {
			await prompt("Your final message must be ONLY the JSON array described in the system prompt. Output it now.");
		}
		// A quick "no findings" usually means the reviewer stopped looking, not
		// that the change is clean: one nudge back to its plan and the brief.
		const work = session.getSessionStats().toolCalls - progressState.calls;
		if (extras.minToolCalls && !signal.aborted && work < extras.minToolCalls && isEmptyFindingsReply(session.getLastAssistantText() ?? "")) {
			onEvent?.({ type: "multi_review_nudge", toolCalls: work } as unknown as AgentSessionEvent);
			const plan = progressState.plan.length
				? ` Your plan was: ${progressState.plan.map((p, i) => `(${i + 1}) ${p}`).join("; ")}. You reported finishing ${progressState.done} of ${progressState.plan.length}.`
				: "";
			const before = session.getLastAssistantText() ?? "";
			try {
				await prompt(
					`You concluded there are no findings after only ${work} tool call${work === 1 ? "" : "s"}, which is too little to rule out problems in this change.${plan} ` +
						"Before concluding, use your tools to trace the changed functions' callers and the tests that cover them, check each focus area and requirement in the brief, and use git blame/log on the touched lines. " +
						"Then output the JSON array again: [] only if you still find nothing.",
				);
				if (!signal.aborted && !(session.getLastAssistantText() ?? "").includes("[")) {
					await prompt("Your final message must be ONLY the JSON array described in the system prompt. Output it now.");
				}
			} catch {
				// Timed out mid-nudge: fall through to the fallback below.
			}
			// Cut mid-nudge: what it found since may still come out in the harvest.
			const harvested = signal.aborted ? await harvest(session, extras.late, onEvent) : undefined;
			if (harvested?.includes("[")) return harvestedResult(session, harvested, extras.late!, started);
			// The nudge only adds; a timeout or a non-answer during it must not
			// cost the reviewer the valid [] it already gave.
			const after = session.getLastAssistantText() ?? "";
			if (signal.aborted || !after.includes("[")) {
				const stats = session.getSessionStats();
				return {
					text: before,
					stopReason: "stop",
					usage: sessionUsage(stats),
					toolCalls: stats.toolCalls,
					durationMs: Date.now() - started,
				};
			}
		}
		const stats = session.getSessionStats();
		const last = [...session.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
			| { stopReason?: string; errorMessage?: string }
			| undefined;
		const stopReason = last?.stopReason ?? "stop";
		let errorMessage: string | undefined;
		if (signal.aborted) {
			const harvested = await harvest(session, extras.late, onEvent);
			if (harvested) return harvestedResult(session, harvested, extras.late!, started);
			errorMessage = `aborted: ${String(signal.reason ?? "cancelled")}`;
		} else if (stopReason === "error" || stopReason === "aborted") errorMessage = `${stopReason}: ${last?.errorMessage ?? "(no message)"}`;
		return {
			text: session.getLastAssistantText() ?? "",
			stopReason,
			errorMessage,
			usage: sessionUsage(stats),
			toolCalls: stats.toolCalls,
			durationMs: Date.now() - started,
		};
	} catch (err) {
		const harvested = signal.aborted ? await harvest(session, extras.late, onEvent) : undefined;
		if (harvested) return harvestedResult(session, harvested, extras.late!, started);
		return {
			text: "",
			stopReason: "error",
			errorMessage: signal.aborted ? `aborted: ${String(signal.reason ?? "cancelled")}` : (err instanceof Error ? err.message : String(err)),
			durationMs: Date.now() - started,
		};
	} finally {
		unwarn();
		signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		session.dispose();
	}
}

function harvestedResult(
	session: { getSessionStats(): SessionStatsLike },
	text: string,
	late: LateSession,
	started: number,
): ModelCallResult {
	const stats = session.getSessionStats();
	return {
		text,
		stopReason: "stop",
		usage: sessionUsage(stats),
		toolCalls: stats.toolCalls,
		durationMs: Date.now() - started,
		partial: String(late.deadline.cut.reason),
	};
}

/** The reply format a harvested review or verify session must use. */
const JSON_FINAL_FORMAT = "Output ONLY the JSON your instructions describe, with no prose around it.";

const JSON_REPAIR_PROMPT = `The text below should contain a JSON array of code-review findings but fails to parse. Output ONLY the corrected JSON array with the same findings and wording — escape quotes, backslashes, and newlines inside strings. Do not add, drop, or change findings.`;

/** Re-emitting quoted code verbatim is exactly what trips a recitation check. */
const JSON_REPAIR_NO_QUOTE = " Exception: replace any source code quoted verbatim with its file:line.";

export interface ReviewerRunOptions {
	/** Nested agent with read-only repo tools instead of a single completion. */
	useTools: boolean;
	timeoutMs: number;
	/** Directory reviewers' tools see (a PR-head worktree for PR reviews); default ctx.cwd. */
	cwd?: string;
	/** Live per-session trace the lead can watch (progress.json, trace.jsonl). */
	trace?: ReviewTrace;
	tracePhase?: ReviewerActivity["phase"];
	/** Sandbox is usable: verifiers get the `run` tool. */
	sandbox?: boolean;
	sandboxHomeDirs?: string[];
	sandboxExtras?: SandboxExtras;
	/** clangd navigation for C/C++ reviews, shared by every session in the run. */
	xref?: XrefService;
	/** Web search for reviewer and verifier sessions; unset means none. */
	webSearch?: WebSearchOptions;
	/** Run when the review ends (the caller's finally), e.g. stopping clangd. */
	cleanups?: Array<() => void>;
	/** Review phase only: see AgenticExtras.minToolCalls. */
	minToolCalls?: number;
	/** Cap on one read/grep result's text (tool-budget.ts); 0 = pi's default. */
	readMaxChars?: number;
	/** The fan-out's straggler cutoff; set by runAllReviewers. */
	cutoff?: StragglerCutoff;
	/** The session's name in the trace when not just its spec (a second pass's "#2"). */
	traceName?: string;
}

export async function runReviewer(
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
	const deadline = startDeadline(runOpts.timeoutMs, runOpts.cutoff, { harvest: runOpts.useTools });
	const signal = abortSignal ? AbortSignal.any([abortSignal, deadline.cut]) : deadline.cut;
	// Late work (the harvest, a JSON repair after it) runs to the hard end.
	const lateSignal = abortSignal ? AbortSignal.any([abortSignal, deadline.end]) : deadline.end;
	const tracer = runOpts.trace?.start(runOpts.traceName ?? formatReviewerSpec(reviewerSpec), runOpts.tracePhase ?? "review", runOpts.cwd ?? ctx.cwd);
	const verifying = runOpts.tracePhase === "verify";
	// Reviewers run their own repros; verifiers run code to settle claims.
	const canRun = Boolean(runOpts.sandbox);
	// Each retry starts a fresh session: an errored one may have dropped its stream mid-turn.
	const call = await retryOnError(signal, () => runOpts.useTools
		? runAgenticReviewer(
			ctx, model, reviewerSpec.thinking,
			systemPrompt + buildToolPromptAddendum(model, runOpts, canRun, false),
			userPrompt, signal, runOpts.cwd ?? ctx.cwd, tracer?.onEvent,
			{
				runDir: canRun ? runOpts.cwd ?? ctx.cwd : undefined,
				sandboxHomeDirs: runOpts.sandboxHomeDirs,
				sandboxExtras: runOpts.sandboxExtras,
				xref: runOpts.xref,
				webSearch: runOpts.webSearch,
				minToolCalls: verifying ? undefined : runOpts.minToolCalls,
				late: { deadline, userSignal: abortSignal, finalFormat: JSON_FINAL_FORMAT },
				readMaxChars: runOpts.readMaxChars,
			},
		)
		: callModel(ctx, model, systemPrompt + modelAddendum(model), userPrompt, {
			thinking: reviewerSpec.thinking,
			temperature,
			signal,
		}), (retry, error) => tracer?.onEvent({ type: "multi_review_error_retry", retry, error } as unknown as AgentSessionEvent));
	// Cut while waiting to retry an error: say both.
	if (call.errorMessage && deadline.cut.aborted && !abortSignal?.aborted) {
		call.errorMessage = call.errorMessage.startsWith("aborted") ? String(deadline.cut.reason) : `${String(deadline.cut.reason)}, retrying after: ${call.errorMessage}`;
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
			const fixed = call.text.includes("[") && !lateSignal.aborted
				? await callModel(ctx, model, JSON_REPAIR_PROMPT + (checksRecitation(model) ? JSON_REPAIR_NO_QUOTE : ""), `Parse error: ${first}\n\n${call.text}`, {
					thinking: "low",
					temperature: 0,
					signal: lateSignal,
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
	deadline.dispose();
	const partial = call.partial ? ` (partial: ${call.partial})` : "";
	tracer?.finish(errorMessage === undefined, errorMessage ?? `${runOpts.tracePhase === "verify" ? "done" : `${findings.length} findings`}${partial}`);
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
		...(call.partial ? { partial: call.partial } : {}),
	};
}

const MAX_PARALLEL = 16;

/** Workers bail early on abort, leaving holes in result arrays; never let those flow downstream. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("multi-review aborted");
}

/**
 * When no reviewer produced usable output, the run has no signal at all —
 * report the failures instead of publishing an empty "clean" review.
 */
export function allReviewersFailedResult(runs: ReviewerRunResult[], mode: string): MultiReviewRunResult | null {
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
export async function runAllReviewers(
	resolved: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean; pass?: number }>,
	systemPrompt: string,
	/** A string, or per row (a second pass gets the diff's files reversed). */
	userPrompt: string | ((row: { pass?: number }) => string),
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

	// Straggler cutoff: once a quorum has answered, the rest get as long
	// again as the quorum took (min STRAGGLER_MIN_GRACE_MS, and never before
	// STRAGGLER_MIN_TOTAL_MS overall). A degraded endpoint otherwise holds
	// the whole review hostage until its full timeout.
	// Each session is warned when this is set, and harvested at the cut.
	const started = Date.now();
	const quorum = stragglerQuorum(total);
	const cutoff = new StragglerCutoff();
	const phaseOpts: ReviewerRunOptions = { ...runOpts, cutoff };
	let okCount = 0;
	const noteFinished = (ok: boolean) => {
		if (ok) okCount++;
		if (cutoff.cutAt !== undefined || okCount < quorum || done >= total) return;
		const quorumMs = Date.now() - started;
		const graceMs = Math.max(STRAGGLER_MIN_GRACE_MS, quorumMs * STRAGGLER_GRACE_FACTOR, STRAGGLER_MIN_TOTAL_MS - quorumMs);
		cutoff.arm(
			Date.now() + graceMs,
			`cut as straggler: ${quorum}/${total} reviewers finished in ${Math.round(quorumMs / 1000)}s, waited ${Math.round(graceMs / 1000)}s more`,
			`${okCount} of ${total} reviewers have finished`,
		);
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
				const prompt = typeof userPrompt === "string" ? userPrompt : userPrompt(slot);
				const partial = await runReviewer(slot.model, slot.rs, ctx, systemPrompt, prompt, temperature, abortSignal, slot.pass ? { ...phaseOpts, traceName: formatRunSpec(slot) } : phaseOpts);
				const full: ReviewerRunResult = {
					formattedSpec: formatRunSpec(slot),
					...(slot.pass ? { pass: slot.pass } : {}),
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
					formattedSpec: formatRunSpec(slot),
					...(slot.pass ? { pass: slot.pass } : {}),
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
	throwIfAborted(abortSignal);
	return results;
}

/** A reviewer's spec as shown, with " #2" on a model's second pass. */
export function formatRunSpec(row: { rs: ReviewerSpec; pass?: number }): string {
	return formatReviewerSpec(row.rs) + (row.pass ? ` #${row.pass}` : "");
}

export const STRAGGLER_MIN_GRACE_MS = 45_000;
export const STRAGGLER_GRACE_FACTOR = 1.0;
/**
 * Stragglers are never cut before this much total time. Reviewer times vary
 * 2-5x between runs, so a deadline relative to a fast quorum alone cut
 * healthy main reviewers (Argon@medium ~270s, gpt-6.1-sol@high ~160s).
 * reviewerTimeoutSec still caps the wait.
 */
export const STRAGGLER_MIN_TOTAL_MS = 300_000;

/** Successful answers needed before stragglers get a deadline; pools of ≤2 always wait for everyone. */
export function stragglerQuorum(total: number): number {
	if (total <= 2) return Number.POSITIVE_INFINITY;
	return Math.max(2, Math.ceil((total * 2) / 3));
}

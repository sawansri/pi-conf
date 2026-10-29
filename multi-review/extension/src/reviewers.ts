import { type AgentSessionEvent, type ExtensionContext, createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { createGitTool, createProgressTool, createRunTool } from "./agent-tools.ts";
import { type Model, type ReviewerSpec, type ThinkingLevelAlias, formatReviewerSpec } from "./config.ts";
import { type ReviewerFinding, type ReviewerRunResult, parseReviewerJson } from "./findings.ts";
import { type ModelCallResult, callModel } from "./models.ts";
import type { MultiReviewRunResult } from "./pipeline.ts";
import { REVIEWER_TOOLS_ADDENDUM, VERIFIER_RUN_ADDENDUM, XREF_ADDENDUM } from "./prompts.ts";
import type { SandboxExtras } from "./sandbox.ts";
import { ReviewTrace, type ReviewerActivity } from "./trace.ts";
import { abortable, withTimeout } from "./util.ts";
import { XrefService, createXrefTool } from "./xref.ts";

/** A bare `[]` (optionally fenced): the reviewer says there's nothing to report. */
export function isEmptyFindingsReply(text: string): boolean {
	return /^\s*(```(?:json)?\s*)?\[\s*\]\s*(```)?\s*$/.test(text);
}

export interface AgenticExtras {
	/** Directory for the sandboxed `run` tool; unset means no `run`. */
	runDir?: string;
	sandboxHomeDirs?: string[];
	sandboxExtras?: SandboxExtras;
	xref?: XrefService;
	/** Nudge once when the reply is [] after fewer non-progress tool calls than this. */
	minToolCalls?: number;
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
	const progressState = { plan: [] as string[], done: 0, calls: 0 };
	const customTools: Array<ReturnType<typeof createProgressTool> | ReturnType<typeof createGitTool> | ReturnType<typeof createRunTool> | ReturnType<typeof createXrefTool>> = [
		createProgressTool(progressState),
		createGitTool(cwd),
	];
	if (extras.runDir) customTools.push(createRunTool(extras.runDir, extras.sandboxHomeDirs ?? [], extras.sandboxExtras));
	if (extras.xref) customTools.push(createXrefTool(extras.xref));
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
		customTools,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const onAbort = () => void session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
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
			// The nudge only adds; a timeout or a non-answer during it must not
			// cost the reviewer the valid [] it already gave.
			const after = session.getLastAssistantText() ?? "";
			if (signal.aborted || !after.includes("[")) {
				const stats = session.getSessionStats();
				return {
					text: before,
					stopReason: "stop",
					usage: { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total, cost: stats.cost },
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
		unsubscribe?.();
		session.dispose();
	}
}

const JSON_REPAIR_PROMPT = `The text below should contain a JSON array of code-review findings but fails to parse. Output ONLY the corrected JSON array with the same findings and wording — escape quotes, backslashes, and newlines inside strings. Do not add, drop, or change findings.`;

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
	/** Run when the review ends (the caller's finally), e.g. stopping clangd. */
	cleanups?: Array<() => void>;
	/** Review phase only: see AgenticExtras.minToolCalls. */
	minToolCalls?: number;
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
	const signal = withTimeout(abortSignal, runOpts.timeoutMs);
	const tracer = runOpts.trace?.start(formatReviewerSpec(reviewerSpec), runOpts.tracePhase ?? "review", runOpts.cwd ?? ctx.cwd);
	const verifying = runOpts.tracePhase === "verify";
	const canRun = verifying && Boolean(runOpts.sandbox);
	const call = runOpts.useTools
		? await runAgenticReviewer(
			ctx, model, reviewerSpec.thinking,
			systemPrompt + REVIEWER_TOOLS_ADDENDUM + (runOpts.xref ? XREF_ADDENDUM : "") + (canRun ? VERIFIER_RUN_ADDENDUM : ""),
			userPrompt, signal, runOpts.cwd ?? ctx.cwd, tracer?.onEvent,
			{
				runDir: canRun ? runOpts.cwd ?? ctx.cwd : undefined,
				sandboxHomeDirs: runOpts.sandboxHomeDirs,
				sandboxExtras: runOpts.sandboxExtras,
				xref: runOpts.xref,
				minToolCalls: verifying ? undefined : runOpts.minToolCalls,
			},
		)
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
	tracer?.finish(errorMessage === undefined, errorMessage ?? (runOpts.tracePhase === "verify" ? "done" : `${findings.length} findings`));
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

	// Straggler cutoff: once a quorum has answered, the rest get as long
	// again as the quorum took (min STRAGGLER_MIN_GRACE_MS, and never before
	// STRAGGLER_MIN_TOTAL_MS overall). A degraded endpoint otherwise holds
	// the whole review hostage until its full timeout.
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
		const graceMs = Math.max(STRAGGLER_MIN_GRACE_MS, quorumMs * STRAGGLER_GRACE_FACTOR, STRAGGLER_MIN_TOTAL_MS - quorumMs);
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
const STRAGGLER_GRACE_FACTOR = 1.0;
/**
 * Stragglers are never cut before this much total time. Reviewer times vary
 * 2-5x between runs, so a deadline relative to a fast quorum alone cut
 * healthy main reviewers (Argon@medium ~270s, gpt-6.1-sol@high ~160s).
 * reviewerTimeoutSec still caps the wait.
 */
const STRAGGLER_MIN_TOTAL_MS = 300_000;

/** Successful answers needed before stragglers get a deadline; pools of ≤2 always wait for everyone. */
export function stragglerQuorum(total: number): number {
	if (total <= 2) return Number.POSITIVE_INFINITY;
	return Math.max(2, Math.ceil((total * 2) / 3));
}

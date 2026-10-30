import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { GIT_TOOL, RUN_TOOL } from "./agent-tools.ts";
import { type RunSnapshot, shortSpec } from "./progress.ts";
import { WEB_SEARCH_TOOL } from "./web-search.ts";
import { XREF_TOOL } from "./xref.ts";

// ---------- live reviewer trace ----------

/** Tool nested reviewers call to report their plan and each finished item. */
export const PROGRESS_TOOL = "progress";

/** Snapshot/refresh cadence for progress.json and the activity lines. */
const ACTIVITY_REFRESH_MS = 2_000;
/** Stderr heartbeat cadence for print mode. */
export const ACTIVITY_LOG_MS = 30_000;

/** What one reviewer or verifier session is doing right now. */
export interface ReviewerActivity {
	reviewer: string;
	phase: "review" | "verify";
	state: "running" | "ok" | "failed";
	startedAt: number;
	finishedAt?: number;
	turns: number;
	toolCalls: number;
	lastTool?: string;
	/** Characters streamed so far: reasoning, and visible reply text. */
	thinkingChars: number;
	textChars: number;
	/** Self-reported through the progress tool. */
	plan: string[];
	done: string[];
	note?: string;
}

interface ReviewerTraceHandle {
	onEvent(event: AgentSessionEvent): void;
	finish(ok: boolean, note: string): void;
}

/** Compact `read index.ts:1400` style label for a tool call; paths relative to `cwd`. */
function describeToolCall(name: string, args: unknown, cwd: string): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const raw = [a.pattern, a.path, a.glob].find((v) => typeof v === "string") as string | undefined;
	const target = raw && path.isAbsolute(raw) && raw.startsWith(cwd + path.sep) ? path.relative(cwd, raw) : raw;
	const at = typeof a.offset === "number" ? `:${a.offset}` : "";
	return target ? `${name} ${target.length > 60 ? `…${target.slice(-59)}` : target}${at}` : name;
}

function formatChars(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatActivityLine(a: ReviewerActivity, now: number): string {
	const secs = Math.round(((a.finishedAt ?? now) - a.startedAt) / 1000);
	const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
	const parts = [`${shortSpec(a.reviewer)} ${a.phase}`, elapsed];
	if (a.plan.length > 0) {
		// By count, not text: models rarely repeat a plan item verbatim.
		const now = a.plan[a.done.length];
		parts.push(`${Math.min(a.done.length, a.plan.length)}/${a.plan.length} checked${now && a.state === "running" ? ` (now: ${now.length > 50 ? `${now.slice(0, 49)}…` : now})` : ""}`);
	}
	if (a.turns > 0) parts.push(`turn ${a.turns}`, `${a.toolCalls} tool${a.toolCalls === 1 ? "" : "s"}`);
	parts.push(`${formatChars(a.thinkingChars)} thinking`, `${formatChars(a.textChars)} text`);
	if (a.lastTool) parts.push(`last: ${a.lastTool}`);
	return parts.join(" · ");
}

/**
 * Live view of every reviewer/verifier session, so the lead can watch a run
 * instead of waiting on it blind. Writes to `dir`:
 *  - progress.json: per-session snapshot (turns, tool calls, streamed
 *    thinking/text size, last tool), plus the progress widget's state (`run`)
 *    and its activity lines, rewritten at most every ACTIVITY_REFRESH_MS;
 *  - trace.jsonl: each tool call and each completed assistant message
 *    (thinking and text in full), appended as they happen.
 * Running sessions also feed the progress widget / tool updates.
 */
export class ReviewTrace {
	readonly progressPath: string;
	readonly tracePath: string;
	private readonly sessions: ReviewerActivity[] = [];
	private lastRefresh = 0;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private run: RunSnapshot | undefined;

	constructor(readonly dir: string, private readonly onActivity?: (lines: string[]) => void) {
		fs.mkdirSync(dir, { recursive: true });
		this.progressPath = path.join(dir, "progress.json");
		this.tracePath = path.join(dir, "trace.jsonl");
		fs.writeFileSync(this.tracePath, "");
		this.refresh();
	}

	start(reviewer: string, phase: ReviewerActivity["phase"], cwd: string): ReviewerTraceHandle {
		const a: ReviewerActivity = { reviewer, phase, state: "running", startedAt: Date.now(), turns: 0, toolCalls: 0, thinkingChars: 0, textChars: 0, plan: [], done: [] };
		this.sessions.push(a);
		this.append(a, { kind: "start" });
		this.schedule();
		return {
			onEvent: (event) => {
				if (event.type === "turn_start") a.turns++;
				else if (event.type === "tool_execution_start" && event.toolName === PROGRESS_TOOL) {
					const args = (event.args ?? {}) as { plan?: unknown; done?: unknown };
					// Some models resend `plan: []` with every `done`; only a non-empty plan replaces it.
					const plan = Array.isArray(args.plan) ? args.plan.filter((x): x is string => typeof x === "string") : [];
					if (plan.length > 0) a.plan = plan;
					if (typeof args.done === "string") a.done.push(args.done);
					this.append(a, { kind: "progress", plan: args.plan, done: args.done });
				} else if ((event as { type: string }).type === "multi_review_web_search") {
					// Native (server-side) searches never pass through pi's tool events.
					const query = (event as unknown as { query: string }).query;
					a.toolCalls++;
					a.lastTool = `web_search ${query.length > 50 ? `${query.slice(0, 49)}…` : query}`;
					this.append(a, { kind: "tool", tool: "web_search", native: true, args: { query } });
				} else if ((event as { type: string }).type === "multi_review_nudge") {
					this.append(a, { kind: "nudge", toolCalls: (event as unknown as { toolCalls: number }).toolCalls });
				} else if (event.type === "tool_execution_end" && (event.toolName === GIT_TOOL || event.toolName === RUN_TOOL || event.toolName === XREF_TOOL || event.toolName === WEB_SEARCH_TOOL)) {
					// Executed commands are evidence; keep the head of what they returned.
					const content = ((event.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []);
					const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
					this.append(a, { kind: "tool_result", tool: event.toolName, isError: event.isError, text: text.slice(0, 600) });
					return;
				} else if (event.type === "tool_execution_start") {
					a.toolCalls++;
					a.lastTool = describeToolCall(event.toolName, event.args, cwd);
					this.append(a, { kind: "tool", tool: event.toolName, args: event.args });
				} else if (event.type === "message_update") {
					const e = event.assistantMessageEvent;
					if (e.type === "thinking_delta") a.thinkingChars += e.delta.length;
					else if (e.type === "text_delta") a.textChars += e.delta.length;
				} else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
					const content = ((event.message as { content?: unknown[] }).content ?? []) as Array<{ type: string; text?: string; thinking?: string }>;
					const thinking = content.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("\n");
					const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
					if (thinking || text) this.append(a, { kind: "message", turn: a.turns, thinking, text });
				} else return;
				this.schedule();
			},
			finish: (ok, note) => {
				a.state = ok ? "ok" : "failed";
				a.finishedAt = Date.now();
				a.note = note;
				this.append(a, { kind: "finish", ok, note });
				this.refresh();
			},
		};
	}

	/** The progress widget's state; a finished run is written at once. */
	setRun(run: RunSnapshot): void {
		this.run = run;
		if (run.finished) this.refresh();
		else this.schedule();
	}

	/** Stop the pending refresh; leaves the files for the lead to read. */
	close(): void {
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.refresh();
	}

	private append(a: ReviewerActivity, entry: Record<string, unknown>): void {
		const line = { t: new Date().toISOString(), reviewer: a.reviewer, phase: a.phase, ...entry };
		try {
			fs.appendFileSync(this.tracePath, JSON.stringify(line) + "\n");
		} catch {
			/* tracing must never fail a review */
		}
	}

	private schedule(): void {
		if (this.refreshTimer) return;
		const wait = Math.max(0, ACTIVITY_REFRESH_MS - (Date.now() - this.lastRefresh));
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh();
		}, wait);
		this.refreshTimer.unref?.();
	}

	private refresh(): void {
		this.lastRefresh = Date.now();
		const now = Date.now();
		const activity = this.sessions.filter((a) => a.state === "running").map((a) => formatActivityLine(a, now));
		try {
			fs.writeFileSync(this.progressPath, JSON.stringify({
				updatedAt: new Date(now).toISOString(),
				trace: this.tracePath,
				run: this.run,
				activity,
				sessions: this.sessions.map((a) => ({ ...a, elapsedSec: Math.round(((a.finishedAt ?? now) - a.startedAt) / 1000) })),
			}, null, 2) + "\n");
		} catch {
			/* tracing must never fail a review */
		}
		this.onActivity?.(activity);
	}
}

import type { AgentToolUpdateCallback, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { ReviewerRunResult } from "./findings.ts";
import { ACTIVITY_LOG_MS } from "./trace.ts";

const STATUS_KEY = "multi-review";

export function setStatus(text: string | undefined, ctx: ExtensionContext) {
	ctx.ui.setStatus(STATUS_KEY, text);
}

// ---------- progress surface ----------

const PROGRESS_WIDGET_KEY = "multi-review-progress";

export type ToolUpdateFn = AgentToolUpdateCallback<any> | undefined;

interface MultiReviewProgressPatch {
	phase: string;
	done?: number;
	total?: number;
	latest?: string;
}

/** The widget's state, mirrored into progress.json for watchers outside pi (the Claude Code mod). */
export interface RunSnapshot {
	mode: string;
	phase: string;
	done?: number;
	total?: number;
	latest?: string;
	/** The last few `latest` lines, oldest first. */
	events: string[];
	startedAt: number;
	finished: boolean;
}

export interface MultiReviewProgressReporter {
	update(patch: MultiReviewProgressPatch): void;
	/** Send every state change, and the current state now, to `sink`. */
	mirror(sink: (run: RunSnapshot) => void): void;
	/** One line per running reviewer session (from ReviewTrace). */
	activity(lines: string[]): void;
	finish(summary: string): void;
	clear(): void;
}

export function shortSpec(spec: string): string {
	return spec.split("/").pop() || spec;
}

export function formatReviewerProgressLine(done: number, total: number, latest: ReviewerRunResult): string {
	const verdict = latest.ok ? "✓" : "✗";
	const findings = latest.ok ? `${latest.findings.length} finding${latest.findings.length === 1 ? "" : "s"}` : (latest.errorMessage ?? "error");
	const cost = latest.usage?.cost ? `, $${latest.usage.cost.toFixed(4)}` : "";
	const tools = latest.toolCalls ? `, ${latest.toolCalls} tool call${latest.toolCalls === 1 ? "" : "s"}` : "";
	const clamped = latest.clamped ? " [thinking clamped]" : "";
	return `${verdict} ${shortSpec(latest.formattedSpec)}${clamped} (${done}/${total}) — ${findings}, ${(latest.durationMs / 1000).toFixed(1)}s${tools}${cost}`;
}

export function createProgressReporter(ctx: ExtensionContext, mode: string, onUpdate?: ToolUpdateFn): MultiReviewProgressReporter {
	const startedAt = Date.now();
	const events: string[] = [];
	let state: Required<Pick<MultiReviewProgressPatch, "phase">> & Omit<MultiReviewProgressPatch, "phase"> = {
		phase: "starting",
	};
	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	let activity: string[] = [];
	let lastActivityLog = 0;
	let sink: ((run: RunSnapshot) => void) | undefined;
	let finished = false;

	function mirrorState(): void {
		sink?.({ mode, phase: state.phase, done: state.done, total: state.total, latest: state.latest, events: events.slice(-3), startedAt, finished });
	}

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
		for (const a of activity) lines.push(truncateToWidth(theme.fg("dim", `  ⋯ ${a}`), width));
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
		showWidget();
		publishUpdate();
		mirrorState();
	}

	function showWidget(): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(PROGRESS_WIDGET_KEY, (_tui, theme) => ({
			render: (width: number) => renderLines(theme, width),
			invalidate: () => {},
		}), { placement: "belowEditor" });
	}

	function publishUpdate(): void {
		const live = activity.map((a) => `\n⋯ ${a}`).join("");
		onUpdate?.({
			content: [{ type: "text", text: `multi-review · ${mode} · ${state.phase}${state.done !== undefined && state.total !== undefined ? ` (${state.done}/${state.total})` : ""}${state.latest ? `\n${state.latest}` : ""}${live}` }],
			details: { phase: state.phase, done: state.done, total: state.total, latest: state.latest, mode, activity },
		});
	}

	return {
		update(patch: MultiReviewProgressPatch): void {
			state = { ...state, ...patch };
			if (patch.latest) events.push(patch.latest);
			publish();
		},
		mirror(fn: (run: RunSnapshot) => void): void {
			sink = fn;
			mirrorState();
		},
		activity(lines: string[]): void {
			activity = lines;
			// Print mode's only view: a heartbeat, not every throttled refresh.
			if (process.env.MULTI_REVIEW_DEBUG && lines.length > 0 && Date.now() - lastActivityLog >= ACTIVITY_LOG_MS) {
				lastActivityLog = Date.now();
				for (const a of lines) console.error(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s]   ⋯ ${a}`);
			}
			showWidget();
			publishUpdate();
		},
		finish(summary: string): void {
			state = { ...state, phase: summary, latest: undefined };
			activity = [];
			finished = true;
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

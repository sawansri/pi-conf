/**
 * Per-session time budget for straggling reviewers. Rather than cut a slow
 * session and lose minutes of work, it is warned once (steered with the time
 * it has left), then stopped and asked for its answer with tools off:
 *
 *   start ──── warn ──────── cut ── harvest ── end
 *              │             │                 └ hard end: start + timeoutMs
 *              │             └ stop working: end − harvest, or the straggler cutoff
 *              └ 75% of the working time (start to cut), or the straggler
 *                cutoff being set, whichever is first
 *
 * The harvest comes out of timeoutMs, so a session never outlasts it.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { createProgressTool } from "./agent-tools.ts";
import { abortable, lastTurnAssistantText } from "./util.ts";

export const WARN_FRACTION = 0.75;
export const HARVEST_MS = 60_000;
/** The harvest's share of a short timeout (headless runs shrink timeouts to fit). */
const HARVEST_MAX_FRACTION = 0.2;

/**
 * Shared by one fan-out (a review or verify phase, a Socratic round): once a
 * quorum has answered, when the rest are cut.
 */
export class StragglerCutoff {
	cutAt?: number;
	reason = "";
	/** "4 of 5 reviewers have finished", for the warning. */
	status = "";
	private listeners = new Set<() => void>();

	arm(cutAt: number, reason: string, status: string): void {
		if (this.cutAt !== undefined) return;
		this.cutAt = cutAt;
		this.reason = reason;
		this.status = status;
		for (const l of this.listeners) l();
	}

	onArm(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export interface DeadlineWarning {
	secondsLeft: number;
	/** Why now: the pool's status, or how much of the time is gone. */
	why: string;
}

export interface SessionDeadline {
	/** Stop working: the timeout's or the straggler cutoff's reason. Never the caller's abort. */
	readonly cut: AbortSignal;
	/** Hard end: the harvest's budget runs out. */
	readonly end: AbortSignal;
	/** Called at the warning, or at once if it's already due; a later call (a retry's new session) is warned too. */
	listen(onWarn: (w: DeadlineWarning) => void): void;
	/** Seconds until the cut. */
	secondsLeft(): number;
	dispose(): void;
}

export function startDeadline(timeoutMs: number, cutoff?: StragglerCutoff): SessionDeadline {
	const start = Date.now();
	const harvestMs = Math.min(HARVEST_MS, Math.floor(timeoutMs * HARVEST_MAX_FRACTION));
	const hardEnd = start + timeoutMs;
	let cutAt = hardEnd - harvestMs;
	const cut = new AbortController();
	const end = new AbortController();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const at = (when: number, fn: () => void) => {
		const t = setTimeout(() => {
			timers.delete(t);
			fn();
		}, Math.max(0, when - Date.now()));
		t.unref?.();
		timers.add(t);
		return t;
	};
	let listener: ((w: DeadlineWarning) => void) | undefined;
	/** Why the warning is due, once it is. */
	let due: string | undefined;
	const warn = (why: string) => {
		if (due !== undefined || cut.signal.aborted) return;
		due = why;
		listener?.({ secondsLeft: deadline.secondsLeft(), why });
	};
	const deadline: SessionDeadline = {
		cut: cut.signal,
		end: end.signal,
		secondsLeft: () => Math.max(0, Math.round((cutAt - Date.now()) / 1000)),
		listen: (onWarn) => {
			listener = onWarn;
			if (due !== undefined && !cut.signal.aborted) onWarn({ secondsLeft: deadline.secondsLeft(), why: due });
		},
		dispose: () => {
			for (const t of timers) clearTimeout(t);
			timers.clear();
			unsubscribe?.();
		},
	};
	let cutTimer = at(cutAt, () => cut.abort(`timed out after ${Math.round(timeoutMs / 1000)}s`));
	let endTimer = at(hardEnd, () => end.abort("harvest ran out of time"));
	at(start + (cutAt - start) * WARN_FRACTION, () => warn(`${Math.round(WARN_FRACTION * 100)}% of your time is gone`));

	const onCutoff = () => {
		if (cutoff?.cutAt === undefined || cutoff.cutAt >= cutAt) return;
		cutAt = cutoff.cutAt;
		clearTimeout(cutTimer);
		timers.delete(cutTimer);
		// Already past (a session queued behind the concurrency cap): cut before it starts.
		if (cutAt <= Date.now()) cut.abort(cutoff.reason);
		else cutTimer = at(cutAt, () => cut.abort(cutoff.reason));
		clearTimeout(endTimer);
		timers.delete(endTimer);
		endTimer = at(Math.min(hardEnd, cutAt + harvestMs), () => end.abort("harvest ran out of time"));
		warn(cutoff.status);
	};
	const unsubscribe = cutoff?.onArm(onCutoff);
	onCutoff();
	return deadline;
}

/** The warning steered into a straggling session. */
export function warningText(w: DeadlineWarning, plan: { items: string[]; done: number }, finalFormat: string): string {
	// plan.done counts finished items; the one at that index is in progress.
	const skipped = plan.items.slice(plan.done + 1);
	const rest = skipped.length ? ` Skip the rest of your plan: ${skipped.map((p) => `"${p}"`).join(", ")}.` : "";
	return (
		`Time check: ${w.why}. You have about ${w.secondsLeft}s left before you are cut off.` +
		` Finish the step you're on, then stop investigating.${rest}` +
		` ${finalFormat}`
	);
}

/** The prompt after the cut: tools are off, answer from what was verified. */
export function harvestPrompt(finalFormat: string): string {
	return (
		"Time is up: your tools are now disabled. Do not try to call any. " +
		"Give your final answer now from what you have already verified; leave out anything you didn't get to check. " +
		finalFormat
	);
}

/** What a session needs to be warned and harvested when it runs late. */
export interface LateSession {
	deadline: SessionDeadline;
	/** The caller's own abort: no harvest after it. */
	userSignal?: AbortSignal;
	/** How the final answer must look, e.g. "Output ONLY the JSON array …". */
	finalFormat: string;
}

export type HarvestableSession = {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	steer(text: string): Promise<unknown>;
	clearQueue(): unknown;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	readonly messages: readonly unknown[];
};

/**
 * Steer the warning into the session when the deadline says so, at its next
 * tool call: pi delivers a steer after the turn's tool calls, and a turn with
 * none is the final answer, which a steer would only make it redo. Returns
 * the unsubscribe.
 */
export function armWarning(
	session: HarvestableSession,
	late: LateSession | undefined,
	progress: NonNullable<Parameters<typeof createProgressTool>[0]>,
	onEvent?: (event: AgentSessionEvent) => void,
): () => void {
	if (!late) return () => {};
	let warning: DeadlineWarning | undefined;
	late.deadline.listen((w) => {
		warning = w;
		// From now on every progress call also says how long is left.
		progress.secondsLeft = () => late.deadline.secondsLeft();
		onEvent?.({ type: "multi_review_deadline_warn", secondsLeft: w.secondsLeft, why: w.why } as unknown as AgentSessionEvent);
	});
	return session.subscribe((event) => {
		if (event.type !== "tool_execution_start" || !warning) return;
		const w = { ...warning, secondsLeft: late.deadline.secondsLeft() };
		warning = undefined;
		void session.steer(warningText(w, { items: progress.plan, done: progress.done }, late.finalFormat)).catch(() => undefined);
	});
}

/**
 * After the deadline's cut: stop the turn in flight, switch tools off, and
 * ask once for the answer from what the session has already verified, inside
 * the harvest's budget. Undefined when the caller aborted, the session never
 * got going (cut before its first answer), or nothing came back.
 */
export async function harvest(session: HarvestableSession, late: LateSession | undefined, onEvent?: (event: AgentSessionEvent) => void): Promise<string | undefined> {
	if (!late?.deadline.cut.aborted || late.userSignal?.aborted || late.deadline.end.aborted) return undefined;
	if (!session.messages.some((m) => (m as { role?: string }).role === "assistant")) return undefined;
	const signal = late.userSignal ? AbortSignal.any([late.userSignal, late.deadline.end]) : late.deadline.end;
	const stage = (stage: string) => onEvent?.({ type: "multi_review_harvest", stage, reason: String(late.deadline.cut.reason) } as unknown as AgentSessionEvent);
	stage("stopping");
	const aborted = () => { throw new Error("aborted"); };
	const onAbort = () => void session.abort();
	const tools = session.getActiveToolNames();
	const before = session.messages.length;
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await abortable(session.abort().then(() => session.waitForIdle()), signal, aborted);
		// An undelivered warning would land after the harvest prompt and contradict it.
		session.clearQueue();
		session.setActiveToolsByName([]);
		stage("asking");
		await abortable(session.prompt(harvestPrompt(late.finalFormat)), signal, aborted);
		return signal.aborted ? undefined : lastTurnAssistantText(session.messages.slice(before)) || undefined;
	} catch {
		return undefined;
	} finally {
		signal.removeEventListener("abort", onAbort);
		// A Socratic session goes on to the next round with its tools.
		session.setActiveToolsByName(tools);
	}
}

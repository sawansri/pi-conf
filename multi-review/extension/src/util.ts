import type { ModelCallResult } from "./models.ts";



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

/** Wait `ms`, or less if `signal` fires; false when it was cut short. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export const ERROR_RETRIES = 3;
export const ERROR_RETRY_DELAY_MS = 15_000;

/**
 * Errors another attempt won't fix: bad credentials or request, a missing
 * model, a prompt over the context window. 408 and 429 are transient.
 */
const PERMANENT_ERROR = /\b(400|401|403|404|413|422)\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?key|request)|model.{0,20}(not found|does not exist)|context.{0,10}(length|window)|maximum context|too many tokens|prompt is too long/i;

export function isPermanentError(errorMessage: string): boolean {
	return PERMANENT_ERROR.test(errorMessage);
}

/**
 * Re-run a failed model call up to ERROR_RETRIES times, ERROR_RETRY_DELAY_MS
 * apart. Gateway 5xx, rate limits and dropped streams usually clear within
 * seconds, and one blip shouldn't drop a model from the pool. Timeouts,
 * aborts and permanent errors (isPermanentError) aren't retried: retries
 * share the caller's signal, so they never outlast its deadline. A throw
 * counts as an error.
 */
export async function retryOnError(
	signal: AbortSignal,
	attempt: () => Promise<ModelCallResult>,
	onRetry?: (retry: number, errorMessage: string) => void,
	delayMs = ERROR_RETRY_DELAY_MS,
): Promise<ModelCallResult> {
	const run = () => attempt().catch((err): ModelCallResult => ({ text: "", stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err), durationMs: 0 }));
	let result = await run();
	for (let retry = 1; retry <= ERROR_RETRIES && result.errorMessage !== undefined && !isPermanentError(result.errorMessage) && !signal.aborted; retry++) {
		onRetry?.(retry, result.errorMessage);
		if (!(await sleep(delayMs, signal))) break;
		result = await run();
	}
	return result;
}

/** Caller's signal plus a per-reviewer deadline, so one hung model can't stall the run. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Run `fn` over items with at most `cap` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: T[], cap: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

/** The text of the last assistant message with any, among a turn's messages. */
export function lastTurnAssistantText(turnMessages: readonly unknown[]): string {
	for (let i = turnMessages.length - 1; i >= 0; i--) {
		const m = turnMessages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
		if (text) return text;
	}
	return "";
}

/** "L3", "L3-7", "…7" or "file" for a finding's line range. */
export function formatRange(start: number | null, end: number | null): string {
	if (start === null && end === null) return "file";
	if (start === null) return `…${end}`;
	if (end === null || end === start) return `L${start}`;
	return `L${start}-${end}`;
}

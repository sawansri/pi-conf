

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

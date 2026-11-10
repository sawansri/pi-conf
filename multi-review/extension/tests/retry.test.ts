import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCallResult } from "../src/models.ts";
import { ERROR_RETRIES, retryOnError } from "../src/util.ts";

const ok: ModelCallResult = { text: "[]", stopReason: "stop", durationMs: 1 };
const failed = (errorMessage: string): ModelCallResult => ({ text: "", stopReason: "error", errorMessage, durationMs: 1 });

/** Replays `results` in order, counting calls; a string entry is thrown. */
function scripted(results: Array<ModelCallResult | string>) {
	let calls = 0;
	return {
		get calls() { return calls; },
		attempt: async () => {
			const r = results[calls++];
			if (typeof r === "string") throw new Error(r);
			return r;
		},
	};
}

test("a success is returned without retrying", async () => {
	const s = scripted([ok]);
	assert.equal(await retryOnError(new AbortController().signal, s.attempt, undefined, 0), ok);
	assert.equal(s.calls, 1);
});

test("an error is retried until a success", async () => {
	const s = scripted([failed("503"), failed("429"), ok]);
	const retries: Array<[number, string]> = [];
	const result = await retryOnError(new AbortController().signal, s.attempt, (n, e) => retries.push([n, e]), 0);
	assert.equal(result, ok);
	assert.deepEqual(retries, [[1, "503"], [2, "429"]]);
});

test("gives up after ERROR_RETRIES retries and returns the last error", async () => {
	const s = scripted(Array.from({ length: ERROR_RETRIES + 2 }, (_, i) => failed(`e${i}`)));
	const result = await retryOnError(new AbortController().signal, s.attempt, undefined, 0);
	assert.equal(s.calls, ERROR_RETRIES + 1);
	assert.equal(result.errorMessage, `e${ERROR_RETRIES}`);
});

test("a throw counts as an error", async () => {
	const s = scripted(["socket hang up", ok]);
	assert.equal(await retryOnError(new AbortController().signal, s.attempt, undefined, 0), ok);
	const t = scripted(Array(ERROR_RETRIES + 1).fill("socket hang up"));
	const result = await retryOnError(new AbortController().signal, t.attempt, undefined, 0);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "socket hang up");
});

test("an aborted signal (timeout, straggler cut) is not retried", async () => {
	const ac = new AbortController();
	ac.abort("timeout");
	const s = scripted([failed("aborted: timeout"), ok]);
	await retryOnError(ac.signal, s.attempt, undefined, 0);
	assert.equal(s.calls, 1);
});

test("an abort during the wait ends it early without another attempt", async () => {
	const ac = new AbortController();
	const s = scripted([failed("503"), ok]);
	const result = retryOnError(ac.signal, s.attempt, () => queueMicrotask(() => ac.abort("timeout")), 60_000);
	assert.equal((await result).errorMessage, "503");
	assert.equal(s.calls, 1);
});

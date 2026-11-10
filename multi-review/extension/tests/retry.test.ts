import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelCallResult } from "../src/models.ts";
import { ERROR_RETRIES, isPermanentError, retryOnError } from "../src/util.ts";

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

test("errors another attempt won't fix aren't retried", async () => {
	for (const e of ["error: 401 Unauthorized", "error: 404 model not found", "error: 403 Forbidden", "error: invalid x-api-key"]) {
		const s = scripted([failed(e), ok]);
		assert.equal((await retryOnError(new AbortController().signal, s.attempt, undefined, 0)).errorMessage, e);
		assert.equal(s.calls, 1, e);
	}
	// A fresh session clears these: they're about the failed session's history.
	for (const e of [
		"error: 429 Too Many Requests", "error: 503 Service Unavailable", "error: 408 Request Timeout", "socket hang up", "error: Provider finish_reason: content_filter",
		'error: 400 {"type":"invalid_request_error","message":"messages.1.content.18: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified."}',
		"error: prompt is too long: 210000 tokens > 200000 maximum",
	]) {
		assert.equal(isPermanentError(e), false, e);
	}
});

test("status codes count only as the status, and pi's credential and quota errors are final", () => {
	for (const e of [
		"error: 401 Unauthorized", 'error: 404 {"error":{"message":"model not found"}}', "403 Forbidden", "HTTP 401", 'status: 403',
		"No API key for provider: amd-gateway", "No API key found for openai. Use /login", "error: 429 You exceeded your current quota (insufficient_quota)",
	]) assert.equal(isPermanentError(e), true, e);
	for (const e of [
		"error: 429 Rate limit reached. Limit 1000000, Requested 403.", "error: 502 Bad Gateway: retry after 400 ms", "error: 503 upstream timed out after 404ms",
		"request id 4013-401a failed: 500",
	]) assert.equal(isPermanentError(e), false, e);
});

test("common SDK and gateway formats of 401/403/404 are final", () => {
	for (const e of [
		"Request failed with status code 401", "Error: Request failed with status code 404", "Provider returned error 403", "Request failed: 401",
		"HTTP/1.1 404", "Mistral API error (404): Not Found", 'OpenAI API error (403): {"error":"access denied"}',
		'error: {"error":{"code":404,"message":"models/gemini-nonexistent is not found","status":"NOT_FOUND"}}',
	]) assert.equal(isPermanentError(e), true, e);
});

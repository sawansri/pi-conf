import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewFlags } from "../src/args.ts";
import { DEFAULTS, applyPremiumSwaps, describeFlags, parseReviewerSpec } from "../src/config.ts";
import { applyCliFlags } from "../src/headless.ts";

test("premium swaps Sonnet for Fable and Kimi for Astra, and keeps the other seats", () => {
	const pool = applyPremiumSwaps(DEFAULTS.reviewers, DEFAULTS.premiumSwaps);
	assert.deepEqual(pool, [
		"amd-gateway-anthropic/Claude-Fable-5-2@high",
		"amd-gateway/gpt-6.1-sol@high",
		"amd-gateway/GPT-6.2-Astra@high",
		"amd-gateway/gemini-4-argon@medium",
	]);
	// The default pool itself never changes.
	assert.ok(DEFAULTS.reviewers.includes("amd-gateway-anthropic/Claude-Sonnet-5.5@high"));
});

test("a swap matches its seat whatever the seat's level", () => {
	assert.deepEqual(
		applyPremiumSwaps(["amd-gateway/Kimi-K3.1-Pro@low", "amd-gateway/Kimi-K3.1-Pro"], DEFAULTS.premiumSwaps),
		["amd-gateway/GPT-6.2-Astra@high", "amd-gateway/GPT-6.2-Astra@high"],
	);
});

test("every premium reviewer has its own spend cap, keyed the way runReviewer looks it up", () => {
	// runReviewer reads maxCostUsdBySpec[reviewerSpec.spec]; a key that
	// doesn't match leaves the model on the $1.5 pool cap, which cuts a
	// model at 4x Sonnet's price before it has reviewed much.
	for (const swap of Object.values(DEFAULTS.premiumSwaps)) {
		const spec = parseReviewerSpec(swap)?.spec;
		assert.ok(spec, swap);
		const cap = DEFAULTS.sessionMaxCostUsdByModel[spec];
		assert.ok(cap !== undefined && cap > DEFAULTS.sessionMaxCostUsd, `${spec}: ${cap}`);
	}
});

test("premium is off unless asked for, on every surface", () => {
	const defaults = { verify: false, quick: false };
	assert.equal(parseReviewFlags("#123", defaults).flags.premium, undefined);
	assert.equal(applyCliFlags({ intent: "x" }, "--verify").premium, undefined);

	const parsed = parseReviewFlags("--premium #123", defaults);
	assert.equal(parsed.flags.premium, true);
	assert.equal(parsed.rest, "#123");
	assert.equal(applyCliFlags({ intent: "x" }, "--quick --premium").premium, true);
	assert.equal(describeFlags({ verify: true, quick: false, premium: true }), "balanced+premium+verify");
	// --quick picks its own pool, so premium doesn't apply there.
	assert.equal(describeFlags({ verify: false, quick: true, premium: true }), "quick");
});

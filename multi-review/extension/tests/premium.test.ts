import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReviewFlags } from "../src/args.ts";
import { DEFAULTS, applySwaps, describeFlags, parseReviewerSpec, parseSwapPairs, resolveReviewerChoices } from "../src/config.ts";
import { applyCliFlags, parseReviewRequest } from "../src/headless.ts";

// What the registry has: the default pool, the premium models and Opus.
const AVAILABLE = [
	// Listed first, as pi's registry does: a bare id must not resolve here.
	"anthropic/claude-sonnet-5-5",
	"anthropic/claude-opus-5-5",
	"amd-gateway-anthropic/Claude-Sonnet-5.5",
	"amd-gateway-anthropic/Claude-Opus-5.5",
	"amd-gateway-anthropic/Claude-Fable-5-2",
	"amd-gateway/gpt-6.1-sol",
	"amd-gateway/Kimi-K3.1-Pro",
	"amd-gateway/GPT-6.2-Astra",
	"amd-gateway/gemini-4-argon",
];

test("premium swaps Sonnet for Fable and Kimi for Astra, and keeps the other seats", () => {
	const { specs: pool, notes } = applySwaps(DEFAULTS.reviewers, DEFAULTS.premiumSwaps, AVAILABLE);
	assert.deepEqual(notes, []);
	assert.deepEqual(pool, [
		"amd-gateway-anthropic/Claude-Fable-5-2@medium",
		"amd-gateway/gpt-6.1-sol@high",
		"amd-gateway/GPT-6.2-Astra@medium",
		"amd-gateway/gemini-4-argon@medium",
	]);
	// The default pool itself never changes.
	assert.ok(DEFAULTS.reviewers.includes("amd-gateway-anthropic/Claude-Sonnet-5.5@high"));
});

test("a swap matches its seat whatever the seat's level", () => {
	assert.deepEqual(
		applySwaps(["amd-gateway/Kimi-K3.1-Pro@low", "amd-gateway/Kimi-K3.1-Pro"], DEFAULTS.premiumSwaps, AVAILABLE).specs,
		["amd-gateway/GPT-6.2-Astra@medium", "amd-gateway/GPT-6.2-Astra@medium"],
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

test("a premium model the registry doesn't have leaves the original in its seat", () => {
	const noFable = AVAILABLE.filter((k) => !k.includes("Fable"));
	const { specs, notes } = applySwaps(DEFAULTS.reviewers, DEFAULTS.premiumSwaps, noFable);
	assert.equal(specs[0], "amd-gateway-anthropic/Claude-Sonnet-5.5@high");
	assert.equal(specs[2], "amd-gateway/GPT-6.2-Astra@medium");
	assert.equal(notes.length, 1);
	assert.match(notes[0], /not available.*Claude-Sonnet-5\.5@high keeps its seat/);
});

test("a user swap names its seat by part of the id and its model by bare id, keeping the seat's level", () => {
	const { specs, notes } = applySwaps(DEFAULTS.reviewers, { sonnet: "claude-opus-5.5", Argon: "amd-gateway/gpt-6.1-sol@low" }, AVAILABLE);
	assert.deepEqual(notes, []);
	assert.deepEqual(specs, [
		"amd-gateway-anthropic/Claude-Opus-5.5@high",
		"amd-gateway/gpt-6.1-sol@high",
		"amd-gateway/Kimi-K3.1-Pro@high",
		"amd-gateway/gpt-6.1-sol@low",
	]);
});

test("an unknown model or an unmatched seat changes nothing and says why", () => {
	const { specs, notes } = applySwaps(DEFAULTS.reviewers, { kimi: "amd-gateway/No-Such-Model", grok: "claude-opus-5.5" }, AVAILABLE);
	assert.deepEqual(specs, DEFAULTS.reviewers);
	assert.equal(notes.length, 2);
	assert.match(notes[0], /swap kimi → amd-gateway\/No-Such-Model: model not available, amd-gateway\/Kimi-K3\.1-Pro@high keeps its seat/);
	assert.match(notes[1], /no reviewer seat matches "grok"/);
});

test("user swaps apply after premium, so they can replace a premium seat", () => {
	const premium = applySwaps(DEFAULTS.reviewers, DEFAULTS.premiumSwaps, AVAILABLE).specs;
	assert.equal(applySwaps(premium, { fable: "claude-opus-5.5@max" }, AVAILABLE).specs[0], "amd-gateway-anthropic/Claude-Opus-5.5@max");
});

test("--swap parses on the slash command, the headless command line and the brief", () => {
	assert.deepEqual(parseSwapPairs("sonnet=a/b@high, kimi=c ,bad,=x,y="), { sonnet: "a/b@high", kimi: "c" });
	const parsed = parseReviewFlags("--swap=sonnet=a/b --verify --swap=kimi=c/d@low #12", { verify: false, quick: false });
	assert.deepEqual(parsed.flags.swaps, { sonnet: "a/b", kimi: "c/d@low" });
	assert.equal(parsed.flags.verify, true);
	assert.equal(parsed.rest, "#12");
	assert.deepEqual(applyCliFlags({ intent: "x" }, "--swap=argon=e/f").swaps, { argon: "e/f" });
	assert.deepEqual(parseReviewRequest({ swaps: { sonnet: "a/b" } }), { swaps: { sonnet: "a/b" } });
	assert.ok("error" in parseReviewRequest({ swaps: ["sonnet=a/b"] }));
	assert.ok("error" in parseReviewRequest({ swaps: { sonnet: 3 } }));
});

test("a bare id resolves under the seat's own provider, not another provider with the same model", () => {
	// Real run 20261117-1425-swap-smoke: haiku → claude-sonnet-5.5 seated
	// anthropic/claude-sonnet-5-5, off the gateway the rest of the run used.
	const { specs } = applySwaps(["amd-gateway-anthropic/Claude-Haiku-5.5", "amd-gateway/gpt-6.1-sol@high"], { haiku: "claude-sonnet-5.5", sol: "claude-opus-5.5" }, AVAILABLE);
	assert.deepEqual(specs, ["amd-gateway-anthropic/Claude-Sonnet-5.5", "amd-gateway-anthropic/Claude-Opus-5.5@high"]);
});

test("--reviewers picks the exact pool from a part of an id, with the level the config gives that model", () => {
	const known = [...DEFAULTS.reviewers, ...Object.values(DEFAULTS.premiumSwaps)];
	assert.deepEqual(resolveReviewerChoices(["fable"], AVAILABLE, known), {
		specs: ["amd-gateway-anthropic/Claude-Fable-5-2@medium"],
		errors: [],
	});
	// A bare id prefers the provider the config uses, and an explicit level wins.
	assert.deepEqual(resolveReviewerChoices(["claude-sonnet-5.5@low", "amd-gateway/gpt-6.1-sol", "gpt-6.1-sol"], AVAILABLE, known), {
		specs: ["amd-gateway-anthropic/Claude-Sonnet-5.5@low", "amd-gateway/gpt-6.1-sol@high"],
		errors: [],
	});
	// Two Fables: the one the config names, unless neither is named.
	const twoFables = [...AVAILABLE, "amd-gateway-anthropic/Claude-Fable-5-1"];
	assert.deepEqual(resolveReviewerChoices(["fable"], twoFables, known).specs, ["amd-gateway-anthropic/Claude-Fable-5-2@medium"]);
	assert.match(resolveReviewerChoices(["fable"], twoFables).errors[0], /ambiguous/);
	// No config entry: the model's default level.
	assert.deepEqual(resolveReviewerChoices(["opus"], AVAILABLE, known).specs, ["amd-gateway-anthropic/Claude-Opus-5.5"]);
});

test("--reviewers fails on a model it can't resolve or can't tell apart, instead of substituting", () => {
	assert.match(resolveReviewerChoices(["no-such-model"], AVAILABLE).errors[0], /no available model matches/);
	assert.match(resolveReviewerChoices(["amd-gateway/Claude-Fable-5-2"], AVAILABLE).errors[0], /no available model matches/);
	// "claude" names Sonnet, Opus and Fable; none of them is the obvious one.
	assert.match(resolveReviewerChoices(["claude"], AVAILABLE).errors[0], /ambiguous/);
});

test("--reviewers is parsed on every surface and turns premium off", () => {
	const defaults = { verify: false, quick: false };
	const parsed = parseReviewFlags("--reviewers=fable --verify #12", defaults);
	assert.deepEqual(parsed.flags.reviewers, ["fable"]);
	assert.equal(parsed.rest, "#12");
	assert.deepEqual(parseReviewFlags("--reviewers=sonnet,kimi --reviewers=argon", defaults).flags.reviewers, ["sonnet", "kimi", "argon"]);
	assert.deepEqual(applyCliFlags({ intent: "x" }, "--reviewers=fable").reviewers, ["fable"]);
	assert.deepEqual(parseReviewRequest({ intent: "x", reviewers: ["fable"] }).reviewers, ["fable"]);
	assert.match((parseReviewRequest({ intent: "x", reviewers: "fable" }) as { error: string }).error, /array of strings/);
	assert.equal(describeFlags({ verify: false, quick: false, premium: true, reviewers: ["fable"] }), "balanced");
});

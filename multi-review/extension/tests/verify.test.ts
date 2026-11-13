import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import type { DedupeGroup } from "../src/grouping.ts";
import { assignVerifiers, selectForVerification } from "../src/verify.ts";

const GPT = "amd-gateway/gpt-6.1-sol";
const SONNET = "amd-gateway-anthropic/Claude-Sonnet-5.5";
const KIMI = "amd-gateway/Kimi-K3.1-Pro";
const GEMINI = "amd-gateway/gemini-4-argon";
const POOL = [SONNET, GPT, KIMI, GEMINI];

function group(id: string, ...specs: string[]): DedupeGroup {
	return { id, reviewerSpecs: specs, consensus: new Set(specs).size >= 2, members: specs.map((spec) => ({ spec })) } as unknown as DedupeGroup;
}

test("preferred verifiers take the work; Kimi and Gemini verify only what no preferred model can", () => {
	// Kimi's verify session cost $1.22 for 15 groups in one run, Sonnet's $0.58;
	// gpt-6.1-sol caches its whole prefix and costs a tenth of either.
	const groups = [group("g1", KIMI), group("g2", GEMINI), group("g3", KIMI), group("g4", GPT), group("g5", GPT, SONNET)];
	const load = assignVerifiers(groups, POOL, 1, [GPT, SONNET]);
	assert.deepEqual(load.get(GPT), ["g1", "g3"]);
	assert.deepEqual(load.get(SONNET), ["g2", "g4"]);
	assert.deepEqual(load.get(KIMI), ["g5"]);
	assert.equal(load.has(GEMINI), false);
});

test("with no preference, verifiers are balanced over the pool as before", () => {
	const load = assignVerifiers([group("g1", KIMI), group("g2", KIMI)], POOL, 1, []);
	assert.deepEqual(load.get(SONNET), ["g1"]);
	assert.deepEqual(load.get(GPT), ["g2"]);
});

test("a finding two models raised independently isn't re-verified", () => {
	// 75 confirmations to 6 refutations over 5 runs, and no consensus finding
	// was ever refuted: verifying agreement bought nothing.
	const groups = [group("g1", KIMI), group("g2", KIMI, GPT), group("g3", SONNET)];
	const picked = selectForVerification(groups, false);
	assert.deepEqual(picked.map((g) => g.id), ["g1", "g3"]);
	assert.match(groups[1].verificationNote ?? "", /raised independently by 2 models/);
	assert.deepEqual(selectForVerification(groups, true).map((g) => g.id), ["g1", "g2", "g3"]);
});

test("one model's two passes agreeing is not independent: still verified", () => {
	const g = group("g1", SONNET);
	g.members.push({ spec: SONNET, pass: 2 } as DedupeGroup["members"][number]);
	assert.deepEqual(selectForVerification([g], false).map((x) => x.id), ["g1"]);
});

test("defaults: gpt-6.1-sol then Sonnet verify, and consensus findings are not re-verified", () => {
	assert.deepEqual(DEFAULTS.verifiers, [GPT, SONNET]);
	assert.equal(DEFAULTS.verifyConsensus, false);
});

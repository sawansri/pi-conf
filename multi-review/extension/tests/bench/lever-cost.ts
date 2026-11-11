/**
 * Per-call cost of each lever, from one real run's result.json.
 *
 * Whole-run cost has ~50% coefficient of variation (measured: 6 runs of the
 * same code), so an A/B on totals needs ~50 runs per arm to resolve a 15%
 * effect. The cost model is the other way round: given a call's own reported
 * tokens, repricing it under a lever is exact arithmetic. This reports those
 * savings and, separately, what they are as a share of the run.
 *
 *   node --experimental-transform-types tests/bench/lever-cost.ts <result.json>
 */
import { readFileSync } from "node:fs";

interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number }
interface Row { spec: string; calls: number; usage: Usage }

/** $/M tokens, from ~/.pi/agent/models.json (the gateway catalog). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
	"amd-gateway/Kimi-K3.1-Pro": { input: 2.0, output: 10.0, cacheRead: 0 },
	"amd-gateway/gemini-4-argon": { input: 2.5, output: 15.0, cacheRead: 0 },
	"amd-gateway/gpt-6.1-sol": { input: 1.36, output: 6.8, cacheRead: 0 },
	"amd-gateway-anthropic/Claude-Sonnet-5.5": { input: 2.0, output: 10.0, cacheRead: 0 },
	"amd-gateway-anthropic/Claude-Opus-5.5": { input: 4.0, output: 20.0, cacheRead: 0 },
	"amd-gateway-anthropic/Claude-Haiku-5.5": { input: 0.1, output: 0.5, cacheRead: 0 },
};

const base = (spec: string) => spec.replace(/ \(verify\)$/, "").replace(/ #\d+$/, "").replace(/@.*$/, "");
/** Each component at its OWN rate: cacheRead is free on this gateway, so
 *  folding it into `input` overprices a long cached session by 3x. */
function price(spec: string, u: Usage): number {
	const p = PRICES[base(spec)];
	if (!p) return u.cost;
	return (u.input * p.input + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.input + u.output * p.output) / 1e6;
}
const usd = (x: number) => `$${x.toFixed(4)}`;

const file = process.argv[2];
if (!file) {
	console.error("usage: lever-cost.ts <result.json>");
	process.exit(1);
}
const run = (JSON.parse(readFileSync(file, "utf8")).details as { cost?: { calls: number; usage: Usage; bySpec: Row[] } }).cost;
if (!run) {
	console.error("no cost in result.json");
	process.exit(1);
}
const rows = run.bySpec.map((r) => ({ ...r, priced: price(r.spec, r.usage) }));
const total = rows.reduce((s, r) => s + r.priced, 0);
const promptOf = (u: Usage) => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
const totalOut = run.usage.output;
const totalPrompt = promptOf(run.usage);

console.log(`${file}`);
console.log(`run total ${usd(total)}`);
console.log(`  fresh input ${run.usage.input.toLocaleString()} tok, output ${totalOut.toLocaleString()} tok, ` +
	`cached ${(run.usage.cacheRead ?? 0).toLocaleString()} tok\n`);

// What share of the bill is what. Cached input is free on this gateway, so
// the two things that can be cut are fresh input and output.
console.log("where the money went:");
for (const r of [...rows].sort((a, b) => b.priced - a.priced)) {
	const u = r.usage;
	const p = PRICES[base(r.spec)];
	const inCost = p ? (u.input * p.input + (u.cacheRead ?? 0) * p.cacheRead + (u.cacheWrite ?? 0) * p.input) / 1e6 : 0;
	const outCost = p ? (u.output * p.output) / 1e6 : 0;
	console.log(`  ${r.spec.padEnd(46)} ${usd(r.priced).padStart(8)}  in ${usd(inCost).padStart(8)} out ${usd(outCost).padStart(8)}` +
		`  (${Math.round((r.priced / total) * 100)}%)`);
}

const find = (pred: (spec: string) => boolean) => rows.filter((r) => pred(r.spec));
const sum = (xs: Row[]) => xs.reduce((s, r) => s + r.priced, 0);

console.log("\nlevers, priced on this run's own tokens:");
const grouping = find((s) => base(s) === "amd-gateway-anthropic/Claude-Opus-5.5");
if (grouping.length) {
	const h = PRICES["amd-gateway-anthropic/Claude-Haiku-5.5"];
	const after = grouping.reduce((s, r) => s + ((r.usage.input + (r.usage.cacheWrite ?? 0)) * h.input + r.usage.output * h.output) / 1e6, 0);
	console.log(`  B grouping Opus -> Haiku     ${usd(sum(grouping))} -> ${usd(after)}   saves ${usd(sum(grouping) - after)} ` +
		`(${((sum(grouping) - after) / total * 100).toFixed(1)}% of the run)`);
}
const verifies = find((s) => / \(verify\)$/.test(s));
if (verifies.length) {
	const vp = verifies.reduce((s, r) => s + promptOf(r.usage), 0);
	const vo = verifies.reduce((s, r) => s + r.usage.output, 0);
	const freshIn = verifies.reduce((s, r) => { const p = PRICES[base(r.spec)]; return s + (r.usage.input * p.input) / 1e6; }, 0);
	console.log(`  A narrow verify context      would cut ~70% of the verify prompt's ${vp.toLocaleString()} tok — but only ` +
		`${usd(freshIn)} of it is billable (cached input is $0). Worth ~${usd(freshIn * 0.7)}, and in practice it` +
		` pushes verifiers into tool calls whose OUTPUT is billed: measured +18% on real runs.`);
	console.log(`  C verifier thinking lower    acts on the ${vo.toLocaleString()} output tok the verify round spent (${usd(verifies.reduce((s, r) => { const p = PRICES[base(r.spec)]; return s + (r.usage.output * p.output) / 1e6; }, 0))})`);
}
const second = find((s) => / #2$/.test(s));
if (second.length) {
	console.log(`  G second pass                costs ${usd(sum(second))} (${((sum(second) / total) * 100).toFixed(1)}%) for a reversed diff over the same hunks`);
}
console.log(`  D judge maxTokens            total output ${totalOut.toLocaleString()} tok across ${run.calls} calls`);
console.log(`  E read/tool cap              acts on the ${totalPrompt.toLocaleString()} prompt tok; free when cached, ` +
	`so its value is latency and context headroom, not dollars`);

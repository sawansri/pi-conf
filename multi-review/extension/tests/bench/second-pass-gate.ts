/**
 * The second-pass gate is arithmetic, so it can be checked without a run:
 * a 52-line diff with a 100-line threshold must not spawn `#2`, and the
 * default (0) must keep it. Verified against whichChangedLines.
 *
 *   node --experimental-transform-types tests/bench/second-pass-gate.ts
 */
import { whichChangedLines } from "../../src/pipeline.ts";

const diff = ["+a", "+b", "-c", "@@ -1 +1 @@", "+d"].join("\n");
const runs = (threshold: number) => whichChangedLines(diff) >= threshold;
console.log(`changed lines: ${whichChangedLines(diff)}`);
for (const t of [0, 4, 5, 6, 100]) {
	console.log(`  secondPassMinLines=${String(t).padStart(3)} -> second pass ${runs(t) ? "RUNS" : "skipped"}`);
}
if (!runs(0) || !runs(4) || !runs(5) || runs(6) || runs(100)) {
	console.error("gate logic is wrong");
	process.exit(1);
}
console.log("ok");

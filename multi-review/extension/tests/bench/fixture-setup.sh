#!/usr/bin/env bash
# Builds the review fixture: a small TypeScript service on a committed
# baseline, with a known-defect patch left in the working tree. run.sh reviews
# that patch; lever-cost.ts/prompt-size.ts price and size the prompts.
#
#   tests/bench/fixture-setup.sh
#
# The defects (see PLANTED in run.sh) are:
#   expiry   get() serves a value past its ttl
#   evict    size() reports the map's size while set() never evicts
#   emptyval parsePairs drops a key whose value is empty
#   retryval withRetries loses the successful value
#   nan      buildRequest passes NaN through as a timeout
#   mergefst merge lets the first-inserted item win a collision
#   rankmut  rank mutates the caller's array when limit > length
#   avgzero  averageWeight divides by zero on an empty set
#   heaviest heaviest returns insertion order, not the greatest weight
#   metafilt describe hides meta entries with empty values
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/fixture"
rm -rf "$dir"
mkdir -p "$dir/src/util" "$dir/tests"
cd "$dir"
git init -q -b main .
git config user.email bench@example.com
git config user.name bench

cat > src/cache.ts <<'TS'
export interface Entry {
	value: string;
	expiresAt: number | null;
	hits: number;
}

export class Cache {
	readonly entries = new Map<string, Entry>();
	private readonly maxEntries: number;

	constructor(maxEntries = 100) {
		this.maxEntries = maxEntries;
	}

	get(key: string): string | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return undefined;
		entry.hits += 1;
		return entry.value;
	}

	set(key: string, value: string, ttlMs?: number): void {
		this.entries.set(key, {
			value,
			expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs,
			hits: 0,
		});
	}

	delete(key: string): boolean {
		return this.entries.delete(key);
	}

	size(): number {
		return this.entries.size;
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}
}

/** Parse "k1=v1,k2=v2" into a record; malformed pairs are skipped. */
export function parsePairs(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of text.split(",")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return out;
}
TS

cat > src/request.ts <<'TS'
import { Cache, parsePairs } from "./cache.ts";

export interface Request {
	url: string;
	timeoutMs: number;
}

export function buildRequest(query: string, cache: Cache, defaultTimeoutMs: number): Request {
	const pairs = parsePairs(query);
	const cached = cache.get("last-url");
	const url = pairs.url ?? cached ?? "";
	let timeoutMs = defaultTimeoutMs;
	if (pairs.timeout) {
		timeoutMs = Number(pairs.timeout);
	}
	cache.set("last-url", url, 60_000);
	return { url, timeoutMs };
}

export async function withRetries<T>(attempt: () => Promise<T>, retries = 3, delayMs = 100): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i <= retries; i++) {
		try {
			return await attempt();
		} catch (err) {
			lastError = err;
			if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	throw lastError;
}
TS

for i in 1 2 3 4 5 6; do cat > src/util/mod$i.ts <<TS
export interface Item$i {
	id: string;
	label: string;
	weight: number;
	meta?: Record<string, string>;
}

export function load$i(rows: Item$i[]): Map<string, Item$i> {
	const out = new Map<string, Item$i>();
	for (const r of rows) {
		if (!r.id) continue;
		out.set(r.id, r);
	}
	return out;
}

export function rank$i(items: Item$i[], limit: number): Item$i[] {
	return [...items].sort((a, b) => b.weight - a.weight).slice(0, limit);
}

export function merge$i(left: Item$i[], right: Item$i[]): Item$i[] {
	const byId = load$i([...left, ...right]);
	return [...byId.values()];
}

export function describe$i(item: Item$i): string {
	const meta = item.meta ? Object.entries(item.meta).map(([k, v]) => k + "=" + v).join("; ") : "";
	return item.id + " (" + item.label + ")" + (meta ? " [" + meta + "]" : "");
}
TS
done

cat > src/util/aggregate.ts <<'TS'
import { Item1, rank1 } from "./mod1.ts";

export function totalWeight(rows: Item1[]): number {
	let total = 0;
	for (const r of rows) total += r.weight;
	return total;
}

export function averageWeight(rows: Item1[]): number {
	if (rows.length === 0) return 0;
	return totalWeight(rows) / rows.length;
}

export function groupByLabel(rows: Item1[]): Map<string, Item1[]> {
	const out = new Map<string, Item1[]>();
	for (const r of rows) {
		const bucket = out.get(r.label) ?? [];
		bucket.push(r);
		out.set(r.label, bucket);
	}
	return out;
}

export function heaviest(rows: Item1[]): Item1 | undefined {
	if (rows.length === 0) return undefined;
	return load1(rows).values().next().value;
}

export function heavyBuckets(rows: Item1[], threshold: number): string[] {
	const out: string[] = [];
	for (const [label, items] of groupByLabel(rows)) {
		if (totalWeight(items) > threshold) out.push(label);
	}
	return out;
}
TS

cat > tests/basic.test.ts <<'TS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cache, parsePairs } from "../src/cache.ts";

test("get returns a live entry", () => {
	const c = new Cache();
	c.set("a", "1");
	assert.equal(c.get("a"), "1");
});

test("set with a ttl expires", async () => {
	const c = new Cache();
	c.set("a", "1", 5);
	await new Promise((r) => setTimeout(r, 15));
	assert.equal(c.get("a"), undefined);
});

test("parsePairs splits k=v", () => {
	assert.deepEqual(parsePairs("a=1,b=2"), { a: "1", b: "2" });
});
TS

git add -A
git commit -qm "baseline"

# --- the patch under review: plant the defects ---
python3 - <<'PY'
import pathlib, re
p = pathlib.Path("src/cache.ts"); s = p.read_text()
s = s.replace("""		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return undefined;
		entry.hits += 1;""", """		entry.hits += 1;""")
s = s.replace("""		this.entries.set(key, {""", """		if (this.entries.size >= this.maxEntries) this.evictOne();
		this.entries.set(key, {""")
s = s.replace("""	delete(key: string): boolean {""", """	/** Drop the least-recently-inserted entry to stay under the cap. */
	private evictOne(): void {
		const oldest = this.keys()[0];
		if (oldest !== undefined) this.entries.delete(oldest);
	}

	delete(key: string): boolean {""")
s = s.replace("""		out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();""",
"""		const value = pair.slice(eq + 1).trim();
		if (value.length === 0) continue;
		out[pair.slice(0, eq).trim()] = value;""")
p.write_text(s)

p = pathlib.Path("src/request.ts"); s = p.read_text()
s = s.replace("""		timeoutMs = Number(pairs.timeout);""", """		timeoutMs = Number(pairs.timeout);
		timeoutMs = Math.min(timeoutMs, 30_000);""")
s = s.replace("""			return await attempt();""", """			await attempt();""")
s = s.replace("""			if (i < retries) await new Promise((r) => setTimeout(r, delayMs));""",
              """			await new Promise((r) => setTimeout(r, delayMs));""")
p.write_text(s)

p = pathlib.Path("src/util/aggregate.ts"); s = p.read_text()
s = s.replace("""	if (rows.length === 0) return 0;
	return totalWeight(rows) / rows.length;""", """	return totalWeight(rows) / rows.length;""")
s = s.replace("""	return rank1(rows, 1)[0];""", """	return load1(rows).values().next().value;""")
s = s.replace('import { Item1, rank1 } from "./mod1.ts";', 'import { Item1, load1 } from "./mod1.ts";')
p.write_text(s)

for n in range(1, 7):
    p = pathlib.Path(f"src/util/mod{n}.ts"); s = p.read_text()
    if n == 5:
        s = s.replace("""		if (!r.id) continue;
		out.set(r.id, r);""", """		if (!r.id) continue;
		// BUG: first write wins, but merge5 relies on last-write-wins.
		if (out.has(r.id)) continue;
		out.set(r.id, r);""")
    if n == 2:
        s = s.replace("""	return [...items].sort((a, b) => b.weight - a.weight).slice(0, limit);""",
"""	if (limit > items.length) return items.sort((a, b) => b.weight - a.weight);
	return [...items].sort((a, b) => b.weight - a.weight).slice(0, limit);""")
    if n == 6:
        s = s.replace("""	const meta = item.meta ? Object.entries(item.meta).map(([k, v]) => k + "=" + v).join("; ") : "";""",
"""	const meta = item.meta ? Object.entries(item.meta).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join("; ") : "";""")
    p.write_text(s)
PY

echo "fixture ready at $dir (baseline committed, defects in the working tree)"
git diff --stat | tail -3

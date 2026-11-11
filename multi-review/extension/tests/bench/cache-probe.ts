/**
 * Measures what the gateway actually reports for a repeated prompt.
 *
 * cost.ts gives every model `cacheRead: 0, cacheWrite: 0`, so a cached input
 * token prices at $0. Two very different realities look the same there:
 * the gateway caches and bills nothing for hits (cheap), or it never reports
 * hits and we are paying full price on every turn (expensive). This answers
 * which, per provider API, by sending the same long prefix twice.
 *
 *   node --experimental-transform-types tests/bench/cache-probe.ts [model-spec ...]
 *
 * Not part of the test suite: it needs credentials and network.
 */
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Usage {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	total: number;
	cost: number;
}

const API = "https://llm-api.amd.com/Unified";

/** A long, stable prefix — enough to cross every provider's minimum cacheable length. */
function filler(repeats = 240): string {
	const line =
		"The quick brown fox jumps over the lazy dog while the reviewing model reads a diff and traces every caller of the changed function. ";
	return line.repeat(repeats);
}

async function probe(modelId: string, apiKey: string): Promise<void> {
	const prefix = filler();
	const body = {
		model: modelId,
		max_tokens: 16,
		messages: [
			{ role: "user", content: `${prefix}\n\nReply with the single word: ack` },
			{ role: "assistant", content: "ack" },
			{ role: "user", content: "Reply with the single word: ack" },
		],
	};
	const url = `${API}/v1/messages`;
	const send = async (): Promise<Usage | undefined> => {
		const res = await fetch(`${API}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Ocp-Apim-Subscription-Key": apiKey,
			},
			body: JSON.stringify({ ...body, messages: [{ role: "user", content: prefix }, { role: "user", content: "Reply with the single word: ack" }] }),
		});
		if (!res.ok) {
			console.log(`  ${modelId}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
			return undefined;
		}
		const json = (await res.json()) as { usage?: Record<string, unknown> };
		const u = json.usage ?? {};
		const cached = Number(u.prompt_tokens_details && (u.prompt_tokens_details as { cached_tokens?: number }).cached_tokens) || 0;
		return {
			input: Number(u.prompt_tokens) || 0,
			output: Number(u.completion_tokens) || 0,
			cacheRead: cached,
			cacheWrite: 0,
			total: Number(u.total_tokens) || 0,
			cost: 0,
		};
	};
	void url;
	const first = await send();
	if (!first) return;
	await new Promise((r) => setTimeout(r, 1500));
	const second = await send();
	if (!second) return;
	console.log(
		`  ${modelId.padEnd(34)} prompt=${String(second.input).padStart(6)}  cached=${String(second.cacheRead ?? 0).padStart(6)}  ` +
			`${(second.cacheRead ?? 0) > 0 ? "CACHE HIT reported" : "no cache read reported"}`,
	);
}

async function main(): Promise<void> {
	const key = process.env.LLM_GATEWAY_KEY;
	if (!key) {
		console.error("LLM_GATEWAY_KEY is not set");
		process.exit(1);
	}
	const fromArgs = process.argv.slice(2);
	let models = fromArgs;
	if (models.length === 0) {
		const cfgPath = path.join(os.homedir(), ".pi", "agent", "models.json");
		const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
		models = (cfg.providers["amd-gateway"]?.models ?? []).map((m) => m.id).slice(0, 12);
	}
	console.log(`cache probe: ${models.length} model(s), two identical long prompts each\n`);
	for (const m of models) await probe(m, key);
}

await main();

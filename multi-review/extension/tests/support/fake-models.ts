import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Model, type ReviewerSpec, parseReviewerSpec } from "../../src/config.ts";

/** A model as the registry would hand it over; enough for callModel. */
export function fakeModel(id: string): Model {
	return { id, name: id, provider: "fake", api: "openai-completions", reasoning: false, maxTokens: 8000 } as unknown as Model;
}

export function row(spec: string, pass?: number): { rs: ReviewerSpec; model: Model; clamped: boolean; pass?: number } {
	const rs = parseReviewerSpec(spec)!;
	return { rs, model: fakeModel(rs.spec.split("/")[1]), clamped: false, ...(pass ? { pass } : {}) };
}

/**
 * A ctx whose model registry answers every single-completion call with
 * `reply(model id, system prompt, user prompt)`, and records the calls.
 */
export function fakeCtx(reply: (modelId: string, system: string, user: string) => string) {
	const calls: Array<{ model: string; system: string; user: string }> = [];
	const ctx = {
		cwd: "/work",
		modelRegistry: {
			streamSimple(model: Model, req: { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> }) {
				const user = req.messages[0].content[0].text;
				calls.push({ model: model.id, system: req.systemPrompt, user });
				const text = reply(model.id, req.systemPrompt, user);
				return { result: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }) };
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

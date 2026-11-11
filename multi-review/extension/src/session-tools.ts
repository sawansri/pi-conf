import { createGrepTool, createReadTool } from "@mariozechner/pi-coding-agent";
import { capGrepOutput, capReadOutput, capToolResult } from "./tool-budget.ts";

/**
 * `read` and `grep` for a nested reviewer/verifier session, with the output
 * capped to `maxChars` (see tool-budget.ts for why).
 *
 * Declared as customTools, which pi resolves over the builtin definitions of
 * the same name; they therefore have to expose the same schema. `maxChars`
 * of 0 returns pi's untouched tools, so the cap is opt-in and a reviewer that
 * needs the full file can always page with offset/limit.
 *
 * Only reviewers use these: the lead's own session keeps pi's defaults.
 */
export function createBudgetedReadTools(cwd: string, maxChars: number): unknown[] {
	const read = createReadTool(cwd);
	const grep = createGrepTool(cwd);
	if (!maxChars) return [read, grep];
	return [
		{
			...read,
			execute: async (id: string, params: { offset?: number }, signal?: AbortSignal, onUpdate?: never, ctx?: never) => {
				const result = (await read.execute(id, params as never, signal, onUpdate, ctx)) as Parameters<typeof capToolResult>[0];
				// The resume offset has to count from where the caller started.
				return capToolResult(result, (text) => capReadOutput(text, { maxChars, startLine: params?.offset ?? 1 }));
			},
		},
		{
			...grep,
			execute: async (id: string, params: never, signal?: AbortSignal, onUpdate?: never, ctx?: never) => {
				const result = (await grep.execute(id, params, signal, onUpdate, ctx)) as Parameters<typeof capToolResult>[0];
				return capToolResult(result, (text) => capGrepOutput(text, { maxChars }));
			},
		},
	];
}

/**
 * Folds pi's `--mode json` event stream (one JSON object per line on stdout)
 * into what the caller needs: the final answer, turns, tool calls, the last
 * tool used, and the spend.
 *
 * Event shapes, from a real `pi --mode json -p` run (pi 1.5): `session`
 * (`id`, `cwd`), then per turn `message_end` with the assistant message
 * (`content`, `provider`, `model`, `usage`, `stopReason`, `errorMessage`),
 * `tool_execution_start` (`toolName`, `args`) and `tool_execution_end`
 * (`isError`). pi exits 0 even when the model call failed; the failure is the
 * last assistant message's `stopReason: "error"`.
 *
 * Pure, so tests feed it canned events.
 */

import { billedCost } from "../../multi-review/extension/src/cost.ts";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** At models.json (catalog) prices, which price cache tokens at $0. */
	cost: number;
	/** With the gateway's cache multipliers (multi-review's cost.ts). */
	billed: number;
}

export interface RunState {
	sessionId?: string;
	/** `provider/model` of the last assistant message. */
	model?: string;
	turns: number;
	toolCalls: Record<string, number>;
	toolErrors: number;
	/** e.g. `read src/cli.ts`; undefined once the tool finished. */
	runningTool?: string;
	lastTool?: string;
	/** Text of the latest assistant message that had any. */
	text: string;
	stopReason?: string;
	errorMessage?: string;
	usage: Usage;
}

/** Input price per million tokens for `provider`/`model`, if known. */
export type RateLookup = (provider: string, model: string) => number | undefined;

export function emptyState(): RunState {
	return {
		turns: 0,
		toolCalls: {},
		toolErrors: 0,
		text: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billed: 0 },
	};
}

/** `read src/x.ts`, `bash git status`, …: the tool and its main argument, one line. */
export function describeTool(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const main = ["command", "pattern", "query", "url", "path", "file_path"].map((k) => a[k]).find((v) => typeof v === "string")
		?? Object.values(a).find((v) => typeof v === "string");
	if (typeof main !== "string") return name;
	const oneLine = main.replace(/\s+/g, " ").trim();
	return `${name} ${oneLine.length > 70 ? `${oneLine.slice(0, 69)}…` : oneLine}`;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

/** Applies one event to `state` (mutating it); returns whether anything shown changed. */
export function applyEvent(state: RunState, event: any, rate: RateLookup = () => undefined): boolean {
	switch (event?.type) {
		case "session":
			if (typeof event.id === "string") state.sessionId = event.id;
			return false;
		case "tool_execution_start": {
			const name = typeof event.toolName === "string" ? event.toolName : "tool";
			state.toolCalls[name] = (state.toolCalls[name] ?? 0) + 1;
			state.runningTool = describeTool(name, event.args);
			state.lastTool = state.runningTool;
			return true;
		}
		case "tool_execution_end":
			if (event.isError) state.toolErrors++;
			state.runningTool = undefined;
			return true;
		case "message_end": {
			const msg = event.message;
			if (msg?.role !== "assistant") return false;
			state.turns++;
			if (msg.provider && msg.model) state.model = `${msg.provider}/${msg.model}`;
			const text = textOf(msg.content);
			if (text) state.text = text;
			state.stopReason = msg.stopReason;
			state.errorMessage = msg.errorMessage;
			const u = msg.usage;
			if (u) {
				const usage = {
					input: u.input || 0,
					output: u.output || 0,
					cacheRead: u.cacheRead || 0,
					cacheWrite: u.cacheWrite || 0,
					total: u.totalTokens || 0,
					cost: u.cost?.total || 0,
				};
				state.usage.input += usage.input;
				state.usage.output += usage.output;
				state.usage.cacheRead += usage.cacheRead;
				state.usage.cacheWrite += usage.cacheWrite;
				state.usage.cost += usage.cost;
				state.usage.billed += billedCost(usage, rate(msg.provider ?? "", msg.model ?? ""), msg.model ?? "");
			}
			return true;
		}
		default:
			return false;
	}
}

/** Whether the run failed: pi exited non-zero, or the last model call errored or was aborted. */
export function isFailed(state: RunState, exitCode: number | null): boolean {
	return exitCode !== 0 || state.stopReason === "error" || state.stopReason === "aborted" || state.turns === 0;
}

/** `read×12 grep×3 bash×1`, most used first. */
export function toolSummary(state: RunState): string {
	return Object.entries(state.toolCalls)
		.sort((a, b) => b[1] - a[1])
		.map(([name, n]) => `${name}×${n}`)
		.join(" ");
}

/** One tool call of an assistant message. */
export interface ToolCallLine {
	id: string;
	name: string;
	args: unknown;
}

/**
 * What `--stream-json` and `--events` write for each pi event that matters:
 * every assistant message whole (thinking, text, tool calls), and every tool
 * result. The mod replays these as the subagent's own responses and tool rows.
 */
export type EventLine =
	| { type: "message"; thinking: string; text: string; toolCalls: ToolCallLine[]; stopReason?: string; errorMessage?: string }
	| { type: "tool_end"; id: string; name: string; isError: boolean; text: string };

/** A tool result longer than this is cut; the transcript doesn't need megabytes of `cat`. */
export const TOOL_TEXT_MAX = 50_000;

function partsText(content: unknown, type: "text" | "thinking"): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === type && typeof p[type] === "string")
		.map((p) => p[type] as string)
		.join("\n")
		.trim();
}

export function toEventLine(event: any): EventLine | undefined {
	if (event?.type === "message_end" && event.message?.role === "assistant") {
		const msg = event.message;
		const content: any[] = Array.isArray(msg.content) ? msg.content : [];
		return {
			type: "message",
			thinking: partsText(content, "thinking"),
			text: partsText(content, "text"),
			toolCalls: content
				.filter((p) => p?.type === "toolCall")
				.map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? "tool"), args: p.arguments ?? {} })),
			stopReason: msg.stopReason,
			errorMessage: msg.errorMessage,
		};
	}
	if (event?.type === "tool_execution_end") {
		let text = partsText(event.result?.content, "text");
		if (text.length > TOOL_TEXT_MAX) text = `${text.slice(0, TOOL_TEXT_MAX)}\n… (${text.length - TOOL_TEXT_MAX} more characters; the full result is in the pi session)`;
		return { type: "tool_end", id: String(event.toolCallId ?? ""), name: String(event.toolName ?? "tool"), isError: !!event.isError, text };
	}
	return undefined;
}

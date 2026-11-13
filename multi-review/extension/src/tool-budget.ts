/**
 * Tighter `read`/`grep` output for nested reviewer and verifier sessions.
 *
 * A tool result stays in the session's history and is re-sent with every
 * later turn. Measured on a real run, a reviewer making 26 tool calls
 * carried ~13x its final context in cumulative prompt tokens: one 50KB read
 * (~12.5k tokens) near the start is billed ~25 times. Reviewers read around
 * the hunks they are judging, not whole files, so pi's stock 2000-line /
 * 50KB read budget is far more context than the job needs.
 *
 * The cap is applied to the tool's rendered text, not by replacing the tool:
 * pi's own read/grep definitions keep path resolution, image handling and
 * the offset/limit contract, so a reviewer that needs more can still page.
 * The truncation notice says how, which is what keeps this from costing
 * recall.
 *
 * Pure apart from the tool wrappers, so tests can load it without pi.
 */

/** How many lines of a truncated read to keep from the head. */
const TRUNCATE_KEEP_LINES = 200;

export interface CapOptions {
	/** Characters allowed in one result; 0 or unset disables the cap. */
	maxChars: number;
	/** The 1-indexed line the caller asked `read` to start at (default 1). */
	startLine?: number;
}

/**
 * The text pi's read tool would return, capped. Keeps the head (where a
 * hunk's context is) and says how to get the rest: the reviewer's next call
 * is then a targeted `offset`, not a re-read.
 *
 * pi returns the file's raw text with no line-number gutter, so the resume
 * offset is counted from `startLine` and the number of COMPLETE lines kept.
 * Dropping the last, possibly half-line matters twice: a partial line is
 * invalid code, and resuming from it would skip its remainder.
 */
export function capReadOutput(text: string, opts: CapOptions): string {
	const { maxChars, startLine = 1 } = opts;
	if (!maxChars || text.length <= maxChars) return text;
	const lines = text.slice(0, maxChars).split("\n");
	// The final element is a partial line unless the slice ended on a newline.
	if (!text.slice(0, maxChars).endsWith("\n")) lines.pop();
	const keptLines = lines.length > TRUNCATE_KEEP_LINES ? lines.slice(0, TRUNCATE_KEEP_LINES) : lines;
	const kept = keptLines.join("\n");
	const next = startLine + keptLines.length;
	return (
		`${kept}\n\n[Output clipped to ${keptLines.length} of ${text.split("\n").length} lines ` +
		`(${maxChars} char budget) to keep this session's context small. ` +
		`Use offset=${next} to read on, limit=<n> to bound a read, or grep for the specific symbol.]`
	);
}

/**
 * grep returns one line per match, so the useful cut is by match count
 * rather than characters: keep whole match lines and say how many were
 * dropped so the reviewer can narrow the pattern.
 */
export function capGrepOutput(text: string, opts: CapOptions): string {
	const { maxChars } = opts;
	if (!maxChars || text.length <= maxChars) return text;
	const head = text.slice(0, maxChars);
	const lines = head.split("\n");
	lines.pop(); // the last line may be cut mid-match
	const dropped = text.slice(head.length).split("\n").length;
	return (
		`${lines.join("\n")}\n\n[${lines.length} matches shown, ~${dropped} more clipped at ${maxChars} chars ` +
		`to keep this session's context small. Narrow the pattern, add a path glob, or use read with offset for the rest.]`
	);
}

/** A tool result whose text blocks get capped; anything else passes through. */
export interface CapableResult {
	content: Array<{ type: string; text?: string }>;
	[other: string]: unknown;
}

/**
 * Cap a tool result's text blocks. `structuredContent` is pi's programmatic
 * view of the same call; leaving it uncapped would hand a nested caller the
 * full text the model was denied, so a changed result drops it.
 */
export function capToolResult(result: CapableResult, cap: (text: string) => string): CapableResult {
	let changed = false;
	const content = result.content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		const text = cap(block.text);
		if (text !== block.text) changed = true;
		return { ...block, text };
	});
	if (!changed) return result;
	const { structuredContent: _dropped, ...rest } = result;
	return { ...rest, content };
}

/** OpenAI's limit on `prompt_cache_key`. */
const PROMPT_CACHE_KEY_MAX = 64;

/**
 * A request body with `prompt_cache_key` set, unless pi already set one. The
 * key routes a session's requests to the machine holding its prefix; without
 * it the gateway's Kimi backend billed one review 1.1M fresh input tokens for
 * a context that ended near 310k (~3.5x what working prefix caching allows).
 * pi only sends the key itself for api.openai.com.
 */
export function withPromptCacheKey(payload: unknown, key: string): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	if ((payload as Record<string, unknown>).prompt_cache_key !== undefined) return payload;
	return { ...payload, prompt_cache_key: key.slice(0, PROMPT_CACHE_KEY_MAX) };
}

type PayloadHook = (payload: unknown, model: never) => unknown | Promise<unknown>;

/**
 * Key every request of a session whose model is listed in `models`
 * (`provider/id`, config.promptCacheKeyModels), on top of whatever onPayload
 * pi installed. pi reads `agent.onPayload` per request, so wrapping it after
 * the session is created is enough.
 */
export function installPromptCacheKey(
	session: { agent: { onPayload?: PayloadHook }; sessionId: string },
	model: { provider: string; id: string },
	models: readonly string[],
): void {
	if (!models.includes(`${model.provider}/${model.id}`)) return;
	const inner = session.agent.onPayload;
	const key = `mr-${session.sessionId}`;
	session.agent.onPayload = async (payload, m) => withPromptCacheKey((await inner?.(payload, m)) ?? payload, key);
}

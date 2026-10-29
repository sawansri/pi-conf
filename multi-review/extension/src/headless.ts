import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseValueFlag } from "./args.ts";
import { leadJudgmentInstructions } from "./lead.ts";
import { TRANSIENT_REVIEWERS, runMultiReviewFromArgs } from "./pipeline.ts";
import type { ToolUpdateFn } from "./progress.ts";
import type { MultiReviewDetails } from "./render.ts";

/**
 * Brief fields shared by the multi_review tool and the headless
 * /multi-review-run command (snake_case, as the tool schema exposes them).
 */
export interface ReviewRequest {
	intent?: string;
	spec_path?: string;
	requirements?: string[];
	suspicions?: string[];
	context_files?: string[];
	checks?: string[];
	focus?: string;
	scope?: "diff" | "area";
	pr_number?: number;
	verify?: boolean;
	quick?: boolean;
	/** Triage the PR's existing review comments (needs pr_number). */
	pr_comments?: boolean;
	include_nits?: boolean;
	include_resolved?: boolean;
}

/**
 * Agent-led review: the caller (pi's main agent, or an external harness
 * such as Claude Code via /multi-review-run) wrote the brief and will judge
 * the results, so no external judge runs. Returns the findings markdown
 * plus lead-judgment instructions, or an error.
 */
export async function runAgentLedReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: ReviewRequest,
	signal: AbortSignal | undefined,
	onUpdate?: ToolUpdateFn,
	deadlineMs?: number,
	detailHint?: string,
	traceDir?: string,
): Promise<{ text: string; markdown: string; details: MultiReviewDetails } | { error: string }> {
	const parts: string[] = [];
	const focus = typeof params.focus === "string" ? params.focus.trim() : "";
	if (params.pr_comments && typeof params.pr_number !== "number") return { error: "multi_review: pr_comments needs pr_number" };
	if (typeof params.pr_number === "number") parts.push(String(params.pr_number));
	else if (params.scope === "area") {
		if (!focus) return { error: "multi_review: scope='area' needs `focus` describing the area to review." };
		parts.push(focus);
	}
	const result = await runMultiReviewFromArgs(pi, ctx, parts.join(" "), signal, TRANSIENT_REVIEWERS, onUpdate, {
		agentLead: true,
		brief: {
			intent: params.intent,
			specPath: params.spec_path,
			requirements: params.requirements,
			suspicions: params.suspicions,
			contextFiles: params.context_files,
			checks: params.checks,
		},
		focus: params.scope === "area" ? undefined : focus,
		flags: { verify: params.verify, quick: params.quick },
		deadlineMs,
		detailHint,
		traceDir,
		prComments: params.pr_comments ? { includeNits: Boolean(params.include_nits), includeResolved: Boolean(params.include_resolved) } : undefined,
	});
	if (!result.injectMessage) return { error: result.notifyMessage };
	const { content: markdown, details } = result.injectMessage;
	const hasSpec = Boolean(params.spec_path || params.requirements?.length);
	return { text: `${markdown}\n\n${leadJudgmentInstructions(hasSpec, details.prComments ? params.pr_number : undefined)}`, markdown, details };
}

/** Validate a brief file's JSON into a ReviewRequest; wrong-typed fields are errors, unknown keys ignored. */
export function parseReviewRequest(raw: unknown): ReviewRequest | { error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "brief must be a JSON object" };
	// Explicit nulls (common in model-written JSON) mean "not set".
	const o = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => v !== null));
	const req: ReviewRequest = {};
	const str = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (typeof o[k] !== "string") throw new Error(`"${k}" must be a string`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	const strs = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (!Array.isArray(o[k]) || !(o[k] as unknown[]).every((x) => typeof x === "string")) throw new Error(`"${k}" must be an array of strings`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	const bool = (k: keyof ReviewRequest) => {
		if (o[k] === undefined) return;
		if (typeof o[k] !== "boolean") throw new Error(`"${k}" must be true or false`);
		(req as Record<string, unknown>)[k] = o[k];
	};
	try {
		// A list of focus areas is a harmless shape slip; join instead of failing the run.
		if (Array.isArray(o.focus) && o.focus.every((x) => typeof x === "string")) o.focus = (o.focus as string[]).join("; ");
		str("intent"); str("spec_path"); str("focus");
		strs("requirements"); strs("suspicions"); strs("context_files"); strs("checks");
		bool("verify"); bool("quick"); bool("pr_comments"); bool("include_nits"); bool("include_resolved");
		if (o.scope !== undefined) {
			if (o.scope !== "diff" && o.scope !== "area") throw new Error(`"scope" must be "diff" or "area"`);
			req.scope = o.scope;
		}
		if (o.pr_number !== undefined) {
			if (typeof o.pr_number !== "number" || !Number.isInteger(o.pr_number) || o.pr_number <= 0) throw new Error(`"pr_number" must be a positive integer`);
			req.pr_number = o.pr_number;
		}
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	return req;
}

/**
 * Headless entry for other harnesses:
 * `pi -p "/multi-review-run --brief=b.json [--out=r.json] [--max-seconds=540]" < /dev/null`.
 * The run fits its phases into --max-seconds (default 540: inside a 10-minute
 * shell cap) by shrinking reviewer/verifier timeouts and skipping
 * verification when too little time is left, never by overrunning.
 * Writes `{ok, text, markdown, details}` JSON plus a `.md` of `text` next to
 * it and sets a non-zero exit code on failure (with `{ok:false, error}`
 * written). Progress and the final `OK|FAILED <paths>` line go to stderr:
 * pi's print mode redirects stdout, so callers should pass --out and rely
 * on it plus the exit code.
 */
const HEADLESS_DEFAULT_MAX_SECONDS = 540;

export async function runHeadless(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	process.env.MULTI_REVIEW_DEBUG ||= "1";
	const started = Date.now();
	const briefFlag = parseValueFlag(args, "brief");
	const outFlag = parseValueFlag(briefFlag.rest, "out");
	const maxFlag = parseValueFlag(outFlag.rest, "max-seconds");
	const maxSeconds = maxFlag.value ? Number(maxFlag.value) : HEADLESS_DEFAULT_MAX_SECONDS;
	const outPath = path.resolve(ctx.cwd, outFlag.value ?? path.join(os.tmpdir(), `multi-review-${Date.now()}.json`));
	const mdPath = outPath.replace(/\.json$/, "") + ".md";
	const fail = (error: string) => {
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify({ ok: false, error }, null, 2) + "\n");
		console.error(`multi-review-run: ${error}`);
		console.error(`FAILED ${outPath}`);
		process.exitCode = 1;
	};
	if (!briefFlag.value) return fail("missing --brief=<path to brief JSON>");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, briefFlag.value), "utf8"));
	} catch (err) {
		return fail(`cannot read brief ${briefFlag.value}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const req = parseReviewRequest(raw);
	if ("error" in req) return fail(`invalid brief: ${req.error}`);
	if (!Number.isFinite(maxSeconds) || maxSeconds < 60) return fail("--max-seconds must be a number ≥ 60");
	// The trace sits next to the result so the caller can watch the run live.
	const traceDir = path.dirname(outPath);
	console.error(`TRACE ${path.join(traceDir, "progress.json")} ${path.join(traceDir, "trace.jsonl")}`);
	let out: Awaited<ReturnType<typeof runAgentLedReview>>;
	try {
		out = await runAgentLedReview(
			pi, ctx, req, undefined, undefined, started + maxSeconds * 1000,
			`Verbatim per-reviewer text, by issue id: ${outPath} → details.groups[].members`,
			traceDir,
		);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	if ("error" in out) return fail(out.error);
	const { target, ...rest } = out.details;
	const details = { ...rest, scope: target.label, warnings: target.warnings };
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify({ ok: true, text: out.text, markdown: out.markdown, details }, null, 2) + "\n");
	fs.writeFileSync(mdPath, out.text + "\n");
	console.error(`OK ${mdPath} ${outPath}`);
}

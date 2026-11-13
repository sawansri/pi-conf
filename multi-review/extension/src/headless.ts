import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ParsedReviewArgs, parseBoolFlag, parseValueFlag } from "./args.ts";
import { leadJudgmentInstructions } from "./lead.ts";
import { TRANSIENT_REVIEWERS, runMultiReviewFromArgs } from "./pipeline.ts";
import { normalizeAuthorFilter } from "./pr-comments.ts";
import type { ToolUpdateFn } from "./progress.ts";
import type { MultiReviewDetails } from "./render.ts";
import { MAX_SOCRATIC_ROUNDS, socraticLeadInstructions } from "./socratic.ts";
import { newRunDir } from "./outcomes.ts";

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
	/** Filter PR comments/reviews by GitHub author login(s), "bot", "human", or "!login". */
	comment_authors?: string[];
	include_nits?: boolean;
	include_resolved?: boolean;
	/** Run a multi-round Socratic discussion on `topic` (or `focus`) instead of a defect-finding review. */
	socratic?: boolean;
	/** Topic or question for Socratic discussion. */
	topic?: string;
	/** Number of Socratic discussion rounds (default 2, max 5). */
	rounds?: number;
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
	const topic = typeof params.topic === "string" ? params.topic.trim() : "";
	const authors = normalizeAuthorFilter(params.comment_authors);
	const wantPrComments = Boolean(params.pr_comments || authors.length > 0);
	if (wantPrComments && typeof params.pr_number !== "number") {
		return { error: "multi_review: pr_comments / comment_authors needs pr_number" };
	}
	let targetOverride: ParsedReviewArgs | undefined;
	if (typeof params.pr_number === "number") {
		parts.push(String(params.pr_number));
		targetOverride = { kind: "pr", number: params.pr_number, raw: topic || focus };
	} else if (params.socratic) {
		const effectiveTopic = topic || focus;
		if (!effectiveTopic && params.scope === "area") {
			return { error: "multi_review: socratic mode with scope='area' needs `topic` (or `focus`)." };
		}
		if (params.scope === "diff" || !effectiveTopic) {
			targetOverride = { kind: "default" };
		} else {
			parts.push(effectiveTopic);
			targetOverride = { kind: "text", value: effectiveTopic };
		}
	} else if (params.scope === "area") {
		if (!focus) return { error: "multi_review: scope='area' needs `focus` describing the area to review." };
		parts.push(focus);
		targetOverride = { kind: "text", value: focus };
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
		focus: params.scope === "area" ? undefined : (focus || topic),
		flags: { verify: params.verify, quick: params.quick },
		deadlineMs,
		detailHint,
		traceDir,
		prComments: wantPrComments
			? { includeNits: Boolean(params.include_nits), includeResolved: Boolean(params.include_resolved), authors: authors.length > 0 ? authors : undefined }
			: undefined,
		socratic: params.socratic ? { topic: topic || focus || undefined, rounds: params.rounds } : undefined,
		targetOverride,
	});
	if (!result.injectMessage) return { error: result.notifyMessage };
	const { content: markdown, details } = result.injectMessage;
	const hasSpec = Boolean(params.spec_path || params.requirements?.length);
	const instructions = params.socratic
		? socraticLeadInstructions(hasSpec)
		: leadJudgmentInstructions(hasSpec, details.prComments ? params.pr_number : undefined);
	return { text: `${markdown}\n\n${instructions}`, markdown, details };
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
		// Accept author filter aliases (comment_authors, authors, author, comment_author) as string or string[].
		const rawAuthors = o.comment_authors ?? o.authors ?? o.author ?? o.comment_author;
		if (rawAuthors !== undefined) {
			if (typeof rawAuthors === "string") o.comment_authors = [rawAuthors];
			else if (Array.isArray(rawAuthors) && rawAuthors.every((x) => typeof x === "string")) o.comment_authors = rawAuthors;
			else throw new Error(`"comment_authors" must be a string or array of strings`);
		}
		if (o.discuss !== undefined && o.socratic === undefined) {
			if (typeof o.discuss !== "boolean") throw new Error(`"discuss" must be true or false`);
			o.socratic = o.discuss;
		}
		if (typeof o.mode === "string" && ["socratic", "discuss"].includes(o.mode.toLowerCase()) && o.socratic === undefined) {
			o.socratic = true;
		}
		str("intent"); str("spec_path"); str("focus"); str("topic");
		strs("requirements"); strs("suspicions"); strs("context_files"); strs("checks"); strs("comment_authors");
		bool("verify"); bool("quick"); bool("pr_comments"); bool("include_nits"); bool("include_resolved"); bool("socratic");
		if (o.scope !== undefined) {
			if (o.scope !== "diff" && o.scope !== "area") throw new Error(`"scope" must be "diff" or "area"`);
			req.scope = o.scope;
		}
		if (o.pr_number !== undefined) {
			if (typeof o.pr_number !== "number" || !Number.isInteger(o.pr_number) || o.pr_number <= 0) throw new Error(`"pr_number" must be a positive integer`);
			req.pr_number = o.pr_number;
		}
		if (o.rounds !== undefined) {
			if (typeof o.rounds !== "number" || !Number.isInteger(o.rounds) || o.rounds < 1 || o.rounds > MAX_SOCRATIC_ROUNDS) {
				throw new Error(`"rounds" must be an integer between 1 and ${MAX_SOCRATIC_ROUNDS}`);
			}
			req.rounds = o.rounds;
			req.socratic ??= true;
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

/**
 * One file per headless run, `<pid>.json` = `{pid, cwd, progress, startedAt}`,
 * so a watcher (the Claude Code mod) finds the run's progress.json without
 * parsing the command that started it (shell variables, `cd`, pipes).
 */
export const RUNS_DIR = path.join(os.homedir(), ".cache", "multi-review", "runs");
const RUN_ENTRY_TTL_MS = 60 * 60_000;

function announceRun(progressPath: string, cwd: string): void {
	const now = Date.now();
	try {
		fs.mkdirSync(RUNS_DIR, { recursive: true });
		fs.writeFileSync(path.join(RUNS_DIR, `${process.pid}.json`), JSON.stringify({ pid: process.pid, cwd, progress: progressPath, startedAt: now }) + "\n");
		for (const name of fs.readdirSync(RUNS_DIR)) {
			const file = path.join(RUNS_DIR, name);
			try {
				if (now - fs.statSync(file).mtimeMs > RUN_ENTRY_TTL_MS) fs.rmSync(file, { force: true });
			} catch {
				/* another run pruned it first */
			}
		}
	} catch {
		/* watching is optional; never fail a review over it */
	}
}

/**
 * Apply the boolean run-shape flags given on the command line over a parsed
 * brief. `--verify` / `--quick` are what a caller reaches for; everything else
 * stays a brief field so the brief remains the record of what was asked.
 */
export function applyCliFlags(req: ReviewRequest, args: string): ReviewRequest {
	const out: ReviewRequest = { ...req };
	const verify = parseBoolFlag(args, "verify");
	if (verify.present) out.verify = true;
	const quick = parseBoolFlag(verify.rest, "quick");
	if (quick.present) out.quick = true;
	// Both compose, as they do on the slash command: a fast pass that still
	// cross-checks.
	return out;
}

export async function runHeadless(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	process.env.MULTI_REVIEW_DEBUG ||= "1";
	const started = Date.now();
	const briefFlag = parseValueFlag(args, "brief");
	const outFlag = parseValueFlag(briefFlag.rest, "out");
	const maxFlag = parseValueFlag(outFlag.rest, "max-seconds");
	const maxSeconds = maxFlag.value ? Number(maxFlag.value) : HEADLESS_DEFAULT_MAX_SECONDS;
	const outPath = path.resolve(ctx.cwd, outFlag.value ?? path.join(newRunDir(), "result.json"));
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
	// Flags on the command line win over the brief, so a caller can escalate a
	// saved brief (`--verify`) without rewriting it. The brief alone was the
	// only source before, which meant `--verify` was silently ignored here.
	const effectiveReq = applyCliFlags(req, args);
	// The trace sits next to the result so the caller can watch the run live.
	const traceDir = path.dirname(outPath);
	console.error(`TRACE ${path.join(traceDir, "progress.json")} ${path.join(traceDir, "trace.jsonl")}`);
	announceRun(path.join(traceDir, "progress.json"), ctx.cwd);
	let out: Awaited<ReturnType<typeof runAgentLedReview>>;
	try {
		out = await runAgentLedReview(
			pi, ctx, effectiveReq, undefined, undefined, started + maxSeconds * 1000,
			effectiveReq.socratic
				? `Full per-round Socratic transcript: ${outPath} → details.socratic.rounds`
				: `Verbatim per-reviewer text, by issue id: ${outPath} → details.groups[].members`,
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

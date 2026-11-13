import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type ParsedReviewArgs, parseAuthorFlags, parseBoolFlag, parseReviewArgs, parseReviewFlags, parseSocraticFlags, parseValueFlag } from "./args.ts";
import { type BriefInput, buildBrief, hasBriefInput, readSpecFile } from "./brief.ts";
import { CXX_FILE, cxxAutoCheck, runChecks } from "./checks.ts";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewFlags, type ReviewerSpec, dedupeTarget, describeFlags, loadConfig, parseReviewerSpec, reviewerRunOptions, scaledMinToolCalls } from "./config.ts";
import { type RunCost, addUsage, emptyRunCost, formatRunCost, runCostLine } from "./cost.ts";
import { type HiddenClaim, type SuspicionResult, groupFindings } from "./grouping.ts";
import { type JudgeResult, runJudge } from "./judge.ts";
import { describeResolved, findModel, resolveJudge, resolveReviewerPoolStructured } from "./models.ts";
import { type PrCommentsReport, classifyPrComments, fetchPrComments, normalizeAuthorFilter } from "./pr-comments.ts";
import { type MultiReviewProgressReporter, type ToolUpdateFn, createProgressReporter, formatReviewerProgressLine, shortSpec } from "./progress.ts";
import { DIFF_BUDGET_CHARS, REVIEWER_SYSTEM_PROMPT, buildReviewUserPrompt } from "./prompts.ts";
import type { MultiReviewDetails } from "./render.ts";
import { type ReviewerRunOptions, allReviewersFailedResult, runAllReviewers, throwIfAborted } from "./reviewers.ts";
import { type SandboxExtras, sandboxUnavailable } from "./sandbox.ts";
import { DEFAULT_SOCRATIC_ROUNDS, MAX_SOCRATIC_ROUNDS, runSocraticDiscussion, runSocraticJudge, synthesizeSocraticLeadView } from "./socratic.ts";
import { newRunDir, readOutcomes, trackRecordLines } from "./outcomes.ts";
import { prClaimAsGroup, prCommentsMarkdown, suspicionAsGroup, suspicionMarkdown, synthesizeLeadView, synthesizeMarkdownFromGroups, synthesizeNoFindingsMarkdown } from "./synthesis.ts";
import { type ReviewTarget, buildReviewTarget, exec, preparePrCheckout } from "./target.ts";
import { ReviewTrace } from "./trace.ts";
import { buildNarrowVerifyPrompt } from "./verdicts.ts";
import { runVerification } from "./verify.ts";
import { createXrefService } from "./xref.ts";

/**
 * Output of runMultiReviewFromArgs. Tool surface returns it; slash command
 * uses notify unless explicitly told to stay silent (we don't, today).
 */
export interface MultiReviewRunResult {
	kind: "inject" | "notify";
	notifyMessage: string;
	notifyLevel: "info" | "warning" | "error";
	injectMessage?: {
		customType: "multi-review";
		content: string;
		details: MultiReviewDetails;
	};
}

/** Time-budget reserves for deadline-capped (headless) runs. */
const MIN_PHASE_MS = 45_000;
const GROUPING_RESERVE_MS = 30_000;
const FINAL_RESERVE_MS = 20_000;
/** What checks leave the reviewers under a deadline: tool-using reviews typically take 2–5 minutes. */
const REVIEW_RESERVE_MS = 180_000;
/**
 * The verify round's share of a headless budget. This is carved out of the
 * REVIEW phase (`fit` below), so it is the number that decides how long the
 * reviewers get. It was 150s, which on a 540s budget left reviewers 355s —
 * less than a healthy pool needs — while the verify round it protected was
 * itself clipped. With `verifiersPerFinding` at 1 and only unraised
 * suspicions to check, a verify round is now a fraction of the review, so the
 * reserve is a fraction of it too.
 */
export const VERIFY_RESERVE_MS = 75_000;

/**
 * Shared entry point used by both `/multi-review` and the `multi_review` tool.
 * Centralizes the ordering (pool → judge check → scope → fan-out → dedupe →
 * judge → inject/notify) so the only thing that differs between the two
 * surfaces is how the result surfaces.
 *
 * `signal`: pass `ctx.signal` when called from a tool execution (defined
 * during active turns) so that Ctrl+C and model_call aborts cancel all
 * in-flight reviewer and judge requests. Slash commands fire outside an
 * active turn so ctx.signal is undefined there — we degrade to no abort
 * instead of synthesizing a fake signal so the user gets to see partial
 * results rather than a recall race.
 */
/**
 * Single-shot override: when set, runMultiReviewFromArgs uses these
 * reviewers instead of cfg.reviewers. Cleared after each invocation.
 * Set ONLY by the picker fallback when the user opts not to persist.
 */
export let TRANSIENT_REVIEWERS: ModelSpec[] | null = null;
/** The picker's choice for the next run only (other modules can't assign an imported let). */
export function setTransientReviewers(specs: ModelSpec[] | null): void { TRANSIENT_REVIEWERS = specs; }

export async function runMultiReviewFromArgs(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	rawArgs: string,
	signal: AbortSignal | undefined,
	transientReviewers: ModelSpec[] | null = TRANSIENT_REVIEWERS,
	onUpdate?: ToolUpdateFn,
	runOptions: {
		agentLead?: boolean;
		brief?: BriefInput;
		focus?: string;
		flags?: Partial<ReviewFlags>;
		deadlineMs?: number;
		/** Where the lead can find verbatim per-reviewer text (headless: result.json). */
		detailHint?: string;
		/** Where the live trace goes (progress.json, trace.jsonl); default a fresh temp dir. */
		traceDir?: string;
		/** Triage the PR's existing review comments (CodeRabbit, collaborators), optionally filtered by author. */
		prComments?: { includeNits: boolean; includeResolved: boolean; authors?: string[] };
		/** Run a multi-round Socratic discussion on a topic instead of a defect-finding review. */
		socratic?: { topic?: string; rounds?: number };
		/** Explicit target resolution from structured callers (tool / brief.json). */
		targetOverride?: ParsedReviewArgs;
	} = {},
): Promise<MultiReviewRunResult> {
	const cfg = loadConfig();
	const agentLead = runOptions.agentLead ?? false;
	const parsedFlags = parseReviewFlags(rawArgs, { verify: cfg.verify, quick: false });
	const flags: ReviewFlags = { ...parsedFlags.flags, ...stripUndefined(runOptions.flags ?? {}) };
	const socraticFlags = parseSocraticFlags(parsedFlags.rest);
	const specFlag = parseValueFlag(socraticFlags.rest, "spec");
	rawArgs = specFlag.rest;
	const prCommentsFlag = parseBoolFlag(rawArgs, "pr-comments");
	const nitsFlag = parseBoolFlag(prCommentsFlag.rest, "nits");
	const resolvedFlag = parseBoolFlag(nitsFlag.rest, "resolved");
	const extraAuthorFlags = parseAuthorFlags(resolvedFlag.rest);
	rawArgs = extraAuthorFlags.rest;
	const cliAuthors = [...(flags.authors ?? []), ...extraAuthorFlags.authors];
	const effectiveAuthors = normalizeAuthorFilter(
		runOptions.prComments?.authors?.length
			? runOptions.prComments.authors
			: cliAuthors.length > 0
				? cliAuthors
				: cfg.commentAuthors,
	);
	if (effectiveAuthors.length > 0) flags.authors = effectiveAuthors;
	const isSocratic = Boolean(runOptions.socratic || socraticFlags.socratic);
	const socraticRounds = Math.max(
		1,
		Math.min(MAX_SOCRATIC_ROUNDS, runOptions.socratic?.rounds ?? socraticFlags.rounds ?? DEFAULT_SOCRATIC_ROUNDS),
	);
	const prCommentOpts = runOptions.prComments
		? { ...runOptions.prComments, authors: effectiveAuthors.length > 0 ? effectiveAuthors : undefined }
		: (prCommentsFlag.present || cliAuthors.length > 0)
			? { includeNits: nitsFlag.present, includeResolved: resolvedFlag.present, authors: effectiveAuthors.length > 0 ? effectiveAuthors : undefined }
			: undefined;
	let parsed = runOptions.targetOverride ?? parseReviewArgs(rawArgs);
	if (prCommentOpts && parsed.kind !== "pr") {
		const ghPr = await exec(pi, "gh", ["pr", "view", "--json", "number"], ctx.cwd, 10_000);
		let prNum = 0;
		try {
			prNum = ghPr.code === 0 ? Number(JSON.parse(ghPr.stdout || "{}")?.number) : 0;
		} catch { /* not a PR branch */ }
		if (Number.isFinite(prNum) && prNum > 0) {
			parsed = { kind: "pr", number: prNum, raw: parsed.kind === "text" ? parsed.value : "" };
		} else {
			return { kind: "notify", notifyMessage: "multi-review: --pr-comments / --author needs a PR (e.g. #1234 or an open PR on the current branch)", notifyLevel: "error" };
		}
	}
	const briefInput: BriefInput = { ...runOptions.brief };
	if (specFlag.value && !briefInput.specPath) briefInput.specPath = specFlag.value;
	// An explicitly requested spec that can't be read must not silently
	// degrade into a spec-less review. PR reviews check it against the PR's
	// code after checkout instead (the PR may add the spec).
	if (briefInput.specPath && parsed.kind !== "pr") {
		const spec = readSpecFile(ctx.cwd, briefInput.specPath);
		if ("error" in spec) return { kind: "notify", notifyMessage: `multi-review: ${spec.error}`, notifyLevel: "error" };
	}
	// A transient pool (picker, not persisted) overrides the configured one
	// for this run only; --quick swaps in the fast pool.
	const usingTransientReviewers = transientReviewers !== null && transientReviewers.length > 0;
	const poolName = usingTransientReviewers ? "transient" : flags.quick ? "quickReviewers" : "reviewers";
	// verifyOnly wins over reviewers: a model listed in both only verifies.
	const verifyOnlyIds = new Set(cfg.verifyOnly.map((raw) => parseReviewerSpec(raw)?.spec));
	const reviewOnlySpecs = cfg.reviewers.filter((raw) => !verifyOnlyIds.has(parseReviewerSpec(raw)?.spec));
	// Socratic discussions want the widest set of independent voices: verify-only
	// models join as full participants. Quick runs have no
	// tools, so they keep the quick pool.
	const socraticSpecs = [...reviewOnlySpecs, ...cfg.verifyOnly]
		.filter((raw, i, all) => all.findIndex((o) => parseReviewerSpec(o)?.spec === parseReviewerSpec(raw)?.spec) === i);
	const effectiveReviewerSpecs: string[] = usingTransientReviewers
		? transientReviewers
		: flags.quick ? cfg.quickReviewers : isSocratic ? socraticSpecs : reviewOnlySpecs;
	if (usingTransientReviewers && transientReviewers === TRANSIENT_REVIEWERS) TRANSIENT_REVIEWERS = null;
	if (effectiveReviewerSpecs.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: no ${poolName} configured.\n\n` +
				`Drop a "$PI_CODING_AGENT_DIR/multi-review.json" like:\n` +
				`  { "reviewers": ["amd-gateway/gpt-6-astra", "amd-gateway/Grok-4.7"], "judge": "amd-gateway-anthropic/Claude-Opus-5.5" }\n` +
				`Or with per-reviewer thinking: "amd-gateway/gpt-6-astra@xhigh"\n` +
				`Then /reload.\n\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "warning",
		};
	}
	const resolved = (await resolveReviewerPoolStructured(ctx, effectiveReviewerSpecs)).entries;
	if (resolved.length === 0) {
		return {
			kind: "notify",
			notifyMessage:
				`multi-review: none of the ${poolName} resolved.\n` +
				describeResolved([], effectiveReviewerSpecs) +
				`\nArgs: ${rawArgs.trim() || "(none)"}`,
			notifyLevel: "error",
		};
	}

	const label = isSocratic ? `socratic${flags.quick ? "+quick" : ""} (${socraticRounds}r)` : describeFlags(flags);
	const progress = createProgressReporter(ctx, label, onUpdate);
	let cleanupCheckout: (() => Promise<void>) | undefined;
	let trace: ReviewTrace | undefined;
	// The pipeline copies runOpts; sharing this array lets it register cleanups here.
	const cleanups: Array<() => void> = [];
	try {
		progress.update({ phase: "resolving scope" });
		const target = await buildReviewTarget(pi, parsed, ctx.cwd);
		// A focus hint narrows attention within the diff; it never replaces the diff.
		if (runOptions.focus?.trim()) {
			target.focusHint = target.focusHint ? `${target.focusHint}\n\n${runOptions.focus.trim()}` : runOptions.focus.trim();
		}
		const runOpts: ReviewerRunOptions = {
			...(flags.quick
				? { useTools: false, timeoutMs: cfg.reviewerTimeoutSec * 1000 }
				: {
					...reviewerRunOptions(cfg),
					minToolCalls: scaledMinToolCalls(cfg.minReviewToolCalls, whichChangedLines(target.diffText)),
					readMaxCharsBySpec: cfg.readMaxCharsByModel,
				}),
			cleanups,
		};
		trace = new ReviewTrace(runOptions.traceDir ?? newRunDir(), (lines) => progress.activity(lines));
		runOpts.trace = trace;
		const runTrace = trace;
		progress.mirror((run) => runTrace.setRun(run));
		// PR reviews read the PR's actual code; brief files (spec, context) too,
		// since the PR may add or change them.
		if (target.kind === "pr" && target.pr) {
			progress.update({ phase: "preparing PR checkout" });
			const checkout = await preparePrCheckout(pi, ctx.cwd, target.pr);
			cleanupCheckout = checkout.cleanup;
			target.reviewDir = checkout.dir;
			runOpts.cwd = checkout.dir;
			if (checkout.note) target.metaLines.push(`(${checkout.note})`);
			if (checkout.warning) target.warnings.push(checkout.warning);
		}
		const briefDir = target.reviewDir ?? ctx.cwd;
		let specDir = briefDir;
		if (briefInput.specPath) {
			// A spec is a document about the change, not code under review: when
			// the PR checkout lacks it (e.g. an untracked local doc), use the
			// local copy rather than refusing the review.
			let spec = readSpecFile(briefDir, briefInput.specPath);
			if ("error" in spec && briefDir !== ctx.cwd) {
				const local = readSpecFile(ctx.cwd, briefInput.specPath);
				if (!("error" in local)) {
					spec = local;
					specDir = ctx.cwd;
					target.metaLines.push(`(spec ${briefInput.specPath} read from your local checkout; it isn't in the PR)`);
				}
			}
			if ("error" in spec) {
				progress.finish("failed");
				return { kind: "notify", notifyMessage: `multi-review: ${spec.error}`, notifyLevel: "error" };
			}
		}
		if (hasBriefInput(briefInput)) {
			target.brief = buildBrief(briefDir, { ...briefInput, specPath: undefined }, target.warnings);
			if (briefInput.specPath) {
				const spec = readSpecFile(specDir, briefInput.specPath);
				if (!("error" in spec)) target.brief.spec = spec;
			}
		}
		let prReport: PrCommentsReport | undefined;
		if (prCommentOpts) {
			if (!target.pr) {
				target.warnings.push("could not resolve the PR via gh, so its review comments were not checked");
			} else {
				const authorDesc = prCommentOpts.authors?.length ? ` (author filter: ${prCommentOpts.authors.join(", ")})` : "";
				progress.update({ phase: `fetching PR review comments${authorDesc}` });
				const fetched = await fetchPrComments(pi, ctx.cwd, target.pr, prCommentOpts.includeResolved, target.warnings, prCommentOpts.authors);
				progress.update({ phase: `classifying ${fetched.items.length} PR comment item(s)` });
				const cls = await classifyPrComments(ctx, cfg, fetched.items, prCommentOpts.includeNits, signal);
				if (cls.error) target.warnings.push(`PR comment classification failed (${cls.error}); comments were not checked`);
				prReport = {
					claims: cls.claims,
					others: cls.others,
					authors: prCommentOpts.authors?.length ? prCommentOpts.authors : undefined,
					stats: {
						threads: fetched.items.filter((i) => i.kind === "thread").length,
						// (includes resolved threads, which are context only)
						reviews: fetched.items.filter((i) => i.kind === "review").length,
						conversation: fetched.items.filter((i) => i.kind === "conversation").length,
						skippedResolved: fetched.skippedResolved,
						skippedAuthors: fetched.skippedAuthors || undefined,
						skippedNits: cls.skippedNits,
						noise: cls.noise,
					},
				};
			}
		}
		if (target.diffText.length > DIFF_BUDGET_CHARS) {
			target.warnings.push(`diff is ${target.diffText.length} chars; reviewers saw the first ${DIFF_BUDGET_CHARS}. Narrow the scope or use focus.`);
		}
		// The main agent replaces the external judge; --direct needs one, but
		// a missing judge degrades to deterministic synthesis, not an error.
		const judge = agentLead ? null : resolveJudge(ctx, cfg);
		if (!agentLead && !judge) target.warnings.push(`judge ${cfg.judge} not in registry; showing deterministic synthesis`);
		const resolvedRows = resolved.map((r) => ({ rs: r.rs, model: r.model, clamped: r.clamped }));
		const hintWithTrace = [runOptions.detailHint, `Reviewer trace (tool calls, thinking and replies per session): ${trace.tracePath}`].filter(Boolean).join("\n");
		if (isSocratic) {
			const topic = (
				runOptions.socratic?.topic?.trim() ||
				(parsed.kind === "text" ? parsed.value.trim() : parsed.kind === "pr" ? parsed.raw.trim() : "") ||
				runOptions.focus?.trim() ||
				target.brief?.intent?.trim() ||
				(parsed.kind === "pr"
					? `Examine the design, assumptions, and tradeoffs of PR #${parsed.number}`
					: "Examine the design, assumptions, and tradeoffs of the current working-tree change")
			);
			const result = await runSocraticPipeline(
				ctx, cfg, flags, target, resolvedRows, runOpts, judge, agentLead, signal, progress,
				topic, socraticRounds, label, runOptions.deadlineMs, hintWithTrace, prReport,
			);
			progress.finish("done");
			return result;
		}
		// Verification runs with --verify or PR comments, and in any tool-using
		// run for a straggler's partial findings. Quick runs have no tools, so
		// verify-only models (picked for tool use) sit out.
		const verifies = !flags.quick && (flags.verify || prCommentOpts !== undefined || runOpts.useTools);
		const verifyOnly = verifies ? await resolveReviewerPoolStructured(ctx, cfg.verifyOnly) : { entries: [], missing: [] };
		if (verifyOnly.missing.length > 0) target.warnings.push(`verifyOnly models not in registry, skipped: ${verifyOnly.missing.join(", ")}`);
		const verifierRows = verifyOnly.entries.map((r) => ({ rs: r.rs, model: r.model, clamped: r.clamped }));
		const result = await runReviewPipeline(ctx, cfg, flags, target, resolvedRows, verifierRows, runOpts, judge, agentLead, signal, progress, runOptions.deadlineMs, hintWithTrace, prReport);
		progress.finish("done");
		return result;
	} catch (err) {
		progress.finish("failed");
		throw err;
	} finally {
		trace?.close();
		for (const cleanup of cleanups) cleanup();
		await cleanupCheckout?.();
	}
}

/**
 * Changed lines in a unified diff: added/removed lines plus hunk headers
 * (a hunk header means a region moved even with no added or removed line).
 * Cheap context for the second-pass gate; the diff is already in memory.
 */
export function whichChangedLines(diffText: string): number {
	let n = 0;
	for (const l of diffText.split("\n")) {
		if (l.startsWith("@@") || /^[+-][^+-]/.test(l)) n++;
	}
	return n;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Shared sandbox, clangd xref, web search, and check setup for both review
 * and Socratic discussion runs.
 */
async function prepareExecutionTools(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	flags: ReviewFlags,
	target: ReviewTarget,
	runOpts: ReviewerRunOptions,
	mayExecute: boolean,
	autoCheckDiff: boolean,
	checkReserveMs: number,
	signal: AbortSignal | undefined,
	progress: MultiReviewProgressReporter,
	deadlineMs?: number,
): Promise<{ runOpts: ReviewerRunOptions; sandboxReason: string | null; sandboxExtras: SandboxExtras }> {
	const allCandidatePaths = [
		...target.files.map((f) => f.path),
		...(target.brief?.contextFiles.map((f) => f.path) ?? []),
	];
	const needsSandbox = mayExecute || allCandidatePaths.some((p) => CXX_FILE.test(p));
	const sandboxReason = !cfg.sandbox
		? "sandbox is off in multi-review.json"
		: flags.quick || !runOpts.useTools
			? "quick runs don't execute code"
			: needsSandbox ? await sandboxUnavailable(signal) : "nothing to execute";
	throwIfAborted(signal);
	if (!sandboxReason) {
		const xref = createXrefService(allCandidatePaths, runOpts.cwd ?? ctx.cwd, ctx.cwd, cfg.sandboxHomeDirs);
		if (xref) {
			runOpts = { ...runOpts, xref };
			runOpts.cleanups?.push(() => xref.dispose());
		}
	}
	if (cfg.webSearch && runOpts.useTools) {
		const proxy = findModel(ctx, cfg.webSearchProxyModel as ModelSpec);
		const proxyModel = proxy && proxy.api === "anthropic-messages" ? proxy : undefined;
		if (!proxyModel) target.warnings.push(`webSearchProxyModel ${cfg.webSearchProxyModel} is missing or not an anthropic-messages model; only natively searching models can search`);
		runOpts = { ...runOpts, webSearch: { proxyModel, nativeApis: new Set(cfg.webSearchNativeApis) } };
	}
	const checks = [...(target.brief?.checks ?? [])];
	let sandboxExtras: SandboxExtras = {};
	if (autoCheckDiff && cfg.autoChecks && !sandboxReason && !checks.some((c) => c.includes("mr-cxx-check"))) {
		const auto = cxxAutoCheck(target.files.map((f) => f.path), runOpts.cwd ?? ctx.cwd, ctx.cwd, target.warnings, target.diffText);
		if (auto) {
			checks.unshift(auto.command);
			sandboxExtras = auto.extras;
		}
	}
	if (checks.length > 0 && sandboxReason) {
		target.warnings.push(`checks not run: ${sandboxReason}`);
	} else if (checks.length > 0) {
		const budget = Math.min(cfg.checkTimeoutSec * 1000, deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now() - checkReserveMs);
		target.checkResults = await runChecks(runOpts.cwd ?? ctx.cwd, checks, budget, cfg.sandboxHomeDirs, sandboxExtras, signal, (what) =>
			progress.update({ phase: `checks: ${what.length > 60 ? `${what.slice(0, 59)}…` : what}` }));
		throwIfAborted(signal);
		if (target.checkResults.some((r) => r.timedOut || r.skipped)) {
			target.warnings.push(`some checks hit the ${cfg.checkTimeoutSec}s check budget; brief faster checks (type-check, one target, targeted tests)`);
		}
	}
	return { runOpts, sandboxReason, sandboxExtras };
}

/**
 * Multi-round Socratic discussion pipeline: models get the same tools as in
 * review, form opening positions + Socratic questions in Round 1, and
 * cross-examine each other in Round 2+.
 */
async function runSocraticPipeline(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	flags: ReviewFlags,
	target: ReviewTarget,
	rows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	baseRunOpts: ReviewerRunOptions,
	judge: Model | null,
	agentLead: boolean,
	signal: AbortSignal | undefined,
	progress: MultiReviewProgressReporter,
	topic: string,
	totalRounds: number,
	label: string,
	deadlineMs?: number,
	detailHint?: string,
	prReport?: PrCommentsReport,
): Promise<MultiReviewRunResult> {
	const checkReserve = REVIEW_RESERVE_MS + FINAL_RESERVE_MS;
	const prep = await prepareExecutionTools(
		ctx, cfg, flags, target, baseRunOpts,
		true, Boolean(target.diffText), checkReserve, signal, progress, deadlineMs,
	);
	const runOpts: ReviewerRunOptions = {
		...prep.runOpts,
		sandbox: prep.sandboxReason === null,
		sandboxExtras: prep.sandboxExtras,
	};
	const fitRoundTimeoutMs = (remainingRounds: number): number => {
		if (deadlineMs === undefined) return runOpts.timeoutMs;
		const available = deadlineMs - Date.now() - FINAL_RESERVE_MS;
		return Math.max(MIN_PHASE_MS, Math.min(runOpts.timeoutMs, Math.floor(available / Math.max(1, remainingRounds))));
	};
	const canStartNextRound = () => {
		if (deadlineMs === undefined) return { ok: true, remainingSec: Number.POSITIVE_INFINITY };
		const leftMs = deadlineMs - Date.now() - FINAL_RESERVE_MS;
		return { ok: leftMs >= MIN_PHASE_MS, remainingSec: Math.max(0, Math.round(leftMs / 1000)) };
	};

	const out = await runSocraticDiscussion(
		ctx, cfg, rows, target, topic, totalRounds, runOpts, signal, progress,
		fitRoundTimeoutMs, canStartNextRound, prReport,
	);
	if ("failure" in out) return out.failure;
	const { socratic } = out;

	let markdown: string;
	let judgeLabel = agentLead ? "(main agent)" : "(none)";
	let judgeDurationMs = 0;
	let judgeUsage: JudgeResult["usage"];
	if (agentLead) {
		markdown = synthesizeSocraticLeadView(target, socratic, `${label} · you moderate`, detailHint);
	} else if (judge) {
		progress.update({ phase: `synthesizing discussion (${shortSpec(cfg.judge)})`, done: undefined, total: undefined });
		const jr = await runSocraticJudge(judge, socratic, target, ctx, signal, cfg.temperature, cfg.judgeThinking, cfg.judgeMaxTokens);
		throwIfAborted(signal);
		judgeLabel = cfg.judge;
		judgeDurationMs = jr.durationMs;
		judgeUsage = jr.usage;
		markdown = jr.markdown.trim()
			? jr.markdown
			: `# Multi-Model Socratic Discussion (moderator returned nothing)\n\nModerator \`${cfg.judge}\` failed (${jr.errorMessage ?? `stopReason=${jr.stopReason}`}); transcript follows.\n\n` +
				synthesizeSocraticLeadView(target, socratic, label, detailHint);
	} else {
		markdown = synthesizeSocraticLeadView(target, socratic, label, detailHint);
	}
	if (prReport) markdown += `\n\n${prCommentsMarkdown(prReport, []).join("\n")}`;

	// Same roll-up as a review: every participant turn (across all rounds) plus
	// the moderator. Each round resends the whole history, so rounds dominate.
	const cost: RunCost = emptyRunCost();
	for (const round of socratic.rounds) for (const e of round.entries) addUsage(cost, e.formattedSpec, e.usage);
	if (judgeUsage) addUsage(cost, cfg.judge, judgeUsage);

	const r1 = socratic.rounds[0]?.entries ?? [];
	const failedSpecs = rows
		.filter((_, idx) => !socratic.rounds.some((r) => r.entries[idx]?.ok))
		.map((r) => r.rs.spec);
	const totalTools = socratic.rounds.reduce((s, r) => s + r.entries.reduce((rs, e) => rs + (e.toolCalls ?? 0), 0), 0);
	const details: MultiReviewDetails = {
		target,
		groups: [],
		reviewerSpecs: r1.map((e) => e.spec),
		failedSpecs,
		judge: judgeLabel,
		judgeDurationMs,
		judgeUsage,
		consensusCount: 0,
		totalFindings: 0,
		prComments: prReport,
		socratic,
		cost,
	};
	markdown += runCostLine(cost);
	return {
		kind: "inject",
		notifyMessage:
			`multi-review · ${label} · done\n` +
			`topic: ${topic.slice(0, 100)}${topic.length > 100 ? "…" : ""}\n` +
			`participants: ${rows.length}   rounds: ${socratic.rounds.length}/${totalRounds}   tool calls: ${totalTools}` +
			`\ncost: ${formatRunCost(cost)}` +
			(target.warnings.length ? `\nwarnings: ${target.warnings.length} (see discussion)` : ""),
		notifyLevel: "info",
		injectMessage: { customType: "multi-review", content: markdown, details },
	};
}

/**
 * The one review pipeline: fan-out → group → (verify) → synthesis.
 * Synthesis is deterministic markdown when the main agent leads (it judges
 * from the tool result) and the external judge's markdown under --direct.
 */
async function runReviewPipeline(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	flags: ReviewFlags,
	target: ReviewTarget,
	rows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	verifierRows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	runOpts: ReviewerRunOptions,
	judge: Model | null,
	agentLead: boolean,
	signal: AbortSignal | undefined,
	progress: MultiReviewProgressReporter,
	deadlineMs?: number,
	detailHint?: string,
	prReport?: PrCommentsReport,
): Promise<MultiReviewRunResult> {
	const label = describeFlags(flags);
	// With a deadline (headless callers inside a capped shell), each phase's
	// timeout shrinks to fit, keeping a reserve for the phases after it.
	const fit = (opts: ReviewerRunOptions, reserveMs: number): ReviewerRunOptions =>
		deadlineMs === undefined
			? opts
			: { ...opts, timeoutMs: Math.max(MIN_PHASE_MS, Math.min(opts.timeoutMs, deadlineMs - Date.now() - reserveMs)) };
	// Code only runs sandboxed, and never in quick runs (no tools there). The
	// probe runs only when something would execute: checks, reviewers'
	// repros, or verification (a straggler's partial findings get verifiers
	// even without --verify).
	const mayExecute = (target.brief?.checks.length ?? 0) > 0 || flags.verify || (prReport?.claims.length ?? 0) > 0 || (!flags.quick && runOpts.useTools);
	const checkReserve = REVIEW_RESERVE_MS + GROUPING_RESERVE_MS + (flags.verify ? VERIFY_RESERVE_MS : 0) + FINAL_RESERVE_MS;
	const prep = await prepareExecutionTools(
		ctx, cfg, flags, target, runOpts,
		mayExecute, true, checkReserve, signal, progress, deadlineMs,
	);
	runOpts = prep.runOpts;
	const { sandboxReason, sandboxExtras } = prep;
	const userPrompt = buildReviewUserPrompt(target);
	// secondPass models review twice, the second time with the diff's files
	// reversed. Quick runs (single completions) keep one pass each.
	const twice = new Set(cfg.secondPass.map((raw) => parseReviewerSpec(raw)?.spec));
	// A second pass costs a whole extra session, and its reversed diff shares
	// no prompt cache with pass 1. On a short diff it is nearly the same
	// prompt too, so it mostly re-derives the same findings. `secondPassMinLines`
	// (default 0 = always run) gates it on changed-line count, which is known
	// before the fan-out.
	const changedLines = whichChangedLines(target.diffText);
	const secondPassRuns = (spec: string): boolean => twice.has(spec) && changedLines >= cfg.secondPassMinLines;
	const skippedSecondPass = flags.quick ? [] : rows.filter((r) => twice.has(r.rs.spec) && !secondPassRuns(r.rs.spec)).map((r) => r.rs.spec);
	const passes = flags.quick ? rows : [...rows, ...rows.filter((r) => secondPassRuns(r.rs.spec)).map((r) => ({ ...r, pass: 2 }))];
	if (skippedSecondPass.length > 0) {
		target.metaLines.push(
			`(second pass skipped for ${skippedSecondPass.join(", ")}: ${changedLines} changed lines < secondPassMinLines=${cfg.secondPassMinLines})`,
		);
	}
	const reversedPrompt = passes.length > rows.length ? buildReviewUserPrompt(target, { reverseFiles: true }) : userPrompt;
	progress.update({ phase: `fanning out to ${passes.length} reviewers (cap ${cfg.concurrency})`, done: 0, total: passes.length });
	const runs = await runAllReviewers(
		passes,
		REVIEWER_SYSTEM_PROMPT,
		(row) => (row.pass ? reversedPrompt : userPrompt),
		cfg.concurrency,
		cfg.temperature,
		signal,
		ctx,
		// Reviewers get `run` too, to prove findings by executing their repros.
		{ ...fit(runOpts, GROUPING_RESERVE_MS + (flags.verify ? VERIFY_RESERVE_MS : 0)), sandbox: sandboxReason === null, sandboxExtras },
		(done, total, latest) => progress.update({ phase: "reviewers running", done, total, latest: formatReviewerProgressLine(done, total, latest) }),
	);
	const failure = allReviewersFailedResult(runs, label);
	if (failure) return failure;
	// One roll-up for the whole run: reviewers (both passes), the grouping
	// call, the verify round, and the judge. Nested sessions are in-memory, so
	// this is the only place a run's real spend becomes visible.
	const cost: RunCost = emptyRunCost();
	for (const r of runs) addUsage(cost, r.formattedSpec, r.usage);

	const suspicionTexts = target.brief?.suspicions ?? [];
	const prClaims = prReport?.claims ?? [];
	const hidden: HiddenClaim[] = [
		...suspicionTexts.map((text, i) => ({ key: `S:${i}`, label: "lead hypothesis", text })),
		...prClaims.map((c, i) => ({ key: `P:${i}`, label: `PR comment by @${c.author}`, text: `${c.path ? `${c.path}: ` : ""}${c.claim}` })),
	];
	const { groups, matches, usage: groupingUsage } = await groupFindings(ctx, cfg, runs, signal, progress, hidden);
	addUsage(cost, dedupeTarget(cfg) ?? "grouping (lexical)", groupingUsage);
	// Grouping and judge calls turn an abort into an error + fallback; a
	// cancelled run must stop here, not publish a fallback review.
	throwIfAborted(signal);
	const suspicions: SuspicionResult[] = suspicionTexts.map((text, i) => ({ id: `s${i + 1}`, text, raisedBy: matches.get(`S:${i}`) ?? [] }));
	prClaims.forEach((c, i) => { c.raisedBy = matches.get(`P:${i}`) ?? []; });
	// Suspicions and PR claims ride the verify round as claims of their own:
	// every reviewer is eligible (none raised them; none saw them). PR
	// claims are always verified — checking them is the point of fetching.
	//
	// A suspicion a reviewer raised independently is NOT a verify target: it
	// already entered the round as a finding group, so verifying it again
	// pays twice for one answer. In a real run 16 lead suspicions doubled the
	// verify round (31 targets instead of 15) to $1.21, and 12 of them were
	// duplicates of finding groups or unraised. What a suspicion is for is
	// "did anyone reach this on their own", so an independently-raised one is
	// already answered.
	const unraisedSuspicions = suspicions.filter((s) => s.raisedBy.length === 0);
	const suspicionGroups = flags.verify ? unraisedSuspicions.map(suspicionAsGroup) : [];
	const prClaimGroups = prClaims.map(prClaimAsGroup);
	const verifyTimeLeft = deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now() - FINAL_RESERVE_MS;
	// A straggler's harvested findings are always verified: it was cut off mid-check.
	// By run, not model: one partial pass doesn't make the other's findings partial.
	const runKey = (r: { spec: string; pass?: number }) => `${r.spec}#${r.pass ?? 1}`;
	const partialRuns = new Set(runs.filter((r) => r.partial).map(runKey));
	const findingGroups = flags.verify ? groups : groups.filter((g) => g.members.some((m) => partialRuns.has(runKey(m))));
	const toVerify = [...findingGroups, ...suspicionGroups, ...prClaimGroups];
	if (toVerify.length > 0 && verifyTimeLeft < MIN_PHASE_MS) {
		const unverifiedPartial = partialRuns.size > 0 ? "; partial reviewers' findings are unverified" : "";
		target.warnings.push(`verification skipped: only ${Math.max(0, Math.round(verifyTimeLeft / 1000))}s left of the run's time budget${unverifiedPartial}`);
	} else if (toVerify.length > 0) {
		// One row per model: a duplicate would count as two independent verifiers.
		const verifierPool = [...rows, ...verifierRows].filter((r, i, all) => all.findIndex((o) => o.rs.spec === r.rs.spec) === i);
		if (sandboxReason && cfg.sandbox && !flags.quick && runOpts.useTools) target.warnings.push(`verifiers can't execute code: ${sandboxReason}`);
		const { failures, runs: verifierRuns } = await runVerification(
			ctx, cfg, verifierPool, toVerify, userPrompt,
			{ ...fit(runOpts, FINAL_RESERVE_MS), sandbox: sandboxReason === null, sandboxExtras },
			signal, progress,
			// A verifier needs its findings' files, not every file in the change.
			(assigned) => buildNarrowVerifyPrompt(target, target.brief, assigned),
		);
		for (const r of verifierRuns) addUsage(cost, `${r.spec} (verify)`, r.usage);
		for (const f of failures) target.warnings.push(`verifier failed (its claims stay unverified): ${f}`);
		// Map by the suspicion's own id, not by position: only unraised
		// suspicions enter the round, so the group list is a subset.
		const groupById = new Map(suspicionGroups.map((g) => [g.id, g]));
		for (const sus of suspicions) {
			const g = groupById.get(sus.id);
			if (!g) continue;
			sus.verifications = g.verifications;
			sus.verificationNote = g.verificationNote;
		}
		prClaimGroups.forEach((g, i) => {
			prClaims[i].verifications = g.verifications;
			prClaims[i].verificationNote = g.verificationNote;
		});
	}

	let markdown: string;
	let judgeLabel = agentLead ? "(main agent)" : "(none)";
	let judgeDurationMs = 0;
	let judgeUsage: JudgeResult["usage"];
	if (agentLead) {
		markdown = synthesizeLeadView(target, groups, runs, `${label} · you judge`, detailHint);
		const track = trackRecordLines(readOutcomes(), [...new Set(runs.map((r) => r.spec))]);
		if (track.length) markdown += `\n${track.join("\n")}`;
	} else if (groups.length === 0) {
		markdown = synthesizeNoFindingsMarkdown(target, runs, label);
	} else if (judge) {
		progress.update({ phase: `${groups.length} groups · invoking judge ${shortSpec(cfg.judge)}`, done: undefined, total: undefined });
		const jr = await runJudge(judge, groups, target, runs.filter((r) => !r.ok).map((r) => r.spec), ctx, signal, cfg.temperature, cfg.judgeThinking, cfg.judgeMaxTokens);
		throwIfAborted(signal);
		judgeLabel = cfg.judge;
		judgeDurationMs = jr.durationMs;
		judgeUsage = jr.usage;
		addUsage(cost, cfg.judge, jr.usage);
		markdown = jr.markdown.trim()
			? jr.markdown
			: `# Multi-Model Code Review (judge returned nothing)\n\nJudge \`${cfg.judge}\` failed (${jr.errorMessage ?? `stopReason=${jr.stopReason}`}); deterministic synthesis follows.\n\n` +
				synthesizeMarkdownFromGroups(target, groups, runs, label);
	} else {
		markdown = synthesizeMarkdownFromGroups(target, groups, runs, label);
	}
	if (suspicions.length > 0) markdown += `\n\n${suspicionMarkdown(suspicions, groups, flags.verify).join("\n")}`;
	if (prReport) markdown += `\n\n${prCommentsMarkdown(prReport, groups).join("\n")}`;
	markdown += runCostLine(cost);

	const details: MultiReviewDetails = {
		target,
		groups,
		reviewerSpecs: runs.map((r) => r.spec),
		failedSpecs: runs.filter((r) => !r.ok).map((r) => r.spec),
		judge: judgeLabel,
		judgeDurationMs,
		judgeUsage,
		cost,
		consensusCount: groups.filter((g) => g.consensus).length,
		totalFindings: groups.reduce((s, g) => s + g.members.length, 0),
		suspicions: suspicions.length > 0 ? suspicions : undefined,
		prComments: prReport,
	};
	const verified = groups.filter((g) => g.verifications?.length).length;
	return {
		kind: "inject",
		notifyMessage:
			`multi-review · ${label} · done\n` +
			`scope: ${target.label}   files: ${target.files.length}   diff bytes: ${target.diffText.length}\n` +
			`reviewers: ${runs.length}   issues: ${groups.length}   consensus: ${details.consensusCount}` +
			(flags.verify ? `   verified: ${verified}/${groups.length}` : "") +
			(suspicions.length ? `   suspicions raised independently: ${suspicions.filter((x) => x.raisedBy.length).length}/${suspicions.length}` : "") +
			(prReport ? `   PR claims: ${prClaims.length} (${prClaims.filter((c) => c.verifications?.some((v) => v.verdict === "confirmed")).length} confirmed)` : "") +
			`\ncost: ${formatRunCost(cost)}` +
			(target.warnings.length ? `\nwarnings: ${target.warnings.length} (see review)` : ""),
		notifyLevel: "info",
		injectMessage: { customType: "multi-review", content: markdown, details },
	};
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseBoolFlag, parseReviewArgs, parseReviewFlags, parseValueFlag } from "./args.ts";
import { type BriefInput, buildBrief, hasBriefInput, readSpecFile } from "./brief.ts";
import { CXX_FILE, cxxAutoCheck, runChecks } from "./checks.ts";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewFlags, type ReviewerSpec, describeFlags, loadConfig, parseReviewerSpec, reviewerRunOptions } from "./config.ts";
import { type HiddenClaim, type SuspicionResult, groupFindings } from "./grouping.ts";
import { type JudgeResult, runJudge } from "./judge.ts";
import { describeResolved, resolveJudge, resolveReviewerPoolStructured } from "./models.ts";
import { type PrCommentsReport, classifyPrComments, fetchPrComments } from "./pr-comments.ts";
import { type MultiReviewProgressReporter, type ToolUpdateFn, createProgressReporter, formatReviewerProgressLine, shortSpec } from "./progress.ts";
import { DIFF_BUDGET_CHARS, REVIEWER_SYSTEM_PROMPT, buildReviewUserPrompt } from "./prompts.ts";
import type { MultiReviewDetails } from "./render.ts";
import { type ReviewerRunOptions, allReviewersFailedResult, runAllReviewers, throwIfAborted } from "./reviewers.ts";
import { type SandboxExtras, sandboxUnavailable } from "./sandbox.ts";
import { prClaimAsGroup, prCommentsMarkdown, suspicionAsGroup, suspicionMarkdown, synthesizeLeadView, synthesizeMarkdownFromGroups, synthesizeNoFindingsMarkdown } from "./synthesis.ts";
import { type ReviewTarget, buildReviewTarget, preparePrCheckout } from "./target.ts";
import { ReviewTrace } from "./trace.ts";
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
const VERIFY_RESERVE_MS = 150_000;
const FINAL_RESERVE_MS = 20_000;
/** What checks leave the reviewers under a deadline: tool-using reviews typically take 2–5 minutes. */
const REVIEW_RESERVE_MS = 180_000;

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
		/** Triage the PR's existing review comments (CodeRabbit, collaborators). */
		prComments?: { includeNits: boolean; includeResolved: boolean };
	} = {},
): Promise<MultiReviewRunResult> {
	const cfg = loadConfig();
	const agentLead = runOptions.agentLead ?? false;
	const parsedFlags = parseReviewFlags(rawArgs, { verify: cfg.verify, quick: false });
	const flags: ReviewFlags = { ...parsedFlags.flags, ...stripUndefined(runOptions.flags ?? {}) };
	const specFlag = parseValueFlag(parsedFlags.rest, "spec");
	rawArgs = specFlag.rest;
	const prCommentsFlag = parseBoolFlag(rawArgs, "pr-comments");
	const nitsFlag = parseBoolFlag(prCommentsFlag.rest, "nits");
	const resolvedFlag = parseBoolFlag(nitsFlag.rest, "resolved");
	rawArgs = resolvedFlag.rest;
	const prCommentOpts = runOptions.prComments ?? (prCommentsFlag.present ? { includeNits: nitsFlag.present, includeResolved: resolvedFlag.present } : undefined);
	if (prCommentOpts && parseReviewArgs(rawArgs).kind !== "pr") {
		return { kind: "notify", notifyMessage: "multi-review: --pr-comments needs a PR (e.g. #1234 or a PR URL)", notifyLevel: "error" };
	}
	const briefInput: BriefInput = { ...runOptions.brief };
	if (specFlag.value && !briefInput.specPath) briefInput.specPath = specFlag.value;
	// An explicitly requested spec that can't be read must not silently
	// degrade into a spec-less review. PR reviews check it against the PR's
	// code after checkout instead (the PR may add the spec).
	if (briefInput.specPath && parseReviewArgs(rawArgs).kind !== "pr") {
		const spec = readSpecFile(ctx.cwd, briefInput.specPath);
		if ("error" in spec) return { kind: "notify", notifyMessage: `multi-review: ${spec.error}`, notifyLevel: "error" };
	}
	// A transient pool (picker, not persisted) overrides the configured one
	// for this run only; --quick swaps in the fast pool.
	const usingTransientReviewers = transientReviewers !== null && transientReviewers.length > 0;
	const poolName = usingTransientReviewers ? "transient" : flags.quick ? "quickReviewers" : "reviewers";
	// verifyOnly wins over reviewers: a model listed in both only verifies.
	const verifyOnlyIds = new Set(cfg.verifyOnly.map((raw) => parseReviewerSpec(raw)?.spec));
	const effectiveReviewerSpecs: string[] = usingTransientReviewers
		? transientReviewers
		: flags.quick ? cfg.quickReviewers : cfg.reviewers.filter((raw) => !verifyOnlyIds.has(parseReviewerSpec(raw)?.spec));
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

	const label = describeFlags(flags);
	const progress = createProgressReporter(ctx, label, onUpdate);
	let cleanupCheckout: (() => Promise<void>) | undefined;
	let trace: ReviewTrace | undefined;
	// The pipeline copies runOpts; sharing this array lets it register cleanups here.
	const cleanups: Array<() => void> = [];
	try {
		const parsed = parseReviewArgs(rawArgs);
		progress.update({ phase: "resolving scope" });
		const target = await buildReviewTarget(pi, parsed, ctx.cwd);
		// A focus hint narrows attention within the diff; it never replaces the diff.
		if (runOptions.focus?.trim()) {
			target.focusHint = target.focusHint ? `${target.focusHint}\n\n${runOptions.focus.trim()}` : runOptions.focus.trim();
		}
		const runOpts: ReviewerRunOptions = {
			...(flags.quick ? { useTools: false, timeoutMs: cfg.reviewerTimeoutSec * 1000 } : reviewerRunOptions(cfg)),
			cleanups,
		};
		trace = new ReviewTrace(runOptions.traceDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "multi-review-")), (lines) => progress.activity(lines));
		runOpts.trace = trace;
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
				progress.update({ phase: "fetching PR review comments" });
				const fetched = await fetchPrComments(pi, ctx.cwd, target.pr, prCommentOpts.includeResolved, target.warnings);
				progress.update({ phase: `classifying ${fetched.items.length} PR comment item(s)` });
				const cls = await classifyPrComments(ctx, cfg, fetched.items, prCommentOpts.includeNits, signal);
				if (cls.error) target.warnings.push(`PR comment classification failed (${cls.error}); comments were not checked`);
				prReport = {
					claims: cls.claims,
					others: cls.others,
					stats: {
						threads: fetched.items.filter((i) => i.kind === "thread").length,
						// (includes resolved threads, which are context only)
						reviews: fetched.items.filter((i) => i.kind === "review").length,
						conversation: fetched.items.filter((i) => i.kind === "conversation").length,
						skippedResolved: fetched.skippedResolved,
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
		// Verification runs only with --verify or PR comments. Quick runs have
		// no tools, so verify-only models (picked for tool use) sit out.
		const verifies = !flags.quick && (flags.verify || prCommentOpts !== undefined);
		const verifyOnly = verifies ? await resolveReviewerPoolStructured(ctx, cfg.verifyOnly) : { entries: [], missing: [] };
		if (verifyOnly.missing.length > 0) target.warnings.push(`verifyOnly models not in registry, skipped: ${verifyOnly.missing.join(", ")}`);
		const verifierRows = verifyOnly.entries.map((r) => ({ rs: r.rs, model: r.model, clamped: r.clamped }));
		const result = await runReviewPipeline(ctx, cfg, flags, target, resolvedRows, verifierRows, runOpts, judge, agentLead, signal, progress, runOptions.deadlineMs,
			[runOptions.detailHint, `Reviewer trace (tool calls, thinking and replies per session): ${trace.tracePath}`].filter(Boolean).join("\n"), prReport);
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

function stripUndefined<T extends object>(o: T): Partial<T> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
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
	// probe runs only when something would execute: checks or verification.
	const mayExecute = (target.brief?.checks.length ?? 0) > 0 || flags.verify || (prReport?.claims.length ?? 0) > 0 ||
		target.files.some((f) => CXX_FILE.test(f.path));
	const sandboxReason = !cfg.sandbox
		? "sandbox is off in multi-review.json"
		: flags.quick || !runOpts.useTools
			? "quick runs don't execute code"
			: mayExecute ? await sandboxUnavailable(signal) : "nothing to execute";
	throwIfAborted(signal);
	if (!sandboxReason) {
		// Starts the index refresh now, in parallel with checks and reviewers.
		const xref = createXrefService(target.files.map((f) => f.path), runOpts.cwd ?? ctx.cwd, ctx.cwd, cfg.sandboxHomeDirs);
		if (xref) {
			runOpts = { ...runOpts, xref };
			runOpts.cleanups?.push(() => xref.dispose());
		}
	}
	const checks = [...(target.brief?.checks ?? [])];
	let sandboxExtras: SandboxExtras = {};
	if (cfg.autoChecks && !sandboxReason && !checks.some((c) => c.includes("mr-cxx-check"))) {
		const auto = cxxAutoCheck(target.files.map((f) => f.path), runOpts.cwd ?? ctx.cwd, ctx.cwd, target.warnings, target.diffText);
		if (auto) {
			checks.unshift(auto.command);
			sandboxExtras = auto.extras;
		}
	}
	if (checks.length > 0 && sandboxReason) {
		target.warnings.push(`checks not run: ${sandboxReason}`);
	} else if (checks.length > 0) {
		const reserve = REVIEW_RESERVE_MS + GROUPING_RESERVE_MS + (flags.verify ? VERIFY_RESERVE_MS : 0) + FINAL_RESERVE_MS;
		const budget = Math.min(cfg.checkTimeoutSec * 1000, deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now() - reserve);
		target.checkResults = await runChecks(runOpts.cwd ?? ctx.cwd, checks, budget, cfg.sandboxHomeDirs, sandboxExtras, signal, (what) =>
			progress.update({ phase: `checks: ${what.length > 60 ? `${what.slice(0, 59)}…` : what}` }));
		throwIfAborted(signal);
		if (target.checkResults.some((r) => r.timedOut || r.skipped)) {
			target.warnings.push(`some checks hit the ${cfg.checkTimeoutSec}s check budget; brief faster checks (type-check, one target, targeted tests)`);
		}
	}
	const userPrompt = buildReviewUserPrompt(target);
	progress.update({ phase: `fanning out to ${rows.length} reviewers (cap ${cfg.concurrency})`, done: 0, total: rows.length });
	const runs = await runAllReviewers(
		rows,
		REVIEWER_SYSTEM_PROMPT,
		userPrompt,
		cfg.concurrency,
		cfg.temperature,
		signal,
		ctx,
		fit(runOpts, GROUPING_RESERVE_MS + (flags.verify ? VERIFY_RESERVE_MS : 0)),
		(done, total, latest) => progress.update({ phase: "reviewers running", done, total, latest: formatReviewerProgressLine(done, total, latest) }),
	);
	const failure = allReviewersFailedResult(runs, label);
	if (failure) return failure;

	const suspicionTexts = target.brief?.suspicions ?? [];
	const prClaims = prReport?.claims ?? [];
	const hidden: HiddenClaim[] = [
		...suspicionTexts.map((text, i) => ({ key: `S:${i}`, label: "lead hypothesis", text })),
		...prClaims.map((c, i) => ({ key: `P:${i}`, label: `PR comment by @${c.author}`, text: `${c.path ? `${c.path}: ` : ""}${c.claim}` })),
	];
	const { groups, matches } = await groupFindings(ctx, cfg, runs, signal, progress, hidden);
	// Grouping and judge calls turn an abort into an error + fallback; a
	// cancelled run must stop here, not publish a fallback review.
	throwIfAborted(signal);
	const suspicions: SuspicionResult[] = suspicionTexts.map((text, i) => ({ id: `s${i + 1}`, text, raisedBy: matches.get(`S:${i}`) ?? [] }));
	prClaims.forEach((c, i) => { c.raisedBy = matches.get(`P:${i}`) ?? []; });
	// Suspicions and PR claims ride the verify round as claims of their own:
	// every reviewer is eligible (none raised them; none saw them). PR
	// claims are always verified — checking them is the point of fetching.
	const suspicionGroups = flags.verify ? suspicions.map(suspicionAsGroup) : [];
	const prClaimGroups = prClaims.map(prClaimAsGroup);
	const verifyTimeLeft = deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now() - FINAL_RESERVE_MS;
	const toVerify = [...(flags.verify ? groups : []), ...suspicionGroups, ...prClaimGroups];
	if (toVerify.length > 0 && verifyTimeLeft < MIN_PHASE_MS) {
		target.warnings.push(`verification skipped: only ${Math.max(0, Math.round(verifyTimeLeft / 1000))}s left of the run's time budget`);
	} else if (toVerify.length > 0) {
		// One row per model: a duplicate would count as two independent verifiers.
		const verifierPool = [...rows, ...verifierRows].filter((r, i, all) => all.findIndex((o) => o.rs.spec === r.rs.spec) === i);
		if (sandboxReason && cfg.sandbox && !flags.quick && runOpts.useTools) target.warnings.push(`verifiers can't execute code: ${sandboxReason}`);
		const { failures } = await runVerification(ctx, cfg, verifierPool, toVerify, userPrompt, { ...fit(runOpts, FINAL_RESERVE_MS), sandbox: sandboxReason === null, sandboxExtras }, signal, progress);
		for (const f of failures) target.warnings.push(`verifier failed (its claims stay unverified): ${f}`);
		suspicionGroups.forEach((g, i) => {
			suspicions[i].verifications = g.verifications;
			suspicions[i].verificationNote = g.verificationNote;
		});
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
	} else if (groups.length === 0) {
		markdown = synthesizeNoFindingsMarkdown(target, runs, label);
	} else if (judge) {
		progress.update({ phase: `${groups.length} groups · invoking judge ${shortSpec(cfg.judge)}`, done: undefined, total: undefined });
		const jr = await runJudge(judge, groups, target, runs.filter((r) => !r.ok).map((r) => r.spec), ctx, signal, cfg.temperature, cfg.judgeThinking);
		throwIfAborted(signal);
		judgeLabel = cfg.judge;
		judgeDurationMs = jr.durationMs;
		judgeUsage = jr.usage;
		markdown = jr.markdown.trim()
			? jr.markdown
			: `# Multi-Model Code Review (judge returned nothing)\n\nJudge \`${cfg.judge}\` failed (${jr.errorMessage ?? `stopReason=${jr.stopReason}`}); deterministic synthesis follows.\n\n` +
				synthesizeMarkdownFromGroups(target, groups, runs, label);
	} else {
		markdown = synthesizeMarkdownFromGroups(target, groups, runs, label);
	}
	if (suspicions.length > 0) markdown += `\n\n${suspicionMarkdown(suspicions, groups, flags.verify).join("\n")}`;
	if (prReport) markdown += `\n\n${prCommentsMarkdown(prReport, groups).join("\n")}`;

	const details: MultiReviewDetails = {
		target,
		groups,
		reviewerSpecs: runs.map((r) => r.spec),
		failedSpecs: runs.filter((r) => !r.ok).map((r) => r.spec),
		judge: judgeLabel,
		judgeDurationMs,
		judgeUsage,
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
			(target.warnings.length ? `\nwarnings: ${target.warnings.length} (see review)` : ""),
		notifyLevel: "info",
		injectMessage: { customType: "multi-review", content: markdown, details },
	};
}

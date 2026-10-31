import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { checkLines, checkPromptLines } from "./checks.ts";
import { type Model, type ModelSpec, type MultiReviewConfig, type ReviewerSpec, type ThinkingLevelAlias, formatReviewerSpec } from "./config.ts";
import type { JudgeResult } from "./judge.ts";
import { callModel } from "./models.ts";
import type { MultiReviewRunResult } from "./pipeline.ts";
import type { PrCommentsReport } from "./pr-comments.ts";
import { type MultiReviewProgressReporter, shortSpec } from "./progress.ts";
import { budgetDiff } from "./prompts.ts";
import {
	type ReviewerRunOptions,
	type ReviewerSession,
	STRAGGLER_GRACE_FACTOR,
	STRAGGLER_MIN_GRACE_MS,
	STRAGGLER_MIN_TOTAL_MS,
	buildToolPromptAddendum,
	createReviewerSession,
	stragglerQuorum,
	throwIfAborted,
} from "./reviewers.ts";
import type { ReviewTarget } from "./target.ts";
import { withTimeout } from "./util.ts";

// ---------- Socratic discussion ----------

export const DEFAULT_SOCRATIC_ROUNDS = 2;
export const MAX_SOCRATIC_ROUNDS = 5;

export interface SocraticRoundEntry {
	spec: ModelSpec;
	formattedSpec: string;
	alias: string;
	clamped: boolean;
	ok: boolean;
	text: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	toolCalls?: number;
	durationMs: number;
}

export interface SocraticRound {
	round: number;
	title: string;
	entries: SocraticRoundEntry[];
	durationMs: number;
}

export interface SocraticDetails {
	topic: string;
	rounds: SocraticRound[];
}

export const SOCRATIC_SYSTEM_PROMPT = `You are a participant in a multi-model Socratic inquiry (elenchus) on a technical or codebase topic. Your goal is to reach the truth through rigorous evidence and questioning — not to produce generic advice or agree out of politeness.

Rules of Socratic inquiry:
- Ground claims in concrete evidence: inspect the relevant code, callers, types, tests, and git history before stating a position. Cite specific \`file:line\` locations, commit hashes, or external documentation.
- Surface hidden assumptions — both in your own position and in the premise of the question itself. If the premise rests on a false assumption about how the code or system works, show why.
- Ask sharp, falsifiable Socratic questions: concrete edge cases, invariants, failure modes, or counter-examples that any competing position must answer.
- In cross-examination rounds:
  - Do NOT flatter peers ("Great point", "I agree with Participant A's insightful analysis"). Engage only with substance.
  - Use your tools to verify peers' code claims and \`file:line\` citations before accepting or rejecting them.
  - When a peer's claim rests on a misreading of the code or an invalid assumption, refute it with concrete \`file:line\` evidence.
  - When a peer's question or counter-evidence exposes a flaw or gap in your earlier position, concede the point explicitly and revise your position. Defending a refuted claim is a failure.
  - Keep each round focused and concise (≤ 450 words per round).`;

const SOCRATIC_EMPTY_NUDGE = "Your turn ended without a written response. Write your Socratic response now using the section headings requested in the prompt.";

export function participantAlias(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}

export function roundTitle(round: number, totalRounds: number): string {
	if (round === 1) return "Opening Inquiry & Socratic Questions";
	if (round === totalRounds && totalRounds > 2) return "Dialectic Resolution & Final Positions";
	return "Socratic Cross-Examination & Revised Positions";
}

export function buildSocraticRound1Prompt(target: ReviewTarget, topic: string, prReport?: PrCommentsReport): string {
	const chunks: string[] = [];
	chunks.push("## Topic for Socratic Inquiry");
	chunks.push(topic);
	chunks.push("");
	const brief = target.brief;
	if (brief?.intent) {
		chunks.push("## Background & Context (from the lead)");
		chunks.push(brief.intent);
		chunks.push("");
	}
	if (brief?.spec) {
		chunks.push(`## Spec / Reference Document (${brief.spec.path})`);
		chunks.push(brief.spec.text);
		chunks.push("");
	}
	if (brief && brief.requirements.length > 0) {
		chunks.push("## Constraints & Requirements");
		brief.requirements.forEach((r, i) => chunks.push(`${i + 1}. ${r}`));
		chunks.push("");
	}
	if (target.metaLines.length > 0) {
		chunks.push("## Scope Metadata");
		chunks.push(...target.metaLines);
		chunks.push("");
	}
	if (target.checkResults?.length) chunks.push(...checkPromptLines(target.checkResults));
	if (prReport && (prReport.claims.length > 0 || prReport.others.length > 0)) {
		const authorNote = prReport.authors?.length ? ` (filtered to author(s): ${prReport.authors.join(", ")})` : "";
		chunks.push(`## Existing PR Review Comments${authorNote}`);
		for (const c of prReport.claims) {
			chunks.push(`- **${c.id}** (@${c.author}${c.path ? ` · \`${c.path}${c.line ? `:${c.line}` : ""}\`` : ""}): ${c.claim}`);
		}
		for (const o of prReport.others) {
			chunks.push(`- **${o.type}** (@${o.author}): ${o.summary}`);
		}
		chunks.push("");
	}
	if (target.diffText) {
		chunks.push("## Diff in Scope");
		chunks.push(budgetDiff(target.diffText));
		chunks.push("");
	} else if (target.files.length > 0) {
		chunks.push("## Repository Files (use your tools to read the ones relevant to the topic)");
		for (const f of target.files) chunks.push(`- ${f.path}`);
		chunks.push("");
	}
	if (brief && brief.contextFiles.length > 0) {
		chunks.push("## Related Files (full contents)");
		for (const f of brief.contextFiles) {
			chunks.push(`### ${f.path}`);
			chunks.push("```");
			chunks.push(f.text);
			chunks.push("```");
		}
		chunks.push("");
	}
	chunks.push(
		"## Round 1 Instructions — Independent Opening Inquiry",
		"Investigate the topic using your tools first, then respond in Markdown with these exact sections:",
		"",
		"### Position",
		"Your direct thesis or answer on the topic (2–5 sentences), grounded in what you found.",
		"",
		"### Evidence & Mechanics",
		"The concrete code paths, `file:line` references, git history, or system mechanics that support your position.",
		"",
		"### Assumptions & Failure Modes",
		"What must hold for your position (or the approach under discussion) to work? Under what concrete edge cases or conditions does it break?",
		"",
		"### Socratic Questions",
		"2–4 sharp, falsifiable questions or counter-examples aimed at testing hidden assumptions or exposing weaknesses in competing approaches.",
	);
	return chunks.join("\n");
}

export function buildSocraticFollowUpPrompt(
	round: number,
	totalRounds: number,
	topic: string,
	prevRound: SocraticRound,
	myIndex: number,
	suspicions?: string[],
	includeOwnHistory?: string,
): string {
	const myAlias = participantAlias(myIndex);
	const lines: string[] = [];
	lines.push(`## Round ${round} of ${totalRounds} — ${roundTitle(round, totalRounds)}`);
	lines.push(`Topic: ${topic}`);
	lines.push(`You are **Participant ${myAlias}**. Below are the Round ${round - 1} contributions from your peers (de-identified so you judge arguments on code evidence and logic alone).`);
	lines.push("");
	if (includeOwnHistory) {
		lines.push(`### Your Round ${round - 1} Contribution (Participant ${myAlias})`);
		lines.push(includeOwnHistory);
		lines.push("");
	}
	lines.push(`## Peers' Round ${round - 1} Contributions`);
	let peerCount = 0;
	prevRound.entries.forEach((entry, idx) => {
		if (idx === myIndex || !entry.ok || !entry.text.trim()) return;
		peerCount++;
		lines.push(`### Participant ${entry.alias}`);
		lines.push(entry.text.trim());
		lines.push("");
	});
	if (peerCount === 0) {
		lines.push("_(No peer responses returned in the previous round; test your own Round 1 assumptions and questions below.)_");
		lines.push("");
	}
	if (round === 2 && suspicions && suspicions.length > 0) {
		lines.push("## Additional Socratic Challenges to Test");
		lines.push("Test each of these claims/questions against the codebase with your tools and either confirm or refute it with `file:line` evidence:");
		suspicions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
		lines.push("");
	}
	const isFinal = round === totalRounds;
	lines.push(
		`## Round ${round} Instructions`,
		"Use your tools (`read`, `grep`, `find`, `ls`, `git`, etc.) to verify any code claims or `file:line` citations from your peers that you haven't checked yourself. Then respond in Markdown with these sections:",
		"",
		"### Answers to Peers' Questions",
		"Directly answer the sharpest Socratic questions posed by your peers (cite `Participant X`), backed by `file:line` evidence.",
		"",
		"### Cross-Examination (Refutations & Concessions)",
		"- **Refutations:** Where a peer's claim or assumption is contradicted by the code or has a flaw, refute it with concrete `file:line` evidence.",
		"- **Concessions:** Where a peer's evidence or question exposed a flaw or blind spot in your earlier position, concede it explicitly and state how your view changed.",
		"- Skip empty agreement; only mention agreement when you found independent confirming evidence.",
		"",
		isFinal ? "### Revised Position & Remaining Tradeoffs" : "### Revised Position & Follow-Up Questions",
		isFinal
			? "State your final, cross-examined position, what the evidence settled, and any genuine architectural tradeoffs or open questions that remain."
			: "State your updated position and 1–2 sharper follow-up Socratic questions for the next round.",
	);
	return lines.join("\n");
}

function formatSocraticProgressLine(round: number, totalRounds: number, done: number, total: number, entry: SocraticRoundEntry): string {
	const verdict = entry.ok ? "✓" : "✗";
	const detail = entry.ok ? `${entry.text.length} chars` : (entry.errorMessage ?? "error");
	const tools = entry.toolCalls ? `, ${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}` : "";
	const cost = entry.usage?.cost ? `, $${entry.usage.cost.toFixed(4)}` : "";
	const clamped = entry.clamped ? " [thinking clamped]" : "";
	return `${verdict} ${shortSpec(entry.formattedSpec)}${clamped} [r${round}/${totalRounds} ${done}/${total}] — ${detail}, ${(entry.durationMs / 1000).toFixed(1)}s${tools}${cost}`;
}

export function allSocraticFailedResult(entries: SocraticRoundEntry[], mode: string): MultiReviewRunResult | null {
	if (entries.length === 0 || entries.some((e) => e.ok)) return null;
	return {
		kind: "notify",
		notifyMessage:
			`multi-review · mode=${mode} · all ${entries.length} participants failed in round 1 — no discussion produced:\n` +
			entries.map((e) => `  ✗ ${e.formattedSpec}: ${e.errorMessage?.slice(0, 200) ?? "unknown error"}`).join("\n"),
		notifyLevel: "error",
	};
}

const MAX_PARALLEL = 16;

/**
 * Run a multi-round Socratic discussion across the resolved model pool.
 * When `runOpts.useTools` is true, each participant keeps a persistent in-memory
 * `AgentSession` across rounds so it retains the files it read in Round 1 when
 * cross-examining peers in Round 2+.
 */
export async function runSocraticDiscussion(
	ctx: ExtensionContext,
	cfg: MultiReviewConfig,
	rows: Array<{ rs: ReviewerSpec; model: Model; clamped: boolean }>,
	target: ReviewTarget,
	topic: string,
	totalRounds: number,
	runOpts: ReviewerRunOptions,
	abortSignal: AbortSignal | undefined,
	progress: MultiReviewProgressReporter,
	fitRoundTimeoutMs: (remainingRounds: number) => number,
	canStartNextRound: () => { ok: boolean; remainingSec: number },
	prReport?: PrCommentsReport,
): Promise<{ socratic: SocraticDetails } | { failure: MultiReviewRunResult }> {
	const cwd = runOpts.cwd ?? ctx.cwd;
	const canRun = Boolean(runOpts.sandbox && runOpts.useTools);
	const sessions: Array<ReviewerSession | null> = new Array(rows.length).fill(null);
	const round1Prompt = buildSocraticRound1Prompt(target, topic, prReport);
	const rounds: SocraticRound[] = [];

	const ensureSession = async (idx: number): Promise<ReviewerSession> => {
		if (sessions[idx]) return sessions[idx]!;
		const slot = rows[idx];
		const sys = SOCRATIC_SYSTEM_PROMPT + buildToolPromptAddendum(slot.model, runOpts, canRun, true);
		const sess = await createReviewerSession(ctx, slot.model, slot.rs.thinking, sys, cwd, {
			runDir: canRun ? cwd : undefined,
			sandboxHomeDirs: runOpts.sandboxHomeDirs,
			sandboxExtras: runOpts.sandboxExtras,
			xref: runOpts.xref,
			webSearch: runOpts.webSearch,
		});
		sessions[idx] = sess;
		return sess;
	};

	const resetSession = (idx: number) => {
		try {
			sessions[idx]?.dispose();
		} catch {
			/* ignore dispose errors */
		}
		sessions[idx] = null;
	};

	try {
		for (let r = 1; r <= totalRounds; r++) {
			if (r > 1) {
				const check = canStartNextRound();
				if (!check.ok) {
					target.warnings.push(`Socratic round ${r}/${totalRounds} skipped: only ${check.remainingSec}s left of the run's time budget`);
					break;
				}
			}
			const rTitle = roundTitle(r, totalRounds);
			const phaseLabel = `round ${r}/${totalRounds} (${r === 1 ? "opening inquiry" : "cross-examination"})`;
			progress.update({ phase: phaseLabel, done: 0, total: rows.length });
			const roundStarted = Date.now();
			const roundTimeoutMs = fitRoundTimeoutMs(totalRounds - r + 1);
			const entries: SocraticRoundEntry[] = new Array(rows.length);
			const cap = Math.max(1, Math.min(MAX_PARALLEL, cfg.concurrency, rows.length));
			const total = rows.length;
			let cursor = 0;
			let done = 0;
			let okCount = 0;

			// Per-round straggler cutoff so a degraded endpoint cannot stall a round.
			const quorum = stragglerQuorum(total);
			const straggler = new AbortController();
			const roundAbort = abortSignal ? AbortSignal.any([abortSignal, straggler.signal]) : straggler.signal;
			let stragglerTimer: ReturnType<typeof setTimeout> | undefined;
			const noteFinished = (ok: boolean) => {
				if (ok) okCount++;
				if (stragglerTimer || okCount < quorum || done >= total) return;
				const quorumMs = Date.now() - roundStarted;
				const graceMs = Math.max(STRAGGLER_MIN_GRACE_MS, quorumMs * STRAGGLER_GRACE_FACTOR, STRAGGLER_MIN_TOTAL_MS - quorumMs);
				stragglerTimer = setTimeout(() => {
					straggler.abort(`cut as straggler: ${quorum}/${total} participants finished round ${r} in ${Math.round(quorumMs / 1000)}s, waited ${Math.round(graceMs / 1000)}s more`);
				}, graceMs);
				stragglerTimer.unref?.();
			};

			const prevRound = r > 1 ? rounds[rounds.length - 1] : undefined;
			const worker = async (): Promise<void> => {
				while (true) {
					if (abortSignal?.aborted) return;
					const idx = cursor++;
					if (idx >= rows.length) return;
					const slot = rows[idx];
					const alias = participantAlias(idx);
					const formattedSpec = formatReviewerSpec(slot.rs);
					const signal = withTimeout(roundAbort, roundTimeoutMs);
					const tracer = runOpts.trace?.start(formattedSpec, `round ${r}`, cwd);
					const hadPriorSession = sessions[idx] !== null;
					const ownPrevText = prevRound?.entries[idx]?.ok ? prevRound.entries[idx].text : undefined;
					const userPrompt = r === 1
						? round1Prompt
						: buildSocraticFollowUpPrompt(
							r,
							totalRounds,
							topic,
							prevRound!,
							idx,
							r === 2 ? target.brief?.suspicions : undefined,
							// Include own prior response when stateless (--quick) or when the session was recreated after an earlier error.
							!runOpts.useTools || !hadPriorSession ? ownPrevText : undefined,
						);
					try {
						const call = runOpts.useTools
							? await (await ensureSession(idx)).promptTurn(
								!hadPriorSession && r > 1 ? `${round1Prompt}\n\n---\n\n${userPrompt}` : userPrompt,
								signal,
								tracer?.onEvent,
								SOCRATIC_EMPTY_NUDGE,
							)
							: await callModel(ctx, slot.model, SOCRATIC_SYSTEM_PROMPT, r === 1 ? userPrompt : `${round1Prompt}\n\n---\n\n${userPrompt}`, {
								thinking: slot.rs.thinking,
								temperature: cfg.temperature,
								signal,
							});
						if (call.errorMessage && signal.aborted && !abortSignal?.aborted) {
							call.errorMessage = straggler.signal.aborted
								? String(straggler.signal.reason)
								: `timed out after ${Math.round(roundTimeoutMs / 1000)}s`;
						}
						const ok = call.errorMessage === undefined && Boolean(call.text.trim());
						if (!ok) resetSession(idx);
						const errorMessage = call.errorMessage ?? (!call.text.trim() ? "empty response" : undefined);
						tracer?.finish(ok, errorMessage ?? `round ${r} done (${call.toolCalls ?? 0} tools)`);
						const entry: SocraticRoundEntry = {
							spec: slot.rs.spec,
							formattedSpec,
							alias,
							clamped: slot.clamped,
							ok,
							text: call.text.trim(),
							stopReason: call.stopReason,
							errorMessage,
							usage: call.usage,
							toolCalls: call.toolCalls,
							durationMs: call.durationMs,
						};
						entries[idx] = entry;
						done++;
						noteFinished(ok);
						progress.update({ phase: phaseLabel, done, total, latest: formatSocraticProgressLine(r, totalRounds, done, total, entry) });
					} catch (err) {
						resetSession(idx);
						const errorMessage = err instanceof Error ? err.message : String(err);
						tracer?.finish(false, errorMessage);
						const entry: SocraticRoundEntry = {
							spec: slot.rs.spec,
							formattedSpec,
							alias,
							clamped: slot.clamped,
							ok: false,
							text: "",
							stopReason: "error",
							errorMessage,
							durationMs: 0,
						};
						entries[idx] = entry;
						done++;
						noteFinished(false);
						progress.update({ phase: phaseLabel, done, total, latest: formatSocraticProgressLine(r, totalRounds, done, total, entry) });
					}
				}
			};

			await Promise.all(Array.from({ length: cap }, () => worker()));
			if (stragglerTimer) clearTimeout(stragglerTimer);
			throwIfAborted(abortSignal);

			rounds.push({
				round: r,
				title: rTitle,
				entries,
				durationMs: Date.now() - roundStarted,
			});

			if (r === 1) {
				const failure = allSocraticFailedResult(entries, `socratic (${totalRounds} rounds)`);
				if (failure) return { failure };
			}
		}
	} finally {
		for (let i = 0; i < sessions.length; i++) resetSession(i);
	}

	return { socratic: { topic, rounds } };
}

/** First substantive sentence of a participant's entry for collapsed TUI preview. */
export function summarizeSocraticEntry(text: string, max = 120): string {
	const cleaned = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.join(" ")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "(no text)";
	const first = cleaned.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? cleaned;
	return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/**
 * Markdown view of the Socratic discussion for the lead agent (or fallback view).
 */
export function synthesizeSocraticLeadView(
	target: ReviewTarget,
	socratic: SocraticDetails,
	label: string,
	detailHint?: string,
): string {
	const r1 = socratic.rounds[0]?.entries ?? [];
	const lines: string[] = [`# Multi-Model Socratic Discussion (${label})`, ""];
	lines.push(`**Topic:** ${socratic.topic}`);
	lines.push(`**Scope:** \`${target.label}\` · ${socratic.rounds.length} round${socratic.rounds.length === 1 ? "" : "s"} · ${r1.length} participant${r1.length === 1 ? "" : "s"}`);
	lines.push(
		`**Participants:** ${r1.map((e, idx) => {
			const totalTools = socratic.rounds.reduce((s, r) => s + (r.entries[idx]?.toolCalls ?? 0), 0);
			const totalSec = (socratic.rounds.reduce((s, r) => s + (r.entries[idx]?.durationMs ?? 0), 0) / 1000).toFixed(1);
			const anyOk = socratic.rounds.some((r) => r.entries[idx]?.ok);
			return `Participant ${e.alias} = \`${shortSpec(e.formattedSpec)}\` (${anyOk ? `${totalSec}s, ${totalTools} tools` : `FAILED: ${e.errorMessage?.slice(0, 80) ?? "?"}`})`;
		}).join(" · ")}`,
	);
	for (const note of target.metaLines.filter((l) => l.startsWith("("))) lines.push(`Note: ${note.slice(1, -1)}`);
	if (detailHint) lines.push(detailHint);
	lines.push("");

	for (const round of socratic.rounds) {
		lines.push(`## Round ${round.round} — ${round.title} (${(round.durationMs / 1000).toFixed(1)}s)`, "");
		for (const entry of round.entries) {
			const tools = entry.toolCalls ? ` · ${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}` : "";
			lines.push(`### Participant ${entry.alias} · \`${shortSpec(entry.formattedSpec)}\` (${(entry.durationMs / 1000).toFixed(1)}s${tools})`);
			if (entry.ok) {
				lines.push(entry.text);
			} else {
				lines.push(`_Failed: ${entry.errorMessage ?? "unknown error"}_`);
			}
			lines.push("");
		}
	}

	if (target.brief?.suspicions.length) {
		lines.push("## Lead Challenges Tested in Round 2");
		target.brief.suspicions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
		lines.push("");
	}
	lines.push(...checkLines(target));
	if (target.warnings.length > 0) {
		lines.push("## Warnings", ...target.warnings.map((w) => `- ${w}`), "");
	}
	return lines.join("\n");
}

const SOCRATIC_JUDGE_SYSTEM_PROMPT = `You are the moderator synthesizing a multi-round, multi-model Socratic discussion on a technical topic. Each participant had read-only access to the repository and cross-examined its peers' positions and assumptions.

Synthesize the discussion into a clear Markdown report with these exact sections:

# Socratic Discussion Synthesis

## Topic & Summary
A 2–4 sentence executive answer to the topic based on what survived cross-examination.

## Dialectic Progression
How positions evolved across rounds: which Round 1 claims or assumptions broke under Socratic questioning, who refuted or conceded what, and what code evidence decided each point.

## Surviving Conclusions
The conclusions and recommendations that held up under cross-examination, citing the specific \`file:line\` evidence and which participants established them.

## Refuted Assumptions & Claims
Claims or assumptions (from Round 1 or the prompt's premise) that were disproven during cross-examination, and the concrete evidence that refuted them.

## Genuine Tradeoffs & Open Questions
Where participants still diverge for legitimate design/engineering reasons, stating the tradeoff of each side and what would decide between them.

## Recommended Next Steps
Concrete actions or decisions for the user.`;

export async function runSocraticJudge(
	judgeModel: Model,
	socratic: SocraticDetails,
	target: ReviewTarget,
	ctx: ExtensionContext,
	abortSignal: AbortSignal | undefined,
	temperature: number,
	thinking: ThinkingLevelAlias,
): Promise<JudgeResult> {
	const transcript = synthesizeSocraticLeadView(target, socratic, "transcript");
	const call = await callModel(
		ctx,
		judgeModel,
		SOCRATIC_JUDGE_SYSTEM_PROMPT,
		`${transcript}\n\nNow produce the moderator synthesis per the system prompt. Output ONLY markdown.`,
		{ thinking, temperature, signal: abortSignal },
	);
	const truncated = call.stopReason === "length";
	return {
		markdown: call.errorMessage || truncated ? "" : `${call.text.trim()}\n\n---\n\n${transcript}`,
		stopReason: call.stopReason,
		errorMessage: call.errorMessage ?? (truncated ? "judge output truncated at maxTokens" : undefined),
		usage: call.usage,
		durationMs: call.durationMs,
	};
}

/** Instructions appended to the tool result when the main agent moderates a Socratic discussion. */
export function socraticLeadInstructions(hasSpec: boolean): string {
	const lines = [
		"---",
		"## Lead moderator synthesis (you)",
		"You are the moderator and lead synthesizer of this Socratic discussion, not a passive summarizer. The participants explored the repository with tools, posed Socratic questions in Round 1, and cross-examined each other's positions in Round 2+. You have the full conversation context with the user and can read the code yourself.",
		"- Weigh arguments by the `file:line` evidence and code mechanics cited, not by majority vote.",
		"- Pay close attention to **concessions** and **refutations** in Round 2+: a claim that a participant conceded or that another participant disproved with concrete code evidence is settled.",
		"- If two participants remain split on a factual claim about the codebase, read the relevant `file:line` yourself to settle it before replying.",
		"",
		"Reply to the user in this format:",
		"### Topic",
		"> the question / topic examined",
		"### Participants",
		"- Participant X (`model`) — rounds completed, tool calls, key angle",
	];
	if (hasSpec) {
		lines.push("### Spec & Constraint Alignment", "| Requirement / Constraint | Finding from Discussion | Evidence (file:line) |");
	}
	lines.push(
		"### Dialectic Progression",
		"How the discussion evolved from Round 1 to the final round: which initial hypotheses or unstated assumptions broke under Socratic questioning, and who refuted or conceded what.",
		"### Surviving Conclusions",
		"The conclusions and answers that withstood cross-examination, numbered, each with its `file:line` evidence and why it holds.",
		"### Refuted Assumptions & Claims",
		"Initial claims, intuitions, or prompt premises that were disproven during cross-examination, with the one-line code evidence that ruled each out.",
		"### Genuine Tradeoffs & Open Questions",
		"Where participants legitimately diverged on design tradeoffs (not factual misreads), stating the pros/cons of each option.",
		"### Recommended Next Steps",
		"Concrete recommendations or decisions for the user based on what survived scrutiny.",
		"",
		"Do not edit code unless the user asks.",
	);
	return lines.join("\n");
}

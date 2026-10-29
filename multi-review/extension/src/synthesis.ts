import { checkLines } from "./checks.ts";
import type { ReviewerRunResult } from "./findings.ts";
import { type DedupeGroup, type SuspicionResult, jaccard, keywords } from "./grouping.ts";
import type { PrClaim, PrCommentsReport } from "./pr-comments.ts";
import { shortSpec } from "./progress.ts";
import type { ReviewTarget } from "./target.ts";
import { verificationTally } from "./verify.ts";

export function formatRange(start: number | null, end: number | null): string {
	if (start === null && end === null) return "file";
	if (start === null) return `…${end}`;
	if (end === null || end === start) return `L${start}`;
	return `L${start}-${end}`;
}

/**
 * Light-mode markdown synthesis. Produces a structured markdown doc
 * directly from the deduped groups (no judge call) so the user sees
 * per-model attribution attached to every finding, sorted severity-desc.
 * Schema mirrors what the prompted judge produces so downstream tooling
 * doesn't need a separate light-mode branch.
 */
function verificationLines(g: DedupeGroup): string[] {
	if (!g.verifications?.length) return g.verificationNote ? [`- **Verification:** ${g.verificationNote}`] : [];
	const icon = { confirmed: "✓ confirmed", refuted: "✗ refuted", uncertain: "? uncertain" } as const;
	return [
		`- **Verification (${verificationTally(g)}):**`,
		...g.verifications.map((v) => `    - \`${v.spec}\` ${icon[v.verdict]}: ${v.evidence}`),
		...(g.verificationNote ? [`    - note: ${g.verificationNote}`] : []),
	];
}

/** Below this word overlap with the canonical description, a reviewer's framing is shown. */
const DISTINCT_FRAMING_JACCARD = 0.25;

/** Most actionable member: evidence and repro weigh most, then a fix, then detail. */
function canonicalMember(g: DedupeGroup): DedupeGroup["members"][number] {
	const score = (m: DedupeGroup["members"][number]) =>
		(m.parts?.evidence ? 2 : 0) + (m.parts?.repro ? 2 : 0) + (m.parts?.suggestion ? 1 : 0) + Math.min(1, (m.parts?.core ?? m.comment).length / 1000);
	return g.members.reduce((best, m) => (score(m) > score(best) ? m : best), g.members[0]);
}

function firstSentence(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const cut = flat.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? flat;
	return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

/**
 * The lead's view: one canonical description per issue (plus the first
 * repro/fix any reviewer offered), other framings as one-liners, severity
 * dissent flagged, verification compact. Verbatim per-reviewer text stays
 * in details.groups — ~30–40% of the full markdown was repetition.
 */
export function synthesizeLeadView(
	target: ReviewTarget,
	groups: DedupeGroup[],
	runs: ReviewerRunResult[],
	label: string,
	detailHint?: string,
): string {
	const ok = runs.filter((r) => r.ok);
	const lines: string[] = [`# Multi-Model Code Review (${label})`, ""];
	lines.push(
		`Scope: \`${target.label}\` · ${groups.length} issue${groups.length === 1 ? "" : "s"} from ${ok.length} reviewer${ok.length === 1 ? "" : "s"} · ` +
			`${groups.filter((g) => g.consensus).length} raised independently by ≥2`,
	);
	lines.push(`Reviewers: ${runs.map((r) => `${shortSpec(r.formattedSpec)} ${r.ok ? `(${r.findings.length})` : `FAILED: ${r.errorMessage?.slice(0, 100) ?? "?"}`}`).join(" · ")}`);
	// Scope notes (PR worktree, spec source) — they change how findings read.
	for (const note of target.metaLines.filter((l) => l.startsWith("("))) lines.push(`Note: ${note.slice(1, -1)}`);
	if (detailHint) lines.push(detailHint);
	lines.push("");
	if (groups.length > 0) lines.push("## Issues", "");
	for (const g of groups) {
		const canon = canonicalMember(g);
		const tally = verificationTally(g);
		lines.push(`### ${g.id} · ${g.severity.toUpperCase()} · ${g.title} — ×${g.reviewerSpecs.length}${tally ? ` · ${tally}` : ""}`);
		lines.push(`- **Where:** \`${g.file}:${formatRange(g.line_start, g.line_end)}\` · ${g.category}`);
		lines.push(`- **Raised by:** ${g.members.map((m) => shortSpec(m.spec) + (m.severity !== g.severity ? ` (says ${m.severity.toUpperCase()})` : "")).join(", ")}`);
		lines.push(`- **What:** ${(canon.parts?.core ?? canon.comment).replace(/\s+/g, " ")}`);
		const evidence = canon.parts?.evidence;
		const repro = canon.parts?.repro ?? g.members.find((m) => m.parts?.repro)?.parts?.repro;
		const fix = canon.parts?.suggestion ?? g.members.find((m) => m.parts?.suggestion)?.parts?.suggestion;
		if (evidence) lines.push(`- **Evidence:** ${evidence.replace(/\s+/g, " ")}`);
		if (repro) lines.push(`- **Repro:** ${repro.replace(/\s+/g, " ")}`);
		if (fix) lines.push(`- **Fix:** ${fix.replace(/\s+/g, " ")}`);
		// At most one alternative framing: the most distinct from the canonical
		// one, and only if it differs at all. Paraphrases are noise for the lead;
		// verbatim text stays available in details.groups by issue id.
		const canonWords = keywords(canon.parts?.core ?? canon.comment);
		const alt = g.members
			.filter((m) => m !== canon)
			.map((m) => ({ m, overlap: jaccard(canonWords, keywords(m.parts?.core ?? m.comment)) }))
			.filter((x) => x.overlap < DISTINCT_FRAMING_JACCARD)
			.sort((a, b) => a.overlap - b.overlap)[0];
		if (alt) lines.push(`- **Another angle:** ${shortSpec(alt.m.spec)}: "${firstSentence(alt.m.parts?.core ?? alt.m.comment, 120)}"`);
		if (g.verifications?.length) {
			const mark = { confirmed: "✓", refuted: "✗", uncertain: "?" } as const;
			lines.push(`- **Verification:** ${g.verifications.map((v) => `${mark[v.verdict]} ${shortSpec(v.spec)}: ${v.evidence.replace(/\s+/g, " ").slice(0, 240)}`).join(" · ")}`);
		} else if (g.verificationNote) {
			lines.push(`- **Verification:** ${g.verificationNote}`);
		}
		lines.push("");
	}
	if (groups.length === 0) lines.push(`No findings from ${ok.length} reviewer${ok.length === 1 ? "" : "s"}.`, "");
	lines.push(...checkLines(target), ...warningLines(target));
	return lines.join("\n");
}

/** A PR comment claim as a pseudo-group for the verify round; every reviewer is eligible. */
export function prClaimAsGroup(c: PrClaim): DedupeGroup {
	const origin = `Raised on the PR by @${c.author}${c.outdated ? " (thread is outdated: the code changed after the comment)" : ""}.`;
	return {
		id: c.id,
		file: c.path ?? "(file not stated)",
		line_start: c.line ?? null,
		line_end: c.line ?? null,
		severity: "info",
		category: "pr-claim",
		title: c.claim,
		titles: [c.claim],
		members: [],
		reviewerSpecs: [],
		consensus: false,
		context: c.hunk ? `${origin}\nDiff context the comment was attached to:\n\`\`\`diff\n${c.hunk}\n\`\`\`` : origin,
	};
}

/** PR comment triage for the lead: each claim's independent match and verification, then non-claims. */
export function prCommentsMarkdown(report: PrCommentsReport, groups: DedupeGroup[]): string[] {
	const byId = new Map(groups.map((g) => [g.id, g]));
	const st = report.stats;
	const lines = [
		"## Existing PR review comments (hidden from reviewers)",
		`Fetched ${st.threads} review thread(s)${st.skippedResolved ? ` (${st.skippedResolved} resolved: context only, not re-checked)` : ""}, ${st.reviews} review bod(ies), ${st.conversation} conversation comment(s) → ${report.claims.length} checkable claim(s)` +
			`${st.skippedNits ? ` · ${st.skippedNits} nit(s) skipped (--nits to include)` : ""}${st.noise ? ` · ${st.noise} non-review item(s) ignored` : ""}.`,
		"",
	];
	const mark = { confirmed: "✓", refuted: "✗", uncertain: "?" } as const;
	for (const c of report.claims) {
		const raised = c.raisedBy.map((id) => byId.get(id)).filter((g): g is DedupeGroup => Boolean(g));
		lines.push(`- **${c.id}** · @${c.author} · \`${c.path ?? "?"}${c.line ? `:${c.line}` : ""}\`${c.outdated ? " (outdated)" : ""}${c.nit ? " · nit" : ""} · [comment](${c.url})`);
		lines.push(`    - Claim: ${c.claim}`);
		lines.push(`    - Independent reviewers: ${raised.length ? `raised it — ${raised.map((g) => `${g.id} "${g.title}" (×${g.reviewerSpecs.length})`).join("; ")}` : "did not raise it"}`);
		if (c.verifications?.length) {
			lines.push(`    - Verification (${verificationTally({ verifications: c.verifications } as DedupeGroup)}): ${c.verifications.map((v) => `${mark[v.verdict]} ${shortSpec(v.spec)}: ${v.evidence.replace(/\s+/g, " ").slice(0, 240)}`).join(" · ")}`);
		} else {
			lines.push(`    - Verification: ${c.verificationNote ?? "no verdict returned"}`);
		}
	}
	if (report.claims.length === 0) lines.push("_No checkable claims in the PR's review comments._");
	if (report.others.length > 0) {
		lines.push("", "### Questions and preferences (not verified — answer or note them)");
		for (const o of report.others) lines.push(`- ${o.type} · @${o.author} · [comment](${o.url}): ${o.summary}`);
	}
	lines.push("");
	return lines;
}

/** A suspicion dressed as a group so the verify round can check it like any claim. */
export function suspicionAsGroup(sus: SuspicionResult): DedupeGroup {
	return {
		id: sus.id,
		file: "(lead hypothesis)",
		line_start: null,
		line_end: null,
		severity: "info",
		category: "suspicion",
		title: sus.text,
		titles: [sus.text],
		members: [],
		reviewerSpecs: [],
		consensus: false,
	};
}

/**
 * The lead's suspicions vs. independent discovery. "Raised independently"
 * is the strong signal; "not raised" means either a wrong hypothesis or a
 * shared blind spot — verification (or the lead's own reading) decides.
 */
export function suspicionMarkdown(suspicions: SuspicionResult[], groups: DedupeGroup[], verified: boolean): string[] {
	const byId = new Map(groups.map((g) => [g.id, g]));
	const lines = ["## Lead suspicions (hidden from reviewers)"];
	for (const sus of suspicions) {
		const raised = sus.raisedBy.map((id) => byId.get(id)).filter((g): g is DedupeGroup => Boolean(g));
		const status = raised.length > 0
			? `raised independently — ${raised.map((g) => `${g.id} "${g.title}" (×${g.reviewerSpecs.length})`).join("; ")}`
			: "not raised by any reviewer";
		lines.push(`- **${sus.id}:** ${sus.text}`);
		lines.push(`    - ${status}`);
		if (sus.verifications?.length) {
			const g = { verifications: sus.verifications } as DedupeGroup;
			lines.push(`    - verification (${verificationTally(g)}):`);
			for (const v of sus.verifications) lines.push(`        - \`${v.spec}\` ${v.verdict}: ${v.evidence}`);
		} else if (verified) {
			lines.push(`    - verification: ${sus.verificationNote ?? "no verdict returned"}`);
		}
	}
	lines.push("");
	return lines;
}

function warningLines(target: ReviewTarget): string[] {
	if (target.warnings.length === 0) return [];
	return ["## Warnings", ...target.warnings.map((w) => `- ${w}`), ""];
}

export function synthesizeNoFindingsMarkdown(target: ReviewTarget, reviewerRuns: ReviewerRunResult[], modeLabel = "balanced"): string {
	const ok = reviewerRuns.filter((r) => r.ok);
	const failed = reviewerRuns.filter((r) => !r.ok);
	const lines: string[] = [];
	lines.push(`# Multi-Model Code Review (${modeLabel})`);
	lines.push("");
	lines.push("## Summary");
	lines.push(
		`Scope: \`${target.label}\`. No findings were reported by ${ok.length} reviewer${ok.length === 1 ? "" : "s"}. ` +
			"Nothing to adjudicate.",
	);
	lines.push("");
	lines.push("## Reviewer coverage");
	for (const r of reviewerRuns) {
		const status = r.ok ? "ok" : `failed: ${r.errorMessage?.slice(0, 160) ?? "unknown"}`;
		lines.push(`- \`${r.formattedSpec}\`${r.clamped ? " (thinking clamped by provider)" : ""} — ${status}; ${(r.durationMs / 1000).toFixed(1)}s`);
	}
	if (failed.length > 0) {
		lines.push("");
		lines.push("Note: failed reviewers are excluded from the no-findings assessment.");
	}
	if (target.checkResults?.length) lines.push("", ...checkLines(target));
	if (target.warnings.length > 0) lines.push("", ...warningLines(target));
	return lines.join("\n");
}

export function synthesizeMarkdownFromGroups(
	target: ReviewTarget,
	groups: DedupeGroup[],
	reviewerRuns: ReviewerRunResult[],
	modeLabel = "balanced",
): string {
	const lines: string[] = [];
	const failed = reviewerRuns.filter((r) => !r.ok);
	lines.push(`# Multi-Model Code Review (${modeLabel})`);
	lines.push("");
	lines.push("## Summary");
	const consensusCount = groups.filter((g) => g.consensus).length;
	const totalMembers = groups.reduce((s, g) => s + g.members.length, 0);
	const okCount = reviewerRuns.filter((r) => r.ok).length;
	lines.push(
		`Scope: \`${target.label}\`. ` +
			`${groups.length} deduplicated finding${groups.length === 1 ? "" : "s"} across ` +
			`${okCount} reviewer${okCount === 1 ? "" : "s"}; ` +
			`${consensusCount} consensus, ${totalMembers} raw finding${totalMembers === 1 ? "" : "s"}.`,
	);
	lines.push("");
	if (groups.length === 0) {
		lines.push("_No findings across reviewers; no deep-dive warranted._");
		lines.push("");
	} else {
		lines.push("## Findings");
		for (const g of groups) {
			const range = formatRange(g.line_start, g.line_end);
			const head = g.consensus
				? `### ${g.severity.toUpperCase()} · ${g.title}  [CONSENSUS ×${g.reviewerSpecs.length}]`
				: `### ${g.severity.toUpperCase()} · ${g.title}`;
			lines.push(head);
			lines.push(`- **File:** \`${g.file}:${range}\``);
			lines.push(`- **Category:** ${g.category}`);
			lines.push(`- **Reviewers (${g.reviewerSpecs.length}):**`);
			for (const m of g.members) {
				lines.push(`    - \`${m.spec}\`: ${m.comment}`);
			}
			lines.push(...verificationLines(g));
			lines.push("");
		}
	}
	lines.push(...checkLines(target), ...warningLines(target));
	lines.push("## Reviewers");
	for (const r of reviewerRuns) {
		const status = r.ok
			? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`
			: `FAILED — ${r.errorMessage?.slice(0, 160) ?? "(unknown)"}`;
		const tools = r.toolCalls ? `, ${r.toolCalls} tool calls` : "";
		lines.push(`- \`${r.formattedSpec}\`${r.clamped ? " (thinking clamped)" : ""}: ${status} (${(r.durationMs / 1000).toFixed(1)}s${tools})`);
	}
	if (failed.length > 0) lines.push("", "Failed reviewers are excluded from consensus counts.");
	lines.push("");
	return lines.join("\n");
}

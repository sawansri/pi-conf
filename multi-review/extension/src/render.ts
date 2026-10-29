import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { ModelSpec } from "./config.ts";
import type { ReviewerFinding } from "./findings.ts";
import type { DedupeGroup, SuspicionResult, Verification } from "./grouping.ts";
import type { PrCommentsReport } from "./pr-comments.ts";
import { formatRange } from "./synthesis.ts";
import type { ReviewTarget } from "./target.ts";
import { verificationTally } from "./verify.ts";

// ---------- chat render ----------

/**
 * Payload attached to the message's `details` so the renderer can rebuild
 * the structured layout without re-parsing the judge's markdown. The markdown
 * itself is in `content` so it's selectable in the TUI.
 */
export interface MultiReviewDetails {
	target: ReviewTarget;
	groups: DedupeGroup[];
	reviewerSpecs: ModelSpec[];
	failedSpecs: ModelSpec[];
	judge: string;
	judgeDurationMs: number;
	judgeUsage?: { input: number; output: number; total: number; cost: number };
	consensusCount: number;
	totalFindings: number;
	/** Review markdown, kept apart from tool-result text (which adds lead instructions). */
	markdown?: string;
	suspicions?: SuspicionResult[];
	prComments?: PrCommentsReport;
}

const SEVERITY_COLOR: Record<ReviewerFinding["severity"], "error" | "warning" | "accent" | "muted" | "dim"> = {
	critical: "error",
	high: "error",
	medium: "warning",
	low: "accent",
	info: "muted",
	none: "dim",
};

const SEVERITY_BAR: Record<ReviewerFinding["severity"], string> = {
	critical: "█████",
	high: "████░",
	medium: "███░░",
	low: "██░░░",
	info: "█░░░░",
	none: "░░░░░",
};

export function renderMultiReviewMessage(
	message: { content: string; details?: unknown },
	options: { expanded: boolean },
	theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string; bold: (text: string) => string },
	_ctx: unknown,
): unknown {
	const details = (message.details ?? null) as MultiReviewDetails | null;
	const container = new Container();
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(container);

	const headline = `${theme.fg("toolTitle", theme.bold("multi-review"))} · ${
		details ? `${details.groups.length} groups, ${details.consensusCount} consensus` : "(no payload)"
	}`;
	container.addChild(new Text(headline, 0, 0));

	if (!details) {
		// Fallback to plain markdown if we somehow got here without details.
		container.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
		return box;
	}

	// Severity tally
	const tally: Record<string, number> = {};
	for (const g of details.groups) tally[g.severity] = (tally[g.severity] ?? 0) + 1;
	const tallyStr = (["critical", "high", "medium", "low", "info", "none"] as const)
		.filter((s) => tally[s])
		.map((s) => `${SEVERITY_BAR[s]} ${s}=${tally[s]}`)
		.join("   ");
	if (tallyStr) container.addChild(new Text(theme.fg("dim", tallyStr), 0, 0));

	// Scope line
	container.addChild(new Text(theme.fg("dim", `${details.target.label} · ${details.target.kind}`), 0, 0));
	container.addChild(new Text(
		theme.fg("dim", `judge: ${details.judge} · ${(details.judgeDurationMs / 1000).toFixed(1)}s`),
		0, 0,
	));

	// Per-group brief (always shown)
	for (const g of details.groups) {
		container.addChild(new Spacer(1));
		const head = `${SEVERITY_BAR[g.severity]} ${theme.fg(SEVERITY_COLOR[g.severity], g.severity.toUpperCase())} · ${theme.bold(g.title)}`;
		const consensusTag = g.consensus ? theme.fg("accent", ` [CONSENSUS ×${g.reviewerSpecs.length}]`) : "";
		const tally = verificationTally(g);
		const refuted = g.verifications?.some((v) => v.verdict === "refuted");
		const verifyTag = tally ? theme.fg(refuted ? "warning" : "success", ` ${tally}`) : "";
		container.addChild(new Text(`${head}${consensusTag}${verifyTag}`, 0, 0));
		container.addChild(new Text(theme.fg("dim", `  ${g.file}:${formatRange(g.line_start, g.line_end)} · ${g.category}`), 0, 0));
		if (options.expanded) {
			for (const m of g.members) {
				const specShort = m.spec.split("/").pop() ?? m.spec;
				container.addChild(new Text(`    · ${theme.fg("muted", `${specShort}:`)} ${m.comment}`, 0, 0));
			}
			for (const v of g.verifications ?? []) {
				const specShort = v.spec.split("/").pop() ?? v.spec;
				const mark = v.verdict === "confirmed" ? "✓" : v.verdict === "refuted" ? "✗" : "?";
				const color = v.verdict === "confirmed" ? "success" : v.verdict === "refuted" ? "warning" : "dim";
				container.addChild(new Text(`    ${theme.fg(color, `${mark} ${specShort}:`)} ${v.evidence}`, 0, 0));
			}
		}
	}

	if (details.prComments) {
		const pc = details.prComments;
		const n = (v: Verification["verdict"]) => pc.claims.filter((c) => c.verifications?.some((x) => x.verdict === v)).length;
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted",
			`PR comments: ${pc.claims.length} claim(s) · ✓${n("confirmed")} ✗${n("refuted")} ?${n("uncertain")} · ${pc.claims.filter((c) => c.raisedBy.length).length} also found independently · ${pc.others.length} question/preference`), 0, 0));
		if (options.expanded) {
			for (const c of pc.claims) {
				const tally = c.verifications?.length ? ` ${verificationTally({ verifications: c.verifications } as DedupeGroup)}` : "";
				container.addChild(new Text(`  ${theme.fg("muted", `${c.id} @${c.author}:`)} ${c.claim}${theme.fg("dim", tally)}`, 0, 0));
			}
		}
	}

	if (details.suspicions?.length) {
		container.addChild(new Spacer(1));
		const raised = details.suspicions.filter((x) => x.raisedBy.length > 0).length;
		container.addChild(new Text(theme.fg("muted", `lead suspicions: ${raised}/${details.suspicions.length} raised independently`), 0, 0));
		for (const sus of details.suspicions) {
			const tally = sus.verifications?.length ? ` ${verificationTally({ verifications: sus.verifications } as DedupeGroup)}` : "";
			const mark = sus.raisedBy.length > 0 ? theme.fg("success", `✓ ${sus.raisedBy.join(",")}`) : theme.fg("dim", "· not raised");
			const text = options.expanded ? sus.text : truncateToWidth(sus.text, 90);
			container.addChild(new Text(`  ${theme.fg("muted", `${sus.id}:`)} ${text} ${mark}${theme.fg("dim", tally)}`, 0, 0));
		}
	}

	// In expanded view, render the judge's full markdown.
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── judge markdown ───"), 0, 0));
		const mdTheme = getMarkdownTheme();
		container.addChild(new Markdown(message.content, 0, 0, mdTheme));
	} else {
		container.addChild(new Text(theme.fg("dim", "(Ctrl+O to expand for full judge markdown + per-reviewer comments)"), 0, 0));
	}

	return box;
}

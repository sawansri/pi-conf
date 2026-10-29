import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, ModelSpec, ThinkingLevelAlias } from "./config.ts";
import type { DedupeGroup } from "./grouping.ts";
import { callModel } from "./models.ts";
import { budgetDiff } from "./prompts.ts";
import { formatRange } from "./synthesis.ts";
import type { ReviewTarget } from "./target.ts";
import { verificationTally } from "./verify.ts";

// ---------- judge pass ----------

/**
 * The judge sees the deduped groups with every per-model comment attached,
 * not a flattened list. The schema forces it to write a markdown summary
 * where each finding carries an attribution strip — that's the
 * 'per-model labels preserved' requirement from the design.
 */
const JUDGE_SYSTEM_PROMPT = `You are a senior engineering lead adjudicating multiple independent code reviews. You receive the deduplicated findings with every per-reviewer comment, plus the diff they reviewed. Your job is to decide which findings are real — reviewers hallucinate, misread hunks, and flag pre-existing code.

Output a markdown document with this exact shape:

# Multi-Model Code Review

## Summary
Two- to four-sentence overall assessment, then a one-line "Top risks" list ordered by severity (confirmed findings only).

## Findings
For each finding, in the order provided, write:

### <severity> · <title>
- **File:** <path>:<lines> (or "file" if line numbers null)
- **Category:** <category>
- **Raised by:** <reviewer-count> — <comma-separated short model names>
- **Verdict:** confirmed | plausible | false positive — <one sentence citing the specific diff lines that support or refute it>
- **Judge's take:** <one or two sentences: mechanics, root cause, or a concrete fix>

When reviewers frame the same finding differently, say so in the take — do not silently pick one.

## Side effects
For each confirmed or plausible finding, list what its fix would change besides fixing the issue: behavior or output changes, API/signature or config changes, callers or tests that will need updating, compatibility, performance, and error-handling changes. Write "none" for a fix with no side effects. Skip false positives.

After the side effects, if any models errored or produced unparseable output, add a final '## Coverage' section listing missing reviewers.

Rules:
- Keep every finding in the output (mark false positives, never delete them). Do not invent new findings.
- Verify against the diff. A finding about code the diff doesn't touch is at most "plausible" unless the diff clearly breaks it.
- When independent verification is present, weigh it: a refutation with concrete code evidence usually makes a finding a false positive; confirmations from non-raisers are strong support. Say which way it went.
- You may adjust the displayed severity by one step when the evidence warrants; note the change in the take.
- Keep each finding ≤ 90 words. Do not paste reviewer comments verbatim; they are shown separately.
- Use file paths exactly as given — do not rewrite to absolute paths.
- Severity ladder is critical > high > medium > low > info > none.`;

export interface JudgeResult {
	markdown: string;
	stopReason: string;
	errorMessage?: string;
	usage?: { input: number; output: number; total: number; cost: number };
	durationMs: number;
}

function renderGroupsForJudge(target: ReviewTarget, groups: DedupeGroup[]): string {
	const lines: string[] = [];
	lines.push("## Review target");
	lines.push(`kind: ${target.kind}`);
	lines.push(`label: ${target.label}`);
	if (target.metaLines.length > 0) {
		lines.push("");
		lines.push("metadata:");
		lines.push(...target.metaLines);
	}
	if (target.focusHint) {
		lines.push("");
		lines.push(`focus hint: ${target.focusHint}`);
	}
	if (target.brief?.intent) {
		lines.push("");
		lines.push(`intent: ${target.brief.intent}`);
	}
	if (target.brief?.spec) {
		lines.push("");
		lines.push(`## Spec (${target.brief.spec.path})`);
		lines.push(target.brief.spec.text);
	}
	if (target.brief && target.brief.requirements.length > 0) {
		lines.push("");
		lines.push("## Requirements");
		target.brief.requirements.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
	}
	lines.push("");
	lines.push("## Deduped findings (in severity order)");
	if (groups.length === 0) {
		lines.push("(no findings across reviewers)");
	} else {
		for (const g of groups) {
			const range = formatRange(g.line_start, g.line_end);
			lines.push(
				`- ${g.severity.toUpperCase()}  ${g.file}:${range}  consensus=${g.consensus ? "yes" : "no"} (${g.reviewerSpecs.length} reviewers)`,
			);
			lines.push(`    category: ${g.category}`);
			lines.push(`    titles:`);
			for (const t of g.titles) lines.push(`      - ${t}`);
			lines.push(`    per-reviewer:`);
			for (const m of g.members) {
				lines.push(`      - ${m.spec} (severity=${m.severity}):`);
				for (const cl of m.comment.split("\n")) lines.push(`          ${cl}`);
			}
			if (g.verifications?.length) {
				lines.push(`    independent verification (${verificationTally(g)}):`);
				for (const v of g.verifications) lines.push(`      - ${v.spec}: ${v.verdict} — ${v.evidence}`);
			} else if (g.verificationNote) {
				lines.push(`    verification: ${g.verificationNote}`);
			}
		}
	}
	if (target.diffText) {
		lines.push("");
		lines.push("## Diff under review");
		lines.push(budgetDiff(target.diffText));
	}
	return lines.join("\n");
}

export async function runJudge(
	judgeModel: Model,
	groups: DedupeGroup[],
	target: ReviewTarget,
	failedSpecs: ModelSpec[],
	ctx: ExtensionContext,
	abortSignal: AbortSignal | undefined,
	temperature: number,
	thinking: ThinkingLevelAlias,
): Promise<JudgeResult> {
	const groupsPayload = renderGroupsForJudge(target, groups);
	const coverage = failedSpecs.length > 0
		? `, missing: ${failedSpecs.join(", ")}`
		: "";
	const userPrompt = `${groupsPayload}\n\n## Coverage notes\nReviewers that didn't return usable output: ${failedSpecs.length}${coverage}\n\nNow produce the markdown per the schema in the system prompt. Output ONLY markdown — no preamble, no "Here's the review:" opener.`;
	const call = await callModel(ctx, judgeModel, JUDGE_SYSTEM_PROMPT, userPrompt, { thinking, temperature, signal: abortSignal });
	// A judge cut off at maxTokens drops findings silently; fall back to the
	// deterministic synthesis rather than publish a partial review.
	const truncated = call.stopReason === "length";
	return {
		markdown: call.errorMessage || truncated ? "" : call.text,
		stopReason: call.stopReason,
		errorMessage: call.errorMessage ?? (truncated ? "judge output truncated at maxTokens" : undefined),
		usage: call.usage,
		durationMs: call.durationMs,
	};
}

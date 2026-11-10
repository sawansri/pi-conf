import { normalizeEvidenceKind, parseJsonLenient, pickText } from "./findings.ts";
import type { DedupeGroup, Verification } from "./grouping.ts";
import { formatRange } from "./util.ts";

// The verify round's prompt and verdicts: pure, so tests can load them
// without pi. verify.ts runs the round.

export const VERIFY_SYSTEM_PROMPT = `You are verifying findings that OTHER reviewers raised about a code change. You did not raise them; judge them on the code alone. You get each claim, where it is, and its repro, not the reviewer's argument: build your own.

Verifiers confirm too easily: in studies, LLM validators accept nearly every real problem but reject fewer than a quarter of wrong ones. So try to refute each finding first:
1. Look for what would prevent it: an upstream guard or validation, the type system, a caller that never passes the triggering input, a test that pins the behaviour, the change not touching that code, or a spec that doesn't require it.
2. Only when you find none, check that it happens: run the repro (corrected so it reaches the line, and driving the changed code itself) when you can, else trace the whole path in the code.

Verdicts:
- "confirmed": nothing prevents it and you saw it happen (executed) or traced every step (traced). Plausible is not confirmed.
- "refuted": you found what prevents it, or the claim misreads the code. Cite the code (file:line) or the run that disproves it.
- "uncertain": neither; say what's missing.

Severity is not your call.

Output ONLY a JSON array, one entry per finding:
[{"id": "g1", "verdict": "confirmed"|"refuted"|"uncertain", "evidence_kind": "executed"|"traced"|"inferred", "evidence": "<the command and its output, or the file:line facts that decide it, ≤400 chars>"}]`;

export function buildVerifyPrompt(basePrompt: string, groups: DedupeGroup[]): string {
	const lines = [basePrompt, "", "## Findings to verify"];
	for (const g of groups) {
		if (g.category === "suspicion") {
			lines.push(`### ${g.id} — unconfirmed hypothesis (no location given; find it yourself)`);
			lines.push(`Claim: ${g.title}`);
			lines.push("");
			continue;
		}
		if (g.category === "pr-claim") {
			lines.push(`### ${g.id} — claim from an existing PR review comment · ${g.file}${g.line_start !== null ? `:${g.line_start}` : ""} (line may have moved; verify against the current code)`);
			lines.push(`Claim: ${g.title}`);
			if (g.context) lines.push(g.context);
			lines.push("");
			continue;
		}
		lines.push(`### ${g.id} — ${g.severity.toUpperCase()} · ${g.category} · ${g.file}:${formatRange(g.line_start, g.line_end)}`);
		lines.push(`Title: ${g.title}`);
		// The claim and how to trigger it, not the reviewer's argument for it:
		// persuasive reasoning makes verifiers agree, not check.
		g.members.forEach((m, i) => {
			const claim = (m.parts?.core ?? m.comment).replace(/\n/g, " ");
			lines.push(`Claim ${i + 1}: ${claim}`);
			if (m.parts?.repro) lines.push(`  Repro ${i + 1}: ${m.parts.repro.replace(/\n/g, " ")}`);
		});
		lines.push("");
	}
	lines.push("Output ONLY the JSON array of verdicts per the system prompt.");
	return lines.join("\n");
}

export function parseVerificationJson(rawText: string, expected: Set<string>): Map<string, Omit<Verification, "spec">> {
	const out = new Map<string, Omit<Verification, "spec">>();
	const start = rawText.indexOf("[");
	const end = rawText.lastIndexOf("]");
	if (start === -1 || end <= start) throw new Error(`no JSON array in verifier reply: ${JSON.stringify(rawText.slice(0, 120))}`);
	const parsed = parseJsonLenient(rawText.slice(start, end + 1));
	if (!Array.isArray(parsed)) throw new Error("verifier reply is not an array");
	for (const item of parsed) {
		const rec = (item ?? {}) as Record<string, unknown>;
		const id = pickText(rec, ["id", "group_id", "finding_id", "target_finding_id"]);
		const verdict = normalizeVerdict(pickText(rec, ["verdict", "status", "result"]));
		if (!expected.has(id) || !verdict) continue;
		const evidence = pickText(rec, ["evidence", "reason", "reasoning", "explanation", "justification", "comment"]);
		const evidenceKind = normalizeEvidenceKind(pickText(rec, ["evidence_kind", "evidenceKind", "evidence_type"]));
		out.set(id, { verdict, evidence: (evidence || NO_EVIDENCE).slice(0, 800), ...(evidenceKind ? { evidenceKind } : {}) });
	}
	// Verdicts that match none of the assigned ids are a protocol failure,
	// not "nothing to say" — never let a verifier silently drop out.
	if (out.size === 0 && expected.size > 0) {
		throw new Error(`no usable verdicts for ${[...expected].join(",")} in reply: ${JSON.stringify(rawText.slice(0, 200))}`);
	}
	return out;
}

function normalizeVerdict(raw: string): Verification["verdict"] | undefined {
	const v = raw.toLowerCase().replace(/[^a-z_]/g, "");
	if (["confirmed", "confirm", "valid", "real", "true", "true_positive", "agree"].includes(v)) return "confirmed";
	if (["refuted", "refute", "invalid", "false", "false_positive", "disagree", "rejected"].includes(v)) return "refuted";
	if (["uncertain", "unsure", "unknown", "inconclusive", "unclear"].includes(v)) return "uncertain";
	return undefined;
}

const NO_EVIDENCE = "(no evidence given)";

/**
 * A refutation that cites something is a veto: the lead must answer it
 * before acting on the finding, however many verifiers confirmed. One
 * dissenting judge catches what a majority waves through (Jain et al. 2025:
 * a minority veto cut the worst-case error from 17.6% to 2.8%).
 */
export function vetoes(g: Pick<DedupeGroup, "verifications">): Verification[] {
	// Evidence is something to check: a file.ext:line, or a sentence of it.
	return (g.verifications ?? []).filter((v) => v.verdict === "refuted" && v.evidence !== NO_EVIDENCE && (/[\w/-]\.[A-Za-z]\w*:\d+/.test(v.evidence) || v.evidence.trim().length >= 20));
}

/** One-line verification summary for a group, e.g. "✓2 ✗1 ?0". */
export function verificationTally(g: DedupeGroup): string {
	if (!g.verifications?.length) {
		if (!g.verificationNote) return "";
		return g.verifiers === 0 ? "unanimous" : "unverified";
	}
	const n = (v: Verification["verdict"]) => g.verifications!.filter((x) => x.verdict === v).length;
	return `✓${n("confirmed")} ✗${n("refuted")} ?${n("uncertain")}`;
}

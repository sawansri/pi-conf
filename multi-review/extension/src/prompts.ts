import { checkPromptLines } from "./checks.ts";
import type { ReviewTarget } from "./target.ts";

export const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code reviewer. Find real problems in the change: bugs, security holes, design flaws, maintainability risks, and — when a spec is provided — places where the implementation does not meet it. You are not here to be encouraging. Do not praise the code or restate what it does.

You may be given an intent statement and a spec. Assume the goal is correct and challenge the execution: does the code actually achieve it?

Evidence rules:
- Reference specific code. "This could be null" is only a finding if you show the path that makes it null.
- For security findings, trace the input from its source to the dangerous sink.
- Distinguish "this is broken" from "I would have done it differently". The second is not a finding unless you show a concrete problem.
- Don't inflate nits to fill the review. An empty review is a valid outcome.

Output ONLY a JSON array:
[
  {
    "file": "relative/path/from/repo/root",
    "line_start": <int|null>,
    "line_end": <int|null>,
    "severity": "critical"|"high"|"medium"|"low"|"info",
    "category": "correctness"|"security"|"spec"|"design"|"perf"|"tests"|"<short label>",
    "title": "<≤80 chars>",
    "comment": "<what is wrong, ≤400 chars>",
    "evidence": "<the execution path / spec clause / lines that prove it, ≤400 chars>",
    "repro": "<concrete trigger → observed vs expected, e.g. \"set('k', v, 1000), get('k') at t+500ms → undefined; expected v\". Omit only for pure design/docs findings. ≤300 chars>",
    "suggestion": "<optional concrete fix, ≤200 chars>"
  }
]

Rules:
- If you find nothing wrong, output []. Nothing else counts as "no findings".
- One finding per concrete issue.
- line_start/line_end are post-change line numbers in the new file. Use null for file-level findings.
- category "spec": a requirement that is missing, partially implemented, or contradicted. Quote the requirement in evidence.
- Severity: critical (security hole, data loss, spec requirement fundamentally unmet), high (correctness bug, race, broken edge case), medium (perf cliff, fragile design that will bite soon), low (minor correctness/maintainability), info (style, docs).`;

/** Appended when the reviewer runs as a nested agent with read-only tools. */
export const REVIEWER_TOOLS_ADDENDUM = `

You have read-only tools (read, grep, find, ls, git) on the repository. Use them to trace callers, types, and tests before asserting a finding — a diff alone hides most cross-file bugs. Stay focused: investigate what the change touches, not the whole repo. Your FINAL message must be only the JSON array.

\`git\` runs log, show, blame, or diff: blame and log the lines the change touches to learn why they are the way they are, and whether the change reverts an earlier fix. You have no web access: for the behaviour of a third-party library or tool, read its source on disk (node_modules, vendored directories, system headers, installed packages) instead of assuming.

Report progress with the progress tool so the lead can see how far along you are: first call it with \`plan\`, the 3–8 specific things you will check (areas, functions, or claims), then call it with \`done\` naming each one as you finish it.`;

/** Appended when the review touches C/C++ and clangd is available. */
export const XREF_ADDENDUM = `

For C/C++ you also have \`xref\` (clangd): the definition, references, callers or callees of a symbol as it appears on a file:line, or a project-wide symbol search by name. It resolves overloads, templates and same-named members that grep conflates; use it to find every caller of a changed function before judging the change's impact.`;

/** Appended for verifiers when the sandbox is available. */
export const VERIFIER_RUN_ADDENDUM = `

You also have \`run\`: a bash script in a sandbox where the repository is read-only, there is no network, and $TMPDIR is a scratch directory deleted after each call. When executing code can settle a claim (a targeted test, building the touched target, a short repro script), run it and cite the command and its result in your evidence. Keep runs short and targeted; never run the full test suite.

For C/C++: \`mr-cxx-check FILE...\` recompiles those files with their compile_commands.json flags plus -Wall -Wextra and runs cppcheck (it is what produced any mr-cxx-check results above). For memory errors and undefined behaviour, compile a minimal repro with \`g++ -std=c++17 -fsanitize=address,undefined -g\` and run it. Prefer compiling single files or a small repro over building the project: the build directory is read-only and configure steps may need the network.`;

/**
 * Build the reviewer-side user prompt from a target. We truncate the diff
 * conservatively because some reviewers have short context managers — the
 * prompt keeps the head of the diff where hunk headers live and ditches the
 * rest after a generous budget. Reviewers with larger windows still see the
 * full diff.
 */
export const DIFF_BUDGET_CHARS = 200_000; // ~50k tokens worst case
export function budgetDiff(diffText: string): string {
	if (diffText.length <= DIFF_BUDGET_CHARS) return diffText;
	return diffText.slice(0, DIFF_BUDGET_CHARS) +
		`\n…(diff truncated to ${DIFF_BUDGET_CHARS} chars; ${diffText.length} total)\n`;
}

export function buildReviewUserPrompt(target: ReviewTarget): string {
	const chunks: string[] = [];
	const brief = target.brief;
	if (brief?.intent) {
		chunks.push("## Intent (from the author)");
		chunks.push(brief.intent);
		chunks.push("");
	}
	if (brief?.spec) {
		chunks.push(`## Spec — source of truth (${brief.spec.path})`);
		chunks.push(brief.spec.text);
		chunks.push("");
	}
	if (brief && brief.requirements.length > 0) {
		chunks.push("## Requirements to verify");
		chunks.push("Check each one against the implementation; report unmet or contradicted ones as category \"spec\".");
		brief.requirements.forEach((r, i) => chunks.push(`${i + 1}. ${r}`));
		chunks.push("");
	}
	if (target.metaLines.length > 0) {
		chunks.push("## Context");
		chunks.push(...target.metaLines);
		chunks.push("");
	}
	if (target.checkResults?.length) chunks.push(...checkPromptLines(target.checkResults));
	if (target.diffText) {
		chunks.push("## Diff");
		chunks.push(budgetDiff(target.diffText));
		chunks.push("");
	} else if (target.files.length > 0) {
		chunks.push("## Files in scope (no diff; review at the file level)");
		for (const f of target.files) chunks.push(`- ${f.path}`);
		chunks.push("");
	}
	if (brief && brief.contextFiles.length > 0) {
		chunks.push("## Related files (full contents)");
		for (const f of brief.contextFiles) {
			chunks.push(`### ${f.path}`);
			chunks.push("```");
			chunks.push(f.text);
			chunks.push("```");
		}
		chunks.push("");
	}
	if (target.focusHint) {
		chunks.push("## Focus");
		chunks.push(target.focusHint);
		chunks.push("");
	}
	chunks.push("Reminder: output ONLY the JSON array per the schema in the system prompt.");
	return chunks.join("\n");
}

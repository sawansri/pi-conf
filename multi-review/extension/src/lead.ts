import { parseReviewArgs } from "./args.ts";
import type { ReviewFlags } from "./config.ts";

/**
 * Turn a `/multi-review` invocation into a task for the main agent. The agent
 * has the conversation context the reviewers lack, so it drafts the brief
 * (intent, spec requirements, related files, focus) and calls multi_review,
 * then acts as lead reviewer on the results.
 */
export function buildHandoffPrompt(
	rawArgs: string,
	flags: ReviewFlags,
	specPath: string | undefined,
	prComments?: { includeNits: boolean; includeResolved: boolean },
): string {
	const parsed = parseReviewArgs(rawArgs);
	const focus = parsed.kind === "text" ? parsed.value : parsed.kind === "pr" ? parsed.raw : "";
	const scope = parsed.kind === "pr"
		? `PR #${parsed.number} (\`gh pr view ${parsed.number}\` / \`gh pr diff ${parsed.number}\`)`
		: parsed.kind === "text"
			? "the area the user described below (no diff — reviewers get the focus text and the repo)"
			: "the working-tree diff against the default branch, committed and uncommitted (`git diff $(git merge-base origin/HEAD HEAD)` or similar)";
	const lines: string[] = [];
	lines.push(`The user ran \`/multi-review ${rawArgs.trim()}\`. You are the lead reviewer for a multi-model code review. Do not edit code during this task.`);
	lines.push("");
	lines.push(`1. **Scope.** Under review: ${scope}. Look at the change yourself so you understand it before briefing anyone.`);
	if (specPath) {
		lines.push(`2. **Spec.** Read \`${specPath}\` in full. It is the source of truth: the review checks the implementation against it.`);
	} else {
		lines.push("2. **Intent.** Work out what the change is supposed to do from this conversation, commit messages, and the PR description. If you genuinely can't tell, ask the user instead of calling the tool.");
	}
	lines.push("3. **Brief.** Call the `multi_review` tool once. Reviewers are other model families with read-only repo access; they do NOT see this conversation, so the brief must carry what they can't discover — but NOT where you think the bugs are. Independent discovery is the point: hypotheses in the brief anchor every reviewer on the same spots, turn \"consensus\" into an echo of your prompt, and copy your blind spots into theirs.");
	lines.push("   - `intent`: what the change must accomplish, plus facts reviewers can't find in the repo (external tool/API behaviour, deployment constraints, what's deliberately out of scope). State goals, not a narration of the implementation — reviewers should verify what the code does, not take your description of it as given. Reviewers challenge the execution, not the intent.");
	if (specPath) {
		lines.push("   - `requirements`: every concrete, checkable requirement / acceptance criterion in the spec, one per item, quoted or tightly paraphrased. Include the edge cases and error behaviour the spec pins down.");
		lines.push(`   - \`spec_path\`: "${specPath}" (the full spec is passed to reviewers verbatim).`);
	} else {
		lines.push("   - `requirements`: only if the user stated explicit acceptance criteria.");
	}
	lines.push("   - `context_files`: up to 8 repo paths reviewers should read in full beyond the diff — callers, types/interfaces, tests that pin the behaviour. Skip files the diff already shows whole.");
	lines.push("   - `checks`: up to 4 fast commands that type-check or run the tests covering the change. They run once in a sandbox (repo read-only, no network) before the review and every reviewer sees the output. Pick commands that finish in well under 2 minutes and don't write into the repo; never the full suite. Changed C/C++ files are compile-checked automatically.");
	lines.push(`   - \`focus\`: risk AREAS only (e.g. "API-key handling across agents", "config-file merge lifecycle", "test isolation"), never hypotheses ("does X compile?", "is Y null when Z?")${focus ? `, plus the user's request: "${focus}"` : ""}.`);
	lines.push("   - `suspicions`: your specific hypotheses about possible bugs, one per item. They are NOT shown to the reviewers; they're checked against what reviewers find independently (and cross-checked by verifiers when verify is on), so you learn which of your suspicions others reached on their own.");
	if (parsed.kind === "pr") lines.push(`   - \`pr_number\`: ${parsed.number}`);
	if (parsed.kind === "text") lines.push(`   - \`scope\`: "area" (and put the area description in \`focus\`)`);
	if (flags.verify) lines.push("   - `verify`: true (each finding is cross-checked by reviewers who didn't raise it)");
	if (flags.quick) lines.push("   - `quick`: true (fast reviewer pool, no tools)");
	if (prComments && parsed.kind === "pr") {
		lines.push(`   - \`pr_comments\`: true${prComments.includeNits ? ", `include_nits`: true" : ""}${prComments.includeResolved ? ", `include_resolved`: true" : ""} — the PR's existing review comments (CodeRabbit, collaborators) are fetched and verified separately. Do NOT copy them into the brief (not focus, not suspicions): reviewers must find issues independently so agreement with a comment means something. Your own suspicions are still fine.`);
	}
	lines.push("4. **Verdict.** When results return, follow the lead-judgment instructions in the tool result.");
	return lines.join("\n");
}

/** Appended to the tool result: the main agent is the final judge (pstack-style buckets). */
export function leadJudgmentInstructions(hasSpec: boolean, prNumber?: number): string {
	const lines = [
		"---",
		"## Lead judgment (you)",
		"You are the lead reviewer, not an aggregator. Reviewers saw only your brief and the repo; you have the conversation and can read the code. Before putting a single-reviewer finding in Act On, verify it yourself. Findings raised independently by ≥2 models are the strongest signal, but check them too. Be slow to dismiss correctness and security findings.",
		"Dismiss: hypotheticals the call sites rule out, \"I would have done it differently\", findings about code the change didn't touch, and nits inflated to fill a review.",
		"If the result lists your suspicions: one raised independently is strong signal; one nobody raised is either wrong or a shared blind spot — read the code (or weigh its verification evidence) before deciding. Say which of your suspicions held up.",
		"If a finding has independent verification (✓ confirmed / ✗ refuted / ? uncertain by reviewers who did not raise it), weigh the evidence, not the vote: a refutation citing concrete code usually means Dismissed; a split verdict means read the code yourself.",
		"",
		"Reply to the user in this format:",
		"### Intent",
		"> the intent you briefed",
		"### Reviewers",
		"- model — N findings (or why it failed)",
	];
	if (hasSpec) {
		lines.push("### Spec conformance", "| Requirement | Status (met / partial / missing / contradicted) | Evidence (file:line) |");
	}
	if (prNumber !== undefined) {
		lines.push(
			"### Existing PR comments",
			"One row per claim (and per question/preference): | id | author | where | verdict (valid / invalid / unclear / not a defect) | evidence | action (fix → Act On / reply with explanation / answer / resolve) |.",
			"Weigh verification evidence and whether independent reviewers reached the same defect; a human reviewer's claim that verifiers refute is presented with the code evidence, not overruled silently. Valid claims go into Act On (note the comment id).",
			"### New issues not mentioned on the PR",
			"What the independent reviewers found that no PR comment covers (these are the extra value of this review).",
		);
	}
	lines.push(
		"### Act On",
		"Real issues that would block a PR, numbered. Each: what, where (file:line), which models raised it, why it matters, **Repro** (the concrete trigger → observed vs expected; take the reviewer's and correct it if needed), **Test** (the failing test that will prove the fix), and the fix. Aim for ≤5; more means you aren't filtering hard enough.",
		"### Side effects",
		"For each Act On fix: what changes besides fixing the issue — behavior or output changes, API/signature or config changes, callers or tests that will need updating, compatibility, performance, and error-handling changes. Check the call sites; don't guess. Write \"none\" for a fix with no side effects, rather than leaving it out.",
		"### Consider",
		"Legitimate but debatable now — state the tradeoff.",
		"### Noted",
		"Valid but not actionable; one line each.",
		"### Dismissed",
		"Each with a one-line reason, so the user can override you.",
		"### Agreement Map",
		"Where models agreed or diverged, and what that pattern suggests.",
		"",
		...(prNumber !== undefined
			? [
				`Draft replies: after the verdict, write a reply for each triaged PR comment (valid → what will be fixed and how; invalid → the code evidence; question → the answer) into a local markdown file such as /tmp/multi-review/pr-${prNumber}-replies.md — one section per comment with its link. NEVER post to GitHub or resolve threads (not via gh, not via the API): the user posts replies themselves. Tell the user where the file is.`,
				"",
			]
			: []),
		"Do not apply fixes unless the user asks. If they do, work from your verdict, not this raw review:",
		"1. For each Act On item: write its test from the repro, run it and see it FAIL, fix, see it PASS. A test that passes before the fix doesn't prove anything; rewrite it.",
		"2. Run the project's full test suite.",
		"3. Confirm with a re-review of the new diff: multi_review with verify: true, `focus` on the areas you touched, and `suspicions` = each fixed Act On item phrased as a claim that it is still present (e.g. \"g2 still present: get() returns expired entries at cache.ts:6\"). Report each as fixed (refuted by verifiers, not raised) or still present, plus any new issues the fixes introduced.",
	);
	return lines.join("\n");
}

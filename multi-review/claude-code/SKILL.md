---
name: multi-review
description: Multi-model code review through pi's multi-review extension. Reviewers from other model families (Sonnet 5.5, gpt-6.1-sol, gpt-6-luna; Gemini 4 Argon as a verifier), each with read-only repo access, review the current change, a PR, or a spec implementation in parallel. You write the brief, act as lead reviewer on their findings, and, if asked, fix the issues test-first and confirm the fixes with a re-review. Also verifies a PR's existing review comments (CodeRabbit, other bots, collaborators): which are real, which are wrong, and what they missed, with draft replies (never posted). Use when the user asks for a multi-model review, a second opinion from other models, a check of an implementation against a spec, whether CodeRabbit's or reviewers' PR comments are valid or real, or to fix and confirm review findings.
argument-hint: "[--spec=path] [--verify] [--quick] [#PR [--pr-comments [--nits] [--resolved]] | area to review]"
allowed-tools: Bash(pi -p *) Bash(mkdir *) Bash(git diff *) Bash(git log *) Bash(git show *) Bash(git status *) Bash(git merge-base *) Bash(git rev-parse *) Bash(gh pr view *) Bash(gh pr diff *) Read Write
---

# Multi-model review (lead: you)

You are the lead reviewer. pi's `multi-review` extension runs the reviewers. You understand the change, write their brief, run the review, then judge the findings with the context they don't have. Do not edit code during this task unless the user asks.

Arguments: `$ARGUMENTS`
- `--spec=<path>`: a spec/design doc that is the source of truth.
- `--verify`: each finding (and each of your suspicions) is cross-checked by reviewers who didn't raise it. Costs ~1.5–2×. Use it for high-stakes changes.
- `--quick`: a fast pool without repo tools (10–50s). Good for small diffs or a first look.
- `#123` or a PR URL: review that PR. Any other text is either a focus for the diff review or, if there is no change to review, the area to review.
- `--pr-comments` (with a PR): also triage the PR's existing review comments (CodeRabbit, other bots, collaborators). `--nits` includes nitpicks, and `--resolved` re-checks resolved threads.

**Never post to GitHub.** Don't comment, review, reply, or resolve threads, whether with `gh` or the API. Replies are drafted into a local file for the user to post.

## 1. Understand the change

Run all commands from the repository root, where you already are; pi derives the scope from the working directory.

**Don't check out the PR, switch branches, or create worktrees or copies.** For PR reviews the extension reads the PR's actual code itself. It reuses your checkout if it's already the PR head; otherwise it creates and removes a temporary worktree. A spec that isn't in the PR (an untracked local doc) is read from the local checkout. To look at PR code yourself, use `gh pr diff <n>` and `git show <sha>:<path>`.
- Default scope: everything since the branch left the default branch, committed and uncommitted: `git diff $(git merge-base origin/HEAD HEAD)`. Fall back to `main`/`master` if `origin/HEAD` doesn't exist.
- PR: `gh pr view <n>` and `gh pr diff <n>`.
- With `--spec`, read the spec in full.

If this conversation produced the change, you already have most of this. Still look at the diff as it actually stands.

## 2. Write the brief

Reviewers do NOT see this conversation. Give them what they can't discover, but not where you think the bugs are. Independent discovery is the point. Hypotheses in the brief anchor every reviewer on the same spots, turn "consensus" into an echo of your prompt, and copy your blind spots into theirs.

Write a JSON file (e.g. `/tmp/multi-review/<timestamp>/brief.json`; create the directory first). All fields are optional; text fields are strings, list fields are arrays of strings:

```json
{
  "intent": "Implement Phase 1 of agent-roadmap.md: … Facts outside this repo: pi's models.json apiKey supports ${NAME} interpolation; … Out of scope: …",
  "spec_path": "agent-roadmap.md",
  "requirements": ["1.1: per-model entries include contextWindow from recipe_options.ctx_size", "…"],
  "context_files": ["src/cpp/cli/pi_profile.cpp", "test/cpp/test_pi_profile.cpp"],
  "checks": ["python3 -m pytest -q -p no:cacheprovider test/test_pi_profile_cli.py"],
  "focus": "API-key handling across agents; mcp.json merge lifecycle; CLI flag parsing; test isolation and CI wiring",
  "suspicions": ["--no-mcp may not set the optional to false with the vendored CLI11", "…"],
  "verify": true
}
```

| Field | Content |
|---|---|
| `intent` | What the change must accomplish, plus facts reviewers can't find in the repo: external tool/API behaviour, deployment constraints, what's deliberately out of scope. State goals; don't narrate the implementation, which reviewers verify for themselves. |
| `spec_path` | The spec path exactly as the user gave it: repo-relative or absolute (don't rewrite an absolute path; the spec may live outside the repo). Its text goes to reviewers verbatim. |
| `requirements` | With a spec: every concrete, checkable requirement, one per item, including the edge cases and error behaviour it pins down. Without one: only explicit acceptance criteria. |
| `context_files` | Up to 8 repo paths reviewers should read in full beyond the diff: callers, types/interfaces, tests that pin the behaviour. |
| `checks` | Up to 4 fast commands that type-check or run the tests covering the change, finishing well under 2 minutes in total. They run once before the review in a sandbox where the repo is read-only and there is no network, so skip in-tree builds and anything that downloads. Changed C/C++ files get a compile + cppcheck check automatically when a `compile_commands.json` exists; don't add one yourself. Never the full suite. |
| `focus` | Risk AREAS only ("API-key handling across agents", "config-file merge lifecycle"), never hypotheses ("does X compile?"). |
| `suspicions` | Your specific bug hypotheses, one per item. Hidden from reviewers. They're matched against what reviewers find independently, and with `verify` they're cross-checked. |
| `scope` | `"area"` only when there is no change to review and `focus` describes the area; otherwise omit it. |
| `pr_number` | For PR reviews. |
| `verify`, `quick` | From the arguments. |
| `pr_comments`, `include_nits`, `include_resolved` | For `--pr-comments`, `--nits` and `--resolved`. The comments are fetched and checked by the extension. **Do not copy them into the brief** (not `focus`, not `suspicions`): reviewers must find issues independently, so agreement with a comment means something. Your own suspicions are still fine. |

## 3. Run the review

```bash
pi -p "/multi-review-run --brief=<brief.json> --out=<dir>/result.json" < /dev/null
```

- Write the command exactly in this form, with literal absolute paths (e.g. `/tmp/multi-review/20261030-1215/brief.json`): no shell variables or `$(...)`, nothing chained before it (no `cd …;`, no assignments), and nothing after `< /dev/null` (no `2>&1 | tail`). That form matches the pre-approved `Bash(pi -p *)` rule, keeps pi's stderr progress visible, and lets the `multi-review-status` mod show the run live above the prompt. The review's scope comes from the working directory: if the shell isn't at the repo root, `cd` there in a separate Bash call first.
- Run it in the **foreground** with the Bash tool's maximum timeout (`timeout: 600000`). It typically takes 1–5 minutes. Don't use `run_in_background`: non-interactive sessions end before it finishes.
- The run fits itself into `--max-seconds` (default 540, inside the 10-minute Bash cap). It shrinks reviewer timeouts, and when time runs short it skips verification with a warning instead of overrunning. Any such warning is in the result's Warnings section; mention it to the user.
- `< /dev/null` is required: `pi -p` waits for stdin to close before it starts.
- Progress lines and the final `OK <md> <json>` / `FAILED <json>` line go to stderr. Exit code 0 means success.
- `<dir>/progress.json` shows each reviewer session live: state, plan items checked (self-reported), turns, tool calls, streamed thinking/text size, last tool. `<dir>/trace.jsonl` has every tool call and each assistant message (thinking and text) per session. If the user asks how the review is going, run it with `run_in_background` (interactive sessions only) and read `progress.json`. If a reviewer failed or timed out, read its entries in `trace.jsonl` to see what it was doing.
- On failure, read `result.json` (`{"ok": false, "error": ...}`) and tell the user what went wrong. Typical causes: the reviewer models aren't reachable, a spec path is wrong, or the extension isn't installed.

## 4. Judge, report, and save the verdict

Read `<dir>/result.md`. It is the compact lead view. Each issue has one canonical description with **Evidence**, **Repro** and **Fix**, other reviewers' framings as one-liners, and its verification tally and evidence. Then come your suspicions, warnings, and a **Lead judgment** section. Follow that section:
- verify single-reviewer findings by reading the code;
- weigh verification evidence rather than votes;
- say which of your suspicions held up.

Reply in its format: Intent · Reviewers · (Spec conformance) · Act On · Side effects · Consider · Noted · Dismissed · Agreement Map. Every Act On item gets a **Repro** and a **Test**. **Side effects** lists, for each Act On fix, everything it changes besides fixing the issue: behavior or output changes, API or config changes, callers and tests that need updating, compatibility, and performance. Check the call sites to find them, and write "none" for a fix with no side effects.

If you need a reviewer's exact wording, `result.json` → `details.groups[].members` has the verbatim per-reviewer text (look issues up by id).

Then write your verdict to `<dir>/verdict.md`. That file, not the raw review, is the working document for any fix session:

```markdown
# Verdict — <scope> (<date>)
Review: <dir>/result.md

## Act On
- [ ] A1 (g2) <title> — `file:line`
  - Repro: <trigger → observed vs expected>
  - Test: <test file / name and what it asserts>
  - Fix: <approach>
  - Side effects: <what else the fix changes, or "none">
## Consider / Noted / Dismissed
<one line each>
```

### With `--pr-comments`: triage and draft replies

The result has an **Existing PR review comments** section. Each checkable claim extracted from the comments shows whether the independent reviewers found the same defect, plus verifier verdicts with evidence. Questions and preferences come after the claims. Resolved threads are used only as context; they're not re-checked.

Your reply adds, as the Lead judgment section asks:
- **Existing PR comments:** one row per claim, question and preference. Give the verdict (valid / invalid / unclear / not a defect), the evidence, and the action (fix → Act On / reply with explanation / answer / resolve). A human reviewer's claim that verifiers refute is presented with the code evidence, not overruled silently.
- **New issues not mentioned on the PR:** what this review found beyond the existing comments.

Then write `<dir>/pr-replies.md`: one section per comment with its link, the verdict, and a ready-to-paste reply. Valid → what will be fixed and how. Invalid → the code evidence. Question → the answer. Tell the user the path. **Do not post anything.**

## 5. If the user asks you to fix

Don't edit until asked. Then work through `verdict.md`:
1. **Test first.** For each Act On item, write the test from its repro, run it and see it **fail**, then fix and see it **pass**. A test that passes before the fix proves nothing; rewrite it. Tick the item in `verdict.md`.
2. **Run the full test suite.**
3. **Confirmation re-review.** Write a new brief and run step 3 again:
   - `intent`: "Fixes for the issues in <dir>/verdict.md: …" plus the original intent.
   - `focus`: the areas the fixes touched.
   - `suspicions`: each fixed Act On item, phrased as a claim that it is still present (e.g. `"A1 still present: get() returns expired entries at cache.ts:6"`).
   - `verify`: true.

   Reviewers hunt for new problems in the fixed diff while verifiers check each old issue.
4. **Report** each Act On item as **fixed** (its suspicion was refuted and nobody raised it) or **still present**, plus any new issues the fixes introduced. Update `verdict.md` to match.

## Prerequisites

pi must be on PATH, with the multi-review extension installed (`~/.pi/agent/extensions/multi-review`) and its reviewer models configured. nono (https://nono.sh) is optional: without it checks don't run and verifiers can't execute code; the result's Warnings say so. Setup is described in `install.md` in the pi-conf repo.

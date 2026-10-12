---
name: multi-review
description: Multi-model code review through pi's multi-review extension. Reviewers from other model families (Sonnet 5.5, gpt-6-sol, gpt-6-luna), each with read-only repo access, review the current change, a PR, or a spec implementation in parallel. You write the brief and act as lead reviewer on their findings. Use when the user asks for a multi-model review, a second opinion from other models, or a check of an implementation against a spec.
argument-hint: "[--spec=path] [--verify] [--quick] [#PR | area to review]"
allowed-tools: Bash(pi -p *) Bash(mkdir *) Bash(git *) Bash(gh pr *) Read Write
---

# Multi-model review (lead: you)

You are the lead reviewer. pi's `multi-review` extension runs the reviewers. You understand the change, write their brief, run the review, then judge the findings with the context they don't have. Do not edit code during this task unless the user asks.

Arguments: `$ARGUMENTS`
- `--spec=<path>`: a spec/design doc that is the source of truth.
- `--verify`: each finding (and each of your suspicions) is cross-checked by reviewers who didn't raise it. Costs ~1.5–2×. Use it for high-stakes changes.
- `--quick`: a fast pool without repo tools (10–50s). Good for small diffs or a first look.
- `#123` or a PR URL: review that PR. Any other text is either a focus for the diff review or, if there is no change to review, the area to review.

## 1. Understand the change

Run all commands from the repository root; pi derives the scope from the working directory.
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
  "focus": "API-key handling across agents; mcp.json merge lifecycle; CLI flag parsing; test isolation and CI wiring",
  "suspicions": ["--no-mcp may not set the optional to false with the vendored CLI11", "…"],
  "verify": true
}
```

| Field | Content |
|---|---|
| `intent` | What the change must accomplish, plus facts reviewers can't find in the repo: external tool/API behaviour, deployment constraints, what's deliberately out of scope. State goals; don't narrate the implementation, which reviewers verify for themselves. |
| `spec_path` | Repo-relative spec path (passed to reviewers verbatim). |
| `requirements` | With a spec: every concrete, checkable requirement, one per item, including the edge cases and error behaviour it pins down. Without one: only explicit acceptance criteria. |
| `context_files` | Up to 8 repo paths reviewers should read in full beyond the diff: callers, types/interfaces, tests that pin the behaviour. |
| `focus` | Risk AREAS only ("API-key handling across agents", "config-file merge lifecycle"), never hypotheses ("does X compile?"). |
| `suspicions` | Your specific bug hypotheses, one per item. Hidden from reviewers. They're matched against what reviewers find independently, and with `verify` they're cross-checked. |
| `scope` | `"area"` only when there is no change to review and `focus` describes the area; otherwise omit it. |
| `pr_number` | For PR reviews. |
| `verify`, `quick` | From the arguments. |

## 3. Run the review

```bash
pi -p "/multi-review-run --brief=<brief.json> --out=<dir>/result.json" < /dev/null
```

- Run it in the **foreground** with the Bash tool's maximum timeout (`timeout: 600000`). It typically takes 1–5 minutes. Don't use `run_in_background`: non-interactive sessions end before it finishes.
- The run fits itself into `--max-seconds` (default 540, inside the 10-minute Bash cap). It shrinks reviewer timeouts, and when time runs short it skips verification with a warning instead of overrunning. Any such warning is in the result's Warnings section; mention it to the user.
- `< /dev/null` is required: `pi -p` waits for stdin to close before it starts.
- Progress lines and the final `OK <md> <json>` / `FAILED <json>` line go to stderr. Exit code 0 means success.
- On failure, read `result.json` (`{"ok": false, "error": ...}`) and tell the user what went wrong. Typical causes: the reviewer models aren't reachable, a spec path is wrong, or the extension isn't installed.

## 4. Judge and report

Read `<dir>/result.md`. It contains the grouped findings with per-reviewer comments, verification verdicts, how your suspicions fared, a reviewer roster, and a **Lead judgment** section. Follow that section. It asks you to verify single-reviewer findings by reading the code, to weigh verification evidence rather than votes, and to say which of your suspicions held up. Reply in its format: Intent · Reviewers · (Spec conformance) · Act On · Consider · Noted · Dismissed · Agreement Map.

`result.json` has the same content in structured form (`details.groups`, `details.suspicions`, `details.warnings`) if you need to look something up.

## Prerequisites

pi must be on PATH, with the multi-review extension installed (`~/.pi/agent/extensions/multi-review`) and its reviewer models configured. Setup is described in `install.md` in the pi-conf repo.

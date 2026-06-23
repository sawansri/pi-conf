# Multi-Review

Fan-out code review across multiple models that are already registered in your
pi config. No `models.json` edits, no provider restrictions — pick reviewers
from whatever you have (Fireworks, Kimi, MiniMax, Z.AI/GLM, Claude, OpenAI,
any provider that has an API key wired into `~/.pi/agent/auth.json`).

## What it does

A single command (or LLM tool call) sends the same review prompt + scope to
several models in parallel, collects structured JSON findings, dedupes them
across models, then asks one "judge" model to write a final markdown summary
that preserves per-model labels. The result is injected as a session message
that you can expand/collapse with `Ctrl+O` like any other entry.

## Invocation surface

| Surface | How |
|---------|-----|
| Slash command | `/multi-review` (use defaults) · `/multi-review 4321` (review PR #4321) · `/multi-review focus the diff in `src/auth/*`` (free-text focus) |
| LLM-callable tool | The active agent can invoke `multi_review` when it decides a review would help — same params as the command. |

## Design (sequenced commits during development)

1. **Scaffold + design docs** — this commit.
2. **Model pool & validation** — `multi-review.reviewers` and `multi-review.judge` settings
   pointing at `provider/id` strings that already exist in `ctx.modelRegistry`.
   Validation refuses to run if either pool is empty.
3. **Slash-command arg parsing** — three input shapes: `[/multi-review]`,
   `[/multi-review <pr-number>]`, `[/multi-review <free-text focus>]`.
4. **Scope resolution** —
   - PR number ⇒ `gh pr view <num> --json files,title,body,baseRefName,headRefName,url`
     + `gh pr diff <num>` for the actual diff. Falls back to
     `git diff <base>...HEAD` if `gh` is missing or the repo isn't GitHub.
   - Free text ⇒ appended to the reviewer prompt as a focus hint. No review
     scope is implied; you may want to point at specific hunks yourself.
5. **Parallel fan-out** — `Promise.all` of `completeSimple()` per reviewer,
   single shared prompt asking for JSON `[{file, line_start, line_end,
   severity, category, comment}]`. Abort signal threaded from `ctx.signal`
   so `Ctrl+C` cancels all in-flight.
6. **Dedupe & group** — group findings by `file + overlapping line range`,
   count how many of the configured reviewers flagged each group → "consensus"
   badge when ≥ 2. Per-model labels stay attached so you can see who said what.
7. **Judge pass** — one final `completeSimple()` call against the configured
   judge model (default = currently active model). Prompt is the deduped
   findings tree plus all reviewer→comment maps. Output is markdown with each
   finding showing the severity, the file/line, the consensus count, and a
   per-model attribution strip.
8. **Render & wire-up** — inject the judge's output as a custom-typed session
   entry via `pi.sendMessage({ customType: "multi-review", ... })` plus a
   `pi.registerMessageRenderer()` that renders the entry with severity
   colors, reviewer chips, and Ctrl+O collapsing.
9. **Polish** — abort handling, defaults file, dry-run flag, edge cases on
   parse failures.

## Defaults file

`$PI_CODING_AGENT_DIR/multi-review.json` (drop-in; missing file falls back to
in-code defaults silently, same convention as `tdd-pipeline.json`):

```json
{
  "reviewers": [
    "fireworks/accounts/fireworks/models/minimax-m3",
    "fireworks/accounts/fireworks/models/glm-5p2",
    "fireworks/accounts/fireworks/models/kimi-k2p7"
  ],
  "judge": "fireworks/accounts/fireworks/models/glm-5p2",
  "judgeThinking": "high",
  "concurrency": 4,
  "temperature": 0.2
}
```

This file stays optional — if absent, the picker UI shows everything from
`ctx.modelRegistry.getAvailable()` that resolves.

## Out of scope

- **Auto-apply suggestions.** Review outputs a description, not a fix.
- **models.json modifications.** Per user requirement, the extension reads
  the user's existing registry and never adds new entries.
- **Provider pinning.** Pickers include any provider; Fireworks models show
  up alongside Anthropic / OpenAI / Kimi / MiniMax / Z.AI.

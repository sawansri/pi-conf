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
| Slash command | `/multi-review-pick` — open the multi-select TUI picker to choose reviewer models from your registry (with optional persist-to-`multi-review.json`) |
| LLM-callable tool | The active agent can invoke `multi_review` when it decides a review would help — same params as the command. |

`/multi-review` registers argument autocompletion with a few example shapes
(`#1234`, a PR URL, `focus: …`) so the call shape is discoverable without
memorization.

If the configured reviewer pool is empty AND the agent has UI access,
`/multi-review` opens the picker as a fallback so the user can set up the
pool without leaving the active review. The user can opt to persist the
choice (`/multi-review.json`) or use it for the current run only (transient
override, never touches the file).

## Wire-up

1. **Arg parsing** — three shapes: `[/multi-review]`, `[/multi-review <pr>]`,
   `[/multi-review <free-text focus>]`. Accepts `#1234`, raw `1234`, and
   `…/pull/1234` style URLs. Trailing prose after a PR number flows into
   the focus hint so callers can combine shapes.

2. **Scope resolution** —
   - PR number ⇒ `gh pr view <num> --json title,body,files,baseRefName,headRefName,url`
     + `gh pr diff <num>`. Falls back to
     `git fetch origin pull/<num>/head:pr-<num>` + `git diff pr-<num>...HEAD`
     when `gh` is missing or the repo isn't GitHub.
   - Default (no args) ⇒ `git diff <upstream>...HEAD`, falling back through
     `main` / `master` / `develop` / `origin/main` / `origin/master`, then
     `git show HEAD` if all diffs are empty. Not-a-git-repo ⇒ scan with
     `find`, excluding `node_modules`/`.git`/`dist`/`build`/`.next`/lockfiles.
   - Free text ⇒ no diff; the focus hint becomes the user's directive and a
     directory listing feeds reviewers enough scope to be useful.

3. **Parallel fan-out** — `Promise.all` (capped by `multi-review.concurrency`,
   max 16) of `completeSimple()` per reviewer in a single shared in-process
   call. Abort signal threaded from the tool's `ctx.signal` so `Ctrl+C`
   during an agent turn cancels every in-flight call. Fail-soft: a single
   reviewer's parse/protocol crash doesn't abort the rest.

4. **Structured prompt** — each reviewer is told to output ONLY a JSON
   array `[{file, line_start, line_end, severity, category, title, comment}]`
   with `severity ∈ {critical|high|medium|low|info|none}` and a free-form
   short `category` label. Parser is tolerant of markdown fences and prose
   wrap; finds the first `[` and last `]` before parsing.

5. **Dedupe + group** — greedy O(N²) overlap matcher (same file + touching
   lines OR either side file-level). Per-group carries the full per-model
   attribution: `members[]` keep every spec's original comment, `titles[]`
   collect distinct titles, `reviewerSpecs[]` feeds the consensus badge
   (≥ 2 reviewers ⇒ CONSENSUS). Group severity escalates to the max of
   members.

6. **Judge pass** — single `completeSimple()` on the configured judge model
   with maxTokens 8192 and temperature inherited from defaults. Output is
   structured markdown: severity + title + file:line + category + per-reviewer
   comment list + one-sentence "Judge's take". Reviews never merged silently:
   when reviewers disagree, both comments appear.

7. **Render + inject** — judges' markdown lands as a custom-typed session
   entry (`pi.sendMessage({ customType: "multi-review", ... })`) so it lives
   in the transcript, survives `/compact`, and shows under `/tree`. The
   custom message renderer (`pi.registerMessageRenderer`) renders a compact
   severity tally + per-finding brief in the collapsed view; expanded mode
   (Ctrl+O) shows per-reviewer comments and the full markdown synthesis.

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

This file stays optional — if absent, the extension warns on `/multi-review`
and tells you the exact shape to drop. Unknown fields, wrong types, or
malformed JSON all degrade silently to in-code defaults so the file is
never load-bearing.

## Out of scope (by design)

- **Auto-apply suggestions.** Review outputs a description, not a fix.
- **models.json modifications.** The extension reads `ctx.modelRegistry`
  only; per the user requirement it never adds new entries or modifies
  provider configuration.
- **Provider pinning.** The reviewer pool is whatever you listed in
  `multi-review.json`; pickers can include any provider that the
  registry has API keys for (Fireworks, Kimi, MiniMax, Z.AI, Anthropic,
  OpenAI, etc.).
- **Sub-process sharding.** Following the `completeSimple()` in-process
  pattern, not the `subagent`-style subprocess spawn. Single fire-time,
  no per-reviewer tool sandbox.
- **Interactive reviewer picker.** Empty pool currently just notifies.
  A `ctx.ui.custom()` multi-select picker is a future polish item.

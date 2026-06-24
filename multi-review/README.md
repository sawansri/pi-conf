# Multi-Review

Fan-out code review across multiple models that are already registered in your
pi config. No `models.json` edits, no provider restrictions — pick reviewers
from whatever you have (Fireworks, Kimi, MiniMax, Z.AI/GLM, Claude, OpenAI,
any provider that has an API key wired into `~/.pi/agent/auth.json`).

## What it does

A single command (or LLM tool call) sends the same review prompt + scope to
several models in parallel, collects structured JSON findings, dedupes them
across models, then asks one "judge" model to write a final markdown summary
that preserves per-model labels. While it runs, pi shows live progress
(reviewer count, latest completed model, judge/dedupe phase) in the status
area/widget and streams tool updates when called via `multi_review`. The result
is injected as a session message that you can expand/collapse with `Ctrl+O`
like any other entry.

## Invocation surface

| Surface | How |
|---------|-----|
| Slash command | `/multi-review [--mode=balanced\|light\|triage] [PR-number \| free-text focus]` |
| Slash command | `/multi-review-pick` — open the multi-select TUI picker to choose reviewer models from your registry (with optional persist-to-`multi-review.json`) |
| LLM-callable tool | The active agent can invoke `multi_review({pr_number?, focus?, mode?})` when it decides a review would help |

`/multi-review` registers argument autocompletion with a few example shapes
(`#1234`, a PR URL, `focus: …`, `--mode=...`) so the call shape is
discoverable without memorization.

If the configured reviewer pool is empty AND the agent has UI access,
`/multi-review` opens the picker as a fallback so the user can set up the
pool without leaving the active review. The user can opt to persist the
choice (`/multi-review.json`) or use it for the current run only (transient
override, never touches the file).

## Review modes

The run shape varies by `mode`. Set the default via `multi-review.mode` in
the defaults file, override per-run with `--mode=X` on the slash command or
the `mode` parameter on the `multi_review` tool.

| Mode | What it does | When to use | Cost |
|------|-------------|-----------|------|
| `balanced` *(default)* | N reviewers structured prompt → dedupe → 1 judge synthesis markdown | Default: full review where the synthesis quality matters | ~1× baseline |
| `light` | N reviewers structured prompt → dedupe → markdown synthesized directly from groups (no judge call) | Trust the per-model attribution; want speed / lower cost | ~0.5× (no judge) |
| `triage` | N reviewers with verdict prompt (`escalate: bool`, `files_to_escalate`, `reasoning`). If ≥ `multi-review.triageEscalationThreshold` reviewers say escalate, automatically re-runs balanced on a follow-up target scoped to those files. | Big diffs where most areas are noise; you want a cheap first pass | ~0.4× (no escalate) to ~1.4× (deep) |
| `council` | 2 rounds of de-identified deliberation + judge iff round-2 disagrees. Round-1 raises findings; round-2 has each reviewer weigh in on each peer finding (agree / disagree / extend); judge arbitrates only the disputed ones. | High-stakes architectural reviews where disagreement is the signal | ~2× baseline (always round-2) + judge when disputed |

### Council-mode details

Round 1 is the same structured `[{file, line, severity, ...}]` prompt that
all other modes use. Round 2 takes the dedupe-pass output, de-identifies
each reviewer's contributions behind stable letter aliases (A, B, C, …,
aligned by `provider/id`), and asks each reviewer to emit per-finding
verdicts:

```json
[
  {"target_finding_id": "g1", "verdict": "agree", "comment": "real"},
  {"target_finding_id": "g3", "verdict": "extend",  "comment": "also breaks on Windows path with backslash", "suggested_severity": "high"}
]
```

A group's verdict distribution drives escalation:
- **0 disagree + 0 extend** = unanimous; no judge call, finding is rendered with the per-model round-1+round-2 attribution directly.
- **Any disagree or extend** = disputed; judge runs once over the disputed-only list and emits `{target_finding_id, final_severity, verdict_text}` per entry. Severity may be promoted or demoted by one step based on technical grounds.

Anonymity is **approximate**: aliases are stable per round (same A→spec
across all reviewers). An alert reviewer can pattern-match their own
involvement in a finding. Randomizing the alias map per-recipient per-round
would tighten this; that's a future polish item.

Sample triage verdict from a reviewer:
```json
{"escalate": true, "files_to_escalate": ["src/auth/login.ts"], "reasoning": "Token refresh race window widened without lock acquisition."}
```

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
     `discoverSourceFiles()` below.
   - Free text ⇒ no diff; the focus hint becomes the user's directive and a
     directory listing feeds reviewers enough scope to be useful.

`discoverSourceFiles()` is shared by both default-mode and free-text-mode
fallbacks. Strategy 1: `git ls-files --cached --others --exclude-standard -z`
(native gitignore handling for repos). Strategy 2 (fallback when git
isn't present or cwd isn't a repo): iterative DFS bounded at depth 12 and
200k entries, hard-excluding `.git`/`node_modules`/`dist`/`build`/
`.next`/`target`/`.cache`/`.turbo`/`coverage`/`.venv`/`__pycache__`, then
applying every .gitignore found along each candidate's ancestry. The
gitignore parser implements `*`, `?`, `[abc]`, `**/x`, `x/**`, leading-`/`
anchoring, trailing-`/` directory-only, and `!` negation. No alternation or
extglob — documented limitation.

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

   Each reviewer also runs at the thinking level included with its spec
   (`provider/id@level`, see Defaults). Bare specs fall back to model
   defaults; the SDK clamps per model.

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
  "temperature": 0.2,
  "mode": "balanced",
  "triageEscalationThreshold": 1
}
```

This file stays optional — if absent, the extension warns on `/multi-review`
and tells you the exact shape to drop. Unknown fields, wrong types, or
malformed JSON all degrade silently to in-code defaults so the file is
never load-bearing.

`mode` accepts `balanced` | `light` | `triage` | `council` (default `balanced`).
`triageEscalationThreshold` is the count of reviewers needed to escalate
in `triage` mode (default `1`); bump it to 2+ for consensus-only escalation.

### Per-reviewer thinking level (optional)

A reviewer entry can carry a `@level` suffix to force a specific thinking
level for that run. The suffix matches the same `provider/id@level` syntax
used elsewhere in this repo (`tdd-pipeline` uses it for `/build-models`).

```jsonc
{
  "reviewers": [
    "fireworks/.../minimax-m3@xhigh",   // force xhigh on the slow model
    "fireworks/.../glm-5p2@high",       // moderate reasoning
    "fireworks/.../kimi-k2p7"           // bare → model default (medium)
  ]
}
```

Rules:
- Allowed levels: `off | minimal | low | medium | high | xhigh`.
- Bare spec → model default (`medium` for reasoning-capable models, no
  reasoning field emitted otherwise).
- A level that the model's `thinkingLevelMap` clamps to a softer value
  (e.g. `xhigh` → `high` on some Fireworks-hosted models) is surfaced in
  the notify under "clamped" so you don't have to guess why reasoning
  looks lighter than expected.

The picker (`/multi-review-pick`) currently writes bare specs only; edit
the JSON directly if you want per-reviewer levels. Editing the picker to
expose per-row level controls is tracked as future polish.

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
- **Full model configuration UI.** The picker selects reviewer models only.
  Per-reviewer thinking levels and judge choice are still edited directly in
  `multi-review.json`.

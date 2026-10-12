# Install

## Prereqs

- pi (the extension uses `ctx.modelRegistry.streamSimple` and
  `pi.appendEntry` / `pi.sendMessage` / `pi.registerMessageRenderer`
  / `pi.registerTool` / `pi.registerCommand` from
  `@mariozechner/pi-coding-agent`).
- One or more models registered in your pi config with valid credentials.
  Anywhere `ctx.modelRegistry.getAvailable()` returns a model is fair game
  — Fireworks, Kimi, MiniMax, Z.AI, Anthropic, OpenAI, etc.
- For PR-number input: `gh` CLI authenticated (`gh auth status`), or a git
  repo where `git fetch origin pull/<N>/head:pr-<N>` is reachable without
  GH-aware tooling.
- For free-text focus input: nothing extra — that's the fallback shape.

The extension makes **no** changes to `~/.pi/agent/models.json` (per the
design constraint).

## 1. Install the extension

```bash
# Globally
mkdir -p ~/.pi/agent/extensions/multi-review
cp /home/sawan/Projects/pi-conf/multi-review/extension/index.ts \
   ~/.pi/agent/extensions/multi-review/index.ts

# Or project-local
mkdir -p .pi/extensions/multi-review
cp /home/sawan/Projects/pi-conf/multi-review/extension/index.ts \
   .pi/extensions/multi-review/index.ts
```

Reload inside pi with `/reload`, or restart.

## 2. (Optional) Drop a defaults file

```bash
cat > ~/.pi/agent/multi-review.json << 'EOF'
{
  "reviewers": [
    "amd-gateway/gpt-6-astra@xhigh",
    "amd-gateway/Grok-4.7@high",
    "amd-gateway/DeepSeek-V4-Pro@high",
    "amd-gateway/Kimi-K2.7-Code@high",
    "amd-gateway/gemini-3.8-flash@high"
  ],
  "judge": "amd-gateway-anthropic/Claude-Opus-5.5",
  "judgeThinking": "high",
  "concurrency": 5,
  "temperature": 0.2,
  "mode": "balanced",
  "triageEscalationThreshold": 1
}
EOF
```

The file is read once on first use (cached for the extension's lifetime);
`/reload` to rescan. Unknown keys, bad JSON, or a missing file all fall
back silently to in-code defaults. Only the keys listed above are honored
— anything else is ignored.

Per-reviewer thinking level is supported via the `provider/id@level`
suffix on each reviewer entry; bare entries use the model default:

```bash
cat > ~/.pi/agent/multi-review.json << 'EOF'
{
  "reviewers": [
    "amd-gateway/gpt-6-astra@xhigh",
    "amd-gateway/Grok-4.7@max",
    "amd-gateway/Kimi-K2.7-Code"
  ],
  "mode": "balanced"
}
EOF
```

Allowed levels: `off | minimal | low | medium | high | xhigh | max`. If a model
clamps a level (e.g. `xhigh` on gemini-3.8-flash), the notify surfaces it
under "clamped" so you can spot it without guessing.

### Picking a mode

Set `"mode"` in the defaults file (or override per-run with
`--mode=balanced|light|triage|council`):

- `balanced` — fan-out; the main agent judges (with `--direct`, an
  external judge does). Default.
- `light` — fan-out with deterministic synthesis. Only differs from
  balanced in `--direct` runs, where it skips the judge call.
- `triage` — cheap verdict first; auto-escalates to balanced when at
  least `triageEscalationThreshold` reviewers (default 1) report a
  concrete concern. Use for big diffs where most areas are noise.
- `council` — 2 rounds of de-identified deliberation (raise, then
  peer-aware verdicts) + judge iff round-2 disagreed/extended on
  something. Roughly 2× cost; use for high-stakes architectural
  reviews where disagreement is the signal.

## 3. Verify the two surfaces

### Slash command

Inside pi, type `/multi-review ` and you should see completions for
`--spec=`, `--mode=…`, `--direct`, `#`.

The command hands the task to your main agent. It reads the change, writes
the reviewer brief, calls `multi_review`, and replies with an Act On /
Consider / Noted / Dismissed verdict.

Review the working tree (committed + uncommitted) against the default branch:
```
/multi-review
```

Run a PR review:
```
/multi-review 4321
```

Review the implementation against a spec (adds a conformance table):
```
/multi-review --spec=docs/feature-spec.md
```

Review an area of the codebase (no diff):
```
/multi-review the auth/ subdirectory, especially error handling
```

Skip the agent and use the configured judge (also what print/RPC modes do):
```
/multi-review --direct --mode=light
```

Open the reviewer picker to (re-)configure your pool without dragging
scope into it:
```
/multi-review-pick
```

Space toggles a selection, ↑↓ moves between selectable model rows,
PgUp/PgDn jumps, `a` selects all, `A` clears, Enter confirms, Esc cancels.
The picker renders as a bounded overlay so large model registries don't flood
the chat view. On confirm you'll be asked whether to persist the selection to
`multi-review.json` or use it for the current run only.

If you run `/multi-review` with an empty pool AND no UI is available
(e.g. RPC mode), you'll get the regular fallback warning instead of
the picker.

### LLM-callable tool

Ask the active agent for a review:
```
> please do a multi-model code review on PR 4321
```

The agent should write a brief and call `multi_review`. The tool result
renders as the review panel (`Ctrl+O` to expand), and the agent's verdict
follows it.

## 4. Inspect and tune

The status footer shows the loaded pool on session start:
```
multi-review · pool: 5 (amd-gateway/gpt-6-astra@xhigh, amd-gateway/Grok-4.7@high, amd-gateway/DeepSeek-V4-Pro@high, +2 more)
```

Per-run status updates flow through the same status key and a temporary
progress widget below the editor:
```
multi-review · mode=balanced · resolving scope
multi-review · mode=balanced · reviewers running (4/5)
latest: ✓ gpt-6-astra@xhigh (4/5) — 4 findings, 33.8s, 5 tool calls
multi-review · mode=balanced · grouping findings (Claude-Opus-5.5)
multi-review · done
```
When called through the `multi_review` tool, the same progress is also sent
via tool updates so the pending tool row changes as reviewers complete.

## Failure recovery cheat-sheet

| Symptom | What to do |
|---------|-----------|
| `no reviewers configured` | Add `multi-review.json` per step 2 |
| A reviewer shows `timed out after 300s` | Raise `reviewerTimeoutSec`, or lower that reviewer's `@level` (Grok-4.7@high takes ~3 min with tools) |
| `cannot read spec …` | `--spec` paths are relative to pi's cwd; the run refuses to continue without the spec rather than silently dropping it |
| `none of the configured reviewers resolved` | Confirm each spec is rule-typed in `~/.pi/agent/models.json` AND has its API key wired (`/login` or env var); the extension never adds models itself |
| `judge model missing` | Same as above for `multi-review.json` → `judge` |
| `git fetch origin pull/N/head failed` | Network or auth problem in the git remote; try running fetch by hand |
| `gh pr view failed` | Either missing `gh`, unauthed, or repo isn't GitHub'd; we silently fall back to `git fetch`+`git diff` |
| Judge output truncated | Calls request up to 32k output tokens (capped at the model's maxTokens); trim the reviewer pool if a judge still truncates |
| Watching a run in print/RPC mode | Set `MULTI_REVIEW_DEBUG=1`; progress lines go to stderr. When scripting `pi -p`, close stdin (`< /dev/null`) or pi waits for it |
| Directory listing empty in free-text mode | Either nothing tracked + nothing non-ignored-added by git, or all paths matched gitignore. Run `git ls-files --others --exclude-standard` in the project to see what we'd find. |
| `.gitignore` patterns not honored | We support `*`/`?`/`[…]`/`**`/leading-`/`/trailing-`/`/`!` negation. No `{a,b}` alternation or extglob. Files that need deeper .gitignore features should be reviewed with `git` directly. |

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/multi-review
```

No background processes, no global state damage. `models.json` left
untouched. In-session `multi-review` entries persist in the session
file but render as plain markdown after the renderer is gone.

# Install

## Prereqs

- pi (the extension uses `completeSimple` from `@mariozechner/pi-ai` and
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
    "fireworks/accounts/fireworks/models/minimax-m3@xhigh",
    "fireworks/accounts/fireworks/models/glm-5p2@high",
    "fireworks/accounts/fireworks/models/kimi-k2p7"
  ],
  "mode": "balanced"
}
EOF
```

Allowed levels: `off | minimal | low | medium | high | xhigh`. If a model
clams a level (e.g. `xhigh`→`high` on Fireworks), the notify surfaces it
under "clamped" so you can spot it without guessing.

### Picking a mode

Set `"mode"` in the defaults file (or override per-run with
`--mode=balanced|light|triage|council`):

- `balanced` — fan-out + judge. Default.
- `light` — fan-out only; no judge. ~50% faster, halves token cost.
  Use when you trust the per-model attribution and don't need synthesis.
- `triage` — cheap verdict first; auto-escalates to balanced when at
  least `triageEscalationThreshold` reviewers (default 1) report a
  concrete concern. Use for big diffs where most areas are noise.
- `council` — 2 rounds of de-identified deliberation (raise, then
  peer-aware verdicts) + judge iff round-2 disagreed/extended on
  something. Roughly 2× cost; use for high-stakes architectural
  reviews where disagreement is the signal.

## 3. Verify the two surfaces

### Slash command

Inside pi, type `/multi-review` and you should see autocomplete entries
for `(default)`, `#1234`, `PR URL`, `focus: …`.

Run a no-args review of your cwd:
```
/multi-review
```

Run a PR review:
```
/multi-review 4321
```

Run a free-text review:
```
/multi-review focus: the auth/ subdirectory, especially error handling
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

The agent should call `multi_review` automatically with the right args.
The result lands as a chat entry — `Ctrl+O` to expand.

## 4. Inspect and tune

The status footer shows the loaded pool on session start:
```
multi-review · pool: 3 (fireworks/.../minimax-m3, fireworks/.../glm-5p2, +1 more)
```

Per-run status updates flow through the same status key and a temporary
progress widget below the editor:
```
multi-review · mode=balanced · resolving scope
multi-review · mode=balanced · reviewers running (2/3)
latest: ✓ glm-5p2 (2/3) — 1 finding, 18.4s, $0.0021
multi-review · 7 groups · invoking judge glm-5p2
multi-review · done
```
When called through the `multi_review` tool, the same progress is also sent
via tool updates so the pending tool row changes as reviewers complete.

## Failure recovery cheat-sheet

| Symptom | What to do |
|---------|-----------|
| `no reviewers configured` | Add `multi-review.json` per step 2 |
| `none of the configured reviewers resolved` | Confirm each spec is rule-typed in `~/.pi/agent/models.json` AND has its API key wired (`/login` or env var); the extension never adds models itself |
| `judge model missing` | Same as above for `multi-review.json` → `judge` |
| `git fetch origin pull/N/head failed` | Network or auth problem in the git remote; try running fetch by hand |
| `gh pr view failed` | Either missing `gh`, unauthed, or repo isn't GitHub'd; we silently fall back to `git fetch`+`git diff` |
| Judge output truncated | Most judges cap at 4-8k output tokens; trim your reviewer pool or lower judge maxTokens ask |
| Directory listing empty in free-text mode | Either nothing tracked + nothing non-ignored-added by git, or all paths matched gitignore. Run `git ls-files --others --exclude-standard` in the project to see what we'd find. |
| `.gitignore` patterns not honored | We support `*`/`?`/`[…]`/`**`/leading-`/`/trailing-`/`/`!` negation. No `{a,b}` alternation or extglob. Files that need deeper .gitignore features should be reviewed with `git` directly. |

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/multi-review
```

No background processes, no global state damage. `models.json` left
untouched. In-session `multi-review` entries persist in the session
file but render as plain markdown after the renderer is gone.

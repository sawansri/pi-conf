# Install

## Prereqs

- pi (the extension uses `ctx.modelRegistry.streamSimple` and
  `pi.appendEntry` / `pi.sendMessage` / `pi.registerMessageRenderer`
  / `pi.registerTool` / `pi.registerCommand` from
  `@mariozechner/pi-coding-agent`).
- One or more models registered in your pi config with valid credentials.
  Anywhere `ctx.modelRegistry.getAvailable()` returns a model is fair game
  (any provider with credentials). The default pool expects
  `amd-gateway/gemini-4-argon` in `models.json` (an `openai-completions`
  entry shaped like `gemini-3.8-flash`); if it's missing, that reviewer is
  skipped with a notice.
- For PR-number input: `gh` CLI authenticated (`gh auth status`), or a git
  repo where `git fetch origin pull/<N>/head:pr-<N>` is reachable without
  GH-aware tooling.
- For free-text focus input: nothing extra — that's the fallback shape.
- Optional, to let reviews execute code (checks, the verifiers' `run` tool,
  the C/C++ compile check): [nono](https://nono.sh) on PATH or in
  `~/.local/bin`, and a kernel with Landlock (5.13+; 6.7+ to block TCP):

  ```bash
  curl -fsSL https://nono.sh/install.sh -o /tmp/nono-install.sh   # read it first
  NONO_INSTALL_DIR=~/.local/bin sh /tmp/nono-install.sh
  grep -q landlock /sys/kernel/security/lsm && echo landlock ok
  ```

  The C/C++ check and `xref` also want a `compile_commands.json` (CMake:
  `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`), and the analysis tools, installed
  without root into `~/.local/share/multi-review/venv` (clang-tidy, lizard
  and clangd from PyPI, ~600MB):

  ```bash
  ~/.pi/agent/extensions/multi-review/tools/install-cxx-analysis
  ```

  `cppcheck` is used when it's on PATH. Each missing tool is skipped with a
  note in the check output.

The extension makes **no** changes to `~/.pi/agent/models.json` (per the
design constraint).

## 1. Install the extension

Symlink it (recommended when you edit this repo: changes go live on `/reload`):

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn ~/Projects/pi-conf/multi-review/extension ~/.pi/agent/extensions/multi-review
```

Or copy a snapshot:

```bash
mkdir -p ~/.pi/agent/extensions/multi-review
cp -r ~/Projects/pi-conf/multi-review/extension/. ~/.pi/agent/extensions/multi-review/
```

(The whole directory: `index.ts` registers the extension and imports the
modules in `src/`; `tools/` holds the scripts the sandbox runs.)

Project-local instead: use `.pi/extensions/multi-review` in the repo. Pi
loads any subdirectory that contains an `index.ts`. Restart pi or run
`/reload`.

### Claude Code (optional)

To trigger reviews from Claude Code, install the skill:

```bash
ln -sfn ~/Projects/pi-conf/multi-review/claude-code ~/.claude/skills/multi-review
```

Then `/multi-review` in Claude Code (see README, "Using it from other
harnesses"). It needs `pi` on PATH and the extension installed as above.

To watch a run live in Claude Code (the same lines as pi's progress
widget, in the band above the prompt), install the `multi-review-status`
mod. It needs Claude Code 2.1.287 or later:

```bash
claude plugin marketplace add ~/Projects/pi-conf
claude plugin install multi-review-status@pi-conf
```

An installed plugin is cached by version. After changing the mod, bump
`version` in `claude-code-mod/.claude-plugin/plugin.json` and run
`claude plugin update multi-review-status@pi-conf`. To try it for one
session without installing, use
`claude --plugin-dir ~/Projects/pi-conf/multi-review/claude-code-mod`.

## 2. (Optional) Drop a defaults file

```bash
cat > ~/.pi/agent/multi-review.json << 'EOF'
{
  "reviewers": [
    "amd-gateway-anthropic/Claude-Sonnet-5.5@high",
    "amd-gateway/gpt-6.1-sol@high",
    "amd-gateway/gpt-6-luna@high"
  ],
  "judge": "amd-gateway-anthropic/Claude-Opus-5.5",
  "judgeThinking": "high",
  "concurrency": 5,
  "temperature": 0.2,
  "verify": false,
  "verifiersPerFinding": 2,
  "verifyOnly": ["amd-gateway/gemini-4-argon@medium"],
  "quickReviewers": [
    "amd-gateway/gpt-6-luna@low",
    "amd-gateway-anthropic/Claude-Haiku-5.5",
    "amd-gateway/gemini-3.8-flash@low"
  ],
  "reviewerTools": true,
  "reviewerTimeoutSec": 420,
  "sandbox": true,
  "checkTimeoutSec": 120,
  "autoChecks": true,
  "minReviewToolCalls": 10,
  "webSearch": true
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
    "amd-gateway-anthropic/Claude-Sonnet-5.5@high",
    "amd-gateway/gpt-6.1-sol@high",
    "amd-gateway/gpt-6-luna"
  ]
}
EOF
```

Allowed levels: `off | minimal | low | medium | high | xhigh | max`. If a model
clamps a level (e.g. `xhigh` on gemini-3.8-flash), the notify surfaces it
under "clamped" so you can spot it without guessing.

### Review options

- *(default)* — full pool with read-only tools; the main agent judges.
- `--verify` — each issue is cross-checked by 2 reviewers who didn't
  raise it (confirmed / refuted / uncertain, with evidence). ~1.5–2× cost.
  Set `"verify": true` to make it the default.
- `--quick` — the `quickReviewers` pool, no tools. 10–50s.
- `--direct` — skip the agent; the configured judge synthesizes.

Old `--mode=` values still parse: `council` → `--verify`,
`triage` → `--quick`, `balanced` and `light` → default.

## 3. Verify the two surfaces

### Slash command

Inside pi, type `/multi-review ` and you should see completions for
`--spec=`, `--verify`, `--quick`, `--direct`, `#`.

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
/multi-review --direct
```

Cross-check every issue (adds ✓/✗/? badges with evidence):
```
/multi-review --verify --spec=docs/feature-spec.md
```

Calling the tool directly, the agent keeps its hypotheses out of the brief:
```
multi_review
  intent: "Implements Phase 1 of agent-roadmap.md … (goals + external facts, not implementation narrative)"
  spec_path: agent-roadmap.md
  requirements: ["1.1: models.json per-model entries include contextWindow …", …]
  focus: "API-key handling across agents, mcp.json merge lifecycle, CLI flag parsing, test isolation and CI wiring"
  suspicions: ["CLI11 add_flag(\"--mcp,!--no-mcp\") may not set false for --no-mcp", "refresh without a key may keep a stale Authorization header"]
  verify: true
```

Triage a PR's existing review comments (CodeRabbit, collaborators) and
review it fresh. Draft replies go to a local file; nothing is posted:
```
/multi-review #1234 --pr-comments
/multi-review #1234 --pr-comments --nits --resolved
```

Fast first look:
```
/multi-review --quick
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
multi-review · pool: 3 (amd-gateway-anthropic/Claude-Sonnet-5.5@high, amd-gateway/gpt-6.1-sol@high, amd-gateway/gpt-6-luna@high)
```

Per-run status updates flow through the same status key and a temporary
progress widget below the editor:
```
multi-review · mode=balanced+verify · resolving scope
multi-review · mode=balanced+verify · reviewers running (2/4)
latest: ✓ gpt-6.1-sol@high (2/4) — 11 findings, 132.5s, 24 tool calls
multi-review · mode=balanced+verify · grouping findings (Claude-Opus-5.5)
multi-review · mode=balanced+verify · verifying findings (2/3)
latest: ✓ gpt-6-luna@high verified 3/3 (2 confirmed, 1 refuted), 8.9s
multi-review · done
```
When called through the `multi_review` tool, the same progress is also sent
via tool updates so the pending tool row changes as reviewers complete.

## Failure recovery cheat-sheet

| Symptom | What to do |
|---------|-----------|
| `no reviewers configured` | Add `multi-review.json` per step 2 |
| A reviewer shows `timed out after 420s` or `cut as straggler` | Straggler: the rest of the pool finished long before it (often a degraded endpoint; check the gateway status page). Timeout: raise `reviewerTimeoutSec` or lower that reviewer's `@level` (higher levels didn't improve results in testing) |
| `checks not run: nono is not installed` / `verifiers can't execute code` | Install nono (Prereqs), or set `"sandbox": false` to silence it |
| `C/C++ files changed but no compile_commands.json` | Configure with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` (it is looked for at the repo root, `build*/`, `build*/*/`, `out/*/`) |
| A check fails with "Permission denied" | The repo is read-only in the sandbox; brief checks that don't write into it (type-checks, tests that write to `$TMPDIR`) |
| `cannot read spec …` | `--spec` paths are relative to pi's cwd; the run refuses to continue without the spec rather than silently dropping it |
| An issue shows `unanimous` instead of ✓/✗ | Every reviewer raised it, so nobody independent was left to verify it; the lead agent checks those itself |
| `none of the configured reviewers resolved` | Confirm each spec is rule-typed in `~/.pi/agent/models.json` AND has its API key wired (`/login` or env var); the extension never adds models itself |
| `judge model missing` | Same as above for `multi-review.json` → `judge` |
| `git fetch origin pull/N/head failed` | Network or auth problem in the git remote; try running fetch by hand |
| `gh pr view failed` | Either missing `gh`, unauthed, or repo isn't GitHub'd; we silently fall back to `git fetch`+`git diff` |
| Judge output truncated | Calls request up to 32k output tokens (capped at the model's maxTokens); trim the reviewer pool if a judge still truncates |
| Watching a run in print/RPC mode | Set `MULTI_REVIEW_DEBUG=1`; progress lines go to stderr (`=2` also dumps raw reviewer replies). When scripting `pi -p`, close stdin (`< /dev/null`) or pi waits for it |
| Directory listing empty in free-text mode | Either nothing tracked + nothing non-ignored-added by git, or all paths matched gitignore. Run `git ls-files --others --exclude-standard` in the project to see what we'd find. |
| `.gitignore` patterns not honored | We support `*`/`?`/`[…]`/`**`/leading-`/`/trailing-`/`/`!` negation. No `{a,b}` alternation or extglob. Files that need deeper .gitignore features should be reviewed with `git` directly. |

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/multi-review   # removes the symlink or the copy, not the repo
```

No background processes, no global state damage. `models.json` left
untouched. In-session `multi-review` entries persist in the session
file but render as plain markdown after the renderer is gone.

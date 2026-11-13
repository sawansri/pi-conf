# AGENTS.md

Notes for coding agents working in this repo. They cover what earlier agent
sessions had to dig out themselves. User-facing docs are elsewhere; this file
points to them instead of repeating them:

- `multi-review/README.md`. See "Executing code" for the sandbox and tools,
  "Model choice" for model benchmarks, "Cost" for the cache multipliers and
  efficiency levers, and "Defaults file" for every config key.
- `multi-review/install.md` has the troubleshooting table, including
  `MULTI_REVIEW_DEBUG=1|2`.
- `multi-review/claude-code/SKILL.md` covers headless use from Claude Code
  (`--max-seconds 540`, a 600000 ms foreground timeout).

## Layout and what is live

- `multi-review/extension/` is the pi extension. `~/.pi/agent/extensions/multi-review`
  is a symlink to it, so edits are live after `/reload` in pi, with no build.
- `multi-review/claude-code/` is the Claude Code skill. It is a symlink from
  `~/.claude/skills/multi-review`, so SKILL.md edits apply at once.
- `multi-review/claude-code-mod/` is the status mod. The installed copy comes
  from the marketplace, so run `claude plugin update multi-review-status@pi-conf`
  after editing it. `/reload-plugins` doesn't upgrade a session that's already
  running; use `claude --resume`.
- `tdd-pipeline/` is a separate pi pipeline.
- pi is installed at `~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)`.
  The compiled binary is no use for learning pi's behaviour; read
  `node_modules/@earendil-works/pi-coding-agent/dist/core/*.d.ts` and
  `agent-session.js` there instead. The extension imports `@mariozechner/*`,
  and `tests/support/pi-resolve.mjs` maps that to `@earendil-works/*`.

## Tests

- Unit tests: `multi-review/extension/mr-test.sh`. They need node ≥22 and
  have no network or model calls. `tests/support/fake-models.ts` provides a
  fake `ctx.modelRegistry`, so pipeline code runs deterministically. Keep new
  tests that way.
- Before trusting a new test, break the code it covers and watch it fail.
  A race test once passed without its fix.
- Node test harnesses: `AbortSignal.timeout` timers are unref'd, so a fake
  model that hangs needs a `setInterval` to keep the process alive.
- Type-checking has no committed setup, and the system `tsc` is too old.
  Install `typescript@5` with `--no-save` in a scratch dir, point
  `paths`/`typeRoots` at the pi release, and run `node …/typescript/bin/tsc`.
  Main already has a few errors (`sandbox.ts` `import.meta`, `progress.ts`
  Theme), so compare the error list before and after your change instead of
  expecting zero.
- Status mod tests: `cd multi-review/claude-code-mod && claude plugin test`.
- Benchmarks: `extension/tests/bench/run.sh [balanced|quick|verify|qverify]`
  runs a real review of a fixture with 10 planted defects. It costs money
  and calls the gateway. Total cost varies run to run by about 50% (CV), so
  a handful of runs can't show a 15% effect. Argue from per-call token
  arithmetic (`lever-cost.ts`) and measure cache behaviour with
  `cache-probe.ts`; don't infer it from `models.json`.

## Analyzing a review run

### Where runs live

| Run | Directory | Files |
|---|---|---|
| Interactive (pi) | `~/.local/share/multi-review/runs/YYYYMMDD-HHMMSS-xxxxxx/` | `progress.json`, `trace.jsonl` |
| Headless (skill) | `~/.local/share/multi-review/runs/<timestamp>/` (the brief's directory; `--out` decides) | the above + `brief.json`, `result.json`, `result.md`, `verdict.md`, `outcomes.json` |
| Benchmark | `~/.local/share/multi-review/runs/bench-YYYYMMDD-HHMMSS-<mode>/` | as headless |

`$XDG_DATA_HOME` replaces `~/.local/share` when it is set. Runs from before
commit `5f667e0` were written to `/tmp` (`/tmp/multi-review-XXXXXX/`,
`/tmp/multi-review/<name>/`, `/tmp/mr-bench-*`), which a reboot clears, so
most of them are gone. `~/.local/share/multi-review/outcomes.jsonl`
survives, with one line per finding: run, group, spec, severity, evidence,
verification and bucket. `~/.cache/multi-review/runs/<pid>.json` only
registers a run for the status mod, and entries for dead processes stay
behind.

### First step: `extension/tools/mr-run-summary <run-dir>...`

It prints one line per session: phase, ok/failed, turns, seconds, tool calls
by tool, files read more than twice, finish note, and the cost at catalog
price vs the billed cost. Read the **billed** column.

### Traps

- **The reported cost is low.** `models.json` prices cache reads and writes
  at $0, but the gateway bills 0.05x and 1.25x the input rate (`cost.ts`).
  Anthropic models are under-reported the most: in run `20261111-1321`,
  Sonnet showed $0.30 at catalog price and was billed $1.18. Kimi showed
  $2.43 and was billed $3.14.
- **Runs before commit `a70d083` show $0 for failed or timed-out sessions,**
  even though those sessions were billed.
- **Cost per session exists only in `result.json`** (`details.cost.bySpec`).
  Without it, for a cancelled or interactive run, only the last three
  sessions' costs survive, as text in `progress.json` `run.events`.
- **`trace.jsonl` can't show how big a tool result was.** `tool_result` is
  recorded only for `git`, `run`, `xref` and `web_search`, and cut to 600
  characters (`trace.ts`). `read` and `grep` results aren't recorded. You can
  count calls, but to find what grew the context, use the fresh `input`
  tokens in `bySpec`.
- **Session names:** `@level` is the thinking level, `#2` is the second pass
  (files in reverse order), and `(verify)` is a verifier. Result groups strip
  the level, so to tell which level found something, read the session's final
  message in the trace.
- **`progress.json` lists two sessions with the same name** for the second
  pass. Match them by `startedAt`.

### Trace events

Each line has `t`, `reviewer`, `phase` (`review`/`verify`) and `kind`. The
kinds are `start`, `finish` (`ok`, `note`), `tool` (`args`), `tool_result`,
`message`, `progress`, `deadline_warn` (`secondsLeft`, `why`), `harvest`,
`error_retry`, `filter_retry` and `nudge`. This lists how each session ended
and why, in order:

```sh
python3 -c "import json;[print(e['t'][11:19],e['reviewer'].split('/')[-1],e['kind'],{k:v for k,v in e.items() if k not in('t','reviewer','kind')}) for e in map(json.loads,open('trace.jsonl')) if e['kind'] in('deadline_warn','harvest','finish','filter_retry','error_retry','nudge')]"
```

### Triage for an expensive run

1. Run `mr-run-summary` and sort the sessions by billed cost. Usually one
   session dominates.
2. In that session, compare fresh `input` with `cacheRead`. A high fresh
   input means many tool calls or large tool results. Look at its calls per
   turn and its re-reads.
3. Check timeouts in `failedSpecs` and in the finish notes. A session that
   ran to its full time budget usually did so because the straggler cutoff
   never armed, or because a verifier slot timed out and returned nothing.
4. The guards are `readMaxChars`/`readMaxCharsByModel` (the size of one
   result) and `sessionMaxCostUsd` (the whole session). Time limits alone
   don't bound spend, because the fastest model makes the most calls.

## Model quirks (default pool)

- **Kimi K3.1 Pro.** It is the cost driver: about 4 tool calls and ~25k
  fresh tokens per turn. It made 194 calls vs Sonnet's 64 on the same PR and
  re-read the same files 5–7 times. It is fast, so it is rarely the session
  that times out, which is why the time budget never stopped it. `@xhigh`
  performed the same as `@high`.
- **gpt-6.1-sol.** It sends `plan: []` with every progress `done` call, so
  plan updates must not overwrite the plan with an empty one. Commanding
  wording in a prompt ("your tools are now disabled, do not…") triggers the
  gateway's `content_filter`, so keep harvest-style prompts plain (see
  `harvestPrompt`). Its reasoning text doesn't show in traces.
- **gemini-4-argon.** It is slow (355–512s on large diffs) and is usually
  the session that gets cut. It is prone to `content_filter` in verify. With
  too little prodding it answers `[]` after a few tool calls, which is what
  `minReviewToolCalls` addresses.
- **Sonnet 5.5.** It is the fastest and cheapest at catalog price, though
  not once cache is billed. It often finishes before marking plan items done.
- The same model's run time varies 2–5x between runs, so don't tune timing
  constants on one run.

## Environment gotchas

- Sandboxing: AppArmor blocks bwrap/userns on this host, so the sandbox uses
  nono (Landlock). `/tmp` is noexec inside it, so scratch goes in
  `~/.cache/multi-review`.
- ptrace is restricted, so you can't attach to a running pi. Use its
  `progress.json`.
- `pkill -f <pattern>` run from an agent's shell matches and kills that same
  shell. Use `pkill -f 'patter[n]'`.
- Gateway: `https://llm.amd.com/api/models` is public JSON with each model's
  price and `overall_status`. A retry fixes some errors, such as Anthropic's
  400 "thinking … blocks cannot be modified" (a fresh session clears it).
  Only 401/403/404, bad credentials and missing models are final. A
  restricted deployment answers "Deployment … not found", not 403. 8
  concurrent reviews hit `402 prepaid credits required`.
- `pi -p … < /dev/null` without the redirect hangs waiting on stdin. For a
  single-model experiment outside the extension, use
  `pi -p --session-dir $S --model amd-gateway/<id>:<level> "…" < /dev/null`.

## Conventions

- Commit small and often, with conventional-commit subjects
  (`fix(multi-review): …`). The body should say what a real run showed: the
  run directory, the dollars, the counts.
- Every cost or behaviour claim in code comments and in the README cites a
  measured run. Keep doing that, and correct the README when a measurement
  disproves it.
- Never post to GitHub (PR comments, reviews, resolving threads). Draft
  replies locally.

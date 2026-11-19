# pi-subagent

Run pi agents as subagents of Claude Code. The pi agent does the work on
pi's models (the AMD gateway pool, Lemonade); Claude Code dispatches it,
shows it, and gets its answer back.

Two parts:

- **`pi-agent`**, a CLI that runs one pi agent headlessly and prints its
  answer. Usable from any shell or from Claude Code's Bash tool.
- **The `pi-subagent` mod** (`claude-code-mod/`), which makes each pi agent a
  native Claude Code agent type. Claude starts them with the Agent tool like
  `Explore` or `general-purpose`, so they appear in the tasks list, run in
  the background, and open as a transcript, and Claude spends no tokens on
  them.

## Agents

The agent definitions are pi-lite-subagent's Markdown files, so one file
serves pi's own `subagent` tool and Claude Code:

| Scope | Directory |
|---|---|
| user | `~/.pi/agent/agents/*.md` (or `$PI_CODING_AGENT_DIR/agents/`) |
| project | the nearest `.pi/agents/*.md` above the working directory; overrides a user agent of the same name |

```markdown
---
name: explore
description: Read-only codebase search.
tools: read, grep, find, ls        # optional; omitted = every tool
model: amd-gateway/Kimi-K3.1-Pro   # optional; omitted = pi's default model
thinking: high                     # optional
---

You are a read-only search agent. …   (appended to pi's system prompt)
```

`pi-agent list` shows what it finds. `none` (`pi-subagent:pi` in Claude
Code) is pi's default agent with every tool and no extra prompt.

## In Claude Code (the mod)

Each agent becomes `pi-subagent:<name>`, plus `pi-subagent:pi`. Ask for one
by name ("use the pi explore agent to …", "run pi-subagent:reviewer in the
background on this diff"), or let Claude pick from the descriptions, which
start with `[pi · model · tools]`.

- **Tasks list and transcript.** The run shows in the tasks list like any
  subagent. Its transcript holds the task, one notice per pi tool call
  (`→ grep TODO src`), any text pi wrote between calls, a summary line with
  turns, tools, time and billed cost, and the answer.
- **Background.** It works the same way the Agent tool's background mode
  does for other agents.
- **Follow-ups.** A message sent to a finished pi subagent (SendMessage)
  resumes the same pi session, so pi still has its context.
- **Model per task.** A first line `pi-model: provider/id[:level]` in the
  task overrides the agent's model.
- **Interrupting** the subagent kills pi.
- **No Claude tokens.** A `turn.step` hook answers the subagent's model
  requests itself by running `pi-agent run --stream-json`. The agent type
  still has to name a model, so it names `haiku` with one harmless tool.
  Haiku would only run if the mod failed to serve a turn, and then it
  replies that pi didn't run. In a live run (2026-11-19, explore on
  Sonnet 5.5@low), the subagent answered in 3 s with 0 Claude tool calls,
  and a SendMessage follow-up resumed the same pi run.

Agent definitions are read when the session starts. After adding one,
start a new session (or `claude --resume`).

### Install

```sh
ln -s "$PWD/pi-subagent/pi-agent" ~/.local/bin/pi-agent   # the mod runs `pi-agent` from PATH
claude plugin marketplace add "$PWD"                        # once, for the pi-conf marketplace
claude plugin install pi-subagent@pi-conf
```

After editing the mod, run `claude plugin update pi-subagent@pi-conf` and
restart the session.

## From a shell (`pi-agent`)

```sh
pi-agent list
pi-agent run explore -- "Where is the billed cost computed? path:line"
pi-agent run reviewer --model amd-gateway/gpt-6.1-sol:high --task-file brief.md
pi-agent resume ~/.local/share/pi-subagent/runs/<run> -- "And the tests for it?"
```

It prints pi's final answer on stdout, followed by a summary line
(`pi-agent: ok · explore · <model> · 3 turns · grep×2 read×1 · 14s · $0.02 billed`),
the run directory and the session file. The exit code is 0 for ok, 1 when
the run failed or timed out, and 2 for a usage error. `pi-agent --help`
lists the options.

`--timeout` defaults to 540 s, which fits a foreground Bash call in Claude
Code. A timed-out run keeps its session, so you can follow up with
`pi-agent resume <run> -- "Time is up. Report what you found."` to collect
what it had.

Each run directory (`$XDG_DATA_HOME/pi-subagent/runs/<stamp>-<agent>-<id>/`)
holds `meta.json` (agent, model, tools, cwd), `tasks.md` (every prompt sent),
`session/*.jsonl` (the pi session; `pi --session <file>` opens it),
`result.json` (status, turns, tool counts, tokens, catalog and billed cost),
`result.md` (the last answer) and `stderr.txt`.

The billed cost uses multi-review's `cacheMultipliers`
(`multi-review/extension/src/cost.ts`), because models.json prices cache
tokens at $0.

### Nesting

By default the pi agent can't start subagents of its own: `pi-agent` sets
`PI_SUBAGENT_DEPTH`, so pi-lite-subagent doesn't register its `subagent`
tool. `--nesting` lifts that.

`pi-agent` never passes `PI_SUBAGENT_NAME`. With it set, pi-lite-subagent
marks the session "inspection only" and drops every later prompt without
an error, which would break `resume`.

## Tests

```sh
pi-subagent/test.sh                                   # pi-agent; tests/fake-pi.mjs stands in for pi
cd pi-subagent/claude-code-mod && claude plugin test .  # the mod; the test kit stands in for the engine
```

Neither makes network or model calls.

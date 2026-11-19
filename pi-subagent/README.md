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

- **Tasks list and transcript, like a Claude subagent's.** The run shows in
  the tasks list. Its transcript replays pi turn by turn. Each assistant
  message shows its text, preceded by a `∴ Thinking` notice holding pi's
  reasoning. That has to be a notice: Claude Code shows thinking a hook
  streams but records only thinking the model signed. In a live run
  (DeepSeek-V4.1-Flash:high), ~22k characters of streamed thinking were
  missing from the stored transcript, while the notices were kept. Each pi tool call is a
  real tool row with its input and pi's output, for example
  `pi-subagent - grep (pattern: "TODO", path: "src")`. The mod's display
  tools (`mcp__pi-subagent__read`, `grep`, `find`, `ls`, `bash`, `edit`,
  `write`, `web_search`, `web_extract`, and `tool` for any other pi tool)
  run nothing; the mod answers each call with the result pi got. A notice
  gives the pi run directory, and a summary line at the end gives turns,
  tools, time and billed cost.
- **Background.** It works the same way the Agent tool's background mode
  does for other agents.
- **Follow-ups.** A message sent to a finished pi subagent (SendMessage)
  resumes the same pi session, so pi still has its context.
- **Model per task.** A first line `pi-model: provider/id[:level]` in the
  task overrides the agent's model.
- **Interrupting** the subagent kills pi.
- **No Claude tokens.** pi runs detached (`pi-agent start`) and appends
  each message and tool result to `<run>/events-<n>.jsonl`. A `turn.step`
  hook answers each of the subagent's model requests with pi's next
  message. Hooks wait for pi inside a `pi-agent wait` child, because a
  hook's own code gets only 10 s but time spent in a `$` call doesn't
  count. The agent type
  still has to name a model, so it names `haiku` with one harmless tool.
  Haiku would only run if the mod failed to serve a turn, and then it
  replies that pi didn't run. In a live run (2026-11-19, explore on
  Sonnet 5.5@low), the subagent answered in 3 s with 0 Claude tool calls,
  and a SendMessage follow-up resumed the same pi run.

Agent definitions are read when the session starts. After adding one,
start a new session (or `claude --resume`). The same goes for installing
the mod: a session started before the install has no `pi-subagent:*`
types until it is restarted or resumed (`/plugin` doesn't load a new
plugin's hooks into a running session). Without them Claude may fall back
to `pi-agent run` through Bash, which works but shows no tasks-list entry
or transcript. When Claude Code runs `pi-agent run` that way, it prints a
note on stderr naming the agent type to use and saying how to load the mod.

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

`start`, `wait` and `stop` are what the mod uses. `start` runs `run` or
`resume` detached and prints `{ runDir, events, pid }`. `wait` blocks until
the events file has the next message (or one tool's result) and prints it.
`stop` ends the run.

`run` and `resume` print pi's final answer on stdout, followed by a summary line
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

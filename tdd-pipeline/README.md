# TDD Pipeline — design doc

A stateful pi extension that automates the **plan → tests → green → verify**
loop, while leaving every phase interruptible by hand.

## TL;DR

You paste a feature. You answer a Socratic interview. While you answer, the
extension quietly swaps models and injects the next phase's prompt the moment
the current one finishes. You can type, point, scold, redirect, or pause at any
moment — the automation just stops on top of you.

```
/build <feature>
   ↓  sets state entry in session, switches to GPT-5.5 high
/grill <feature>             ← you drive this interactively
   ↓  auto-detected when grill-me's checkpoint is approved
write failing tests           ← GPT-5.5 medium, scoped to approved plan
   ↓  detected when last assistant message contains "Test Command: ..."
loop until green              ← Fireworks deepseek-v4-pro @ xhigh thinking
   ↓  detected when last assistant message contains "Status: Green"
verify                        ← status widget shows "ready for review"
```

## Why no subagents

Subagents are great for context isolation but bad for *interruptibility*. When
the green loop is misbehaving, you want to type "stop changing that signature"
and have it land directly. A subagent would force you to either abort the whole
process or wait for it to finish — neither is what you want for a daily-driver
TDD workflow.

The cost of *not* isolating: an iced-over context once the green loop has
spammed you with 40 turns of pytest output. Mitigation:

- We `pi.sendUserMessage("Continue, but keep diffs small", { deliverAs: "steer" })`
  when context grows past a threshold — steers interrupt the agent cleanly.
- The phase-injection prompts instruct the model to summarize state at the
  start of every response, keeping token usage bounded.
- When green is reached, `/compact` is recommended to the user.

## State machine

```
                /build <feature>
IDLE ─────────────────────────────► PLAN_PENDING
                                       │  sets model: openai/gpt-5.5
                                       │  sets thinking: high
                                       │  injects: /grill <feature>
                                       ▼
                              PLAN_READY  ◄── auto when grill-me state entry
                                            has approvedOutputPlan
                                       │  sets model: openai/gpt-5.5
                                       │  sets thinking: medium
                                       │  injects: scope & write tests
                                       ▼
                              TEST_READY  ◄── auto when assistant message
                                            contains "Test Command:"
                                       │  sets model: fireworks deepseek-v4-pro
                                       │  sets thinking: xhigh
                                       │  injects: iterate to green
                                       ▼
                              IMPL_DONE   ◄── auto when assistant message
                                            contains "Status: Green"
                                       │  status widget: "ready for review"
                                       ▼
                              VERIFY
```

Each arrow is a phase transition. Transitions are *attempted* — any user
message between them cancels the transition until you hit `/build-next`
explicitly. So if you start typing `"actually the test file should live in
tests/integration/..."` mid-automation, the extension waits for that to
resolve before advancing.

## Commands

| Command | Effect |
|---------|--------|
| `/build <feature>` | Start the pipeline. Sets state, switches to plan phase. |
| `/build-status` | Show current phase, model, thinking level, what triggered, what's next. |
| `/build-next` | Manually advance to the next phase regardless of detectors. |
| `/build-pause` | Stop all automation. Phase stays put until `/build-next`. |
| `/build-reset` | Clear state. Next `/build` starts fresh. |
| `/build-model <provider/id>` | Override the model for the **current** phase only. |

Every command is optional. The default happy path needs only `/build` and your
grill answers.

## Why this works inside pi (not outside it)

- **`pi.setModel()` / `pi.setThinkingLevel()`**: programmatic model cycling.
  See `docs/extensions.md` → "ExtensionAPI Methods".
- **`pi.sendUserMessage()` + `deliverAs: "followUp"`**: injects a real user
  message that triggers a turn. Lets us kick off phase 2 / 3 without the user
  typing.
- **`pi.appendEntry(customType, data)`**: state persists across reloads and
  shows up in `/tree` so you can rewind if a phase went sideways.
- **`ctx.ui.setStatus()`**: footer widget always shows current phase.
- **`agent_end` event**: lets us attempt phase transition at exactly the right
  moment.

If you read the references above, you can rewrite this whole thing as a skill
or a smaller tool — but a stateful extension is the right shape because we
need to react to events and drive model changes that prompt templates can't.

## Jump-in semantics

When you type mid-pipeline:

1. `pi` clocks your message in the input event handler.
2. If we were about to auto-advance, we cancel it (the last entry is your
   message + our button-press attempt).
3. Your message lands normally — `steer` while streaming, plain when idle.
4. The phase stays where it is. The status widget reflects "paused — user
   activity detected".
5. When you stop typing and the agent is idle again, you can hit `/build-next`
   or just keep directing the agent — phase advances only happen on explicit
   signal after this.

This means: if the green model is hallucinating API signatures, you just type
"check src/api/auth.ts line 42" and steer it. Zero special-casing needed.

## Files

```
pi-conf/tdd-pipeline/
├── README.md                ← this file (design + how it works)
├── install.md               ← install + verify steps
├── extension/
│   └── index.ts             ← the extension code, drop-in
└── examples/
    └── session-transcript.md ← annotated example of a real run
```

## Configuration the extension assumes you have

Already true in your environment per `~/.pi/agent/models.json`:

- `fireworks` provider with `accounts/fireworks/models/minimax-m3` and
  `accounts/fireworks/models/deepseek-v4-pro` listed (`reasoning: true`)
- Fireworks API key present (env `FIREWORKS_API_KEY` or `auth.json`)
- OpenAI API key present (env `OPENAI_API_KEY` or `auth.json`)

Already installed (or trivial to install):

- `@majorgilles/pi-grill-me` (npm package, install via `pi install npm:@majorgilles/pi-grill-me`)

## Extension required

If you don't already have `examples/extensions/subagent/` installed, that's
fine — this pipeline does not use subagents. But if you want to add optional
subagent steps later (e.g. parallel reviewer after green), install the
subagent extension. It is independent of this one.

## Failure modes the extension handles

| What goes wrong | What happens |
|-----------------|--------------|
| `/build` while a build is already running | Asks for confirmation, then resets. |
| `setModel()` fails (no API key) | Stops pipeline, surfaces error in status widget. |
| Grill-me never reaches output phase | Pipeline never auto-advances past PLAN_PENDING. Hit `/build-next` to skip grill and proceed with whatever plan you wrote yourself. |
| Test authoring model goes off-script | Auto-detection of "Test Command:" misses, phase stalls. Hit `/build-next` to advance manually. |
| Green loop spins forever | Detection misses "Status: Green". Hit `/build-next` when you decide it's done; or `/build-pause` to take over the wheel yourself. |
| You want to abandon the build | `/build-reset` wipes state. |

The principle: **auto-advance is a convenience, never a gate.** Anything the
detectors miss, the manual commands handle.

## Why this answer is "an extension" not "a skill"

Skills are markdown. They can't:
- Switch models programmatically
- Persist state across turns
- React to session events
- Inject prompts as user messages
- Show status widgets

Prompts do template expansion but the model itself has to "play the orchestrator"
which is unreliable once the conversation goes long (compaction or distraction).
Extensions are deterministic — they enforce the transitions.

## When to swap to subagents instead

If you find yourself wanting to fire off multiple features in parallel and not
be in the loop for any of them, *then* port this to subagents (the existing
`examples/extensions/subagent/` is the right base). Today, you want the loop
interactive, so the main session wins.

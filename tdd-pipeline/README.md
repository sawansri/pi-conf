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
                /build <feature> [--autonomous]
IDLE ─────────────────────────────► PLAN_PENDING
                                       │  planner model + thinking
                                       │  injects: /grill <feature>
                                       ▼
                              PLAN_READY  ◄── detector: grill-me state entry
                                                 has approvedOutputPlan
                                       │  with --autonomous: auto-advance
                                       │  without: notify, user /build-next
                                       ▼
                              TEST_READY  ◄── detector: last assistant message
                                                 contains "Test Command:"
                                       │  with --autonomous: auto-advance
                                       │  without: notify, user /build-next
                                       ▼
                              IMPL_DONE   ◄── detector: last assistant message
                                                 contains "Status: Green"
                                       │  verify phase: read-only investigation
                                       ▼
                              VERIFY      ◄── terminal, user reviews
```

**Auto-advance defaults to OFF** (`state.autonomous` is `false` in `defaultState()`
unless flipped by `--autonomous`, the toggle, or `tdd-pipeline.json`). When
off, each phase boundary produces a notification — *you* run `/build-next`
when you're ready, `/build-continue "..."` to push, or `/build-rewind` to
retry. When on, detectors directly call `attemptAdvance(...)` and the
pipeline progresses without intervention.

This default is deliberate: phase boundaries are the right place to add
clarifying context ("the auth scheme is OAuth, not session tokens"), correct
scope ("tests should live in `tests/integration/`"), or pivot strategy.

Each arrow is a phase transition. Any user message between them cinches the
session, and the next `agent_end` only acts *if* the assistant's *current*
response satisfies the detector *and* the build is autonomous. If you're in
manual mode, detector satisfaction prints a one-line notification; nothing
else changes.

## Commands

| Command | Effect |
|---------|--------|
| `/build <feature> [--autonomous]` | Start the pipeline. `--autonomous` flips auto-advance ON for this build (default OFF). |
| `/build-status` | Show current phase, model, thinking level, autonomous flag, transitions count. |
| `/build-next` | Manually advance to the next phase regardless of detectors. |
| `/build-continue [nudge]` | Re-inject the current phase's prompt *without advancing*. Use when the agent stopped without finishing, or to push the loop forward without bumping to verify. Optional `nudge` text is appended. |
| `/build-pause` | Hard-pause: no completion-driven notifications, no auto-advance. Stays put until `/build-next`. |
| `/build-autonomous` | Toggle auto-advance for the current build. |
| `/build-rewind` | Tree-navigate back to the entry where the current phase started. `/tree` then shows the abandoned branch as a *summarized* entry. Then `/build-continue` re-fires the phase prompt. |
| `/build-reset` | Clear state. Next `/build` starts fresh. |
| `/build-model <provider/id>` | Override the model for the **current** phase only. |
| `/build-models <phase>=<provider/id>[@thinking] …` | Override model + thinking for one or more phases *in one atomic commit*. Validates every spec against `ctx.modelRegistry.find()` and the thinking enum *before* writing any state. |

Every command is optional. The default happy path needs only `/build`, your
grill answers, and one `/build-next` per phase boundary.

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

## Progressing within a phase (without advancing)

The implementation phase is a long loop; the model usually stops short of green
or wanders. Two commands give you fine-grained control *without* jumping to
verify:

- **`/build-continue`** — re-injects the current phase prompt as a fresh user
  message, via `deliverAs: "followUp"`. The phase state does NOT change. The
  model picks up where it left off (with the prompt as nudge-in-context). Use
  this when the agent stopped without finishing, or after you've steered it
  off-track and want to remind it of the goal.
- **`/build-continue "stop touching the schema, focus on validation"`** —
  any text after `/build-continue` is appended to the phase prompt as a
  *User nudge*: section, so the model gets both the original directive and
  your override.

The phase prompt itself is recorded in `state.currentPhasePrompt` at every
phase transition, so `/build-continue` always remembers what was being asked.

## Rolling back within a phase (tree integration)

pi's session tree holds every user / assistant / tool entry. The pipeline
*remembers where each phase began* via `state.phaseAnchorEntryId` — captured
the moment before we inject the phase's first user message.

`/build-rewind` uses pi's `ctx.navigateTree(targetId, { summarize: true,
label: "rewind-<phase>" })` to:

1. Match-state the conversation back to a sustainable re-entry point
   (everything from the current phase is summarized into one entry).
2. Keep the abandoned work accessible via `/tree` — pick the `rewind-<phase>`
   branch to read the summary.
3. Pipeline state stays unchanged — after rewind, hit `/build-continue` and
   the phase prompt is re-fired against the truncated context.

This is the right tool when:
- The implementer made an architectural mistake and you want to start over
  in this phase but keep the plan and tests.
- The green loop overfit to a wrong approach and you're stuck in a bad
  basin — rewind to before it started over-correcting.

It's NOT the right tool for:
- Mild mid-phase tweaks. Use `/build-continue "..."` for those.
- Wanting to abandon the whole build. Use `/build-reset`.

You can also use pi's native `/tree` command directly without the wrapper.
The extension just makes the "rewind to phase start" action one keystroke.

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

## Adding newer Codex models (gpt-5.5, gpt-5.6, …)

OpenAI ships new Codex-hosted models faster than pi's bundled
`models.generated.js` updates. Symptoms: `/model` doesn't list `gpt-5.5`,
so `setModel()` fails and the pipeline halts on phase switch.

The plugin that's already in your pi (v0.68.1) tops out at `gpt-5.4` /
`gpt-5.4-mini` on the `openai-codex` provider. To use newer Codex models
today, drop them into `~/.pi/agent/models.json` — pi merges your overrides
into built-in providers without replacing them:

```json
{
  "providers": {
    "openai-codex": {
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5 (ChatGPT Plus via Codex)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "cost": { "input": 1.25, "output": 10, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "gpt-5.5-codex",
          "name": "GPT-5.5 Codex",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "cost": { "input": 1.25, "output": 10, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

After `/reload` (or restart), `openai-codex/gpt-5.5` appears in `/model`.
Whether the ChatGPT Plus OAuth route returns a usable token for a given
model id depends on OpenAI's rollout. Try the ids; the working one stays.

Same pattern for future models (gpt-5.6, gpt-6, etc.) and for any
non-Codex provider — see `docs/models.md` → "Overriding Built-in
Providers" and the `merge semantics` block: built-ins are kept;
custom entries are upserted by `id`.

## Configuration the extension assumes you have

Already true in your environment per `~/.pi/agent/models.json`:

- `fireworks` provider with `accounts/fireworks/models/minimax-m3` and
  `accounts/fireworks/models/deepseek-v4-pro` listed (`reasoning: true`)
- Fireworks API key present (env `FIREWORKS_API_KEY` or `auth.json`)
- OpenAI API key present (env `OPENAI_API_KEY` or `auth.json`)

Already installed (or trivial to install):

- `@majorgilles/pi-grill-me` (npm package, install via `pi install npm:@majorgilles/pi-grill-me`)
- `@calesennett/pi-codex-usage` (recommended companion — live Codex 5h/7d
  footer; install via `pi install npm:@calesennett/pi-codex-usage`, see
  `install.md` → "Optional companions")

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
| Green loop wanders or stops without finishing | `/build-continue ["nudge"]` to re-inject the phase prompt without advancing. |
| Implementation went badly, want to retry *just* this phase | `/build-rewind` reverts the session tree to the start of the current phase; `/build-continue` then re-fires the phase prompt. |
| Auto-detection of "Status: Green" misses | Hit `/build-next` to advance manually, or `/build-pause` then `/build-reset` to abandon this build. |
| You want to abandon the build | `/build-reset` wipes state. |

The principle: **detectors are a convenience, never a gate.** Anything the
detectors miss, the manual commands handle. `/build-next` advances, even
with no detector fire. `/build-continue` is for progression-in-place,
`/build-rewind` is for rollback-in-place, and `/tree` (native) gives you
arbitrary jumps if those two don't suffice. Manual mode (the default)
simply makes the convenience off until you opt in.

## Per-phase model control

Two layers, both ends of the spectrum from "set once and forget" to "set all
three in one keystroke".

### `~/.pi/agent/tdd-pipeline.json` — persistent defaults

Drop a JSON file at `$PI_CODING_AGENT_DIR/tdd-pipeline.json` to override the
in-code defaults for every fresh build. Loaded once at first `defaultState()`
call (then cached for the lifetime of the extension; `/reload` re-reads).
Unknown fields and bad JSON fall back to in-code defaults silently — malformed
files never break the pipeline.

```json
{
  "plannerModel": "openai-codex/gpt-5.5",
  "plannerThinking": "high",
  "testerModel": "openai-codex/gpt-5.4-mini",
  "testerThinking": "medium",
  "implementerModel": "fireworks/accounts/fireworks/models/glm-5p2",
  "implementerThinking": "xhigh"
}
```

Recognized fields: `plannerModel`, `plannerThinking`, `testerModel`,
`testerThinking`, `implementerModel`, `implementerThinking`.
Thinking values: `off | minimal | low | medium | high | xhigh`. Anything else
is ignored.

### `/build-models <spec>…` — atomic multi-phase override

Phase aliases: `plan | planner`, `test | tester`, `implement | impl |
implementer`. Spec format: `phase=provider/model[@thinking]`. Multiple
tokens separated by spaces. Either the model or the `@thinking` part is
optional; the unchanged field keeps its previous value.

```
> /build-models impl=fireworks/accounts/fireworks/models/glm-5p2@xhigh
> /build-models planner=openai-codex/gpt-5.5@high tester=glm-5.4-mini@medium
> /build-models planner=gpt-5.5@high tester=gpt-5.4-mini@medium impl=glm-5p2@xhigh
```

Validation runs on every spec *before* any state mutation:

| Check | Behavior on fail |
|---|---|
| phase alias recognized | Token is silently skipped |
| model has `provider/id` shape | Continue, error reported at commit time |
| `ctx.modelRegistry.find(provider, id)` returns a non-null Model | Error reported, commit aborted |
| thinking value in enum | Error reported, commit aborted |
| any spec fails validation | **All specs rejected; zero state mutated** |

On all-pass: writes `state.{phaseModel, phaseThinking}` for each, refreshes
the status widget, prints the applied changes.

Live cycle:

```
> /build add /healthz endpoint              # uses tdd-pipeline.json then
                                            #   in-code defaults as fallback
> /build-status                            # Phase: plan · openai-codex/gpt-5.5@high
> /build-models impl=minimax-m3@xhigh       # override, BEFORE the implementer phase
> /build-status                            # ...Implementer: fireworks/.../minimax-m3@xhigh
```

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

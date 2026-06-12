# Install

## Prereqs (you already have these per your `~/.pi/agent/`)

- `fireworks` provider in `~/.pi/agent/models.json` with these reasoning-capable models:
  - `accounts/fireworks/models/minimax-m3`
  - `accounts/fireworks/models/deepseek-v4-pro`
- `openai` provider reachable (GPT-5.5 family).
- API keys:
  - `OPENAI_API_KEY` (env or `~/.pi/agent/auth.json`)
  - `FIREWORKS_API_KEY` (env or `~/.pi/agent/auth.json`)

If any are missing, set them first. `pi --list-models` should show them as
available.

## 1. Install grill-me

```bash
pi install npm:@majorgilles/pi-grill-me
```

If you'd rather scope it locally instead of globally:

```bash
pi install --local npm:@majorgilles/pi-grill-me
```

After install, `/grill <topic>` should be available.

## 2. Drop the pipeline extension

Copy the extension into your user extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/tdd-pipeline
cp /home/sawan/Projects/pi-conf/tdd-pipeline/extension/index.ts \
   ~/.pi/agent/extensions/tdd-pipeline/index.ts
```

Then either restart `pi` or hit `/reload` inside it.

Verify:

```
/build-status
```

Should print "No active build." That's the success case.

Also verify the model-setter works by listing:

```
:help /build
```

or just type `/build` and you should see autocomplete with the description.

## 3. Optional: pin Fireworks thinking to a level that works

Reasoning-capable Fireworks models accept `reasoning_effort` ∈ {low, medium,
high}. `xhigh` is not always honored on Fireworks. If you want to be safe,
edit the `defaultState()` in `index.ts` and set `implementerThinking: "high"`.
Or override per-run with `/build-model fireworks/accounts/fireworks/models/deepseek-v4-pro`
*before* entering implement phase (the phase already started, it re-applies
the model).

Or, more permanently, add a `compat.reasoningEffortMap` in `models.json`:

```json
{
  "providers": {
    "fireworks": {
      "modelOverrides": {
        "accounts/fireworks/models/deepseek-v4-pro": {
          "compat": {
            "reasoningEffortMap": {
              "off": "low",
              "low": "low",
              "medium": "medium",
              "high": "high",
              "xhigh": "high"
            }
          }
        }
      }
    }
  }
}
```

This collapses pi's "xhigh" to Fireworks' "high", avoiding 400s.

## 4. Optional: choose a different implementer model

Default is `fireworks/accounts/fireworks/models/deepseek-v4-pro` because it's
strong on coding tasks. To swap:

- Once during install: edit `defaultState()` in `index.ts`.
- During a run: `/build-model fireworks/accounts/fireworks/models/minimax-m3`
  while in implement phase.

You can also add `kimi-k2.6` etc. to your `models.json` if your account lists
them, then `/build-model fireworks/<that-id>` at runtime.

## 5. Verify the full loop manually (one sanity run)

```
/model openai/gpt-5.5
/build        ← type without args to see usage hint, then Ctrl+C
/build add a /healthz endpoint that returns {"ok": true}
```

Then drive the grill interview to "tests + impl plan" output. Once you answer
"yes proceed":
- Status widget should show `build:Test · ...`
- Worst case: detector misses, status stays on plan; type `/build-next`
- Test phase finishes its message with "Test Command: …" → auto-advance fires
- Implement phase runs autonomously; final "Status: Green" auto-advances
- Verify phase shows diff summary

## Failure recovery cheat-sheet

| Symptom | What to do |
|---------|-----------|
| Status widget stuck on phase | `/build-next` |
| Wrong model picked | `/build-model <provider/id>` |
| Got bored of automation | `/build-pause`, drive yourself |
| Want to throw it all away | `/build-reset` |
| Context feels big after green | Hit `/compact` |
| Need to see the approved grill plan | `/checkpoint edit` (grill-me command) |
| Need to see exactly what tests were written | `read` the test files — the test phase wrote them |

## Uninstall

```bash
rm -rf ~/.pi/agent/extensions/tdd-pipeline
```

No background processes, no global state damage. `models.json` left untouched.

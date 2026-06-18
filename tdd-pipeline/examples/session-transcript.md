# Example session

Annotated transcript of a real run. `>` is what the user typed. `#` are
comments explaining extension behaviour. Default mode is **manual** —
detector firings print a notification, you run `/build-next` to advance.

```text
pi v0.68.1
> /build add /healthz endpoint that returns {"ok": true}

# extension: loadState() → none. Sets state phase=plan, feature=...,
# autonomous=false (default), saves currentPhasePrompt + phaseAnchorEntryId.
# extension: setModel(openai-codex/gpt-5.5) + setThinkingLevel("high")
# extension: sendUserMessage("/grill add /healthz endpoint...")
# Status widget: build:Plan · openai-codex/gpt-5.5 (manual)

> What's the framework Express/Fastify/Hono or something else?

# grill-me drives the Socratic interview.
> Fastify
> Yes, the endpoint should be unauthenticated
> Test plan + implementation plan

# Extension: agent_end fires. isPlanApprovedByGrillMe() matches.
# Because state.autonomous === false, the extension does NOT advance.
# It prints a notification instead.
# Status widget unchanged: build:Plan (manual).

> Plan looks approved by grill-me. Phase plan → test boundary —
> /build-next to advance (or /build-continue "…" to push,
> /build-rewind to retry).

> (you actually have a question about Fastify auth middleware before
> letting tests be authored)
> actually — make sure the test suite uses supertest-fetch against the
> real listener, not a fake mongo mock

# steer — agent runs, still hasn't produced a "Test Command:" line so
# nothing further happens.

> /build-next

# Manual advance: logTransition(state, "test"), switch to tester model,
# inject the test-authoring prompt. Anchor captured for /build-rewind.
# Status widget: build:Test · openai-codex/gpt-5.4-mini (manual)

> (assistant writes tests)
> ## Test Command
> `npx vitest run tests/healthz.test.ts`
>
> ## Files Created
> - tests/healthz.test.ts — asserts GET /healthz returns 200 + {"ok": true}
>
> ## Expected Failure Summary
> - healthz.test.ts:12 — `expected 200, got 404`

# Extension: agent_end fires. isTestAuthored() matches "Test Command:".
# Manual mode → notify, do NOT advance.

> Tests have been authored. Phase test → implement boundary —
> /build-next to advance.

> (you skim the test file — looks good)

> /build-next

# Manual advance: state→implement. Switch to fireworks glm-5p2 @ xhigh
# (or whatever implementerModel is locked in). Inject the green-loop prompt.
# Status widget: build:Implement · fireworks/.../glm-5p2 (manual)

> (assistant runs tool: bash, edit, bash, edit, ... many cycles)
$ vitest run tests/healthz.test.ts
 FAIL  tests/healthz.test.ts
   × healthz › returns ok
     expected 200, got 404

edit src/server.ts
+ app.get('/healthz', async () => ({ ok: true }))

$ vitest run tests/healthz.test.ts
 PASS  tests/healthz.test.ts

$ npm test
... all green

> ## Status: Green
>
> ## Files Changed
> - src/server.ts — added /healthz handler
> - tests/healthz.test.ts — new test file
>
> ## Remaining Risks
> None.

# Extension: agent_end fires. isImplementationGreen() matches.
# Manual mode → notify.

> Implementation reports green. Phase implement → verify boundary —
> /build-next to advance.

> /build-next

# Manual advance: state→verify. Switch to a careful reviewer model.
# Status widget: build:Verify (manual)

> (assistant runs read-only investigation)
> ## Verification
>
> Test command final run: PASS
> git diff --stat:
>   src/server.ts        | 3 +++
>   tests/healthz.test.ts | 18 +++++++++++++++
>
> Wider suite: green.
>
> Summary: Fastify /healthz returns {"ok": true}, unauthenticated, scoped
> to the approved plan. Risk: none surfaced.

# Status widget stays on Verify. User looks at the diff and runs `npm test`
# themselves. When done:
> /build-reset
```

What the user typed explicitly:

- `> /build add /healthz endpoint…`
- 4 grill answers (3 from grill-me + 1 mid-pipeline steer)
- 4 advances: `/build-next × 4` (plan→test→implement→verify, after detector notifications)
- `/build-reset`

If the user had instead run `/build <feature> --autonomous`, **all four
`/build-next`s disappear** — the extension handles every phase transition
silently and the user just reviews the final verify output.

## Switching to autonomous mid-build

```
> /build add /healthz endpoint…          # status: build:Plan (manual)
# … you drive through plan
> /build-autonomous                      # status flips to (auto)
# From this point on detector firings call attemptAdvance(...) directly.
> (rest of the build runs unattended)
```

Or persisted across all builds:

```bash
cat > ~/.pi/agent/tdd-pipeline.json << 'EOF'
{ "autonomous": true }
EOF
# /reload
```

## Mid-impl digression (with /build-continue)

The fireworks implementer stalls on a weird vitest config error for two
turns. Rather than advance, you push it:

```
> /build-continue stop reading vitest config from vite.config.ts; the
> project uses vitest.config.ts. Re-run the failing test.
```

Extension behaviour: re-injects `currentPhasePrompt` (the original
"You are the TDD green step…" directive) followed by the appended
`User nudge:` line, via `deliverAs: "followUp"`. Phase stays `implement`.
Auto/manual flag unchanged.

## Mid-impl reversal (with /build-rewind)

Five turns into the green loop, the implementer picked a bad abstraction.
You want a fresh start without losing the plan and tests:

```
> /build-rewind
? Rewind current phase? … [confirm]
# Extension: ctx.navigateTree(state.phaseAnchorEntryId,
#   { summarize: true, label: "rewind-implement" })
# Session collapses the abandoned implement work into a single summary
# entry labeled "rewind-implement" — visible in /tree.
# Pipeline state stays at implement, prompt + anchor preserved.

> /build-continue
# Extension re-fires the original implementer prompt against the
# truncated context (plan + tests intact).
```

## Bail-out at any step

```
> /build-pause
# Hard-pause: no completion-driven notifications, no auto-advance
# interactions. Status widget shows "(paused)". Stays put until
# /build-next or /build-resume... wait, there's no /build-resume.
# Just /build-next to advance manually, or /build-reset.

> /build-model fireworks/accounts/fireworks/models/minimax-m3
# Swap current phase's model live. /build-models covers multi-phase overrides.

> /build-models impl=glm-5p2@xhigh
# Atomic multi-phase override. Validates every spec, commits all at once.
```

Mid-impl jump-in works in either mode because you can just type a message
and pi routes it as `steer`/`followUp` — the next `agent_end` only acts
*if* the assistant's *current* response satisfies a detector *and* the
build is autonomous.

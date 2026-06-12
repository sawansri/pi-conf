# Example session

Annotated transcript of a real run. `>` is what the user typed. `#` are
comments explaining extension behaviour. Bolded text is the extension's
`/build` family output.

```text
pi v0.68.1
> /build add /healthz endpoint that returns {"ok": true}

# extension: loadState() → none. Sets state phase=plan, feature=...
# extension: setModel(openai/gpt-5.5) + setThinkingLevel("high")
# extension: sendUserMessage("/grill add /healthz endpoint...")
# Status widget: build:Plan · openai/gpt-5.5

> What's the framework Express/Fastify/Hono or something else?

# grill-me drives the Socratic interview.
> Fastify
> Yes, the endpoint should be unauthenticated
> Test plan + implementation plan

# Extension observes grill-me has approved output plan (phase=output). It:
#  - logTransition(state, "test", ...)
#  - saveState(...)
#  - setStatusWidget("build:Test · openai/gpt-5.5")
#  - setModel(gpt-5.5) + setThinkingLevel("medium")
#  - sendUserMessage("You are the test author...")
# Status widget flips to build:Test.

> (assistant message)
# Below is what the assistant writes — the test command line is the
# trigger for the next auto-advance.
# 
# ## Test Command
# `npx vitest run tests/healthz.test.ts`
# 
# ## Files Created
# - tests/healthz.test.ts — asserts GET /healthz returns 200 + {"ok": true}
# 
# ## Expected Failure Summary
# - healthz.test.ts:12 — `expected 200, got 404`

# Extension: agent_end fires. isTestAuthored() matches "Test Command:".
# It: logTransition("implement") → saveState → setWidget →
# setModel(fireworks/deepseek-v4-pro) + setThinkingLevel("xhigh") →
# sendUserMessage("You are the TDD green step...")
# Status widget: build:Implement · fireworks/accounts/fireworks/models/deepseek-v4-pro

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

# Extension: agent_end fires. isImplementationGreen() matches "Status: Green".
# Transitions to verify. Model switches back to gpt-5.5 @ medium
# (uses testerModel/Thinking) because the verify phase wants a careful
# reviewer, not the implementer.
# Status widget: build:Verify.

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

# Status widget stays on Verify. User reviews. When done:
> /build-reset
```

Everything after `/build` is either grill-me or the extension driving the
next phase. The user types only:
- `> /build add a /healthz endpoint...`
- 3 grill answers
- `/build-reset`

To bail out at any step:
- `> actually skip grill, just write the plan yourself`
  → then `/build-next` → goes straight to test phase.
- `> /build-pause`
  → no more auto-advance; you drive the model yourself.
- `> /build-model fireworks/accounts/fireworks/models/minimax-m3`
  → swap implementer; current and future implement phases use it.

Mid-impl jump-in works because you just type a message and pi routes it.

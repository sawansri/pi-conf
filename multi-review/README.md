# Multi-Review

Multi-model code review where **your main agent is the lead reviewer**.
Reviewers are other model families from your pi registry; they run in
parallel with read-only repo access, and their findings come back to the
main agent, which judges them with the conversation context they lack.
Optionally checks the implementation against a **spec file**. Design
borrows from pstack's `/interrogate` (intent-first briefs, evidence-required
findings, lead-judgment buckets).

## What it does

1. `/multi-review [--spec=path] [args]` hands the task to the main agent.
2. The agent looks at the change (and reads the spec), then writes the
   reviewer **brief**: an intent paragraph, the spec's checkable
   requirements, related files to read in full, and focus areas. Reviewers
   don't see the conversation, so the brief has to carry it.
3. The agent calls the `multi_review` tool. N reviewers run in parallel as
   nested pi agents with `read`/`grep`/`find`/`ls` only, each with a
   timeout. Their JSON findings are grouped into issues by a fast semantic
   clustering pass, which gives per-issue consensus counts.
4. The tool result (rendered as a collapsible review panel) goes back to
   the agent with lead-judgment instructions. The agent verifies the
   findings and replies with **Intent · Reviewers · Spec conformance ·
   Act On · Consider · Noted · Dismissed · Agreement Map**. It does not
   apply fixes unless you ask.

`--direct` (and print/RPC modes, which have no agent turn to hand off to)
skips the agent: the extension runs the pipeline itself and an external
judge model writes the synthesis.

## Invocation surface

| Surface | How |
|---------|-----|
| Slash command | `/multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number \| free-text focus]` |
| Slash command | `/multi-review-pick`: open the multi-select TUI picker to choose reviewer models from your registry (optionally saved to `multi-review.json`) |
| LLM-callable tool | `multi_review({intent?, spec_path?, requirements?, suspicions?, context_files?, focus?, scope?, pr_number?, verify?, quick?})`. The agent can call it on its own too |

Tool parameters:

| Param | Meaning |
|-------|---------|
| `intent` | What the change must accomplish, plus facts reviewers can't find in the repo (external API behaviour, constraints, out-of-scope items). Goals, not a narration of the implementation. Reviewers challenge the execution, not the intent. |
| `spec_path` | Repo-relative spec/design doc, passed to reviewers verbatim as the source of truth (60k char cap). |
| `requirements` | Checkable requirements, one per item. Reviewers report unmet ones as category `spec`. |
| `context_files` | Up to 12 paths reviewers get in full (callers, types, tests). |
| `focus` | Risk **areas** ("config-file merge lifecycle"), never hypotheses. A hint layered on the diff; it never replaces the diff. |
| `suspicions` | The lead's own bug hypotheses (≤ 20). **Never shown to reviewers.** They're matched against what reviewers find independently and, with `verify`, cross-checked by verifiers. |
| `scope` | `diff` (default: working tree vs default branch, or the PR) or `area` (no diff; review what `focus` describes). |
| `pr_number` | As for the slash command. |
| `verify`, `quick` | Same as `--verify` / `--quick`. |

Argument autocompletion completes only the token you're typing (`--spec=`,
`--verify`, `--quick`, `--direct`, `#`) and keeps what's already typed.

If the configured reviewer pool is empty AND the agent has UI access,
`/multi-review` opens the picker as a fallback. You can save the choice to
`multi-review.json` or use it for the current run only (transient
override, never touches the file).

## Brief discipline: what reviewers are told

The brief is specific about **facts** and vague about **where the bugs
are**:

- **Tell reviewers:** requirements (a checklist from the spec), facts
  outside the repo (for example "pi's `models.json` supports `${NAME}`
  interpolation"), constraints, and what's out of scope. Without these,
  reviewers miss real bugs or invent wrong ones.
- **Don't tell them** the lead's hypotheses ("does `--mcp,!--no-mcp`
  compile?", "is maxTokens == contextWindow valid?"). Hypotheses anchor
  every reviewer on the same spots. "Found by 3 reviewers" then measures
  the prompt rather than independent discovery, and the author's blind
  spots get copied into the reviewers'. The intent describes goals rather
  than the implementation, for the same reason: reviewers should verify
  what the code does, not take it as given.

The lead's hypotheses go in `suspicions` instead. The grouping call matches
each one against the independent findings, and `--verify` sends them to
verifiers as claims of their own. The result has a **Lead suspicions**
section and panel lines like:

```
lead suspicions: 1/2 raised independently
  s1: The expiry comparison in get() is inverted … ✓ g1 ✓2 ✗0 ?0
  s2: Deleting from the Map while iterating … skips entries · not raised ✓0 ✗2 ?0
```

A suspicion raised independently is the strongest signal there is. One
that nobody raised is either wrong (s2 above: both verifiers refuted it,
and the lead dismissed its own hypothesis) or a shared blind spot, and the
verifier evidence or the lead's own reading decides which.

## Using it from other harnesses (Claude Code, scripts, CI)

The review engine runs headless, so any harness that can run a shell
command can be the lead reviewer:

```bash
pi -p "/multi-review-run --brief=brief.json --out=/tmp/mr/result.json" < /dev/null
```

- **Input:** `brief.json` has the same fields as the `multi_review` tool
  (`intent`, `spec_path`, `requirements`, `suspicions`, `context_files`,
  `focus`, `scope`, `pr_number`, `verify`, `quick`). Wrong-typed fields are
  rejected and unknown keys ignored.
- **Output:** `result.json` holds `{ok, text, markdown, details}`, where
  `details` has `groups`, `suspicions`, `warnings` and the reviewer roster.
  `result.md` holds `text`: the findings plus the lead-judgment
  instructions. On failure: `{ok: false, error}` and exit code 1.
- **No external judge runs.** The caller is the lead and judges the results.
- **Scope** comes from the working directory. Run it from the repo root.
- **stderr** carries progress and the final `OK <md> <json>` /
  `FAILED <json>` line. pi's print mode redirects stdout, so use `--out`
  and the exit code. `< /dev/null` is required (`pi -p` waits for stdin).

### Claude Code

`claude-code/SKILL.md` is a Claude Code skill wrapping this:

```bash
ln -sfn ~/Projects/pi-conf/multi-review/claude-code ~/.claude/skills/multi-review
```

The flow:
1. In Claude Code, `/multi-review [--spec=path] [--verify] [--quick] [#PR | area]`,
   or a request like "get a multi-model review of this".
2. Claude reads the diff and the spec, then writes the brief with the same
   discipline: goals and outside facts, risk areas, and its hypotheses
   kept in `suspicions`.
3. It runs `/multi-review-run` in the background (Bash, `run_in_background`),
   waits for the completion notification, and reads `result.md`.
4. It delivers the lead verdict: Intent · Reviewers · Spec conformance ·
   Act On · Consider · Noted · Dismissed · Agreement Map.

Claude Code becomes the lead with the implementation context, just as
pi's main agent is inside pi. The skill pre-approves only `pi -p`,
`mkdir`, `git`, `gh pr`, Read and Write.

## Review options

The modes used to mix three separate choices: breadth (which reviewers),
depth (a second checking round), and who writes the verdict. Now each is
its own option:

| Option | What it does | When | Cost / time (5-reviewer pool) |
|--------|-------------|------|------------------------------|
| *(default)* | Sonnet 5.5 + gpt-6-sol + gpt-6-luna with read-only tools → grouping → the main agent judges | Most reviews | ~1× · ~2–3 min on a 700-line diff |
| `--verify` | Adds a cross-check round: each issue goes to `verifiersPerFinding` (2) reviewers **who did not raise it**. With tools, they reply confirmed / refuted / uncertain plus code evidence | High-stakes changes; when false positives are expensive | ~1.5–2× |
| `--quick` | `quickReviewers` pool (gpt-6-luna@low, Haiku 5.5, Gemini Flash@low), single completions, no tools | Small diffs, a cheap first look | ~0.2× · 10–50s |
| `--direct` | No agent hand-off: the configured judge writes the synthesis (print/RPC modes always do this) | Scripting, or when you don't want the agent involved | +1 judge call |

Options combine: `--quick --verify` is a fast pass that still cross-checks.
Verification batches each verifier's assigned issues into one session.
Reviewers whose own review failed can still verify; having raised nothing,
they're the most independent checkers. An issue every reviewer raised is
marked *unanimous* (no one is left to check it independently), and the
lead agent checks those itself.

How verification shows up:
- The review panel shows a `✓n ✗n ?n` badge per issue (amber if anything
  was refuted). The expanded view shows each verifier's evidence.
- The lead agent is told to weigh the evidence, not the vote: a refutation
  that cites concrete code usually means Dismissed, and a split verdict
  means it reads the code itself.
- In a live test, a quick reviewer claimed that deleting from a `Map` while
  iterating skips keys. Both verifiers refuted it, citing iteration
  semantics.

**Legacy modes** still parse: `--mode=council` → `--verify`,
`--mode=triage` → `--quick`, and `--mode=balanced|light` → default. In
`multi-review.json`, `"mode": "council"` sets `verify: true`.

Why council and triage were removed:
- **Council** had every reviewer vote, text-only, on every finding,
  including its own. Omitted votes counted as agreement, and anonymous
  aliases added complexity without real independence. Verify is cheaper
  and targets false positives directly.
- **Triage** sent the full diff to every reviewer just to get a yes/no,
  then re-ran all of them on the same diff when escalating, costing more
  than a normal run. Tool-using reviewers plus the agent-written focus
  already narrow attention.

## Wire-up

1. **Arg parsing** — three shapes: `[/multi-review]`, `[/multi-review <pr>]`,
   `[/multi-review <free-text focus>]`, plus `--spec=path`, `--verify`, `--quick`, and
   `--direct` anywhere. Accepts `#1234`, raw `1234`, and `…/pull/1234`
   style URLs. Trailing prose after a PR number flows into the focus hint.

2. **Scope resolution** —
   - PR number ⇒ `gh pr view <num> --json title,body,files,baseRefName,headRefName,url`
     + `gh pr diff <num>`. Falls back to
     `git fetch origin pull/<num>/head:pr-<num>` + `git diff origin/HEAD...pr-<num>`
     when `gh` is missing or the repo isn't GitHub.
   - Default (no args) ⇒ `git diff <upstream>...HEAD`, falling back through
     `main` / `master` / `develop` / `origin/main` / `origin/master`, then
     `git show HEAD` if all diffs are empty. Not-a-git-repo ⇒ scan with
     `discoverSourceFiles()` below.
   - Free text ⇒ no diff; the focus hint becomes the user's directive and a
     directory listing feeds reviewers enough scope to be useful.

`discoverSourceFiles()` is shared by both default-mode and free-text-mode
fallbacks. Strategy 1: `git ls-files --cached --others --exclude-standard -z`
(native gitignore handling for repos). Strategy 2 (fallback when git
isn't present or cwd isn't a repo): iterative DFS bounded at depth 12 and
200k entries, hard-excluding `.git`/`node_modules`/`dist`/`build`/
`.next`/`target`/`.cache`/`.turbo`/`coverage`/`.venv`/`__pycache__`, then
applying every .gitignore found along each candidate's ancestry. The
gitignore parser implements `*`, `?`, `[abc]`, `**/x`, `x/**`, leading-`/`
anchoring, trailing-`/` directory-only, and `!` negation. No alternation or
extglob — documented limitation.

3. **Brief** — intent, spec (verbatim), requirements checklist, and
   `context_files` (full contents, 40k/file, 150k total) are prepended to
   the diff. An explicitly requested spec that can't be read fails the run
   rather than silently reviewing without it.

4. **Parallel fan-out** — capped by `multi-review.concurrency` (max 16).
   With `reviewerTools: true` (default) each reviewer is a nested pi agent
   (`createAgentSession`, in-memory, no extensions/skills/context files)
   with `read`/`grep`/`find`/`ls` only, so it can trace callers and tests
   instead of guessing from hunks. Otherwise it's a single
   `ctx.modelRegistry.streamSimple()` call. Both paths use registry auth
   (literal keys and custom headers in `models.json`). Each reviewer gets
   `reviewerTimeoutSec` (default 420). **Straggler cutoff:** once a quorum
   (⅔ of the pool, at least 2) has answered, the rest get half as long
   again as the quorum took (min 45s), then are cut. A degraded endpoint
   no longer holds the whole review hostage. Aborts are authoritative: a
   call returns when its signal fires even if the provider stream hangs.
   Abort is threaded from the tool's signal. Fail-soft: one reviewer's failure doesn't stop the rest, but
   failures (`stopReason` error/aborted/timeout, empty output at maxTokens,
   no JSON array) are reported as failures, never as "no findings". If
   every reviewer fails, the run reports errors instead of a review.
   Temperature is omitted when reasoning is on. For PR reviews, files on
   disk are the local checkout, and reviewers are told the diff is
   authoritative.

5. **Reviewer prompt** — adversarial and evidence-required (trace the
   execution path, trace security inputs to the sink, no "I'd have done it
   differently", empty review is valid). Output is ONLY a JSON array of
   `{file, line_start, line_end, severity, category, title, comment,
   evidence, suggestion}`. Category `spec` marks unmet requirements. The
   parser tolerates fences, prose wrap, and `{"findings": [...]}`; only an
   explicit `[]` means clean.

6. **Grouping** — one fast call (`dedupeModel`, default: the judge at low
   thinking) partitions findings into issues ("same root cause, same fix").
   Code validates the result: every finding appears once, and no cluster
   holds two findings from one reviewer. On any failure it falls back to
   lexical matching: same file, member lines within 2, and shared
   distinctive vocabulary, with words common to most findings ignored.
   Consensus = ≥ 2 distinct reviewers; group severity = max of members.

   Each reviewer runs at the thinking level in its spec (`provider/id@level`,
   see Defaults). Bare specs fall back to model defaults; the SDK clamps
   per model.

6b. **Verification** (`--verify`) — `assignVerifiers` gives each issue to
   up to `verifiersPerFinding` reviewers outside its raisers, least-loaded
   first. Each verifier gets the same brief and diff plus its assigned
   issues (with the reviewers' comments, de-identified) and returns
   `[{id, verdict, evidence}]`. Off-schema field names and verdict words
   are normalized. A reply with no usable verdicts counts as a verifier
   failure (shown under Warnings); the issues it was assigned stay
   unverified, never counted as refuted.

7. **Lead judgment** — when the agent called the tool, the result is the
   grouped findings plus a reviewer roster plus pstack-style instructions:
   verify single-reviewer findings before Act On, aim for ≤ 5 Act On items,
   give a reason for each dismissal, and add a spec conformance table when a
   spec was given. The tool result renders with the review panel
   (`Ctrl+O` expands per-reviewer comments).

   **Direct mode judge** — a single call on the configured judge at
   `judgeThinking`. It sees the groups, the diff, and the brief, and marks
   each finding confirmed / plausible / false positive. The output lands as
   a `multi-review` custom message.

## Model choice

The default pool comes from an internal benchmark, not vendor numbers. The
target was this extension at `e64d3b4`, with **10 known bugs** (all fixed
since) that are visible from the code alone. It is a 3.3k-line,
whole-file review with read-only tools, 2 runs per config, and Opus 5.5
grading findings against the answer key. Times are under 8-way gateway
load, so they're inflated in absolute terms but comparable to each other.

| Reviewer | Known bugs found | Valid extras | Dubious | Time | Notes |
|---|---|---|---|---|---|
| **Claude-Sonnet-5.5@high** | **8, 8** | 9, 7 | **0, 0** | **142s, 124s** | Best recall, cleanest, fastest |
| **gpt-6-sol@xhigh** | 6, 8 | 13, 13 | 1, 1 | 177s, 168s | Most extras per minute |
| Grok-4.7@xhigh | 7, 7 | 6, 6 | 1, 1 | 867s, 860s | Good but slow |
| Grok-4.7@high | 6, 8 | 4, 4 | 2, 0 | 845s, 815s | |
| gpt-6.1-sol@xhigh | 7 | 13 | 1 | 925s | |
| gpt-6-astra@xhigh | 7, 6 | 20, 18 | 0, 1 | 470s, 483s | Most extras; slow |
| gpt-6-astra@max | 6, parse-fail | 17 | 2 | 1065s, 720s | Max didn't help |
| **gpt-6-luna@xhigh** | 6, 6 | 8, 9 | **0, 0** | 419s, 577s | Precise; fast at lower levels |
| gemini-3.8-flash@high | 6, parse-fail | 2 | 0 | 248s, 402s | Later timed out at 420s; gateway lists it as Degraded |
| DeepSeek-V4.1-Flash@max | 6 | 7 | 2 | 1208s | Slow |
| Kimi-K2.7-Code@high | 4, parse-fail | 2 | 2 | 797s, 856s | |
| Kimi-K2.7-Code@max | 4, parse-fail | 2 | 1 | 315s, 343s | |
| DeepSeek-V4-Pro@high/max | 3–5 | 1–4 | 2–3 | ~800s | Max didn't help |
| GLM-5.3-Flash@max, Qwen3.8-Flash-Next@xhigh | — | — | — | never returned (45+ min) | On-prem endpoints hung |

Findings:
- **Raising reasoning bought nothing.** astra, Kimi and DeepSeek at `max`
  were no better than one level lower, only slower. Model choice matters
  far more than level.
- **Sonnet + gpt-6-sol cover every bug any model found** (the
  maxTokens/reasoning bug went unfound by all). luna adds a third
  independent voice for consensus and for the verifier pool.
- **Parse failures were the biggest quality loss.** 4 of 25 runs lost all
  output to malformed JSON (raw backslashes and quotes from quoted code).
  This led to the string-aware JSON repair, plus a model re-emit fallback.

On a realistic 700-line diff (commit `a88d67e` against its parent), the
default pool finished in **138s**, with 7 of 12 issues confirmed by two
or more reviewers.

The judge and grouping model stay Opus 5.5 (your main model). Public
code-review benchmarks (Qodo, Macroscope) point the same way: Claude
models lead on recall, while gpt-6-astra leads on precision but is slow.

## Defaults file

`$PI_CODING_AGENT_DIR/multi-review.json` (drop-in; missing file falls back to
in-code defaults silently, same convention as `tdd-pipeline.json`):

```json
{
  "reviewers": [
    "amd-gateway-anthropic/Claude-Sonnet-5.5@high",
    "amd-gateway/gpt-6-sol@xhigh",
    "amd-gateway/gpt-6-luna@high"
  ],
  "judge": "amd-gateway-anthropic/Claude-Opus-5.5",
  "judgeThinking": "high",
  "concurrency": 5,
  "temperature": 0.2,
  "verify": false,
  "verifiersPerFinding": 2,
  "quickReviewers": [
    "amd-gateway/gpt-6-luna@low",
    "amd-gateway-anthropic/Claude-Haiku-5.5",
    "amd-gateway/gemini-3.8-flash@low"
  ],
  "reviewerTools": true,
  "reviewerTimeoutSec": 420,
  "dedupeModel": "amd-gateway-anthropic/Claude-Opus-5.5@low"
}
```

`reviewerTools: false` makes reviewers single completions (faster, diff-only).
`dedupeModel: "lexical"` skips the grouping call.

This file stays optional — if absent, the extension warns on `/multi-review`
and tells you the exact shape to drop. Unknown fields, wrong types, or
malformed JSON all degrade silently to in-code defaults so the file is
never load-bearing.

`verify: true` turns the verification round on for every run. The
`quickReviewers` pool is used by `--quick`; its entries take the same
`provider/id@level` form as `reviewers`.

### Per-reviewer thinking level (optional)

A reviewer entry can carry a `@level` suffix to force a specific thinking
level for that run. The suffix matches the same `provider/id@level` syntax
used elsewhere in this repo (`tdd-pipeline` uses it for `/build-models`).

```jsonc
{
  "reviewers": [
    "amd-gateway-anthropic/Claude-Sonnet-5.5@high",
    "amd-gateway/DeepSeek-V4-Pro@high", // DeepSeek has no medium; bare would clamp up
    "amd-gateway/gpt-6-luna"            // bare → medium
  ]
}
```

Rules:
- Allowed levels: `off | minimal | low | medium | high | xhigh | max`.
- Bare spec → model default (`medium` for reasoning-capable models, no
  reasoning field emitted otherwise).
- A level that the model's `thinkingLevelMap` clamps to a softer value
  (e.g. `xhigh` on gemini-3.8-flash, or `medium` on DeepSeek-V4-Pro) is surfaced in
  the notify under "clamped" so you don't have to guess why reasoning
  looks lighter than expected.

The picker (`/multi-review-pick`) currently writes bare specs only; edit
the JSON directly if you want per-reviewer levels. Editing the picker to
expose per-row level controls is tracked as future polish.

## Out of scope (by design)

- **Auto-apply suggestions.** Review outputs a description, not a fix.
- **models.json modifications.** The extension reads `ctx.modelRegistry`
  only; per the user requirement it never adds new entries or modifies
  provider configuration.
- **Provider pinning.** The reviewer pool is whatever you listed in
  `multi-review.json`; pickers can include any provider that the
  registry has API keys for.
- **Sub-process sharding.** Reviewers run in-process (nested agent
  sessions or registry calls), not as spawned `pi` subprocesses.
- **Write access for reviewers.** Nested reviewer agents get read-only
  tools only, with no bash.
- **Full model configuration UI.** The picker selects reviewer models only.
  Per-reviewer thinking levels and judge choice are still edited directly in
  `multi-review.json`.

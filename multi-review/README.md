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
   Act On · Side effects · Consider · Noted · Dismissed · Agreement
   Map**. It does not apply fixes unless you ask.

`--direct` (and print/RPC modes, which have no agent turn to hand off to)
skips the agent: the extension runs the pipeline itself and an external
judge model writes the synthesis.

## Invocation surface

| Surface | How |
|---------|-----|
| Slash command | `/multi-review [--spec=path] [--verify] [--quick] [--direct] [PR-number [--pr-comments [--nits] [--resolved]] \| free-text focus]` |
| Slash command | `/multi-review-pick`: open the multi-select TUI picker to choose reviewer models from your registry (optionally saved to `multi-review.json`) |
| LLM-callable tool | `multi_review({intent?, spec_path?, requirements?, suspicions?, context_files?, checks?, focus?, scope?, pr_number?, verify?, quick?, pr_comments?, include_nits?, include_resolved?})`. The agent can call it on its own too |

Tool parameters:

| Param | Meaning |
|-------|---------|
| `intent` | What the change must accomplish, plus facts reviewers can't find in the repo (external API behaviour, constraints, out-of-scope items). Goals, not a narration of the implementation. Reviewers challenge the execution, not the intent. |
| `spec_path` | Repo-relative spec/design doc, passed to reviewers verbatim as the source of truth (60k char cap). |
| `requirements` | Checkable requirements, one per item. Reviewers report unmet ones as category `spec`. |
| `context_files` | Up to 12 paths reviewers get in full (callers, types, tests). |
| `checks` | Up to 4 fast shell commands (type-check, targeted tests) run once in the sandbox before the fan-out; every reviewer and verifier sees the output. See [Executing code](#executing-code-tools-checks-and-the-sandbox). |
| `focus` | Risk **areas** ("config-file merge lifecycle"), never hypotheses. A hint layered on the diff; it never replaces the diff. |
| `suspicions` | The lead's own bug hypotheses (≤ 20). **Never shown to reviewers.** They're matched against what reviewers find independently and, with `verify`, cross-checked by verifiers. |
| `scope` | `diff` (default: working tree vs default branch, or the PR) or `area` (no diff; review what `focus` describes). |
| `pr_number` | As for the slash command. |
| `verify`, `quick` | Same as `--verify` / `--quick`. |
| `pr_comments`, `include_nits`, `include_resolved` | With `pr_number`: triage the PR's existing review comments (see below). |

Argument autocompletion completes only the token you're typing (`--spec=`,
`--verify`, `--quick`, `--direct`, `#`) and keeps what's already typed.

If the configured reviewer pool is empty AND the agent has UI access,
`/multi-review` opens the picker as a fallback. You can save the choice to
`multi-review.json` or use it for the current run only (transient
override, never touches the file).

## Existing PR comments (CodeRabbit, collaborators)

`--pr-comments` (with a PR) also triages the review comments already on
the PR. It answers both questions in one run: which existing comments are
right, and what did everyone miss.

1. **Fetch** (read-only `gh`):
   - review threads via GraphQL, with path, line, diff hunk, and resolved
     and outdated flags;
   - review bodies (bots put "outside diff range" and nitpick findings
     there);
   - conversation comments.

   Bodies are cleaned: HTML comments, badges, and CodeRabbit's "Prompt
   for AI Agents" copies are dropped.
2. **Classify** (one fast call). Each item is split into checkable
   **claims**, or classed as **question**, **preference** or **noise**
   (walkthroughs, approvals, "done" replies).
   - **Nitpick claims** are dropped unless `--nits`.
   - **Resolved threads** are not re-checked unless `--resolved`. They're
     given to the classifier as *context only*, so a bot's summary that
     repeats a settled inline comment doesn't bring it back.
   - **Outdated threads** are kept: whether they still apply is the
     useful question.
3. **Fresh review, blind.** Reviewers never see the comments. The comments
   aren't in the brief, the same anchoring argument as for suspicions.
4. **Match and verify.** Each claim is matched against the independent
   findings by the grouping call, and is **always** cross-checked by
   verifiers at the PR's latest commit. Verifiers get the comment's
   original diff hunk to find the spot again.
5. **Output.** An *Existing PR review comments* section shows, per claim,
   its author and link, whether independent reviewers reached it, and the
   verdicts with evidence. Questions and preferences come next. Then the
   lead gives a per-comment verdict and action, a list of **new issues not
   on the PR**, and **draft replies in a local file**. Nothing is ever
   posted to GitHub.

**PR checkout.** A PR review reads the PR's actual code. If your checkout
is already the PR's latest commit with no edits to tracked files, it's
used as is. Otherwise a temporary detached worktree is created at that
commit (fetching `pull/N/head` if needed) and removed afterwards. Your
checkout, branches and stash are never touched. A spec that isn't in the
PR (e.g. an untracked local doc) is read from your local checkout.

Example, on lemonade #3765 (a shared-HF-cache model-deletion fix):
- **Comments in:** 15 items → 10 claims, 5 questions/preferences, and 1
  resolved thread kept as context.
- **Refuted, with current-code evidence:** 5 claims that later commits
  had already addressed.
- **Confirmed:** 5 claims, 3 of them also found independently by the
  fresh reviewers.
- **Human comments** (the shared-cache ownership debate, the UI warning
  question) came through as questions and preferences for the lead to
  answer.

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

## Executing code: tools, checks and the sandbox

Reviewers read; verifiers can also run things. Everything that executes
model- or lead-chosen code runs under [nono](https://nono.sh), a Landlock
sandbox (no root, no user namespaces, ~0.15s per call).

| Who | Tools |
|-----|-------|
| Reviewers | `read`, `grep`, `find`, `ls`, `git`, `progress`, and `xref` for C/C++ changes |
| Verifiers | the same, plus `run` (when the sandbox works) |

- **`git`** runs `log`, `show`, `blame`, or `diff` in the reviewed checkout,
  so reviewers can see why touched code is the way it is and whether a
  change reverts an earlier fix. Options that write files, read files from
  outside the repo, or run configured programs are refused, including git's
  abbreviated forms (`--cont` for `--contents`) and `-O<file>`. Paths
  outside the repo are refused too, since they'd switch `git diff` into
  no-index mode.
- **`run`** (verifiers only) runs a bash script to settle a claim by
  execution: a targeted test, compiling the touched files, or a repro.
  For C/C++, verifiers are told to compile repros with
  `-fsanitize=address,undefined`.
- **Checks** run once before the fan-out, all at the same time (each in
  its own sandbox), inside `checkTimeoutSec` (120s): the brief's `checks`, plus, with `autoChecks`, a built-in one
  per language. Their output goes into every reviewer's prompt and into the
  lead's `result.md`. Under a headless deadline they leave reviewers at
  least 3 minutes.
- **C/C++ auto check** (`tools/mr-cxx-check`, on PATH in the sandbox):
  when the change touches C/C++ files and a `compile_commands.json` exists,
  it analyzes the changed files and up to 3 files including each changed
  header. No build system is involved, so CMake re-configures (and their
  network needs) never happen. Everything is reported only on **changed
  lines** (from the review's diff, passed as `MR_CXX_DIFF`; by hand, `git
  diff HEAD`), so old warnings in a touched file stay out; compile errors
  are reported wherever they are. PR worktrees borrow the main checkout's
  compile database with paths remapped onto the worktree.

  All passes run at once on one worker pool sized to the machine (PR 4002's
  8 files: 9.3s sequential → 4.5s).

  | Pass | What it adds | Cost on lemonade (CPU) |
  |------|--------------|------------------|
  | gcc, the file's own flags + `-fsyntax-only -Wall -Wextra -Wduplicated-cond -Wduplicated-branches -Wlogical-op -Wshadow=local` | compile errors, front-end warnings | ~1s per file |
  | clang-tidy: `bugprone-*`, `performance-*`, `concurrency-mt-unsafe`, a few `misc-*`, cognitive complexity > 25 (a repo's own `.clang-tidy` wins) | use-after-move, dangling handles, unchecked optionals, needless copies, int overflow before widening, empty catches | ~2s per file |
  | cppcheck `warning,performance,portability` | missing returns, provable null dereferences | <1s |
  | lizard, for each function the diff touches | complexity, NLOC and parameters before → after, flagged over CCN 15 / 6 params / 100 NLOC or CCN +5 (informational, never fails the check) | milliseconds |

  Tried and left out: clang-tidy's path-sensitive `clang-analyzer-*`
  (5–10× the time per file, no extra findings on lemonade), gcc
  `-fanalyzer` (85s per file, only false positives in C++), optimizer-only
  gcc warnings like `-Wnull-dereference` (silent under `-fsyntax-only`),
  flawfinder (nothing in modern C++), semgrep (experimental C++, rules need
  login), Infer (unmaintained).
- **`xref`** (C/C++ changes, when clangd is installed): definition,
  references, callers and callees of a symbol on a given `file:line`, or a
  project-wide symbol search, from a sandboxed clangd shared by every
  session in the run. It starts when the review does, so its index builds
  while checks and reviewers run. clangd's background index persists in
  `~/.local/share/multi-review/clangd-index/<repo>/` (next to a copy of the
  compile database; nothing is written into the repo): about 20s cold on
  lemonade (half the machine's cores), about 3s on later runs, which
  re-index only what changed. The
  change's own files are opened up front, so callers it adds show up even
  though the index predates them; answers given while the index is still
  building say so. PR worktrees use the main checkout's index, with paths
  mapped back onto the worktree.
- **No web access.** Reviewers are told to read a dependency's source on
  disk (node_modules, vendored directories, system headers) rather than
  assume its behaviour.
- **Effort floor.** A reviewer that answers `[]` after fewer than
  `minReviewToolCalls` (10) tool calls is nudged once to work through its
  plan, the brief's focus areas, and git history first. If the nudge times
  out or rambles, its earlier `[]` stands.

What the sandbox allows:

- The repository (and a worktree's main `.git`) is **read-only**. The only
  writable place is a fresh scratch directory per call, which is also
  `$HOME` and `$TMPDIR` and is deleted afterwards. Commands that write into
  the repo, like in-tree builds, fail with "permission denied".
- **Readable:** system directories (`/usr`, `/etc`, `/opt`), the
  extension's `tools/`, and `sandboxHomeDirs` (toolchains such as `~/.nvm`;
  `~/.cargo` only for `bin/`, `registry/` and `git/`, since it holds
  `credentials.toml`). Nothing else in `$HOME` is readable, so credentials
  like `~/.pi/agent/auth.json` can't be printed back to a model. `/tmp` is
  not writable (PR worktrees and other runs' traces live there).
- **Network:** TCP is blocked. DNS lookups are not: Landlock filters TCP
  only, and the network namespaces that would close that need the
  unprivileged user namespaces AppArmor blocks on Ubuntu.
- **Limits:** 8G memory and 4096 processes per call, in a cgroup of its
  own. On timeout or abort the run gets SIGTERM, then the cgroup is killed,
  which takes children that `setsid` away too.

Without nono, or with `"sandbox": false`, checks are skipped with a warning
and verifiers have no `run` tool; everything else works as before.

Note that pi's own `read` tool, which every reviewer has, is not sandboxed:
it can read any file your user can.

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
- **Live trace** next to `result.json`: `progress.json` is a snapshot of
  every reviewer and verifier session (state, items checked out of its
  plan, turns, tool calls, streamed thinking/text size, last tool),
  rewritten every 2s. Reviewers report the plan themselves through a
  `progress` tool: the 3–8 things they'll check up front, then each one
  as it's done (Sonnet tends to finish before marking items).
  `trace.jsonl` logs each tool call and each assistant message (thinking
  and text in full) as it happens. stderr repeats the running sessions'
  lines every 30s. Inside pi the same lines appear in the progress widget
  and the tool's pending row, and the result names the trace file (a
  temp dir).

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
   Act On · Side effects · Consider · Noted · Dismissed · Agreement Map. It also saves
   the verdict as `verdict.md`, a checklist where each Act On item has a
   repro, a test, a fix, and the fix's side effects.
5. **If you ask it to fix**, it works from `verdict.md`, not the raw
   review:
   - for each item: write the failing test from the repro → see it fail →
     fix → see it pass;
   - run the full suite;
   - **confirmation re-review**: `--verify` on the new diff, with each
     fixed item as a suspicion ("A1 still present: …").

   Reviewers hunt for regressions while verifiers check each old issue.
   Each item comes back fixed or still present.

Claude Code becomes the lead with the implementation context, just as
pi's main agent is inside pi. The skill pre-approves only `pi -p`,
`mkdir`, `git`, `gh pr view`/`gh pr diff`, Read and Write. It deliberately
leaves out `gh pr comment`/`review`, so posting to GitHub always needs your
approval, and the skill never asks to.

## Review options

The modes used to mix three separate choices: breadth (which reviewers),
depth (a second checking round), and who writes the verdict. Now each is
its own option:

| Option | What it does | When | Cost / time (3-reviewer pool) |
|--------|-------------|------|------------------------------|
| *(default)* | Sonnet 5.5 + gpt-6.1-sol + gpt-6-luna with read-only tools → grouping → the main agent judges | Most reviews | ~1× · ~2–3 min on a 700-line diff |
| `--verify` | Adds a cross-check round: each issue goes to `verifiersPerFinding` (2) reviewers **who did not raise it**, or to `verifyOnly` models (Gemini 4 Argon@medium). With tools, they reply confirmed / refuted / uncertain plus code evidence | High-stakes changes; when false positives are expensive | ~1.5–2× |
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
   with `read`/`grep`/`find`/`ls`/`git` only (verifiers also get the
   sandboxed `run`; see [Executing code](#executing-code-tools-checks-and-the-sandbox)), so it can trace callers and tests
   instead of guessing from hunks. Otherwise it's a single
   `ctx.modelRegistry.streamSimple()` call. Both paths use registry auth
   (literal keys and custom headers in `models.json`). Each reviewer gets
   `reviewerTimeoutSec` (default 420). **Straggler cutoff:** once a quorum
   (⅔ of the pool, at least 2) has answered, the rest get as long again
   as the quorum took (min 45s, and never cut before 300s in total), then
   are cut. A degraded endpoint
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
   evidence, repro, suggestion}`. `repro` is the concrete trigger and the
   observed vs expected result, which makes every finding test-ready. Category `spec` marks unmet requirements. The
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

7. **Lead judgment** — when an agent leads (the tool, or `/multi-review-run`),
   the result is a **compact lead view**. Each issue shows one canonical
   description (the most actionable member) with Evidence / Repro / Fix,
   at most one genuinely different angle from another reviewer, severity
   dissent ("says MEDIUM"), and the verification tally with evidence.
   Verbatim per-reviewer text stays in `details.groups[].members`. The main
   gain is structure: one actionable entry per issue. Size drops modestly,
   about 19% on a quick run, more with verbose reviewers. Then come
   pstack-style instructions:
   every Act On item gets a Repro and the Test that will prove the fix,
   verify single-reviewer findings before Act On, aim for ≤ 5 Act On items,
   list each fix's side effects (behavior, API, caller, compatibility
   and performance changes beyond the fix itself),
   give a reason for each dismissal, and add a spec conformance table when a
   spec was given. The tool result renders with the review panel
   (`Ctrl+O` expands per-reviewer comments).

   **Direct mode judge** — a single call on the configured judge at
   `judgeThinking`. It sees the groups, the diff, and the brief, and marks
   each finding confirmed / plausible / false positive, then lists the
   side effects of fixing each real one. The output lands as
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
- **Gemini 4 Argon joined the default pool after this benchmark** and
  isn't in the table yet. It's a frontier model from a different family
  (Google) than the Claude and GPT reviewers, so its blind spots should
  overlap least with theirs. On a narrow area review it took ~350s at
  `@high` (past the straggler cutoff) and ~270s at `@medium`, where it
  confirmed the main findings and added one no other reviewer raised.
  Over the next real reviews it returned 0 findings every time (one run
  timed out), while its verifier verdicts cited concrete code, so it moved
  to `verifyOnly`: it verifies but no longer reviews.
- **DeepSeek V4.1 Flash** (the gateway's pre-1017 checkpoint) works with
  tools and thinking but was too slow to review: cut as a straggler at
  `@high`, timed out at 900s at `@max` after ~200k characters of reasoning.
- **gpt-6.1-sol@high replaced gpt-6-sol@xhigh.** On the same narrow area
  review: 6-sol@xhigh took 125s (5 findings), 6.1-sol@xhigh 386s (6),
  6.1-sol@high 153s (6, including each other model's unique finding),
  6.1-sol@medium 83s (4).
- **Grok-4.7 and GLM-5.3-Flash are still too slow** on this gateway, even
  with GLM's on-prem endpoint no longer hanging. Grok timed out at 900s
  at `@high` and `@xhigh` (3–4.5 min per turn). GLM took 777s at `@high`
  (4 findings, rated lower) and timed out at `@max`.
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
  "dedupeModel": "amd-gateway-anthropic/Claude-Opus-5.5@low",
  "sandbox": true,
  "checkTimeoutSec": 120,
  "autoChecks": true,
  "minReviewToolCalls": 10,
  "sandboxHomeDirs": [".nvm", ".cargo/bin", ".cargo/registry", ".cargo/git", ".rustup", ".pyenv", ".bun", ".deno", ".volta", "go", ".local/bin", ".local/lib"]
}
```

`reviewerTools: false` makes reviewers single completions (faster, diff-only).
`sandbox`, `checkTimeoutSec`, `autoChecks`, `minReviewToolCalls` and
`sandboxHomeDirs` are described under
[Executing code](#executing-code-tools-checks-and-the-sandbox).
`verifyOnly` models skip the review and only join the `--verify` (and
`--pr-comments`) verification round; a model listed in both `reviewers` and
`verifyOnly` only verifies. Quick runs leave them out.
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
- **Write access for reviewers.** Reviewers get read-only tools and no
  shell; only verifiers get `run`, and only inside the sandbox, where the
  repo is read-only.
- **Full model configuration UI.** The picker selects reviewer models only.
  Per-reviewer thinking levels and judge choice are still edited directly in
  `multi-review.json`.

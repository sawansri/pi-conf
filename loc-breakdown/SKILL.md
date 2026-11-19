---
name: loc
description: Break a change (working tree, branch, commit range or PR) down by lines of code — by category, language, directory, mechanical kind (moved, whitespace-only, comment, blank), changed entities, complexity, and by purpose. A script does all the counting; you only label hunks with their purpose and analyse the tables. Use when the user asks how big a change is, what its lines are for, how much is tests/docs/refactor vs feature, or whether a PR should be split.
argument-hint: "[#PR | base..head | base...head | rev] [-- path...]"
allowed-tools: Bash(python3 ~/.claude/skills/loc/loc_breakdown.py *) Bash(git status *) Bash(git rev-parse *) Bash(git remote *) Bash(git fetch *) Bash(git symbolic-ref *) Bash(gh pr view *) Read Write
---

# /loc: LOC breakdown

Arguments: `$ARGUMENTS`

`~/.claude/skills/loc/loc_breakdown.py` counts everything. **Never count, add up or estimate a number yourself.** Every number you show must appear in the script's output; if you want one it doesn't print, say so rather than computing it.

## 1. Resolve the target

Run the script from inside the repo. Pick flags from the argument:

| Argument | Flags |
|---|---|
| none, on the default branch, dirty tree | `--base HEAD` (working tree incl. untracked) |
| none, on the default branch, clean | `--base HEAD~1 --head HEAD` |
| none, on another branch | `--base <remote>/<default> --merge-base` (branch + uncommitted work) |
| `#N` or a PR URL | `gh pr view N --json baseRefName,headRefOid`; `git fetch <remote> pull/N/head <baseRefName>`; then `--base <remote>/<baseRefName> --head <headRefOid> --merge-base`. `<remote>` is the one `git remote -v` shows for the PR's base repo (in lemonade it is `origin`, not the fork). |
| `A..B` | `--base A --head B` |
| `A...B` | `--base A --head B --merge-base` |
| one revision `X` | `--base X~1 --head X` |
| `-- paths` | append `-- paths` |

Find the default branch with `git symbolic-ref refs/remotes/origin/HEAD`.

## 2. Collect

```
python3 ~/.claude/skills/loc/loc_breakdown.py collect <flags>
```

It prints `report.md` and writes, in the directory it names at the end:

- `hunks.txt`: every hunk as `=== hN  path  [category]  @@ … @@ func  [+a -r]  sem: <entity>`, then its lines. Pure renames, binaries and mode changes get a hunk with no lines so they can be labelled too.
- `hunks.json`, `tools.json`: the raw counts.

Optional tools fill extra sections when installed: `cloc` (exact code/comment/blank), `sem` (changed functions/classes; same-file "moves" that only shifted lines are already dropped), `lizard` (cyclomatic complexity before/after). A missing tool shows as a one-line note; mention it, don't work around it.

## 3. Label every hunk with its purpose

A purpose is **why** the lines exist, not where they are; the category column already says where. Label a feature's tests and docs with the feature's purpose, so the purpose × category table shows how much of each purpose is tests. Use separate purposes only for work with its own reason: an unrelated refactor, a drive-by fix, formatting, CI, dependency bumps, regenerated files.

Name purposes `kind: subject`, kind one of `feat`, `fix`, `refactor`, `test`, `docs`, `ci`, `build`, `chore`, `style`, `generated`. Aim for 3–8 purposes; fewer for a small change.

Work top-down to keep reading cheap:

1. From the report's Files table, commit subjects and `sem:` entities, label whole files or globs that clearly have one purpose.
2. Read in `hunks.txt` only the hunks of files that may mix purposes (big src files, files touched by several commits), and label those hunks by id.
3. If one long hunk mixes purposes, rerun collect with `--context 0` (and the same flags) so git splits it, then label the new ids. Hunk ids change between runs, so relabel from the new `hunks.txt`.

Write `<dir>/labels.json`:

```json
{
  "purposes": {"feat: lora adapter": "Load a LoRA checkpoint as a GGUF adapter in llamacpp"},
  "assign": {
    "src/cpp/server/backends/llamacpp/*": "feat: lora adapter",
    "test/test_llamacpp_system_backend.py": "feat: lora adapter",
    "h12": "refactor: extract port selection"
  }
}
```

A hunk id beats an exact path, which beats a glob; among globs the longest wins.

## 4. Tally

```
python3 ~/.claude/skills/loc/loc_breakdown.py tally <dir>
```

It fails and lists any hunk without a label, or any unknown hunk id. Fix `labels.json` and rerun until it passes; don't use `--allow-unlabeled`.

## 5. Report

Show, in this order:

1. One line: the target, files, `+added / -removed`, churn.
2. The tally's purpose table and purpose × category table, as printed.
3. The report's category table, plus the cloc, sem and lizard sections when they say something (skip a section that adds nothing).
4. **Analysis**, a few bullets, each citing numbers from the tables:
   - which purpose dominates the churn, and how much of each purpose is tests or docs;
   - how much is mechanical (moved, whitespace-only, blank, comment, generated) vs substantive;
   - complexity hotspots from lizard (functions whose CCN rose, new functions with high CCN);
   - anything that looks out of scope for the change's stated purpose, and whether the change would split cleanly by purpose (name the purposes and their churn).

Keep the prose short. Give the output directory so the user can open `report.md`, `tally.md` and `hunks.txt`.

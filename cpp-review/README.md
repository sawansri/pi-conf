# cpp-review

Local tools and configs for reviewing lemonade C++ changes. Nothing here is
committed to lemonade: `link-into` symlinks the configs into a clone and adds
them to that clone's `info/exclude`.

```sh
~/Projects/pi-conf/cpp-review/link-into ~/Projects/lemonade   # once per clone/worktree
```

`BASE` below is the branch point, e.g. `BASE=$(git merge-base origin/main HEAD)`.

## Installed

| Tool | Install | Version |
|---|---|---|
| clang-tidy, clang-tidy-diff.py, run-clang-tidy.py | `pipx install clang-tidy` | 23.1 |
| clang-format, git-clang-format | `pipx install clang-format` | 23.1 |
| clangd | `pipx install clangd` | 22.1 |
| clangd-lsp (Claude Code plugin) | `claude plugin install clangd-lsp@claude-plugins-official` | |
| ast-grep | `pipx install ast-grep-cli` (its `sg` alias removed: it shadows `/usr/bin/sg`) | 0.51 |
| jscpd | `npm i -g jscpd` | 5.4 |
| cppcheck | apt (was already installed) | 2.13 |
| gcovr, diff-cover | `pipx install gcovr diff-cover` | 8.8, 11.0 |
| CodeQL CLI + query packs | bundle in `~/.local/opt/codeql`, linked to `~/.local/bin/codeql` | 2.27 |
| clang + libFuzzer | `sudo apt install clang libclang-rt-18-dev` | 18 |
| sem, lizard, cloc | see `../loc-breakdown` | |

## Static: run on the change

```sh
# clang-tidy, changed lines only. Checks: clang-tidy.yaml (linked as .clang-tidy).
git diff $BASE -U0 -- 'src/cpp/*' | clang-tidy-diff.py -p1 -path build -quiet

# Project rules (empty catch, detach, sleeps, shell commands, manual lock, ...).
ast-grep scan -c ~/Projects/pi-conf/cpp-review/ast-grep/sgconfig.yml $(git diff --name-only $BASE -- 'src/cpp/*')

# New copy-paste clones vs the base.
jscpd src/cpp -f cpp,c -l 15 -k 120 --baseline-from-ref $BASE -r console -o ~/.cache/cpp-tools-trial/jscpd
#   not --changed: it only sees uncommitted files and writes .jscpd-baseline.json into the repo.

# cppcheck on changed files (quiet, shallow).
for f in $(git diff --name-only $BASE -- 'src/cpp/*.cpp'); do
  cppcheck --project=build/compile_commands.json --file-filter="*$f" \
    --enable=warning,performance,portability --suppress='*:*aixlog.hpp' --quiet
done

# Formatting of changed lines. lemonade has no .clang-format, so this uses
# LLVM style (2-space) and is only useful once a style is chosen.
git clang-format --diff $BASE -- src/cpp
```

`build/compile_commands.json` comes from the default preset and can be stale;
regenerate with `cmake --preset default`.

ast-grep rules have tests: `cd ast-grep && ast-grep test --skip-snapshot-tests`.

## Dynamic: build presets (CMakeUserPresets.json)

Build trees go to `~/.cache/lemonade-build/<clone>-<preset>`, outside the clone.
All presets build only `cpp-ci-tests` and run the `cpp-ci` label.

```sh
cmake --preset asan && cmake --build --preset asan && ctest --preset asan
cmake --preset tsan && cmake --build --preset tsan && setarch $(uname -m) -R ctest --preset tsan

# Coverage of the change's lines (unit tests only; the Python integration
# tests drive a separate server and don't feed it).
cmake --preset coverage && cmake --build --preset coverage && ctest --preset coverage
B=~/.cache/lemonade-build/lemonade-coverage
gcovr -r . $B --filter 'src/cpp/' --gcov-exclude-directories '.*/CMakeFiles/[0-9.]+/.*' \
  --gcov-ignore-errors=no_working_dir_found --cobertura-pretty -o $B/cov.xml --txt-summary -j 16
diff-cover $B/cov.xml --compare-branch=$BASE
```

The coverage preset compiles with `-fprofile-update=atomic`: without it the
threaded tests corrupt counters and gcovr stops on "negative hits". The test
presets set `TMPDIR=~/.cache/tmp` because `/tmp` is noexec here and
LlamaCppSystemBackendTest runs a fake `llama-server` from it. The sanitizer
presets skip GlibcAllocatorPolicyTest, which `LD_PRELOAD`s a malloc probe that
a sanitizer runtime can't coexist with.

TSan needs `setarch -R` (ASLR off): gcc 13's TSan aborts with "unexpected
memory mapping" under this kernel's `vm.mmap_rnd_bits=32`. The tsan test
preset also skips RepositoryFixtureTest, which segfaults inside the TSan
allocator on glibc's internal `getaddrinfo_a` thread (cpp-httplib's
`CPPHTTPLIB_USE_NON_BLOCKING_GETADDRINFO`), and ProcessManagerTest, whose
zombie/exit-code checks failed 8 of 10 runs under TSan but 0 of 5 under ASan
(cause not found).

First run (2026-11-18, `feat/llamacpp-lora-checkpoint`): asan built in 6 min
and passed 115/115; tsan built in 3 min and passed 113/113 with no race
reports; coverage built in 2 min, 116/116, 43.9% of `src/cpp`
lines; diff-cover showed the branch's 6 changed C++ lines at 0% (only the
Python integration test exercises them).

`fuzz` configures with clang 18 and `-fsanitize=fuzzer-no-link` (checked:
it configures, and a toy libFuzzer target found its planted crash). lemonade
has no fuzz targets yet; a target links with `-fsanitize=fuzzer`.

## CodeQL (no build needed)

```sh
S=~/.cache/cpp-tools-trial/codeql-src; rm -rf $S; mkdir -p $S
git archive HEAD src/cpp | tar -x -C $S
codeql database create ~/.cache/cpp-tools-trial/codeql-db --language=cpp --build-mode=none --source-root $S --overwrite
codeql database analyze ~/.cache/cpp-tools-trial/codeql-db \
  codeql/cpp-queries:codeql-suites/cpp-security-and-quality.qls \
  --format=sarif-latest --output=~/.cache/cpp-tools-trial/codeql.sarif
```

## Editor / Claude Code

`clangd-config.yaml` is linked as `~/.config/clangd/config.yaml`. It adds
`-Wshadow -Wnon-virtual-dtor -Woverloaded-virtual` for lemonade sources on top
of lemonade's `.clangd`. The clangd-lsp plugin uses the `clangd` on PATH.

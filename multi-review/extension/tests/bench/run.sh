#!/bin/bash
# Runs a real headless review of the fixture and prints cost + recall.
#
# The fixture has known planted defects (see PLANTED below). Each run writes
# result.json; this script reports what it cost and which defects the pool
# actually found, so a change to the pipeline can be judged on both at once.
#
#   tests/bench/run.sh [quick|balanced] [extra pi flags...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fixture="$here/fixture"
mode="${1:-balanced}"; shift || true
outdir="${MR_BENCH_OUT:-${XDG_DATA_HOME:-$HOME/.local/share}/multi-review/runs/bench-$(date +%Y%m%d-%H%M%S)-$mode}"
mkdir -p "$outdir"

cli_flags=()
case "$mode" in
  quick)    cli_flags+=(--quick) ;;
  verify)   cli_flags+=(--verify) ;;
  qverify)  cli_flags+=(--quick --verify) ;;
esac

cat > "$outdir/brief.json" <<JSON
{
  "intent": "Add an entry cap with LRU-ish eviction to Cache, validate the timeout query parameter, and keep the retry helper's contract (it must return the successful value). Callers must keep working.",
  "requirements": [
    "Cache.get() must not return a value past its ttl",
    "Cache must never exceed its maxEntries cap",
    "parsePairs must preserve a key whose value is empty",
    "withRetries must return the value from the first successful attempt",
    "buildRequest must not pass a NaN timeout through to the caller",
    "merge must let the right-hand item win on an id collision",
    "rank must never mutate the caller's array",
    "averageWeight must return 0 for an empty set",
    "heaviest must return the item with the greatest weight"
  ],
  "checks": ["node --experimental-transform-types --no-warnings --test 'tests/*.test.ts'"],
  "focus": ["cache expiry and eviction accounting", "retry-helper return value"],
  "suspicions": ["expired entries are still served", "the retry helper loses the successful value",
                 "merge keeps the left-hand item on a collision", "averageWeight divides by zero on an empty set"]
}
JSON

cd "$fixture"
timeout 900 pi -p --no-session \
  --model "amd-gateway/gpt-6.1-sol" \
  "/multi-review-run --brief=$outdir/brief.json --out=$outdir/result.json ${cli_flags[*]}" \
  > "$outdir/pi.log" 2>&1
status=$?

python3 - "$outdir" "$mode" "$status" <<'PY'
import json, re, sys, os, pathlib
outdir, mode, status = sys.argv[1], sys.argv[2], sys.argv[3]
res = pathlib.Path(outdir, "result.json")
PLANTED = {
    "expiry":    r"expir|ttl|past its|stale",
    "evict":     r"evict|maxEntries|cap|leak|unbounded",
    "emptyval":  r"empty (value|string)|parsePairs",
    "retryval":  r"withRetries|retry.{0,30}return|return.{0,20}attempt|discard",
    "nan":       r"NaN|timeout.{0,20}(number|parse|valid)|Number\(",
    "mergefst":  r"merge.{0,60}(first|left).{0,40}(win|keep|survive)|first write wins|last-write-wins",
    "rankmut":   r"rank.{0,60}mutat|mutat.{0,40}(caller|input|argument)",
    "avgzero":   r"averageWeight|divide by zero|divi.{0,10}by.{0,10}zero|NaN",
    "heaviest":  r"heaviest.{0,60}(first|insert)|not the heaviest|insertion order",
    "metafilt":  r"describe.{0,40}(meta|empty)|empty (value|string).{0,20}skip",
}
if not res.exists():
    print(f"[{mode}] NO RESULT (pi exit {status}); see {outdir}/pi.log")
    sys.exit(1)
d = json.loads(res.read_text())
det = d.get("details") or {}
cost = det.get("cost") or {}
groups = det.get("groups") or []
text = json.dumps(det).lower()
found = {k: bool(re.search(v, text)) for k, v in PLANTED.items()}
print(f"[{mode}] exit={status} issues={len(groups)} reviewers={len(det.get('reviewerSpecs') or [])}")
cu = cost.get("usage") or {}
print(f"  cost=${cu.get('cost',0):.4f}  calls={cost.get('calls',0)}  "
      f"in={cu.get('input',0)} out={cu.get('output',0)} cacheRead={cu.get('cacheRead',0)} cacheWrite={cu.get('cacheWrite',0)}")
for row in sorted(cost.get("bySpec") or [], key=lambda r: -r["usage"]["cost"]):
    print(f"    {row['spec']:44} ${row['usage']['cost']:.4f}  calls={row['calls']} "
          f"in={row['usage']['input']} out={row['usage']['output']} cr={row['usage'].get('cacheRead',0)}")
print("  recall: " + "  ".join(f"{k}={'Y' if v else 'n'}" for k, v in found.items()))
print(f"  recall_score={sum(found.values())}/{len(found)}")
PY
echo "  out=$outdir"

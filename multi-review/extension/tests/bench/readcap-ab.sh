#!/usr/bin/env bash
# A/B the read cap on the fixture, in parallel. The fixture is small, so this
# mainly checks that capping does not cost recall or force re-reads.
set -uo pipefail
cd "$(dirname "$0")/../.."
base=/tmp/mr-readcap; rm -rf "$base"; mkdir -p "$base"
mode="${1:-balanced}"; N="${2:-2}"
mkcfg() {
  mkdir -p "$1"
  if [ "$2" = off ]; then echo '{"readMaxChars":0}' > "$1/multi-review.json"
  else echo '{"readMaxChars":24000}' > "$1/multi-review.json"; fi
  ln -sfn "$HOME/.pi/agent/models.json" "$1/models.json"
  ln -sfn "$HOME/.pi/agent/auth.json" "$1/auth.json"
}
one() { local v="$1" i="$2" d="$base/$1-$2"; mkcfg "$d" "$v"
  PI_CODING_AGENT_DIR="$d" MR_BENCH_OUT="$base/out-$v-$i" tests/bench/run.sh "$mode" > "$base/$v-$i.log" 2>&1; }
for i in $(seq 1 "$N"); do one off "$i" & one on "$i" & done
wait
python3 - "$base" <<'PY'
import json,glob,sys,os,statistics as st
b=sys.argv[1]
P={"amd-gateway/Kimi-K3.1-Pro":(2.0,10.0),"amd-gateway/gemini-4-argon":(2.5,15.0),
   "amd-gateway/gpt-6.1-sol":(1.36,6.8),"amd-gateway-anthropic/Claude-Sonnet-5.5":(2.0,10.0),
   "amd-gateway-anthropic/Claude-Opus-5.5":(4.0,20.0),"amd-gateway-anthropic/Claude-Haiku-5.5":(0.1,0.5)}
def kb(s): return s.replace(" (verify)","").replace(" #2","").replace("@high","").replace("@medium","").replace("@low","")
for v in ("off","on"):
    tot=[];fi=[];ocr=[];tk=[]
    for f in sorted(glob.glob(f"{b}/out-{v}-*/result.json")):
        d=json.load(open(f))["details"]; u=d["cost"]["usage"]
        tot.append(u["cost"])
        fi.append(sum(r["usage"]["input"]*P[kb(r["spec"])][0]/1e6 for r in d["cost"]["bySpec"] if kb(r["spec"]) in P))
        ocr.append(sum(r["usage"]["output"]*P[kb(r["spec"])][1]/1e6 for r in d["cost"]["bySpec"] if kb(r["spec"]) in P))
        tk.append(u["input"])
    if not tot: continue
    print(f"readMaxChars={v:3} n={len(tot)}  cost=${st.mean(tot):.4f}  freshIn=${st.mean(fi):.4f} ({st.mean(tk):,.0f} tok)  output=${st.mean(ocr):.4f}")
PY

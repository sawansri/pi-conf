#!/usr/bin/env bash
# Final controlled A/B of everything shipped, run in parallel.
#   base = pre-change behaviour (levers off)   new = shipped defaults
set -uo pipefail
cd "$(dirname "$0")/../.."
base=/tmp/mr-final; rm -rf "$base"; mkdir -p "$base"
mode="${1:-balanced}"

mkcfg() {
  mkdir -p "$1"
  if [ "$2" = base ]; then
    printf '%s\n' '{ "dedupeDefaultModel": null, "judgeMaxTokens": 0,' \
      '  "readMaxChars": 0, "verifyNarrowContext": false, "verifierThinking": null,' \
      '  "secondPassMinLines": 0, "minReviewToolCalls": 10 }' > "$1/multi-review.json"
  else
    printf '%s\n' '{ "dedupeDefaultModel": "amd-gateway-anthropic/Claude-Haiku-5.5",' \
      '  "judgeMaxTokens": 8000, "readMaxChars": 0, "verifyNarrowContext": false,' \
      '  "verifierThinking": null, "secondPassMinLines": 0, "minReviewToolCalls": 10 }' > "$1/multi-review.json"
  fi
  ln -sfn "$HOME/.pi/agent/models.json" "$1/models.json"
  ln -sfn "$HOME/.pi/agent/auth.json" "$1/auth.json"
}

one() {
  local v="$1" i="$2" d="$base/$1-$2"
  mkcfg "$d" "$v"
  PI_CODING_AGENT_DIR="$d" MR_BENCH_OUT="$base/out-$v-$i" \
    tests/bench/run.sh "$mode" > "$base/$v-$i.log" 2>&1
}

N="${2:-4}"
for i in $(seq 1 "$N"); do one base "$i" & one new "$i" & done
wait

python3 - "$base" "$mode" <<'PY'
import json,sys,glob,os,statistics as st
base,mode=sys.argv[1],sys.argv[2]
P={"amd-gateway/Kimi-K3.1-Pro":(2.0,10.0),"amd-gateway/gemini-4-argon":(2.5,15.0),
   "amd-gateway/gpt-6.1-sol":(1.36,6.8),"amd-gateway-anthropic/Claude-Sonnet-5.5":(2.0,10.0),
   "amd-gateway-anthropic/Claude-Opus-5.5":(4.0,20.0),"amd-gateway-anthropic/Claude-Haiku-5.5":(0.1,0.5)}
def kb(s): return s.replace(" (verify)","").replace(" #2","").replace("@high","").replace("@medium","").replace("@low","")
def get(v):
    out=[]
    for f in glob.glob(f"{base}/out-{v}-*/result.json"):
        d=json.load(open(f))["details"]
        out.append(d)
    return out
def summarize(ds):
    c=[d["cost"]["usage"]["cost"] for d in ds]
    ph={"reviewers":[], "verify":[], "grouping":[]}
    out_tok=[]; in_tok=[]; rec=[]
    for d in ds:
        s={"reviewers":0.0,"verify":0.0,"grouping":0.0}
        for r in d["cost"]["bySpec"]:
            ph_ = "grouping" if kb(r["spec"])=="amd-gateway-anthropic/Claude-Haiku-5.5" else ("verify" if "(verify)" in r["spec"] else "reviewers")
            s[ph_]+=r["usage"]["cost"]
        for k in ph: ph[k].append(s[k])
        out_tok.append(d["cost"]["usage"]["output"]); in_tok.append(d["cost"]["usage"]["input"])
        rec.append(len(d.get("groups") or []))
    return dict(c=c, **{k:(st.mean(v) if v else 0) for k,v in ph.items()},
                out=st.mean(out_tok), inp=st.mean(in_tok), issues=st.mean(rec))
for v in ("base","new"):
    ds=get(v)
    if not ds: print(f"{v}: no runs"); continue
    s=summarize(ds)
    print(f"{v:5} n={len(ds)}  mean=${st.mean(s['c']):.4f} median=${st.median(s['c']):.4f} "
          f"sd=${st.stdev(s['c']) if len(s['c'])>1 else 0:.4f}  "
          f"[reviewers ${s['reviewers']:.4f} | verify ${s['verify']:.4f} | grouping ${s['grouping']:.4f}]  "
          f"out={s['out']:.0f} freshIn={s['inp']:.0f} issues={s['issues']:.1f}")
PY

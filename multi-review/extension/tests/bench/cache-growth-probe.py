#!/usr/bin/env python3
# Usage: [CACHE_KEY=k] cache-growth-probe.py MODEL_ID [SEED]  (needs LLM_GATEWAY_KEY; costs cents)
# Does the gateway cache a growing conversation's whole prefix, as a tool loop needs?
import json, os, sys, time, urllib.request, random
API = "https://llm-api.amd.com/Unified/v1/chat/completions"
KEY = os.environ["LLM_GATEWAY_KEY"]
random.seed(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
def chunk(n_words, tag):
    words = ["alpha","beta","gamma","delta","lease","host","machine","enforce","release","token","cache","read","grep"]
    return f"[{tag}] " + " ".join(random.choice(words) + str(random.randint(0, 999)) for _ in range(n_words))
def send(model, messages):
    body = {"model": model, "max_tokens": 64, "messages": messages}
    if os.environ.get("CACHE_KEY"): body["prompt_cache_key"] = os.environ["CACHE_KEY"]
    if model.startswith("Kimi"): body["reasoning_effort"] = "low"
    req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"content-type": "application/json", "Ocp-Apim-Subscription-Key": KEY})
    with urllib.request.urlopen(req, timeout=180) as r:
        j = json.load(r)
    u = j.get("usage", {})
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("cached_tokens") or 0
    return u.get("prompt_tokens", 0), cached, j["choices"][0]["message"].get("content") or ""
model = sys.argv[1]
msgs = [{"role": "system", "content": chunk(12000, "system+brief")}, {"role": "user", "content": "Review. Reply 'ok' only."}]
prev_prompt = 0
for turn in range(1, 5):
    prompt, cached, text = send(model, msgs)
    print(f"{model:16} turn {turn}: prompt={prompt:6} cached={cached:6} uncached={prompt-cached:6} new-since-last={prompt-prev_prompt:6}")
    prev_prompt = prompt
    msgs.append({"role": "assistant", "content": text or "ok"})
    msgs.append({"role": "user", "content": chunk(3000, f"tool result {turn}") + "\nReply 'ok' only."})
    time.sleep(2)

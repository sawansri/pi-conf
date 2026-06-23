# Install

## Prereqs

- pi ≥ current (the extension uses `completeSimple` from `@mariozechner/pi-ai`
  and `pi.appendEntry` / `pi.sendMessage` from `@mariozechner/pi-coding-agent`).
- One or more models registered in your pi config with a valid API key. The extension
  resolves the reviewer pool via `ctx.modelRegistry.getAvailable()` so any provider works.
- For PR-number input: `gh` CLI authenticated (`gh auth status`), or a git
  repo where the PR-equivalent is captured by `git diff <base>...HEAD`.
- For free-text focus input: nothing extra — that's the fallback shape.

The extension makes **no** changes to `~/.pi/agent/models.json` (per the
design constraint).

## 1. Install the extension

```bash
# Globally
mkdir -p ~/.pi/agent/extensions/multi-review
cp /home/sawan/Projects/pi-conf/multi-review/extension/index.ts \
   ~/.pi/agent/extensions/multi-review/index.ts

# Or project-local
mkdir -p .pi/extensions/multi-review
cp /home/sawan/Projects/pi-conf/multi-review/extension/index.ts \
   .pi/extensions/multi-review/index.ts
```

Reload inside pi with `/reload`, or restart.

## 2. (Optional) Drop a defaults file

```bash
cat > ~/.pi/agent/multi-review.json << 'EOF'
{
  "reviewers": [
    "fireworks/accounts/fireworks/models/minimax-m3",
    "fireworks/accounts/fireworks/models/glm-5p2",
    "fireworks/accounts/fireworks/models/kimi-k2p7"
  ],
  "judge": "fireworks/accounts/fireworks/models/glm-5p2",
  "judgeThinking": "high",
  "concurrency": 4,
  "temperature": 0.2
}
EOF
```

The file is read once on first use; reload to pick up changes. Unknown
keys, bad JSON, or a missing file all fall back silently to in-code defaults.

## 3. Verify

Inside pi, type `/multi-review` and hit `:`. The command should autocomplete
with a description.

If reviewers are configured, it should print a "loaded — pool: N models"
notification on session start.

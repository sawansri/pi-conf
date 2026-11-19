#!/usr/bin/env bash
# pi-agent's tests: node >= 22.18 (type stripping), no network or model calls;
# tests/fake-pi.mjs stands in for pi. The mod's tests: cd claude-code-mod && claude plugin test .
set -uo pipefail
cd "$(dirname "$0")"
exec node --no-warnings --test "tests/*.test.ts" "$@"

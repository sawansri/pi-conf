#!/usr/bin/env bash
# Tests for the multi-review extension. Needs no dependencies beyond node
# (>=22 for --experimental-transform-types) and an installed pi release to
# resolve @mariozechner/* from.
set -uo pipefail
cd "$(dirname "$0")"
exec node --experimental-transform-types --no-warnings --import ./tests/support/pi-packages.mjs --test "tests/*.test.ts" "$@"

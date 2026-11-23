#!/usr/bin/env bash
# Explicit append measurement for the Claude plugin. Not a gate, not part of `claude plugin test plugins/context-bar`.
# The host refuses imports from outside a plugin folder, so this copies the plugin byte for byte WITHOUT its *.test.ts files into a scratch
# folder, adds the measurement file and its core, and runs `claude plugin test` there. The code measured is the production files.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -R "$root/plugins/context-bar/." "$tmp/"
find "$tmp" -name '*.test.ts' -o -name '*.test.tsx' | xargs rm -f
cp "$root/bench/append-claude/append-measure.test.ts" "$root/bench/append-measure-core.ts" "$tmp/"
claude plugin test "$tmp"

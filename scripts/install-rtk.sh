#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# Installs the RTK release that tool-gateway supports and names it in the config both coding
# agents read. Does what the README's "Install RTK" block does:
#   platform -> download -> checksum -> unpack -> version check -> config.
# Nothing is unpacked or run before the checksum matches, and nothing reaches the install folder
# before the version check passes. Safe to run twice: each run downloads and verifies again, then
# replaces the same file. An existing config.json is never edited: if it does not already name this
# path, the script prints the line to add.
#
#   bash scripts/install-rtk.sh
#   curl -fsSL <this script's release-tag URL> -o install-rtk.sh; less install-rtk.sh; bash install-rtk.sh
set -eu

v=0.47.0
base="https://github.com/rtk-ai/rtk/releases/download/v$v"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=rtk-aarch64-apple-darwin.tar.gz; verify() { shasum -a 256 -c -; } ;;
  Linux-x86_64) asset=rtk-x86_64-unknown-linux-musl.tar.gz; verify() { sha256sum -c -; } ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# The config is written as JSON with the path inside quotes: a HOME with a quote or backslash would break it.
case "$HOME" in
  *\"* | *\\*) echo "HOME contains a quote or backslash: $HOME" >&2; exit 1 ;;
esac

dir="$HOME/.local/opt/rtk-$v"
mkdir -p "$dir"
chmod 755 "$dir"
work=$(mktemp -d "$dir/.install.XXXXXX")
ctmp=
cleanup() { rm -rf "$work"; [ -z "$ctmp" ] || rm -f "$ctmp"; }
trap cleanup EXIT
cd "$work"

curl --proto '=https' --tlsv1.2 -fsSLO "$base/$asset"
curl --proto '=https' --tlsv1.2 -fsSLO "$base/checksums.txt"
line=$(grep -E "^[0-9a-f]{64}[ *]+$asset\$" checksums.txt) || { echo "no checksum for $asset" >&2; exit 1; }
[ "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" = 1 ] || { echo "ambiguous checksum for $asset" >&2; exit 1; }
printf '%s  %s\n' "${line%%[ *]*}" "$asset" | verify

tar -xzf "$asset" rtk
[ -f rtk ] && [ ! -L rtk ] || { echo "$asset does not hold a regular file rtk" >&2; exit 1; }
chmod 755 rtk
got=$(./rtk --version) || { echo "rtk --version failed" >&2; exit 1; }
[ "$got" = "rtk $v" ] || { echo "expected 'rtk $v', got '$got'" >&2; exit 1; }
mv -f rtk "$dir/rtk"

rtk_path="$dir/rtk"
config="$HOME/.claude/context-economy/config.json"
if [ ! -e "$config" ]; then
  mkdir -p "$(dirname "$config")"
  ctmp="$config.tmp.$$"
  printf '{\n  "rtk": { "path": "%s" }\n}\n' "$rtk_path" > "$ctmp"
  mv "$ctmp" "$config"
  ctmp=
  status="wrote $config"
elif tr -d ' \t\r\n' < "$config" | grep -qF "\"path\":\"$rtk_path\""; then
  status="$config already names this path"
else
  status="$config exists and was not changed. Set \"rtk\": { \"path\": \"$rtk_path\" } in it"
fi

echo "installed: $got at $rtk_path"
echo "config: $status"
echo "next: install the plugins (README, \"2. Install\")"

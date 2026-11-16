#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Run sheet Part 0, the steps that come before the driver can start (it needs Node 24 or later):
#   0.1  clean check (a): nothing of the product, no override, no managed policy file;
#   0.2  Node 24 or later and git.
# Then `node scripts/e1-run.mjs prepare --platform <p> --drill <folder>` does the rest of Part 0.
#
# UNTRIED: the install branches below have been read and shellchecked, never run on a real account.
#
# The account is created and signed in to by the operator (System Settings or `adduser`); this script runs
# in that account, from a copy of the driver checkout that the operator placed there (rsync or tar from the
# engineer's machine: git itself may not be installed yet). It never reads credential files.
#
#   bash scripts/e1-bootstrap.sh [--check-only] [--yes]
#     --check-only   run clean check (a) and report Node and git; install nothing
#     --yes          do not ask before the Linux Node install (the nvm installer is then fetched and run unasked)
#
# Install route (owner decision, review 121 T1; the published runs used this):
#   Linux  Node 24 with nvm, in the account (no sudo). nvm's installer is a script fetched from the network;
#          it is shown and asked about first, unless --yes. git is not installed here: a missing git is an
#          admin task (an adduser account is not a sudo user).
#   macOS  nothing is installed. A standard account cannot run Homebrew; the published runs used the
#          machine-wide Node and Pi. When something is missing the script says what the admin account runs.
set -u

CHECK_ONLY=0; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --check-only) CHECK_ONLY=1 ;;
    --yes) ASSUME_YES=1 ;;
    *) echo "usage: bash scripts/e1-bootstrap.sh [--check-only] [--yes]" >&2; exit 2 ;;
  esac
done

NVM_VERSION="v0.40.3"
PI_PACKAGE="@earendil-works/pi-coding-agent"
FAIL=0
bad() { echo "  FAIL: $*"; FAIL=1; }

echo "== 0.1 clean check (a) =="
date -u +%FT%TZ
uname -sm
for d in "$HOME/.claude" "$HOME/.pi"; do
  if [ -e "$d" ] || [ -L "$d" ]; then echo "$d: PRESENT"; bad "$d exists: this account is not clean"; else echo "$d: absent"; fi
done
n=$(env | grep -c '^CE_RTK_BIN=' || true)
echo "CE_RTK_BIN in the environment: $n"
[ "$n" = "0" ] || bad "CE_RTK_BIN is set: unset it"
for f in /etc/claude-code/managed-settings.json "/Library/Application Support/ClaudeCode/managed-settings.json"; do
  if [ -e "$f" ]; then echo "$f: PRESENT"; bad "managed policy file $f exists"; else echo "$f: absent"; fi
done
if [ "$FAIL" = 1 ]; then echo "clean check (a): FAILED (stop)"; exit 1; fi
echo "clean check (a): OK"

echo "== 0.2 Node 24 or later, git =="
node_major() { command -v node >/dev/null 2>&1 && node --version | sed -E 's/^v([0-9]+)\..*/\1/' || echo 0; }
need_node=0; need_git=0
[ "$(node_major)" -ge 24 ] 2>/dev/null || need_node=1
command -v git >/dev/null 2>&1 || need_git=1
echo "node: $(command -v node >/dev/null 2>&1 && node --version || echo missing)   git: $(command -v git >/dev/null 2>&1 && git --version || echo missing)"
if [ "$need_node" = 0 ] && [ "$need_git" = 0 ]; then echo "Node and git are fine."; exit 0; fi

admin_note() {
  echo "Ask the admin account to install, machine-wide:"
  [ $need_git = 1 ] && echo "  git"
  [ $need_node = 1 ] && echo "  Node 24 or later"
  echo "  and Pi: npm install -g --ignore-scripts $PI_PACKAGE"
}

if [ "$(uname -s)" = Darwin ]; then
  # A standard macOS account cannot run Homebrew: report, install nothing.
  admin_note; exit 1
fi
if [ "$(uname -s)" != Linux ]; then echo "unsupported system $(uname -s)" >&2; exit 1; fi
if [ $need_git = 1 ]; then admin_note; exit 1; fi
if [ "$CHECK_ONLY" = 1 ]; then echo "(--check-only) would install Node 24 with nvm $NVM_VERSION in $HOME/.nvm"; exit 1; fi

echo "About to run: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash   then: nvm install 24"
if [ "$ASSUME_YES" != 1 ]; then
  printf "Run it? [y/N] "; read -r ans; [ "$ans" = y ] || [ "$ans" = Y ] || exit 1
fi
curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash || exit 1
export NVM_DIR="$HOME/.nvm"
# nvm's own scripts read variables they never set, so `set -u` must be off while they run.
set +u
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" || exit 1
nvm install 24 || exit 1
set -u
echo "node: $(node --version)   git: $(git --version)"
[ "$(node_major)" -ge 24 ] 2>/dev/null || { echo "Node is still below 24 (stop)" >&2; exit 1; }
echo "bootstrap: OK. In a new terminal (so nvm is loaded): node scripts/e1-run.mjs prepare --platform linux-x86_64 --drill <folder>"

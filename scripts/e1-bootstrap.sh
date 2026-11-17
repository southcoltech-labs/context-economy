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

# The driver writes its scrubbed copy with gitleaks, exactly this version (scripts/e1-scrub.mjs, the CI pin),
# and finds out only at the end of a run. Check it here, before any sign-in. A matching one anywhere on the
# PATH (Homebrew on the Mac) is used. Otherwise it is installed in ~/.local/bin, without sudo: the archive
# is the pinned release asset and is checked against its published sha256 before it is unpacked.
echo "== 0.1b gitleaks 8.30.1 =="
GITLEAKS_VERSION="8.30.1"
GL_MISSING=0
export PATH="$HOME/.local/bin:$PATH"
have_gitleaks() { [ "$(gitleaks version 2>/dev/null)" = "$GITLEAKS_VERSION" ]; }
if have_gitleaks; then
  echo "gitleaks: $(command -v gitleaks) is $GITLEAKS_VERSION"
else
  case "$(uname -sm)" in
    "Linux x86_64") gl_asset="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"; gl_sha="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" ;;
    "Darwin arm64") gl_asset="gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz"; gl_sha="b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" ;;
    *) echo "gitleaks $GITLEAKS_VERSION is missing and there is no pinned download for $(uname -sm) (stop)" >&2; exit 1 ;;
  esac
  if [ "$CHECK_ONLY" = 1 ]; then echo "(--check-only) gitleaks $GITLEAKS_VERSION is missing: would install it in $HOME/.local/bin"; GL_MISSING=1
  else
    echo "gitleaks $GITLEAKS_VERSION is missing: installing $gl_asset in $HOME/.local/bin (sha256 checked)"
    gl_tmp=$(mktemp -d) || exit 1
    trap 'rm -rf "$gl_tmp"' EXIT
    curl -fsSL -o "$gl_tmp/gl.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${gl_asset}" || { rm -rf "$gl_tmp"; echo "download failed (stop)" >&2; exit 1; }
    gl_got=$( (sha256sum "$gl_tmp/gl.tgz" 2>/dev/null || shasum -a 256 "$gl_tmp/gl.tgz") | cut -d' ' -f1)
    [ "$gl_got" = "$gl_sha" ] || { rm -rf "$gl_tmp"; echo "gitleaks archive sha256 is $gl_got, expected $gl_sha (stop)" >&2; exit 1; }
    mkdir -p "$HOME/.local/bin" && tar -xzf "$gl_tmp/gl.tgz" -C "$HOME/.local/bin" gitleaks || exit 1
    rm -rf "$gl_tmp"; trap - EXIT
    have_gitleaks || { echo "gitleaks installed but does not report $GITLEAKS_VERSION (stop)" >&2; exit 1; }
    echo "gitleaks: $(command -v gitleaks) is $GITLEAKS_VERSION"
  fi
fi

echo "== 0.2 Node 24 or later, git =="
# On Linux the Node is always the account's own, installed with nvm in ~/.nvm (no sudo): a system Node is
# not used, so the run does not depend on what the machine happens to have. On macOS nothing is installed.
node_major() { command -v node >/dev/null 2>&1 && node --version | sed -E 's/^v([0-9]+)\..*/\1/' || echo 0; }
export NVM_DIR="$HOME/.nvm"
# nvm's own scripts read variables they never set, so `set -u` must be off while they run.
nvm_load() {
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"; nvm_rc=$?
  set -u
  return "$nvm_rc"
}
node_from_nvm() { case "$(command -v node 2>/dev/null)" in "$NVM_DIR"/*) return 0 ;; esac; return 1; }
is_linux=0; [ "$(uname -s)" = Linux ] && is_linux=1
[ $is_linux = 1 ] && nvm_load
need_node=0; need_git=0
[ "$(node_major)" -ge 24 ] 2>/dev/null || need_node=1
[ $is_linux = 1 ] && ! node_from_nvm && need_node=1
command -v git >/dev/null 2>&1 || need_git=1
echo "node: $(command -v node >/dev/null 2>&1 && echo "$(node --version) at $(command -v node)" || echo missing)   git: $(command -v git >/dev/null 2>&1 && git --version || echo missing)"
if [ "$need_node" = 0 ] && [ "$need_git" = 0 ]; then echo "Node and git are fine."; exit "$GL_MISSING"; fi

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

have_nvm=0; [ -s "$NVM_DIR/nvm.sh" ] && have_nvm=1
if [ $have_nvm = 1 ]; then plan="nvm install 24 (nvm is already in $NVM_DIR)"
else plan="curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash   then: nvm install 24"; fi
if [ "$CHECK_ONLY" = 1 ]; then echo "(--check-only) would install Node 24 with nvm $NVM_VERSION in $NVM_DIR: $plan"; exit 1; fi

echo "About to run: $plan"
if [ "$ASSUME_YES" != 1 ]; then
  printf "Run it? [y/N] "; read -r ans; [ "$ans" = y ] || [ "$ans" = Y ] || exit 1
fi
if [ $have_nvm = 0 ]; then
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash || exit 1
fi
nvm_load || { echo "nvm is not in $NVM_DIR after its installer ran (stop)" >&2; exit 1; }
set +u
nvm install 24 && nvm use 24 >/dev/null
nvm_rc=$?
set -u
[ "$nvm_rc" = 0 ] || { echo "nvm could not install Node 24 (stop)" >&2; exit 1; }
echo "node: $(node --version) at $(command -v node)   git: $(git --version)"
[ "$(node_major)" -ge 24 ] 2>/dev/null || { echo "Node is still below 24 (stop)" >&2; exit 1; }
node_from_nvm || { echo "node is not the one from nvm (stop)" >&2; exit 1; }
echo "bootstrap: OK. In a new terminal (so nvm is loaded): node scripts/e1-run.mjs prepare --platform linux-x86_64 --drill <folder>"

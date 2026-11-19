#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# One command for a real E1 try in a clean account: the bootstrap, then `prepare`, then the baseline,
# then the files to send collected in one folder. It replaces the copy-and-paste of those steps.
#
#   bash scripts/e1-test-run.sh macos|linux [--drill NAME] [--a VERSION] [--send DIR] [--pass-env NAME] [--yes]
#
#   macos   expects Darwin arm64    --platform macos-arm64    files go to /Users/Shared/context-economy-shared/<account>
#   linux   expects Linux x86_64    --platform linux-x86_64   files go to ~/e1-send
#   --drill NAME    the drill folder under ~/e1-runs (default t1)
#   --a VERSION     the version the baseline installs from `release` (default 0.1.2)
#   --send DIR      where the files to send are copied
#   --pass-env NAME the name of a variable that holds the provider key Pi reads (for example DEEPSEEK_API_KEY).
#                   Export it in this shell first. Only the reviewed provider-key names (scripts/e1-pass-env.txt) are accepted.
#                   The script takes it out of the environment of the bootstrap, nvm and `prepare`; the baseline run gets it and
#                   passes it to the Pi session only. The value is never printed. Pi's own tool subprocesses inherit it from Pi.
#                   Repeatable.
#   --yes           on Linux, do not ask before the nvm installer is fetched and run (the bootstrap's --yes)
#
# The operator still answers the pauses (the sign-ins at P.3, the two host sessions in the baseline).
# A failed step stops the chain; the files are collected anyway. What is copied: the scrubbed transcripts
# and the two bootstrap files (e1-start.txt, e1-end.txt: output of the bootstrap and two times, which hold
# the account name and paths only). Never the raw transcripts or scrub-context.json.
set -u

usage() { echo "usage: bash scripts/e1-test-run.sh macos|linux [--drill NAME] [--a VERSION] [--send DIR] [--pass-env NAME] [--yes]" >&2; exit 2; }
[ $# -ge 1 ] || usage
OS="$1"; shift
DRILL=t1; A_VERSION=0.1.2; SEND=""; BOOT_ARGS=(); PASS_ARGS=(); PASS_NAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --drill) [ $# -ge 2 ] || usage; DRILL="$2"; shift 2 ;;
    --a) [ $# -ge 2 ] || usage; A_VERSION="$2"; shift 2 ;;
    --send) [ $# -ge 2 ] || usage; SEND="$2"; shift 2 ;;
    --pass-env) [ $# -ge 2 ] || usage
      case "$2" in [A-Z]*) ;; *) usage ;; esac
      case "$2" in *[!A-Z0-9_]*) usage ;; esac
      # Only the reviewed provider-key names (scripts/e1-pass-env.txt, the list the driver checks too).
      grep -qxF -- "$2" "$(dirname "$0")/e1-pass-env.txt" || { echo "$2 is not a provider key the driver passes to Pi (the reviewed names are in scripts/e1-pass-env.txt)" >&2; exit 2; }
      [ -n "${!2:-}" ] || { echo "$2 is not set in this shell: export it first (or put it in the account's shell profile), then run again" >&2; exit 2; }
      PASS_ARGS+=(--pass-env "$2"); PASS_NAMES+=("$2"); shift 2 ;;
    --yes) BOOT_ARGS+=(--yes); shift ;;
    *) usage ;;
  esac
done
case "$OS" in
  macos) PLATFORM=macos-arm64; WANT_UNAME="Darwin arm64"; : "${SEND:=/Users/Shared/context-economy-shared/$(id -un)}" ;;
  linux) PLATFORM=linux-x86_64; WANT_UNAME="Linux x86_64"; : "${SEND:=$HOME/e1-send}" ;;
  *) usage ;;
esac
case "$DRILL" in *[!A-Za-z0-9._-]*|"") echo "the drill name may hold only letters, digits, . _ -" >&2; exit 2 ;; esac
[ "$(uname -sm)" = "$WANT_UNAME" ] || { echo "this is $(uname -sm), not $WANT_UNAME: use the other label" >&2; exit 2; }

DIR=$(cd "$(dirname "$0")/.." && pwd) || exit 2
START="$HOME/e1-start.txt"; END="$HOME/e1-end.txt"
# The Claude Code installer puts `claude` in ~/.local/bin; the bootstrap puts gitleaks there too.
export PATH="$HOME/.local/bin:$PATH"

# The key must not reach the bootstrap, the installers, nvm or the prepare run: take the variables out of the
# environment of this script (their values stay in this shell) and give them back to the baseline run only.
# shellcheck disable=SC2163  # `export "$n"` exports the variable whose name is in n, on purpose
for n in ${PASS_NAMES[@]+"${PASS_NAMES[@]}"}; do export -n "$n"; done

# 1. The bootstrap (clean check (a), gitleaks, Node and git). Its output is kept in $START.
set -o pipefail
{ date -u +%FT%TZ; echo "driver commit: $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"; bash "$DIR/scripts/e1-bootstrap.sh" "${BOOT_ARGS[@]+"${BOOT_ARGS[@]}"}"; } 2>&1 | tee "$START"
rc=$?
set +o pipefail

# 2. The two driver runs, only if the bootstrap passed.
if [ "$rc" = 0 ]; then
  # On Linux the bootstrap installed Node with nvm in its own process: load it here.
  # shellcheck disable=SC1091
  if [ "$OS" = linux ] && [ -s "$HOME/.nvm/nvm.sh" ]; then set +u; . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null; set -u; fi
  if cd "$DIR"; then
    node scripts/e1-run.mjs prepare --platform "$PLATFORM" --drill "$DRILL" \
      && ( # shellcheck disable=SC2163
           for n in ${PASS_NAMES[@]+"${PASS_NAMES[@]}"}; do export "$n"; done
           node scripts/e1-run.mjs e1b --part baseline --a "$A_VERSION" --drill "$DRILL" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"} )
    rc=$?
  else
    rc=2
  fi
fi

# 3. Collect, whatever happened.
date -u +%FT%TZ > "$END"
mkdir -p "$SEND" && cp "$START" "$END" "$SEND/" || echo "e1-test-run: could not write to $SEND" >&2
if [ -d "$HOME/e1-runs/$DRILL" ]; then
  find "$HOME/e1-runs/$DRILL" -name '*.txt' ! -name '*.raw.txt' | while IFS= read -r f; do
    rel=${f#"$HOME/e1-runs/$DRILL/"}
    cp "$f" "$SEND/$(printf '%s' "$rel" | tr / -)"
  done
fi
echo "e1-test-run: exit $rc. Files to send:"; ls -l "$SEND"
exit "$rc"

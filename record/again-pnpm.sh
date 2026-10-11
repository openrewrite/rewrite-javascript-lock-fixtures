#!/bin/bash
# The second lock-only install (the written lock must survive a second install) for a pnpm scenario: in a fresh scratch project holding the
# edit phase's inputs (`npmrc` as .npmrc, `tree-before/` then `tree/`, `workspace` else `workspace-before` as
# pnpm-workspace.yaml, `pkg` as package.json) and `after` as pnpm-lock.yaml, runs record-pnpm.sh's phase-2
# command again with the same isolation. Phase-2 `args` are not passed: the frozen-* scenarios' only args are
# --frozen-lockfile, which makes the run a check rather than an install.
# Writes <scenario>/pnpm-again.log ending with "exit=<code>" and "lock unchanged" | "lock changed" |
# "no lock written", and <scenario>/again when the lock changed. Files pnpm left beside the lock are listed in
# <scenario>/probes/again-files.txt (evidence, not committed).
#
# Usage: bash record/again-pnpm.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
[ -f "$D/after" ] || { echo "$(basename "$D") no after"; exit 0; }
PNPM="$(command -v pnpm)"
WORK="$(mktemp -d)"
P="$WORK/project"
mkdir -p "$P" "$WORK/home"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config" XDG_CACHE_HOME="$WORK/home/.cache"
export XDG_DATA_HOME="$WORK/home/.local/share" XDG_STATE_HOME="$WORK/home/.local/state"
export npm_config_userconfig=/dev/null pnpm_config_userconfig=/dev/null pnpm_config_npmrc_auth_file=/dev/null
export pnpm_config_update_notifier=false
unset CI PNPM_HOME npm_config_registry
ARGS=(install --lockfile-only --no-color --store-dir="$WORK/store")
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$P/.npmrc"
cd "$P" || exit 1
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -d "$D/tree" ] && cp -R "$D/tree/." .
if [ -f "$D/workspace" ]; then cp "$D/workspace" pnpm-workspace.yaml
elif [ -f "$D/workspace-before" ]; then cp "$D/workspace-before" pnpm-workspace.yaml; fi
cp "$D/pkg" package.json
cp "$D/after" pnpm-lock.yaml
"$PNPM" "${ARGS[@]}" > "$D/pnpm-again.log" 2>&1
G=$?
if [ $G -ne 0 ]; then S="no lock written"; elif cmp -s pnpm-lock.yaml "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
printf 'pnpm %s, node %s, %s\nexit=%s\n%s\n' "$("$PNPM" --version 2>/dev/null | tail -1)" "$(node --version)" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$G" "$S" >> "$D/pnpm-again.log"
rm -f "$D/again"
[ "$S" = "lock changed" ] && cp pnpm-lock.yaml "$D/again"
FILES="$D/probes/again-files.txt"
find . -path ./node_modules -prune -o -type f -print | sort > "$FILES"
[ -d node_modules ] && find node_modules -maxdepth 2 | sort >> "$FILES"
cd / && rm -rf "$WORK"
echo "$(basename "$D") again=$G ($S)"

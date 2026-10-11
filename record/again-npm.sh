#!/bin/bash
# The second lock-only install (the written lock must survive a second install): in a scratch directory holding the scenario's `npmrc`,
# `tree-before/` then `tree/` (as the edit phase had them), `pkg` as package.json and `after` as
# package-lock.json, runs the edit phase's npm command again. Writes <scenario>/npm-again.log ending with
# "exit=<code>" and "lock unchanged" | "lock changed" | "no lock written", and <scenario>/again when the
# lock changed. Pass the lockfile version the edit phase was given (gap-*-v2: 2), none otherwise.
#
# Usage: bash record/again-npm.sh <scenario-dir> [lockfile-version]
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
V="${2:-}"
[ -f "$D/after" ] || { echo "$(basename "$D") no after"; exit 0; }
WORK="$(mktemp -d)"
ARGS=(install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=warn --userconfig /dev/null)
[ -n "$V" ] && ARGS+=(--lockfile-version "$V")
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$WORK/.npmrc"
cd "$WORK" || exit 1
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
cp "$D/after" package-lock.json
npm "${ARGS[@]}" > "$D/npm-again.log" 2>&1
G=$?
if [ $G -ne 0 ]; then S="no lock written"; elif cmp -s package-lock.json "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
printf 'exit=%s\n%s\n' "$G" "$S" >> "$D/npm-again.log"
rm -f "$D/again"
[ "$S" = "lock changed" ] && cp package-lock.json "$D/again"
cd / && rm -rf "$WORK"
echo "$(basename "$D") again=$G ($S)"

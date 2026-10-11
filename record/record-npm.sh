#!/bin/bash
# Records what real npm writes for one scenario, two-phase: install `pkg-before` from scratch,
# then install `pkg` in the same directory over the lock that produced.
#
# The scenario directory must hold `pkg-before` and `pkg` (package.json before and after the edit).
# Optional inputs: `npmrc` (project .npmrc for both phases), `tree-before/` and `tree/` (extra files
# copied into the project before each phase, e.g. workspace member manifests). With a `shrinkwrap` file,
# `npm shrinkwrap` turns the first phase's lock into npm-shrinkwrap.json, which both phases then record.
# Writes: before, after (absent when npm exits non-zero), npm-before.log, npm-after.log,
# recorded-with, http/.
#
# Usage: bash record/record-npm.sh <scenario-dir> [lockfile-version]
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
V="${2:-}"
WORK="$(mktemp -d)"
L=package-lock.json
ARGS=(install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=warn --userconfig /dev/null)
[ -n "$V" ] && ARGS+=(--lockfile-version "$V")
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$WORK/.npmrc"
cd "$WORK" || exit 1

[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
npm "${ARGS[@]}" > "$D/npm-before.log" 2>&1
B=$?
if [ $B -eq 0 ] && [ -f "$D/shrinkwrap" ]; then
  L=npm-shrinkwrap.json
  npm shrinkwrap --ignore-scripts --loglevel=warn --userconfig /dev/null >> "$D/npm-before.log" 2>&1 || B=$?
fi
rm -f "$D/before"
[ $B -eq 0 ] && cp "$L" "$D/before"

[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
npm "${ARGS[@]}" > "$D/npm-after.log" 2>&1
A=$?
rm -f "$D/after"
[ $A -eq 0 ] && cp "$L" "$D/after"

printf 'npm %s, node %s, %s\nbefore exit=%s, after exit=%s\n' \
  "$(npm --version)" "$(node --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" > "$D/recorded-with"
# the machine npm read (process.platform, process.arch, npm-install-checks' libc), for platform checks on replay
node -e "const {libc}=require(require('path').join(process.execPath,'..','..','lib','node_modules','npm','node_modules','npm-install-checks','lib','current-env.js'));console.log('platform os='+process.platform+' cpu='+process.arch+' libc='+(libc(process.platform)||''))" >> "$D/recorded-with"
cd / && rm -rf "$WORK"
# NO_HTTP=1 skips the registry responses (large real-world projects that are only probed live).
[ -z "${NO_HTTP:-}" ] && node "$BIN/fetch-http.js" "$D"
echo "$(basename "$D") before=$B after=$A"

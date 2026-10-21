#!/bin/bash
# Like record-npm.sh, but the before phase may run under different config than the edit:
#   npmrc-before   project .npmrc for the before phase only (provenance; the edit uses `npmrc`)
#   args-before    extra npm arguments for the before phase, one line (e.g. --lockfile-version 2)
#   args-after     extra npm arguments for the edit phase, one line
# Everything else (inputs, outputs, http/) is as in record-npm.sh.
#
# Usage: bash record/record-npm-phased.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
WORK="$(mktemp -d)"
ARGS=(install --package-lock-only --no-audit --no-fund --loglevel=warn --userconfig /dev/null)
BARGS=()
AARGS=()
[ -f "$D/args-before" ] && read -r -a BARGS < "$D/args-before"
[ -f "$D/args-after" ] && read -r -a AARGS < "$D/args-after"
cd "$WORK" || exit 1

[ -f "$D/npmrc-before" ] && cp "$D/npmrc-before" .npmrc
[ ! -f "$D/npmrc-before" ] && [ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
npm "${ARGS[@]}" ${BARGS[@]+"${BARGS[@]}"} > "$D/npm-before.log" 2>&1
B=$?
rm -f "$D/before"
[ $B -eq 0 ] && cp package-lock.json "$D/before"

rm -f .npmrc
[ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
npm "${ARGS[@]}" ${AARGS[@]+"${AARGS[@]}"} > "$D/npm-after.log" 2>&1
A=$?
rm -f "$D/after"
[ $A -eq 0 ] && cp package-lock.json "$D/after"

printf 'npm %s, node %s, %s\nbefore exit=%s, after exit=%s\nbefore args: %s%s\nafter args: %s\n' \
  "$(npm --version)" "$(node --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" \
  "${BARGS[*]:-}" "$([ -f "$D/npmrc-before" ] && echo ' (+npmrc-before)')" "${AARGS[*]:-}" > "$D/recorded-with"
cd / && rm -rf "$WORK"
[ -z "${NO_HTTP:-}" ] && node "$BIN/fetch-http.js" "$D"
echo "$(basename "$D") before=$B after=$A"

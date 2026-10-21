#!/bin/bash
# Records an open-* scenario like record-npm-phased.sh, with every npm run going through npm-proxied.js, and
# adds the second install. Inputs: pkg-before, pkg, and optionally npmrc, npmrc-before, args-before, args-after
# (one line each), tree-before/, tree/, before-input (a starting lock used as is; the before phase is skipped).
# Writes: before (absent with before-input or when npm fails), after, npm-before.log, npm-after.log,
# npm-again.log (a second lock-only install over `after` with `npmrc`; ends with exit=<code> and whether the
# lock changed; `after-again` when it did), requests-{before,after,again}.log (documents npm asked for),
# recorded-with, http/ (fetch-http.js; SAVE_FULL=1 also keeps the full packuments npm fetched as <name>@full),
# before-yarn / after-yarn (the yarn.lock in the project after each phase, when there is one), and with FRESH=1
# fresh + npm-fresh.log (`pkg` installed from scratch with `npmrc`, tree-before/ and tree/).
# NODE_BIN / NPM_CLI pick the node binary and npm cli (default: the node on PATH and the npm installed beside it).
# Usage: bash record/record-npm-open.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
NODE="${NODE_BIN:-$(command -v node)}"
CLI="${NPM_CLI:-$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js}"
export NODE_BIN="$NODE" NPM_CLI="$CLI"
ARGS=(install --package-lock-only --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=warn --userconfig /dev/null)
BARGS=()
AARGS=()
[ -f "$D/args-before" ] && read -r -a BARGS < "$D/args-before"
[ -f "$D/args-after" ] && read -r -a AARGS < "$D/args-after"
SAVE_DIR=-
FULL="$(mktemp -d)"
[ -n "${SAVE_FULL:-}" ] && SAVE_DIR="$FULL"
W="$(mktemp -d)"

[ -f "$D/npmrc-before" ] && cp "$D/npmrc-before" "$W/.npmrc"
[ ! -f "$D/npmrc-before" ] && [ -f "$D/npmrc" ] && cp "$D/npmrc" "$W/.npmrc"
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." "$W/"
cp "$D/pkg-before" "$W/package.json"
rm -f "$D/before" "$D/after" "$D/after-again" "$D/requests-before.log"
B=-
B_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$D/before-input" ]; then
  cp "$D/before-input" "$W/package-lock.json"
  rm -f "$D/npm-before.log"
else
  node "$BIN/npm-proxied.js" "$W" "$D/requests-before.log" "$SAVE_DIR" "${ARGS[@]}" ${BARGS[@]+"${BARGS[@]}"} > "$D/npm-before.log" 2>&1
  B=$?
  [ $B -eq 0 ] && cp "$W/package-lock.json" "$D/before"
fi
rm -f "$D/before-yarn" "$D/after-yarn"
[ -f "$W/yarn.lock" ] && cp "$W/yarn.lock" "$D/before-yarn"

rm -f "$W/.npmrc"
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$W/.npmrc"
[ -d "$D/tree" ] && cp -R "$D/tree/." "$W/"
cp "$D/pkg" "$W/package.json"
A_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node "$BIN/npm-proxied.js" "$W" "$D/requests-after.log" "$SAVE_DIR" "${ARGS[@]}" ${AARGS[@]+"${AARGS[@]}"} > "$D/npm-after.log" 2>&1
A=$?
[ $A -eq 0 ] && cp "$W/package-lock.json" "$D/after"
[ -f "$W/yarn.lock" ] && cp "$W/yarn.lock" "$D/after-yarn"

G=-
if [ $A -eq 0 ]; then
  node "$BIN/npm-proxied.js" "$W" "$D/requests-again.log" "$SAVE_DIR" "${ARGS[@]}" ${AARGS[@]+"${AARGS[@]}"} > "$D/npm-again.log" 2>&1
  G=$?
  if cmp -s "$W/package-lock.json" "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
  [ $G -eq 0 ] || S="no lock written"
  printf 'exit=%s\n%s\n' "$G" "$S" >> "$D/npm-again.log"
  [ $G -eq 0 ] && ! cmp -s "$W/package-lock.json" "$D/after" && cp "$W/package-lock.json" "$D/after-again"
else
  rm -f "$D/npm-again.log" "$D/requests-again.log"
fi

rm -f "$D/fresh" "$D/npm-fresh.log"
if [ -n "${FRESH:-}" ]; then
  F="$(mktemp -d)"
  [ -f "$D/npmrc" ] && cp "$D/npmrc" "$F/.npmrc"
  [ -d "$D/tree-before" ] && cp -R "$D/tree-before/." "$F/"
  [ -d "$D/tree" ] && cp -R "$D/tree/." "$F/"
  rm -f "$F/package-lock.json"
  cp "$D/pkg" "$F/package.json"
  node "$BIN/npm-proxied.js" "$F" /dev/null - "${ARGS[@]}" ${AARGS[@]+"${AARGS[@]}"} > "$D/npm-fresh.log" 2>&1
  echo "exit=$?" >> "$D/npm-fresh.log"
  [ -f "$F/package-lock.json" ] && cp "$F/package-lock.json" "$D/fresh"
  rm -rf "$F"
fi

printf 'npm %s, node %s, %s\nbefore exit=%s at %s, after exit=%s at %s, again exit=%s\nbefore args: %s%s%s\nafter args: %s\n' \
  "$("$NODE" "$CLI" --version)" "$("$NODE" --version)" "$(date -u +%Y-%m-%d)" "$B" "$B_AT" "$A" "$A_AT" "$G" \
  "${BARGS[*]:-}" "$([ -f "$D/npmrc-before" ] && echo ' (+npmrc-before)')" "$([ -f "$D/before-input" ] && echo ' (before-input)')" \
  "${AARGS[*]:-}" > "$D/recorded-with"
rm -rf "$W"
if [ -n "${SAVE_FULL:-}" ]; then
  mkdir -p "$D/http"
  (cd "$FULL" && find . -name '*@full' -exec sh -c 'mkdir -p "$1/$(dirname "$2")" && cp "$2" "$1/$2"' _ "$D/http" {} \;)
fi
rm -rf "$FULL"
[ -z "${NO_HTTP:-}" ] && node "$BIN/fetch-http.js" "$D"
echo "$(basename "$D") before=$B after=$A again=$G"

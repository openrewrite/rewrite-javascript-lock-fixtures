#!/bin/bash
# record-npm.sh with a user config: `user-npmrc` is npm's --userconfig in both phases, `user-npmrc-before`
# (empty: none; the global config is an empty file) in phase one instead. Each phase runs with its own empty cache at --loglevel=http, so the
# logs name every document npm asks for. Also runs the second install over `after` (again-npm.sh's
# npm-again.log and `again`). http/ and http-<label>/ hold, verbatim, every document the edit phase asked
# for, by registry (registry.<label>.<tld>), refetched with npm's Accept header.
# Inputs: pkg-before, pkg, about; optional npmrc (both phases), npmrc-before, tree-before/, tree/.
# Usage: bash record/record-npm-user.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
WORK="$(mktemp -d)"
mkdir -p "$WORK/proj" "$WORK/again" && : > "$WORK/globalrc" && : > "$WORK/no-userrc"
ARGS=(install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=http --no-update-notifier --globalconfig "$WORK/globalrc")

userconfig() { # $1 = before | after
  if [ "$1" = before ] && [ -f "$D/user-npmrc-before" ]; then
    [ -s "$D/user-npmrc-before" ] && { cp "$D/user-npmrc-before" "$WORK/user-npmrc-before"; echo "$WORK/user-npmrc-before"; return; }
    echo "$WORK/no-userrc"; return
  fi
  [ -f "$D/user-npmrc" ] && { cp "$D/user-npmrc" "$WORK/user-npmrc"; echo "$WORK/user-npmrc"; return; }
  echo "$WORK/no-userrc"
}

project_npmrc() { # $1 = before | after
  rm -f .npmrc
  if [ "$1" = before ] && [ -f "$D/npmrc-before" ]; then cp "$D/npmrc-before" .npmrc
  elif [ -f "$D/npmrc" ]; then cp "$D/npmrc" .npmrc; fi
  return 0
}

cd "$WORK/proj" || exit 1
project_npmrc before
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
npm "${ARGS[@]}" --cache "$WORK/cache-before" --userconfig "$(userconfig before)" > "$D/npm-before.log" 2>&1
B=$?
rm -f "$D/before" "$D/after" "$D/again"
[ $B -eq 0 ] && cp package-lock.json "$D/before"

project_npmrc after
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm "${ARGS[@]}" --cache "$WORK/cache-after" --userconfig "$(userconfig after)" > "$D/npm-after.log" 2>&1
A=$?
[ $A -eq 0 ] && cp package-lock.json "$D/after"

G=skipped
if [ -f "$D/after" ]; then
  cp -R "$WORK/proj/." "$WORK/again/"
  cd "$WORK/again" || exit 1
  npm "${ARGS[@]}" --cache "$WORK/cache-again" --userconfig "$(userconfig after)" > "$D/npm-again.log" 2>&1
  G=$?
  if [ $G -ne 0 ]; then S="no lock written"; elif cmp -s package-lock.json "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
  printf 'exit=%s\n%s\n' "$G" "$S" >> "$D/npm-again.log"
  [ "$S" = "lock changed" ] && cp package-lock.json "$D/again"
fi

printf 'npm %s, node %s, %s\nbefore exit=%s, after exit=%s at %s, again exit=%s\n' \
  "$(npm --version)" "$(node --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" "$STARTED" "$G" > "$D/recorded-with"
node -e "const {libc}=require(require('path').join(process.execPath,'..','..','lib','node_modules','npm','node_modules','npm-install-checks','lib','current-env.js'));console.log('platform os='+process.platform+' cpu='+process.arch+' libc='+(libc(process.platform)||''))" >> "$D/recorded-with"
cd / && rm -rf "$WORK"
node "$BIN/fetch-asked.js" npm "$D" "$D/npm-after.log"
echo "$(basename "$D") before=$B after=$A again=$G"

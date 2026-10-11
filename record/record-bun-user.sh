#!/bin/bash
# record-bun-open.sh with a user config: `user-npmrc` is $HOME/.npmrc of a scratch HOME (XDG_CONFIG_HOME unset, so
# bun reads it there) in every phase, `user-npmrc-before` (empty: none) in phase one instead. The edit is rerun from
# an empty cache with --verbose (requests-after.log: one `GET <url> accept=<...>` per request); http/ and
# http-<label>/ hold, verbatim, every document that rerun asked for, by registry (registry.<label>.<tld>).
# Inputs: pkg-before, pkg, about; optional npmrc, bunfig (both phases unless npmrc-before / bunfig-before),
# tree-before/, tree/. Writes before, after, again, fresh and their logs as record-bun-open.sh does.
# Usage: bash record/record-bun-user.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
BUN="$(command -v bun)"
NODE="$(command -v node)"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home" "$WORK/cache" "$WORK/cache-req" "$WORK/tmp" "$WORK/proj" "$WORK/fresh"

run_bun() {
  local cache="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "${BUN_TIMEOUT:-120}" \
  env -i PATH="/usr/bin:/bin" HOME="$WORK/home" XDG_CACHE_HOME="$WORK/home/.cache" BUN_INSTALL_CACHE_DIR="$cache" \
    TMPDIR="$WORK/tmp" NO_COLOR=1 "$BUN" install --lockfile-only --no-progress "$@"
}

user_config() { # $1 = before | after
  rm -f "$WORK/home/.npmrc"
  if [ "$1" = before ] && [ -f "$D/user-npmrc-before" ]; then
    [ -s "$D/user-npmrc-before" ] && cp "$D/user-npmrc-before" "$WORK/home/.npmrc"
  elif [ -f "$D/user-npmrc" ]; then cp "$D/user-npmrc" "$WORK/home/.npmrc"; fi
  return 0
}

seed_config() { # $1 = before | after
  rm -f .npmrc bunfig.toml
  if [ "$1" = before ] && [ -f "$D/npmrc-before" ]; then cp "$D/npmrc-before" .npmrc
  elif [ -f "$D/npmrc" ]; then cp "$D/npmrc" .npmrc; fi
  if [ "$1" = before ] && [ -f "$D/bunfig-before" ]; then cp "$D/bunfig-before" bunfig.toml
  elif [ -f "$D/bunfig" ]; then cp "$D/bunfig" bunfig.toml; fi
  user_config "$1"
}

edit_inputs() {
  seed_config after
  [ -d "$D/tree" ] && cp -R "$D/tree/." .
  cp "$D/pkg" package.json
}

rm -f "$D/before" "$D/after" "$D/again" "$D/fresh" "$D/files-after"
cd "$WORK/proj" || exit 1
seed_config before
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
run_bun "$WORK/cache" > "$D/bun-before.log" 2>&1
B=$?
[ "$B" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/before"

mkdir -p "$WORK/req" && cp -R "$WORK/proj/." "$WORK/req/"

edit_inputs
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_bun "$WORK/cache" > "$D/bun-after.log" 2>&1
A=$?
ls -A | grep -v '^node_modules$' > "$D/files-after"
[ "$A" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/after"

F=skipped
if [ -f "$D/after" ]; then
  mkdir -p "$WORK/frozen" && cp -R "$WORK/proj/." "$WORK/frozen/"
  cd "$WORK/frozen" || exit 1
  run_bun "$WORK/cache" --frozen-lockfile > "$D/bun-frozen.log" 2>&1
  F=$?
fi

G=skipped
mkdir -p "$WORK/again" && cp -R "$WORK/proj/." "$WORK/again/"
cd "$WORK/again" || exit 1
if [ -f "$D/after" ]; then
  run_bun "$WORK/cache" > "$D/bun-again.log" 2>&1
  G=$?
  if [ ! -f bun.lock ]; then S="no lock written"; elif cmp -s bun.lock "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
  printf 'exit=%s\n%s\n' "$G" "$S" >> "$D/bun-again.log"
  [ "$S" = "lock changed" ] && cp bun.lock "$D/again"
fi

cd "$WORK/req" || exit 1
edit_inputs
run_bun "$WORK/cache-req" --verbose > "$WORK/req.log" 2>&1
QE=$?
awk '/^> HTTP\/1.1 /{if(u!="")print u" accept="a; u=$3" "$4; a="-"} /^> Accept: /{sub(/^> Accept: /,""); a=$0} END{if(u!="")print u" accept="a}' "$WORK/req.log" > "$D/requests-after.log"
if [ ! -f bun.lock ]; then QS="no lock written"; elif [ -f "$D/after" ] && cmp -s bun.lock "$D/after"; then QS="lock same as after"; else QS="lock differs from after"; fi
printf 'exit=%s, %s\n' "$QE" "$QS" >> "$D/requests-after.log"

cd "$WORK/fresh" || exit 1
seed_config after
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
run_bun "$WORK/cache" > "$D/bun-fresh.log" 2>&1
R=$?
[ "$R" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/fresh"

PLATFORM="$("$BUN" -e 'console.log(`os=${process.platform} cpu=${process.arch} libc=`)')"
printf 'bun %s, node %s (fetch only), %s\nbefore exit=%s, after exit=%s, frozen-over-after exit=%s, fresh exit=%s, again exit=%s, empty-cache rerun exit=%s\nplatform %s\nedit started %s\n' \
  "$("$BUN" --version)" "$("$NODE" --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" "$F" "$R" "$G" "$QE" "$PLATFORM" "$STARTED" > "$D/recorded-with"
cd / && rm -rf "$WORK"
"$NODE" "$BIN/fetch-asked.js" bun "$D" "$D/requests-after.log"
echo "$(basename "$D") before=$B after=$A frozen=$F again=$G ($(tail -1 "$D/bun-again.log" 2>/dev/null)) fresh=$R requests: $(tail -1 "$D/requests-after.log")"

#!/bin/bash
# Records an `open-*` Bun scenario: record-bun.sh's phases (before, after, frozen check, fresh) plus the evidence the
# open-questions study needs. Hermetic as record-bun.sh (HOME, XDG, cache, TMPDIR in a throwaway directory).
#
# Inputs: pkg-before, pkg, about; optional npmrc, bunfig (the edit phase's config, and phase one's unless
# npmrc-before / bunfig-before is given), tree-before/, tree/, lock-before (a hand-made start; phase one skipped),
# registry/ (hand-made abbreviated packuments: bun-stub-registry.js serves them on 127.0.0.1:$STUB_PORT, default
# 48731, and proxies the rest to registry.npmjs.org; the scenario's config names that registry).
# Writes: before, after, fresh, bun-{before,after,frozen,fresh}.log, recorded-with (4th line: the edit phase's
# start, UTC), files-after (the project root after the edit), after.lockb / before.lockb when bun wrote binary;
#   requests-after.log: the edit rerun from an EMPTY install cache with --verbose: one line per request
#     (`GET <url> accept=<...>`), then whether that rerun wrote the same lock as `after`;
#   bun-again.log (+ `again` when the lock changed): the second install with `pkg` and the edit's config, over
#     `after`, or over `before` when the edit failed (does the failure repeat); ends `exit=<n>` and
#     `lock unchanged` | `lock changed` | `no lock written`;
#   http/: registry responses (fetch-http.js names from the locks, plus EXTRA), or with registry/ every body the
#     stub served.
# Usage: [STUB_PORT=48731] [NO_HTTP=1] [EXTRA="a b@1.0.0"] bash record/record-bun-open.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
BUN="$(command -v bun)"
NODE="$(command -v node)"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home/.config" "$WORK/cache" "$WORK/cache-req" "$WORK/tmp" "$WORK/proj" "$WORK/fresh"
PORT="${STUB_PORT:-48731}"

# every bun run is killed after $BUN_TIMEOUT seconds (default 120; exit 142): bun 1.3.10 can spin forever
run_bun() {
  local cache="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "${BUN_TIMEOUT:-120}" \
  env -i PATH="/usr/bin:/bin" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" \
    XDG_CACHE_HOME="$WORK/home/.cache" BUN_INSTALL_CACHE_DIR="$cache" TMPDIR="$WORK/tmp" \
    NO_COLOR=1 "$BUN" install --lockfile-only --no-progress "$@"
}

seed_config() { # $1 = before | after
  rm -f .npmrc bunfig.toml
  if [ "$1" = before ] && [ -f "$D/npmrc-before" ]; then cp "$D/npmrc-before" .npmrc
  elif [ -f "$D/npmrc" ]; then cp "$D/npmrc" .npmrc; fi
  if [ "$1" = before ] && [ -f "$D/bunfig-before" ]; then cp "$D/bunfig-before" bunfig.toml
  elif [ -f "$D/bunfig" ]; then cp "$D/bunfig" bunfig.toml; fi
  return 0
}

edit_inputs() {
  seed_config after
  [ -d "$D/tree" ] && cp -R "$D/tree/." .
  cp "$D/pkg" package.json
}

STUB=""
if [ -d "$D/registry" ]; then
  rm -rf "$D/stub-requests.log" "$D/http"
  "$NODE" "$BIN/bun-stub-registry.js" "$D" "$PORT" > "$WORK/stub.out" 2>&1 &
  STUB=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    grep -q listening "$WORK/stub.out" 2>/dev/null && break
    perl -e 'select(undef,undef,undef,0.25)'
  done
fi

rm -f "$D/before" "$D/after" "$D/again" "$D/fresh" "$D/before.lockb" "$D/after.lockb" "$D/files-after"
# link/<name>/: registered with `bun link` in the scratch home (the user's global link directory) for every phase
if [ -d "$D/link" ]; then
  mkdir -p "$WORK/links" && cp -R "$D/link/." "$WORK/links/"
  for L in "$WORK/links"/*/; do
    (cd "$L" && env -i PATH="/usr/bin:/bin" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" \
      XDG_CACHE_HOME="$WORK/home/.cache" BUN_INSTALL_CACHE_DIR="$WORK/cache" TMPDIR="$WORK/tmp" NO_COLOR=1 \
      "$BUN" link > /dev/null 2>&1)
  done
fi
cd "$WORK/proj" || exit 1
seed_config before
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
if [ -f "$D/lock-before" ]; then
  cp "$D/lock-before" bun.lock
  cp "$D/lock-before" "$D/before"
  echo "lock-before supplied; phase one skipped" > "$D/bun-before.log"
  B=seeded
else
  run_bun "$WORK/cache" > "$D/bun-before.log" 2>&1
  B=$?
  [ "$B" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/before"
  [ "$B" -eq 0 ] && [ -f bun.lockb ] && cp bun.lockb "$D/before.lockb"
fi

# the edit's starting state, kept for the empty-cache rerun
mkdir -p "$WORK/req" && cp -R "$WORK/proj/." "$WORK/req/"

edit_inputs
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_bun "$WORK/cache" > "$D/bun-after.log" 2>&1
A=$?
ls -A | grep -v '^node_modules$' > "$D/files-after"
[ "$A" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/after"
[ "$A" -eq 0 ] && [ -f bun.lockb ] && cp bun.lockb "$D/after.lockb"

F=skipped
if [ -f "$D/after" ]; then
  mkdir -p "$WORK/frozen" && cp -R "$WORK/proj/." "$WORK/frozen/"
  cd "$WORK/frozen" || exit 1
  run_bun "$WORK/cache" --frozen-lockfile > "$D/bun-frozen.log" 2>&1
  F=$?
fi

# the second install: over after, or over the untouched start when the edit failed
G=skipped
mkdir -p "$WORK/again" && cp -R "$WORK/proj/." "$WORK/again/"
cd "$WORK/again" || exit 1
LOCKF=bun.lock; NOTE=""
if [ -f "$D/after" ]; then REF="$D/after"
elif [ -f "$D/after.lockb" ]; then REF="$D/after.lockb"; LOCKF=bun.lockb; NOTE=" (binary bun.lockb)"
elif [ "$A" -eq 0 ]; then REF="none"; NOTE=" (the edit left no lock file)"
elif [ -f "$D/before" ]; then REF="$D/before"; NOTE=" (over before: the edit failed)"
else REF=""; fi
if [ -n "$REF" ]; then
  run_bun "$WORK/cache" > "$D/bun-again.log" 2>&1
  G=$?
  if [ ! -f "$LOCKF" ]; then S="no lock written"; elif [ "$REF" != none ] && cmp -s "$LOCKF" "$REF"; then S="lock unchanged"; else S="lock changed"; fi
  printf 'exit=%s\n%s%s\n' "$G" "$S" "$NOTE" >> "$D/bun-again.log"
  [ "$S" = "lock changed" ] && [ "$LOCKF" = bun.lock ] && cp bun.lock "$D/again"
fi

# the edit again from an empty cache, verbose: what bun fetches
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
[ -n "$STUB" ] && kill "$STUB" 2>/dev/null
cd / && rm -rf "$WORK"
if [ -z "${NO_HTTP:-}" ] && [ -z "$STUB" ]; then
  # shellcheck disable=SC2046
  "$NODE" "$BIN/fetch-http.js" "$D" $("$NODE" "$BIN/bun-lock-names.js" "$D") ${EXTRA:-} > /dev/null
fi
echo "$(basename "$D") before=$B after=$A frozen=$F again=$G ($(tail -1 "$D/bun-again.log" 2>/dev/null)) fresh=$R requests: $(tail -1 "$D/requests-after.log")"

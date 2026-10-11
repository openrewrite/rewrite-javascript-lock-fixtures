#!/bin/bash
# Records what real Bun writes for one scenario, two-phase: install `pkg-before` from scratch, then install
# `pkg` in the same directory over the bun.lock that produced. Also checks the result is a fixpoint
# (`--frozen-lockfile` over `after`) and records a from-scratch install of `pkg` as `fresh` for comparison.
#
# Inputs in the scenario directory: `pkg-before`, `pkg` (package.json before and after the edit).
# Optional: `npmrc` (project .npmrc), `bunfig` (project bunfig.toml), `tree-before/` and `tree/` (extra
# files copied into the project before each phase, e.g. workspace member manifests), `lock-before` (a
# hand-written starting bun.lock used instead of phase one, e.g. an older format; copied verbatim to `before`).
# Writes: before, after (absent when bun exits non-zero), fresh, bun-before.log, bun-after.log,
# bun-frozen.log, bun-fresh.log, recorded-with, http/.
#
# The user configuration is hermetic: HOME, XDG dirs, the install cache and TMPDIR point into a throwaway
# directory and the environment is cleared, so neither ~/.npmrc nor ~/.bunfig.toml is ever read.
#
# Usage: bash record/record-bun.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
BUN="$(command -v bun)"
NODE="$(command -v node)"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home/.config" "$WORK/cache" "$WORK/tmp" "$WORK/proj" "$WORK/fresh"

run_bun() {
  env -i PATH="/usr/bin:/bin" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" \
    XDG_CACHE_HOME="$WORK/home/.cache" BUN_INSTALL_CACHE_DIR="$WORK/cache" TMPDIR="$WORK/tmp" \
    NO_COLOR=1 "$BUN" install --lockfile-only --no-progress "$@"
}

seed_config() {
  [ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
  [ -f "$D/bunfig" ] && cp "$D/bunfig" bunfig.toml
  return 0
}

cd "$WORK/proj" || exit 1
seed_config
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
rm -f "$D/before"
if [ -f "$D/lock-before" ]; then
  cp "$D/lock-before" bun.lock
  cp "$D/lock-before" "$D/before"
  echo "lock-before supplied; phase one skipped" > "$D/bun-before.log"
  B=seeded
else
  run_bun > "$D/bun-before.log" 2>&1
  B=$?
  [ "$B" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/before"
fi

[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
run_bun > "$D/bun-after.log" 2>&1
A=$?
rm -f "$D/after"
[ "$A" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/after"

F=skipped
if [ -f "$D/after" ]; then
  mkdir -p "$WORK/frozen" && cp -R "$WORK/proj/." "$WORK/frozen/"
  cd "$WORK/frozen" || exit 1
  run_bun --frozen-lockfile > "$D/bun-frozen.log" 2>&1
  F=$?
fi

cd "$WORK/fresh" || exit 1
seed_config
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
run_bun > "$D/bun-fresh.log" 2>&1
R=$?
rm -f "$D/fresh"
[ "$R" -eq 0 ] && [ -f bun.lock ] && cp bun.lock "$D/fresh"

printf 'bun %s, node %s (fetch only), %s\nbefore exit=%s, after exit=%s, frozen-over-after exit=%s, fresh exit=%s\n' \
  "$("$BUN" --version)" "$("$NODE" --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" "$F" "$R" > "$D/recorded-with"
cd / && rm -rf "$WORK"
# NO_HTTP=1 skips the registry responses; EXTRA="a b@1.0.0" adds names a replay needs beyond the locks.
if [ -z "${NO_HTTP:-}" ]; then
  # shellcheck disable=SC2046
  "$NODE" "$BIN/fetch-http.js" "$D" $("$NODE" "$BIN/bun-lock-names.js" "$D") ${EXTRA:-}
fi
echo "$(basename "$D") before=$B after=$A frozen=$F fresh=$R"

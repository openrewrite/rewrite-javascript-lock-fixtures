#!/bin/bash
# Records what real Yarn 1 (classic) writes for one scenario, two-phase: install `pkg-before` from scratch,
# then install `pkg` in the same directory over the yarn.lock that produced (node_modules removed first, as in
# a fresh checkout). A third phase replays `pkg` over `after` with --frozen-lockfile in a clean directory to
# show whether yarn accepts its own lock unchanged.
#
# The scenario directory must hold `pkg-before` and `pkg`. Optional inputs: `yarnrc` / `npmrc` (project
# .yarnrc / .npmrc for every phase), `tree-before/` and `tree/` (extra files copied into the project before
# each phase, e.g. workspace member manifests), `http-extra` (more `name` or `name@version` to fetch, one per
# line), `tarballs` (any content: also store each locked tarball under http/).
# Writes: before, after (absent when yarn exits non-zero), yarn-before.log, yarn-after.log, yarn-frozen.log,
# yarn-fixpoint.log, recorded-with, http/. With `before-given` (a crafted input lock) phase 1 is skipped and
# `before` is a copy of it.
#
# Hermetic: env -i with HOME and YARN_CACHE_FOLDER in a scratch directory, so no user .yarnrc/.npmrc and no
# npm_config_*/YARN_* variables reach yarn.
#
# Usage: bash record/record-yarn-classic.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
NODE_DIR="$(dirname "$(command -v node)")"
YARN="$(command -v yarn)"
YARN_DIR="$(dirname "$YARN")"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home" "$WORK/cache" "$WORK/project" "$WORK/frozen"
ENV=(env -i "PATH=$NODE_DIR:$YARN_DIR:/usr/bin:/bin" "HOME=$WORK/home" "YARN_CACHE_FOLDER=$WORK/cache" "TMPDIR=$WORK")
ARGS=(install --ignore-scripts --non-interactive --no-progress)
YV="$("${ENV[@]}" yarn --version)"

setup() {
  [ -f "$D/yarnrc" ] && cp "$D/yarnrc" "$1/.yarnrc"
  [ -f "$D/npmrc" ] && cp "$D/npmrc" "$1/.npmrc"
  return 0
}

P="$WORK/project"
setup "$P"
cd "$P" || exit 1
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
cp "$D/pkg-before" package.json
if [ -f "$D/before-given" ]; then
  # A crafted input lock (an older format, another host, CRLF, ...): phase 1 is not run.
  cp "$D/before-given" yarn.lock
  cp "$D/before-given" "$D/before"
  B=given
  rm -f "$D/yarn-before.log"
else
  "${ENV[@]}" yarn "${ARGS[@]}" > "$D/yarn-before.log" 2>&1
  B=$?
  rm -f "$D/before"
  [ $B -eq 0 ] && cp yarn.lock "$D/before"
fi

rm -rf node_modules
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
"${ENV[@]}" yarn "${ARGS[@]}" > "$D/yarn-after.log" 2>&1
A=$?
rm -f "$D/after"
[ $A -eq 0 ] && [ -f yarn.lock ] && cp yarn.lock "$D/after"

F=skipped
X=skipped
if [ -f "$D/after" ]; then
  setup "$WORK/frozen"
  cd "$WORK/frozen" || exit 1
  [ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
  [ -d "$D/tree" ] && cp -R "$D/tree/." .
  cp "$D/pkg" package.json
  cp "$D/after" yarn.lock
  # --frozen-lockfile only checks that every top-level pattern is locked; a plain re-install in a clean
  # directory shows whether yarn would change its own lock.
  "${ENV[@]}" yarn "${ARGS[@]}" --frozen-lockfile > "$D/yarn-frozen.log" 2>&1
  F=$?
  rm -rf node_modules
  "${ENV[@]}" yarn "${ARGS[@]}" > "$D/yarn-fixpoint.log" 2>&1
  X=$?
  if [ "$X" = 0 ]; then
    cmp -s yarn.lock "$D/after" && X=same || X=changed
  fi
fi

printf 'yarn %s, node %s, %s\nbefore exit=%s, after exit=%s, frozen exit=%s, re-install=%s\n' \
  "$YV" "$(node --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" "$F" "$X" > "$D/recorded-with"
cd / && rm -rf "$WORK"

if [ -z "${NO_HTTP:-}" ]; then
  NAMES="$(node "$BIN/yarn-lock-names.js" "$D")"
  EXTRA=""
  [ -f "$D/http-extra" ] && EXTRA="$(cat "$D/http-extra")"
  # shellcheck disable=SC2086
  node "$BIN/fetch-http.js" "$D" $NAMES $EXTRA
  [ -f "$D/tarballs" ] && node "$BIN/yarn-lock-names.js" "$D" --tarballs > /dev/null
fi
echo "$(basename "$D") before=$B after=$A frozen=$F re-install=$X"

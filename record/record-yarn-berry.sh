#!/bin/bash
# Records what real Yarn Berry writes for one scenario, two-phase like record-npm.sh: install `pkg-before`
# from scratch, then install `pkg` in the same directory over the lock that produced. Both phases run
# `yarn install --mode=update-lockfile` through corepack; pkg-before and pkg must name the Yarn version in
# their packageManager field (e.g. "yarn@4.5.3"). Each phase runs the version its own manifest names, so a
# scenario can migrate a lock written by an older Yarn.
#
# Inputs in the scenario directory: pkg-before, pkg (package.json before/after the edit), about.
# Optional: yarnrc (project .yarnrc.yml for both phases), yarnrc-after (replaces it for the second phase),
#   tree-before/ and tree/ (extra files copied into the project before each phase, e.g. workspace members),
#   lock-seed (a yarn.lock to start phase one from instead of an empty file, e.g. one written by Yarn 1),
#   before-commands (one `yarn` argument list per line, run after the phase-one install and before `before`
#     is saved, e.g. `set resolution ms@npm:^2.1.0 npm:2.1.2` to make a lock whose range is not at its max),
#   http-names (extra name or name@version registry responses to fetch, whitespace-separated).
# Writes: before, after (absent when yarn exits non-zero), yarn-before.log, yarn-after.log, recorded-with,
#   pkg-before.written / pkg.written (only when yarn rewrote package.json), yarnrc-before.written /
#   yarnrc.written (only when yarn wrote .yarnrc.yml, e.g. migration settings), http/.
#
# Hermetic: HOME, the corepack home, the Yarn global folder and cache folder are scratch directories (the
# corepack home is kept under .cache/ to avoid re-downloading Yarn), so no ~/.yarnrc.yml or ~/.npmrc is read.
#
# Usage: bash record/record-yarn-berry.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
ROOT="$(cd "$BIN/.." && pwd)"
WORK="$(mktemp -d)"
PROJECT="$WORK/project"
mkdir -p "$PROJECT" "$WORK/home" "$WORK/global" "$WORK/cache"

for f in pkg-before pkg; do
  if ! grep -q '"packageManager" *: *"yarn@' "$D/$f"; then
    echo "$D/$f has no packageManager yarn@<version> field" >&2
    exit 2
  fi
done

export HOME="$WORK/home"
export COREPACK_HOME="$ROOT/.cache/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
export COREPACK_ENABLE_STRICT=1
export YARN_GLOBAL_FOLDER="$WORK/global"
export YARN_CACHE_FOLDER="$WORK/cache"
export YARN_ENABLE_TELEMETRY=0
export YARN_ENABLE_GLOBAL_CACHE=false
export YARN_ENABLE_IMMUTABLE_INSTALLS=false
export YARN_ENABLE_PROGRESS_BARS=false
export YARN_ENABLE_COLORS=false
unset CI

cd "$PROJECT" || exit 1

[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -f "$D/yarnrc" ] && cp "$D/yarnrc" .yarnrc.yml
if [ -f "$D/lock-seed" ]; then cp "$D/lock-seed" yarn.lock; else : > yarn.lock; fi
cp "$D/pkg-before" package.json
YB="$(corepack yarn --version 2>/dev/null)"
corepack yarn install --mode=update-lockfile > "$D/yarn-before.log" 2>&1
B=$?
if [ $B -eq 0 ] && [ -f "$D/before-commands" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    echo "+ yarn $line" >> "$D/yarn-before.log"
    # shellcheck disable=SC2086
    corepack yarn $line >> "$D/yarn-before.log" 2>&1 || B=$?
  done < "$D/before-commands"
fi
rm -f "$D/before" "$D/pkg-before.written" "$D/yarnrc-before.written"
[ $B -eq 0 ] && cp yarn.lock "$D/before"
cmp -s package.json "$D/pkg-before" || cp package.json "$D/pkg-before.written"
if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$D/yarnrc"; then cp .yarnrc.yml "$D/yarnrc-before.written"; fi

[ -d "$D/tree" ] && cp -R "$D/tree/." .
[ -f "$D/yarnrc-after" ] && cp "$D/yarnrc-after" .yarnrc.yml
cp "$D/pkg" package.json
YA="$(corepack yarn --version 2>/dev/null)"
A=skipped
rm -f "$D/after" "$D/pkg.written" "$D/yarnrc.written"
cp .yarnrc.yml "$WORK/yarnrc-in" 2>/dev/null || : > "$WORK/yarnrc-in"
if [ $B -eq 0 ]; then
  corepack yarn install --mode=update-lockfile > "$D/yarn-after.log" 2>&1
  A=$?
  [ $A -eq 0 ] && cp yarn.lock "$D/after"
  cmp -s package.json "$D/pkg" || cp package.json "$D/pkg.written"
  if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$WORK/yarnrc-in"; then cp .yarnrc.yml "$D/yarnrc.written"; fi
fi

printf 'yarn %s then %s (corepack %s), node %s, %s %s (node %s), %s\nbefore exit=%s, after exit=%s\n' \
  "$YB" "$YA" "$(corepack --version)" "$(node --version)" "$(uname -s)" "$(uname -m)" \
  "$(node -p 'process.platform + "-" + process.arch')" "$(date -u +%Y-%m-%d)" "$B" "$A" > "$D/recorded-with"
cd / && rm -rf "$WORK"
# NO_HTTP=1 skips the registry responses.
[ -z "${NO_HTTP:-}" ] && node "$BIN/yarn-berry-http.js" "$D"
echo "$(basename "$D") before=$B after=$A"

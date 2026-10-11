#!/bin/bash
# record-yarn-classic.sh with a user config: `user-npmrc` / `user-yarnrc` become $HOME/.npmrc / $HOME/.yarnrc for the
# edit's install and the installs over its lock (phase 1 runs without them). Those phases go through a logging
# proxy (connect-proxy.js), whose targets are written to `proxy-after.log`.
# Usage: bash record/record-yarn-classic-user.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
NODE_DIR="$(dirname "$(command -v node)")"
YARN="$(command -v yarn)"
YARN_DIR="$(dirname "$YARN")"
WORK="$(mktemp -d)"
PORT=${PROXY_PORT:-4891}
mkdir -p "$WORK/home" "$WORK/cache" "$WORK/project" "$WORK/frozen"
ENV=(env -i "PATH=$NODE_DIR:$YARN_DIR:/usr/bin:/bin" "HOME=$WORK/home" "YARN_CACHE_FOLDER=$WORK/cache" "TMPDIR=$WORK")
PROXIED=("${ENV[@]}" "npm_config_https_proxy=http://127.0.0.1:$PORT" "npm_config_proxy=http://127.0.0.1:$PORT")
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
"${ENV[@]}" yarn "${ARGS[@]}" > "$D/yarn-before.log" 2>&1
B=$?
rm -f "$D/before"
[ $B -eq 0 ] && cp yarn.lock "$D/before"

[ -f "$D/user-npmrc" ] && cp "$D/user-npmrc" "$WORK/home/.npmrc"
[ -f "$D/user-yarnrc" ] && cp "$D/user-yarnrc" "$WORK/home/.yarnrc"
rm -f "$D/proxy-after.log"
node "$BIN/connect-proxy.js" "$PORT" "$D/proxy-after.log" &
PROXY=$!
sleep 1
rm -rf node_modules
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
"${PROXIED[@]}" yarn "${ARGS[@]}" > "$D/yarn-after.log" 2>&1
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
  "${PROXIED[@]}" yarn "${ARGS[@]}" --frozen-lockfile > "$D/yarn-frozen.log" 2>&1
  F=$?
  rm -rf node_modules
  "${PROXIED[@]}" yarn "${ARGS[@]}" > "$D/yarn-fixpoint.log" 2>&1
  X=$?
  if [ "$X" = 0 ]; then
    cmp -s yarn.lock "$D/after" && X=same || X=changed
  fi
fi
kill "$PROXY" 2>/dev/null
sort -u -o "$D/proxy-after.log" "$D/proxy-after.log" 2>/dev/null

printf 'yarn %s, node %s, %s\nbefore exit=%s, after exit=%s, frozen exit=%s, re-install=%s\n' \
  "$YV" "$(node --version)" "$(date -u +%Y-%m-%d)" "$B" "$A" "$F" "$X" > "$D/recorded-with"
cd / && rm -rf "$WORK"
echo "$(basename "$D") before=$B after=$A frozen=$F re-install=$X"

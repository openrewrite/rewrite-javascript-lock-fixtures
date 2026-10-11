#!/bin/bash
# record-yarn-berry.sh with a user config: `user-yarnrc-yml` becomes $HOME/.yarnrc.yml for the edit's install and a
# second install over its lock (phase 1 runs without it). Those go through a logging proxy (connect-proxy.js,
# YARN_HTTP(S)_PROXY), whose targets are written to `proxy-after.log`; the second install writes `again` and
# `yarn-again.log`.
# Usage: bash record/record-yarn-berry-user.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
ROOT="$(cd "$BIN/.." && pwd)"
WORK="$(mktemp -d)"
PROJECT="$WORK/project"
PORT=${PROXY_PORT:-4892}
mkdir -p "$PROJECT" "$WORK/home" "$WORK/global" "$WORK/cache"

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
: > yarn.lock
cp "$D/pkg-before" package.json
YB="$(corepack yarn --version 2>/dev/null)"
corepack yarn install --mode=update-lockfile > "$D/yarn-before.log" 2>&1
B=$?
rm -f "$D/before"
[ $B -eq 0 ] && cp yarn.lock "$D/before"

[ -f "$D/user-yarnrc-yml" ] && cp "$D/user-yarnrc-yml" "$HOME/.yarnrc.yml"
rm -f "$D/proxy-after.log"
node "$BIN/connect-proxy.js" "$PORT" "$D/proxy-after.log" &
PROXY=$!
sleep 1
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
YA="$(corepack yarn --version 2>/dev/null)"
A=skipped
G=skipped
rm -f "$D/after" "$D/again" "$D/yarn-again.log"
if [ $B -eq 0 ]; then
  YARN_HTTP_PROXY="http://127.0.0.1:$PORT" YARN_HTTPS_PROXY="http://127.0.0.1:$PORT" \
    corepack yarn install --mode=update-lockfile > "$D/yarn-after.log" 2>&1
  A=$?
  if [ $A -eq 0 ]; then
    cp yarn.lock "$D/after"
    YARN_HTTP_PROXY="http://127.0.0.1:$PORT" YARN_HTTPS_PROXY="http://127.0.0.1:$PORT" \
      corepack yarn install --mode=update-lockfile > "$D/yarn-again.log" 2>&1
    G=$?
    cmp -s yarn.lock "$D/after" || cp yarn.lock "$D/again"
  fi
fi
kill "$PROXY" 2>/dev/null
sort -u -o "$D/proxy-after.log" "$D/proxy-after.log" 2>/dev/null

printf 'yarn %s then %s (corepack %s), node %s, %s %s (node %s), %s\nbefore exit=%s, after exit=%s, again exit=%s\n' \
  "$YB" "$YA" "$(corepack --version)" "$(node --version)" "$(uname -s)" "$(uname -m)" \
  "$(node -p 'process.platform + "-" + process.arch')" "$(date -u +%Y-%m-%d)" "$B" "$A" "$G" > "$D/recorded-with"
cd / && rm -rf "$WORK"
echo "$(basename "$D") before=$B after=$A again=$G"

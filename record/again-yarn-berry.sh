#!/bin/bash
# The second lock-only install of a yarn-berry scenario (the written lock must survive a second install): a scratch project left as
# record-yarn-berry.sh's edit phase left it (`tree-before/` then `tree/`, the edit phase's .yarnrc.yml:
# `yarnrc.written`, else `yarnrc-after`, else `yarnrc-before.written`, else `yarnrc`; `pkg.written`, else `pkg`,
# as package.json) with `after` as yarn.lock, then the recorder's command and environment again
# (`yarn install --mode=update-lockfile`, the Yarn that package.json names). Writes <scenario>/berry-again.log
# ending with "exit=<code>" and "lock unchanged" | "lock changed" | "no lock written", plus "package.json
# changed" / ".yarnrc.yml changed" when Yarn rewrote them, and <scenario>/again when the lock changed.
# WARM=1 first fills the scratch cache with a full `yarn install --mode=skip-build` over `after` (the cache a
# second install in the recording's own directory would find), restores `after`, and writes
# berry-again-warm.log (and again.warm) instead; the warm-up's output heads that log.
# Usage: [WARM=1] bash record/again-yarn-berry.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
ROOT="$(cd "$BIN/.." && pwd)"
[ -f "$D/after" ] || { echo "$(basename "$D") no after"; exit 0; }
WORK="$(mktemp -d)"
PROJECT="$WORK/project"
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
[ -d "$D/tree" ] && cp -R "$D/tree/." .
if [ -f "$D/yarnrc.written" ]; then cp "$D/yarnrc.written" .yarnrc.yml
elif [ -f "$D/yarnrc-after" ]; then cp "$D/yarnrc-after" .yarnrc.yml
elif [ -f "$D/yarnrc-before.written" ]; then cp "$D/yarnrc-before.written" .yarnrc.yml
elif [ -f "$D/yarnrc" ]; then cp "$D/yarnrc" .yarnrc.yml; fi
if [ -f "$D/pkg.written" ]; then cp "$D/pkg.written" package.json; else cp "$D/pkg" package.json; fi
cp "$D/after" yarn.lock
cp package.json "$WORK/pkg-in"
cp .yarnrc.yml "$WORK/yarnrc-in" 2>/dev/null || : > "$WORK/yarnrc-in"

LOG="$D/berry-again.log"
AGAIN="$D/again"
if [ -n "${WARM:-}" ]; then
  LOG="$D/berry-again-warm.log"
  AGAIN="$D/again.warm"
  echo "+ warm-up: yarn install --mode=skip-build over after" > "$LOG"
  corepack yarn install --mode=skip-build >> "$LOG" 2>&1
  echo "warm-up exit=$?" >> "$LOG"
  cmp -s yarn.lock "$D/after" || echo "warm-up changed the lock; after restored" >> "$LOG"
  cp "$D/after" yarn.lock
  cp "$WORK/pkg-in" package.json
  [ -s "$WORK/yarnrc-in" ] && cp "$WORK/yarnrc-in" .yarnrc.yml
  echo "+ second install: yarn install --mode=update-lockfile" >> "$LOG"
  corepack yarn install --mode=update-lockfile >> "$LOG" 2>&1
  G=$?
else
  corepack yarn install --mode=update-lockfile > "$LOG" 2>&1
  G=$?
fi
if [ $G -ne 0 ]; then S="no lock written"; elif cmp -s yarn.lock "$D/after"; then S="lock unchanged"; else S="lock changed"; fi
printf 'exit=%s\n%s\n' "$G" "$S" >> "$LOG"
cmp -s package.json "$WORK/pkg-in" || echo "package.json changed" >> "$LOG"
if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$WORK/yarnrc-in"; then echo ".yarnrc.yml changed" >> "$LOG"; fi
rm -f "$AGAIN"
[ "$S" = "lock changed" ] && cp yarn.lock "$AGAIN"
cd / && rm -rf "$WORK"
echo "$(basename "$D") again=$G ($S)"

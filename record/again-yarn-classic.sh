#!/bin/bash
# The second install for Yarn classic (the written lock must survive a second install): in a clean scratch directory holding the scenario's
# `yarnrc` / `npmrc`, `tree-before/` then `tree/`, `pkg` as package.json and `after` as yarn.lock, runs the
# edit phase's yarn command again. When the scenario has no `after` (yarn failed), it runs over `before` (or
# `before-given`) instead: does the failure repeat. Writes <scenario>/yarnclassic-again.log (yarn's output,
# then "over=<lock>", "exit=<code>" and "lock unchanged" | "lock changed" | "no lock written" | "lock
# removed") and <scenario>/again when an install over `after` exited 0 and changed the lock.
# Hermetic like record-yarn-classic.sh (env -i, scratch HOME and cache).
#
# Usage: bash record/again-yarn-classic.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
NODE_DIR="$(dirname "$(command -v node)")"
YARN_DIR="$(dirname "$(command -v yarn)")"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home" "$WORK/cache" "$WORK/project"
ENV=(env -i "PATH=$NODE_DIR:$YARN_DIR:/usr/bin:/bin" "HOME=$WORK/home" "YARN_CACHE_FOLDER=$WORK/cache" "TMPDIR=$WORK")
ARGS=(install --ignore-scripts --non-interactive --no-progress)
if [ -f "$D/after" ]; then OVER=after; elif [ -f "$D/before" ]; then OVER=before; else OVER=; fi
rm -f "$D/again"
if [ -z "$OVER" ]; then
  printf 'over=none\nno lock to install over\n' > "$D/yarnclassic-again.log"
  echo "$(basename "$D") again: no lock"
  exit 0
fi
P="$WORK/project"
[ -f "$D/yarnrc" ] && cp "$D/yarnrc" "$P/.yarnrc"
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$P/.npmrc"
cd "$P" || exit 1
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -d "$D/tree" ] && cp -R "$D/tree/." .
cp "$D/pkg" package.json
cp "$D/$OVER" yarn.lock
"${ENV[@]}" yarn "${ARGS[@]}" > "$D/yarnclassic-again.log" 2>&1
G=$?
if [ ! -f yarn.lock ]; then S="lock removed"
elif cmp -s yarn.lock "$D/$OVER"; then
  if [ $G -ne 0 ]; then S="no lock written"; else S="lock unchanged"; fi
else S="lock changed"; fi
printf 'over=%s\nexit=%s\n%s\n' "$OVER" "$G" "$S" >> "$D/yarnclassic-again.log"
[ "$OVER" = after ] && [ $G -eq 0 ] && [ "$S" = "lock changed" ] && cp yarn.lock "$D/again"
cd / && rm -rf "$WORK"
echo "$(basename "$D") again over $OVER: exit=$G ($S)"

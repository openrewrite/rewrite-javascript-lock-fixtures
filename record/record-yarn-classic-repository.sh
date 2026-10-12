#!/bin/bash
# Records what real Yarn 1 (classic) writes for a lock anywhere in a repository, two-phase: install the repository
# as committed, then install it again in the same place after the edit (node_modules removed first, as in a fresh
# checkout). The scenario directory holds:
#   tree-before/   the repository as committed, every file but the lock
#   tree/          the files the edit changes or adds, copied over it for the second phase
#   lock-dir       one line: the directory yarn runs in, from the repository's root (absent: the root)
#   seed/          optional: earlier versions of files of tree-before/, in place for the first install only, so that
#                  `before` is a lock the committed files have moved on from
#   http-extra     optional: more `name` or `name@version` to fetch, one per line
#   tarballs       optional, any content: also store each locked tarball under http/
# The repository is laid out as <scratch>/repo.
# Writes: before, after (absent when yarn exits non-zero), yarn-before.log, yarn-after.log, yarn-again.log (a second
# install over `after` in a clean copy of the repository; it ends with exit=<code> and whether the lock changed,
# `after-again` when it did), recorded-with, http/.
#
# Hermetic: env -i with HOME and YARN_CACHE_FOLDER in a scratch directory, so no user .yarnrc/.npmrc and no
# npm_config_*/YARN_* variables reach yarn.
#
# Usage: bash record/record-yarn-classic-repository.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
NODE_DIR="$(dirname "$(command -v node)")"
YARN_DIR="$(dirname "$(command -v yarn)")"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$WORK/home" "$WORK/cache"
ENV=(env -i "PATH=$NODE_DIR:$YARN_DIR:/usr/bin:/bin" "HOME=$WORK/home" "YARN_CACHE_FOLDER=$WORK/cache" "TMPDIR=$WORK")
ARGS=(install --ignore-scripts --non-interactive --no-progress)
YV="$("${ENV[@]}" yarn --version)"
LOCKDIR=""
[ -f "$D/lock-dir" ] && LOCKDIR="$(tr -d '[:space:]' < "$D/lock-dir")"
R="$WORK/repo"
P="$R${LOCKDIR:+/$LOCKDIR}"
mkdir -p "$P"
rm -f "$D/before" "$D/after" "$D/after-again"

cp -R "$D/tree-before/." "$R/"
[ -d "$D/seed" ] && cp -R "$D/seed/." "$R/"
(cd "$P" && "${ENV[@]}" yarn "${ARGS[@]}") > "$D/yarn-before.log" 2>&1
B=$?
[ $B -eq 0 ] && [ -f "$P/yarn.lock" ] && cp "$P/yarn.lock" "$D/before"

rm -rf "$P/node_modules"
cp -R "$D/tree-before/." "$R/"
[ -d "$D/tree" ] && cp -R "$D/tree/." "$R/"
(cd "$P" && "${ENV[@]}" yarn "${ARGS[@]}") > "$D/yarn-after.log" 2>&1
A=$?
[ $A -eq 0 ] && [ -f "$P/yarn.lock" ] && cp "$P/yarn.lock" "$D/after"

G=-
rm -f "$D/yarn-again.log"
if [ -f "$D/after" ]; then
  R2="$WORK/again/repo"
  P2="$R2${LOCKDIR:+/$LOCKDIR}"
  mkdir -p "$P2"
  cp -R "$D/tree-before/." "$R2/"
  [ -d "$D/tree" ] && cp -R "$D/tree/." "$R2/"
  cp "$D/after" "$P2/yarn.lock"
  (cd "$P2" && "${ENV[@]}" yarn "${ARGS[@]}") > "$D/yarn-again.log" 2>&1
  G=$?
  echo "exit=$G" >> "$D/yarn-again.log"
  if cmp -s "$P2/yarn.lock" "$D/after"; then
    echo unchanged >> "$D/yarn-again.log"
  else
    echo changed >> "$D/yarn-again.log"
    cp "$P2/yarn.lock" "$D/after-again"
  fi
fi

printf 'yarn %s, node %s, %s\nbefore exit=%s, after exit=%s, again exit=%s\nlayout repo/%s\n' \
  "$YV" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$B" "$A" "$G" "$LOCKDIR" > "$D/recorded-with"
printf 'platform os=%s cpu=%s libc=\n' "$(node -p process.platform)" "$(node -p process.arch)" >> "$D/recorded-with"
cd / && rm -rf "$WORK"

if [ -z "${NO_HTTP:-}" ]; then
  NAMES="$(node "$BIN/yarn-lock-names.js" "$D")"
  EXTRA=""
  [ -f "$D/http-extra" ] && EXTRA="$(cat "$D/http-extra")"
  # shellcheck disable=SC2086
  node "$BIN/fetch-http.js" "$D" $NAMES $EXTRA
  [ -f "$D/tarballs" ] && node "$BIN/yarn-lock-names.js" "$D" --tarballs > /dev/null
fi
echo "$(basename "$D") before=$B after=$A again=$G"

#!/bin/bash
# Records what real npm writes for a lock anywhere in a repository, two-phase: install the repository as committed,
# then install it again in the same place after the edit. The scenario directory holds:
#   tree-before/   the repository as committed, every file but the lock
#   tree/          the files the edit changes or adds, copied over it for the second phase
#   lock-dir       one line: the directory npm runs in, from the repository's root (absent: the root)
#   seed/          optional: earlier versions of files of tree-before/, in place for the first install only, so that
#                  `before` is a lock the committed files have moved on from
# The repository is laid out as <scratch>/repo, so a package at its root that is not named `repo` has its name in
# a lock that links it.
# Writes: before, after (absent when npm exits non-zero), npm-before.log, npm-after.log, npm-again.log (a second
# lock-only install over `after`; it ends with exit=<code> and whether the lock changed, `after-again` when it did),
# recorded-with, http/.
#
# Usage: bash record/record-npm-repository.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
ARGS=(install --package-lock-only --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=warn --userconfig /dev/null)
# the real path: under a symlinked one (macOS /var/folders) arborist reads a link target through two names
WORK="$(cd "$(mktemp -d)" && pwd -P)"
R="$WORK/repo"
LOCKDIR=""
[ -f "$D/lock-dir" ] && LOCKDIR="$(tr -d '[:space:]' < "$D/lock-dir")"
P="$R${LOCKDIR:+/$LOCKDIR}"
mkdir -p "$P"
rm -f "$D/before" "$D/after" "$D/after-again"

cp -R "$D/tree-before/." "$R/"
[ -d "$D/seed" ] && cp -R "$D/seed/." "$R/"
(cd "$P" && npm "${ARGS[@]}") > "$D/npm-before.log" 2>&1
B=$?
[ $B -eq 0 ] && cp "$P/package-lock.json" "$D/before"

cp -R "$D/tree-before/." "$R/"
[ -d "$D/tree" ] && cp -R "$D/tree/." "$R/"
(cd "$P" && npm "${ARGS[@]}") > "$D/npm-after.log" 2>&1
A=$?
[ $A -eq 0 ] && cp "$P/package-lock.json" "$D/after"

G=-
rm -f "$D/npm-again.log"
if [ $A -eq 0 ]; then
  (cd "$P" && npm "${ARGS[@]}") > "$D/npm-again.log" 2>&1
  G=$?
  echo "exit=$G" >> "$D/npm-again.log"
  if cmp -s "$P/package-lock.json" "$D/after"; then
    echo unchanged >> "$D/npm-again.log"
  else
    echo changed >> "$D/npm-again.log"
    cp "$P/package-lock.json" "$D/after-again"
  fi
fi

printf 'npm %s, node %s, %s\nbefore exit=%s, after exit=%s, again exit=%s\nlayout repo/%s\n' \
  "$(npm --version)" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$B" "$A" "$G" "$LOCKDIR" \
  > "$D/recorded-with"
# the machine npm read (process.platform, process.arch), for platform checks on replay
printf 'platform os=%s cpu=%s\n' "$(node -p process.platform)" "$(node -p process.arch)" >> "$D/recorded-with"
cd / && rm -rf "$WORK"
# NO_HTTP=1 skips the registry responses.
[ -z "${NO_HTTP:-}" ] && node "$BIN/fetch-http.js" "$D"
echo "$(basename "$D") before=$B after=$A again=$G"

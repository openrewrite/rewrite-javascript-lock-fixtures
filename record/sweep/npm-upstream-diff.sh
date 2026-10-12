#!/bin/bash
# Diffs the upstream source the npm port follows between two npm releases: arborist's lib/, and with --libs the
# libraries the port ports. Pass a path filter to narrow it (a regex on file names).
# Usage: bash npm-upstream-diff.sh <from> <to> [--stat] [--libs] [--filter <regex>]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
A="$ROOT/pm/npm/$1/package"; B="$ROOT/pm/npm/$2/package"; shift 2
STAT=""; LIBS=""; FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --stat) STAT=1 ;;
    --libs) LIBS=1 ;;
    --filter) FILTER="$2"; shift ;;
  esac
  shift
done
DIRS=("node_modules/@npmcli/arborist/lib")
if [ -n "$LIBS" ]; then
  for L in npm-pick-manifest npm-package-arg pacote/lib @npmcli/package-json/lib npm-install-checks @npmcli/map-workspaces \
           json-stringify-nice semver hosted-git-info ssri @npmcli/config/lib @npmcli/name-from-folder npm-normalize-package-bin; do
    DIRS+=("node_modules/$L")
  done
  DIRS+=("lib/utils/explain-eresolve.js" "lib/utils/explain-dep.js" "lib/commands/install.js")
fi
for D in "${DIRS[@]}"; do
  [ -e "$A/$D" ] || [ -e "$B/$D" ] || continue
  if [ -n "$STAT" ]; then
    diff -rq -x node_modules -x '*.md' -x test -x docs "$A/$D" "$B/$D" 2>/dev/null | sed "s|$A/||g; s|$B/||g" | { [ -n "$FILTER" ] && grep -E "$FILTER" || cat; }
  else
    diff -ru -x node_modules -x '*.md' -x test -x docs -x package.json "$A/$D" "$B/$D" 2>/dev/null | sed "s|$A/|a/|g; s|$B/|b/|g" | { [ -n "$FILTER" ] && awk -v re="$FILTER" '/^diff /{p = ($0 ~ re)} p' || cat; }
  fi
done

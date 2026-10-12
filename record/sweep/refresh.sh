#!/bin/bash
# Rebuilds the sweep's reports, exports its findings into the fixtures clone, commits them there, and with a number
# makes an immutable snapshot of the fixtures for agents to build against (an APFS clone: instant, no extra space).
# Each export first removes what the previous one created: every releases file and release/ outcome (no recording
# has those), and the registry files listed in inventory/exported-http.txt, which the export itself writes. A
# scenario's own recorded registry files are never touched.
# Usage: bash refresh.sh [snapshot-number]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/fixtures"
LIST="$ROOT/inventory/exported-http.txt"
node "$ROOT/bin/sweep-matrix.js" "$ROOT/sweep/npm"
if [ -f "$LIST" ]; then
  while read -r created; do
    [ -n "$created" ] && rm -f "$F/$created"
  done < "$LIST"
fi
find "$F/lock/npm" -type f -name releases -delete
find "$F/lock/npm" -type d -name release -prune -exec rm -rf {} +
node "$ROOT/bin/sweep-export.js" --sweep "$ROOT/sweep/npm" --fixtures "$F/lock/npm" \
  --packument "$ROOT/inventory/npm-packument.json" --created-list "$LIST"
git -C "$F" add -A lock/npm
if ! git -C "$F" diff --cached --quiet; then
  SWEPT="$(ls "$ROOT/sweep/npm" | grep -c '^[0-9]')"
  git -C "$F" commit -q -m "What each npm release writes for the npm scenarios ($SWEPT releases swept)"
fi
git -C "$F" log --oneline -1
if [ -n "${1:-}" ]; then
  mkdir -p "$ROOT/snap/$1"
  rm -rf "$ROOT/snap/$1/lock"
  cp -cR "$F/lock" "$ROOT/snap/$1/lock"
  git -C "$F" rev-parse HEAD > "$ROOT/snap/$1/commit"
  echo "snapshot $1 at $(cat "$ROOT/snap/$1/commit")"
fi

#!/bin/bash
# Makes an immutable snapshot of the fixtures clone as it stands (an APFS clone: instant, no extra space), for
# agents and proofs to build against, without exporting anything first (refresh.sh exports, then snapshots).
# Usage: bash snapshot.sh <snapshot-number>
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$ROOT/fixtures"
mkdir -p "$ROOT/snap/$1"
rm -rf "$ROOT/snap/$1/lock"
cp -cR "$F/lock" "$ROOT/snap/$1/lock"
git -C "$F" rev-parse HEAD > "$ROOT/snap/$1/commit"
echo "snapshot $1 at $(cat "$ROOT/snap/$1/commit")"

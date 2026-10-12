#!/bin/bash
# Makes a copy of the fixtures' npm scenarios as recorded, without what an export wrote into them (the releases
# files, release/ outcomes and the registry documents record/sweep/exported/npm.txt lists), for a sweep to read: a
# document an export added would otherwise be served as if the recording held it.
# Usage: bash pristine-npm.sh <dest dir>   (dest/npm is made, an APFS clone)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$1"
rm -rf "$DEST/npm"
mkdir -p "$DEST"
cp -cR "$ROOT/fixtures/lock/npm" "$DEST/npm"
while read -r created; do
  [ -n "$created" ] && rm -f "$DEST/${created#lock/}"
done < "$ROOT/fixtures/record/sweep/exported/npm.txt"
find "$DEST/npm" -type f -name releases -delete
find "$DEST/npm" -type d -name release -prune -exec rm -rf {} +
echo "pristine npm scenarios in $DEST/npm"

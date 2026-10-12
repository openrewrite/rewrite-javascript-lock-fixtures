#!/bin/bash
# Lists, in release order, where a fixed string is present in an upstream file of npm: each release at which it
# appears or disappears. This is how a release-conditional's threshold is found: from the source, not from the
# releases a sweep happened to sample.
# Usage: bash npm-first-release-with.sh <path under package/> <fixed string>
#   e.g. bash npm-first-release-with.sh node_modules/@npmcli/arborist/lib/link.js overrideMatchesSubtree
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="$1"; S="$2"
PREV=""
for V in $(ls "$ROOT/pm/npm" | sort -t. -k1,1n -k2,2n -k3,3n); do
  P="$ROOT/pm/npm/$V/package/$F"
  if [ ! -f "$P" ]; then STATE="no-file"
  elif grep -qF -- "$S" "$P"; then STATE="present"
  else STATE="absent"; fi
  if [ "$STATE" != "$PREV" ]; then echo "$V  $STATE"; PREV="$STATE"; fi
done

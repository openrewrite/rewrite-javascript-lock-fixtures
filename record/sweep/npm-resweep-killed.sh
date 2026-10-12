#!/bin/bash
# Sweeps again every cell in which the sweep's timeout killed npm (inventory/killed-cells.txt, from
# npm-killed-cells.js), but for the scenario that hangs npm 10.4 to 10.7 for good. On a quiet machine a slow npm
# finishes; one that hangs is killed again, and that is its outcome.
# Usage: bash npm-resweep-killed.sh [jobs]
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
J="${1:-8}"
grep -v '^[^ ]* \^(open-hoisted-dependency-missing-nested)\$$' "$ROOT/inventory/killed-cells.txt" | while read -r release only; do
  [ -z "$release" ] && continue
  echo "== npm $release"
  # the scenarios as recorded (pristine-npm.sh): a document an export added would be served as recorded
  node "$ROOT/bin/sweep-npm.js" --scenarios "$ROOT/scratch/npm-pristine/npm" --pm "$ROOT/pm/npm" --out "$ROOT/sweep/npm" \
    --releases "$release" --only "$only" --jobs "$J" --force
done
node "$ROOT/bin/npm-killed-cells.js" "$ROOT/sweep/npm" "$ROOT/inventory/killed-cells-after.txt" | tail -1
echo "== done"

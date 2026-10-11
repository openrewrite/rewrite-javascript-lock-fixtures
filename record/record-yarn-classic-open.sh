#!/bin/bash
# Records one Yarn classic scenario with record-yarn-classic.sh, adds the machine to `recorded-with` (third line
# `platform os=<os> cpu=<arch> libc=`, as record-npm.sh writes it), then the second install (again-yarn-classic.sh).
# Inputs and outputs are record-yarn-classic.sh's plus yarnclassic-again.log / again.
# Usage: bash record/record-yarn-classic-open.sh <scenario-dir>
set -u
BIN="$(cd "$(dirname "$0")" && pwd)"
D="$(cd "$1" && pwd)" || exit 1
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
bash "$BIN/record-yarn-classic.sh" "$D"
printf 'platform os=%s cpu=%s libc=\n' "$(node -p process.platform)" "$(node -p process.arch)" >> "$D/recorded-with"
bash "$BIN/again-yarn-classic.sh" "$D"

#!/bin/bash
# A lock-only install that changes nothing, over any one lock of a Bun scenario: in a scratch project holding the
# lock's own phase (`before`: `npmrc`/`bunfig`, `tree-before/`, `pkg-before`; any other lock: also `tree/` and
# `pkg`), runs record-bun.sh's command with the lock as bun.lock, hermetic the same way, cold cache (an
# install that changes nothing fetches nothing).
# Writes bun-<lock>-again.log ending "exit=<code>" and "lock unchanged" | "lock changed" | "no lock written",
# and <lock>-again when the lock changed, into the scenario directory, or into OUT=<dir>/<scenario>/.
# The downloaded fixtures' layout is understood too: `pkg-after` for `pkg`, `pkg-root` with `pkg-<member>`,
# `pkg-<member>-before` / `pkg-<member>-after` placed where the lock's workspaces name the member.
#
# Usage: [OUT=<dir>] bash record/again-bun-lock.sh <scenario-dir> <lock-file>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
LOCK="$2"
N="$(basename "$D")"
[ -f "$D/$LOCK" ] || { echo "$N/$LOCK missing"; exit 0; }
DEST="$D"
if [ -n "${OUT:-}" ]; then
  mkdir -p "$OUT/$N" && DEST="$(cd "$OUT/$N" && pwd)"
fi
BUN="$(command -v bun)"
NODE="$(command -v node)"
WORK="$(mktemp -d)"
mkdir -p "$WORK/home/.config" "$WORK/cache" "$WORK/tmp" "$WORK/proj"

run_bun() {
  env -i PATH="/usr/bin:/bin" HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" \
    XDG_CACHE_HOME="$WORK/home/.cache" BUN_INSTALL_CACHE_DIR="$WORK/cache" TMPDIR="$WORK/tmp" \
    NO_COLOR=1 "$BUN" install --lockfile-only --no-progress "$@"
}

cd "$WORK/proj" || exit 1
[ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
[ -f "$D/bunfig" ] && cp "$D/bunfig" bunfig.toml
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
PHASE=after
case "$LOCK" in before*) PHASE=before ;; esac
if [ "$PHASE" = after ] && [ -d "$D/tree" ]; then cp -R "$D/tree/." .; fi
"$NODE" "$BIN/bun-place-manifests.js" "$D" "$LOCK" "$PHASE" "$WORK/proj" || { echo "$N/$LOCK no manifest"; cd /; rm -rf "$WORK"; exit 0; }
cp "$D/$LOCK" bun.lock
run_bun > "$DEST/bun-$LOCK-again.log" 2>&1
G=$?
if [ $G -ne 0 ] || [ ! -f bun.lock ]; then S="no lock written"; elif cmp -s bun.lock "$D/$LOCK"; then S="lock unchanged"; else S="lock changed"; fi
printf 'exit=%s\n%s\n' "$G" "$S" >> "$DEST/bun-$LOCK-again.log"
rm -f "$DEST/$LOCK-again"
[ "$S" = "lock changed" ] && cp bun.lock "$DEST/$LOCK-again"
cd / && rm -rf "$WORK"
echo "$N/$LOCK again=$G ($S)"

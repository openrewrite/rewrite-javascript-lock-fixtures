#!/bin/bash
# Records what real pnpm writes for a lock anywhere in a repository, two-phase: install the repository as committed,
# then install it again in the same place after the edit. The scenario directory holds:
#   tree-before/   the repository as committed, every file but the lock
#   tree/          the files the edit changes or adds, copied over it for the second phase
#   lock-dir       one line: the directory pnpm runs in, from the repository's root (absent: the root)
#   seed/          optional: earlier versions of files of tree-before/, in place for the first install only, so that
#                  `before` is a lock the committed files have moved on from
#   http-extra     optional: more `name` or `name@version` to fetch, one per line
# The repository is laid out as <scratch>/repo.
# Writes: before, after (pnpm-lock.yaml of lock-dir; absent when pnpm exits non-zero), pnpm-before.log, pnpm-after.log,
# pnpm-again.log (a second install over `after`; it ends with exit=<code> and whether the lock changed, `after-again`
# when it did), recorded-with, http/.
#
# The user configuration is hermetic, as in record-pnpm.sh: HOME and the XDG directories point into a fresh temp dir,
# and the user npmrc is /dev/null. pnpm 11 defaults (minimumReleaseAge 1440 among them) are left in force; the
# recording time is in recorded-with because minimumReleaseAge makes "now" an input.
#
# Usage: bash record/record-pnpm-repository.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
PNPM="$(command -v pnpm)"
NODE="$(command -v node)"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$WORK/home"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config" XDG_CACHE_HOME="$WORK/home/.cache"
export XDG_DATA_HOME="$WORK/home/.local/share" XDG_STATE_HOME="$WORK/home/.local/state"
export npm_config_userconfig=/dev/null pnpm_config_userconfig=/dev/null pnpm_config_npmrc_auth_file=/dev/null
export pnpm_config_update_notifier=false
unset CI PNPM_HOME npm_config_registry
ARGS=(install --lockfile-only --no-color --store-dir="$WORK/store")
LOCKDIR=""
[ -f "$D/lock-dir" ] && LOCKDIR="$(tr -d '[:space:]' < "$D/lock-dir")"
R="$WORK/repo"
P="$R${LOCKDIR:+/$LOCKDIR}"
mkdir -p "$P"
rm -f "$D/before" "$D/after" "$D/after-again"

cp -R "$D/tree-before/." "$R/"
[ -d "$D/seed" ] && cp -R "$D/seed/." "$R/"
(cd "$P" && "$PNPM" "${ARGS[@]}") > "$D/pnpm-before.log" 2>&1
B=$?
[ $B -eq 0 ] && cp "$P/pnpm-lock.yaml" "$D/before"

cp -R "$D/tree-before/." "$R/"
[ -d "$D/tree" ] && cp -R "$D/tree/." "$R/"
(cd "$P" && "$PNPM" "${ARGS[@]}") > "$D/pnpm-after.log" 2>&1
A=$?
[ $A -eq 0 ] && cp "$P/pnpm-lock.yaml" "$D/after"

G=-
rm -f "$D/pnpm-again.log"
if [ $A -eq 0 ]; then
  (cd "$P" && "$PNPM" "${ARGS[@]}") > "$D/pnpm-again.log" 2>&1
  G=$?
  echo "exit=$G" >> "$D/pnpm-again.log"
  if cmp -s "$P/pnpm-lock.yaml" "$D/after"; then
    echo unchanged >> "$D/pnpm-again.log"
  else
    echo changed >> "$D/pnpm-again.log"
    cp "$P/pnpm-lock.yaml" "$D/after-again"
  fi
fi

printf 'pnpm %s, node %s, %s\nbefore exit=%s, after exit=%s, again exit=%s\nlayout repo/%s\n' \
  "$("$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$B" "$A" "$G" \
  "$LOCKDIR" > "$D/recorded-with"
cd / && rm -rf "$WORK"
if [ -z "${NO_HTTP:-}" ]; then
  EXTRA=()
  [ -f "$D/http-extra" ] && while read -r l; do [ -n "$l" ] && EXTRA+=("$l"); done < "$D/http-extra"
  # shellcheck disable=SC2046
  "$NODE" "$BIN/fetch-http.js" "$D" $("$NODE" "$BIN/pnpm-lock-names.js" "$D") ${EXTRA[@]+"${EXTRA[@]}"}
fi
echo "$(basename "$D") before=$B after=$A again=$G"

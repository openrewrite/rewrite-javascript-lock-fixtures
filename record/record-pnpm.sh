#!/bin/bash
# Records what real pnpm writes for one scenario, two-phase: install `pkg-before` from scratch,
# then install `pkg` in the same directory over the lock that produced.
#
# The scenario directory must hold `pkg-before` and `pkg` (root package.json before and after the edit).
# Optional inputs:
#   workspace-before, workspace   pnpm-workspace.yaml for each phase (a phase without its file keeps
#                                 whatever the previous phase had; `workspace` alone applies to both)
#   npmrc                         project .npmrc for both phases
#   tree-before/, tree/           extra files copied into the project before each phase (member manifests)
#   seed-lock                     a lock pnpm 11 cannot write (older lockfileVersion): phase 1 is skipped
#                                 and `before` is this file verbatim
#   http-extra                    extra `name[@version]` registry routes to fetch, one per line
#   args                          extra pnpm flags for phase 2 only (e.g. --frozen-lockfile)
# Writes: before, after (pnpm-lock.yaml; absent when pnpm exits non-zero), pnpm-before.log, pnpm-after.log,
# recorded-with, http/.
#
# The user configuration is hermetic: HOME and the XDG directories point into a fresh temp dir (no
# ~/.npmrc, no global pnpm config.yaml/rc/auth.ini, an empty metadata cache and store), and the user
# npmrc is /dev/null (via the environment). pnpm 11 defaults (minimumReleaseAge 1440 among them) are left in force; the
# recording time is in recorded-with because minimumReleaseAge makes "now" an input.
#
# Usage: bash record/record-pnpm.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
PNPM="$(command -v pnpm)"
NODE="$(command -v node)"
WORK="$(mktemp -d)"
P="$WORK/project"
mkdir -p "$P" "$WORK/home"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config" XDG_CACHE_HOME="$WORK/home/.cache"
export XDG_DATA_HOME="$WORK/home/.local/share" XDG_STATE_HOME="$WORK/home/.local/state"
# pnpm 11 has no --userconfig flag; it reads the user npmrc path from these (and HOME is a temp dir anyway).
export npm_config_userconfig=/dev/null pnpm_config_userconfig=/dev/null pnpm_config_npmrc_auth_file=/dev/null
export pnpm_config_update_notifier=false
unset CI PNPM_HOME npm_config_registry
ARGS=(install --lockfile-only --no-color --store-dir="$WORK/store")
[ -f "$D/npmrc" ] && cp "$D/npmrc" "$P/.npmrc"
cd "$P" || exit 1

[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
if [ -f "$D/workspace-before" ]; then cp "$D/workspace-before" pnpm-workspace.yaml
elif [ -f "$D/workspace" ]; then cp "$D/workspace" pnpm-workspace.yaml; fi
cp "$D/pkg-before" package.json
if [ -f "$D/seed-lock" ]; then
  # A lock pnpm 11 cannot write (an older lockfileVersion): it is `before` verbatim and phase 1 is skipped.
  cp "$D/seed-lock" pnpm-lock.yaml
  cp "$D/seed-lock" "$D/before"
  echo "phase 1 skipped: before is seed-lock" > "$D/pnpm-before.log"
  B=seeded
else
  "$PNPM" "${ARGS[@]}" > "$D/pnpm-before.log" 2>&1
  B=$?
  rm -f "$D/before"
  [ $B -eq 0 ] && cp pnpm-lock.yaml "$D/before"
fi

[ -d "$D/tree" ] && cp -R "$D/tree/." .
[ -f "$D/workspace" ] && cp "$D/workspace" pnpm-workspace.yaml
cp "$D/pkg" package.json
ARGS2=("${ARGS[@]}")
# shellcheck disable=SC2207
[ -f "$D/args" ] && ARGS2+=($(cat "$D/args"))
"$PNPM" "${ARGS2[@]}" > "$D/pnpm-after.log" 2>&1
A=$?
rm -f "$D/after"
[ $A -eq 0 ] && cp pnpm-lock.yaml "$D/after"

printf 'pnpm %s, node %s, %s\nbefore exit=%s, after exit=%s\n' \
  "$("$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$B" "$A" \
  > "$D/recorded-with"
[ -f "$D/args" ] && printf 'phase 2 args: %s\n' "$(cat "$D/args")" >> "$D/recorded-with"
cd / && rm -rf "$WORK"
# NO_HTTP=1 skips the registry responses. Names come from the locks' packages keys (fetch-http.js reads
# only npm locks itself) plus any extra `name[@version]` listed one per line in <dir>/http-extra.
if [ -z "${NO_HTTP:-}" ]; then
  EXTRA=()
  [ -f "$D/http-extra" ] && while read -r l; do [ -n "$l" ] && EXTRA+=("$l"); done < "$D/http-extra"
  # shellcheck disable=SC2046
  "$NODE" "$BIN/fetch-http.js" "$D" $("$NODE" "$BIN/pnpm-lock-names.js" "$D") ${EXTRA[@]+"${EXTRA[@]}"}
fi
echo "$(basename "$D") before=$B after=$A"

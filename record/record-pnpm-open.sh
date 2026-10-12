#!/bin/bash
# Records an open-* pnpm scenario like record-pnpm.sh (same inputs, same isolation, same before/after/logs/http)
# and adds the second install and evidence of what pnpm fetched and wrote.
#
# Inputs (record-pnpm.sh's): pkg-before, pkg, about; optional workspace-before, workspace, npmrc, tree-before/,
# tree/, seed-lock, http-extra, args (phase-2 flags). Added:
#   args-before    extra flags for phase 1
#   full-before    marker: phase 1 is a full `pnpm install --ignore-scripts` (node_modules written), not lock-only
#   npmrc-before   project .npmrc for phase 1 only (npmrc then applies from phase 2 on)
# Writes (beyond record-pnpm.sh's):
#   pnpm-again.log  a third run of the phase-2 command in the same project, over what phase 2 left (`after`, or
#                   `before` when phase 2 failed); ends with "exit=<code>" and "lock unchanged" | "lock changed" |
#                   "no lock written"; `again` when the lock changed
#   probes/<phase>-files.txt       project files after the phase (node_modules to depth 2)
#   probes/<phase>-changed/<file>  a project file other than the lock that pnpm changed in the phase
#   probes/<phase>-cache/          pnpm's metadata cache of the phase (each phase starts with an empty cache):
#                                  metadata-v1.3 = abbreviated documents, metadata-full-v1.3 = full ones
#   probes/<phase>-store.txt       the files the phase added to the store (tarballs fetched land under files/)
#   probes/<phase>-git.log         every git command pnpm ran in the phase
#   probes/after-lock-written-on-failure  the lock pnpm left behind when phase 2 exited non-zero but changed it
# recorded-with: line 1 and 2 as record-pnpm.sh, then `again exit=`, each phase's start time, the platform.
# NO_HTTP=1 skips http/; NO_CACHE_COPY=1 lists the cache instead of copying it; STORE_PER_PHASE=1 gives each phase
# an empty store (recorded-with says so).
#
# Usage: bash record/record-pnpm-open.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'node "$BIN/redact-paths.js" "$D"; node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
PNPM="$(command -v pnpm)"
NODE="$(command -v node)"
REAL_GIT="$(command -v git)"
WORK="$(mktemp -d)"
P="$WORK/project"
mkdir -p "$P" "$WORK/home" "$WORK/bin"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config" XDG_CACHE_HOME="$WORK/home/.cache"
export XDG_DATA_HOME="$WORK/home/.local/share" XDG_STATE_HOME="$WORK/home/.local/state"
export npm_config_userconfig=/dev/null pnpm_config_userconfig=/dev/null pnpm_config_npmrc_auth_file=/dev/null
export pnpm_config_update_notifier=false
unset CI PNPM_HOME npm_config_registry
printf '#!/bin/bash\necho "git $*" >> "$GITLOG"\nexec "%s" "$@"\n' "$REAL_GIT" > "$WORK/bin/git"
chmod +x "$WORK/bin/git"
export PATH="$WORK/bin:$PATH"
STORE="$WORK/store"
rm -rf "$D/probes" "$D/before" "$D/after" "$D/again" "$D/pnpm-again.log"
mkdir -p "$D/probes"

snapshot() { # <phase> <lock-before-phase>
  local ph="$1"
  (cd "$P" && find . -path ./node_modules -prune -o -type f -print | sort) > "$D/probes/$ph-files.txt"
  [ -d "$P/node_modules" ] && (cd "$P" && find node_modules -maxdepth 2 | sort) >> "$D/probes/$ph-files.txt"
  for f in package.json pnpm-workspace.yaml .npmrc; do
    if [ -f "$P/$f" ] && ! cmp -s "$P/$f" "$WORK/in-$f"; then
      mkdir -p "$D/probes/$ph-changed" && cp "$P/$f" "$D/probes/$ph-changed/$f"
    fi
  done
  if [ -d "$WORK/cache-$ph" ]; then
    if [ -n "${NO_CACHE_COPY:-}" ]; then
      (cd "$WORK/cache-$ph" && find . -type f | sort) > "$D/probes/$ph-cache.txt"
    else
      cp -R "$WORK/cache-$ph" "$D/probes/$ph-cache"
    fi
  fi
  find "$STORE" -type f 2>/dev/null | sort > "$WORK/store-after-$ph"
  comm -13 "$WORK/store-before-$ph" "$WORK/store-after-$ph" | sed "s#^$STORE/##" > "$D/probes/$ph-store.txt"
}

inputs() { # remember what we put in, to tell what pnpm changed
  for f in package.json pnpm-workspace.yaml .npmrc; do
    rm -f "$WORK/in-$f"
    [ -f "$P/$f" ] && cp "$P/$f" "$WORK/in-$f"
  done
}

run() { # <phase> <log> <args...>
  local ph="$1" log="$2"
  shift 2
  # STORE_PER_PHASE=1: each lock-only phase starts with an empty store, so a tarball the phase needs shows as fetched
  [ -n "${STORE_PER_PHASE:-}" ] && [ ! -f "$D/full-before" ] && STORE="$WORK/store-$ph" && set -- "${@/--store-dir=*/--store-dir=$STORE}"
  find "$STORE" -type f 2>/dev/null | sort > "$WORK/store-before-$ph"
  export GITLOG="$D/probes/$ph-git.log"
  : > "$GITLOG"
  "$PNPM" "$@" --cache-dir="$WORK/cache-$ph" > "$log" 2>&1
}

BASE=(install --lockfile-only --no-color --store-dir="$STORE")
BARGS=()
[ -f "$D/args-before" ] && read -r -a BARGS < "$D/args-before"
AARGS=()
[ -f "$D/args" ] && read -r -a AARGS < "$D/args"
PH1=("${BASE[@]}")
[ -f "$D/full-before" ] && PH1=(install --ignore-scripts --no-color --store-dir="$STORE")

cd "$P" || exit 1
if [ -f "$D/npmrc-before" ]; then cp "$D/npmrc-before" .npmrc
elif [ -f "$D/npmrc" ]; then cp "$D/npmrc" .npmrc; fi
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
if [ -f "$D/workspace-before" ]; then cp "$D/workspace-before" pnpm-workspace.yaml
elif [ -f "$D/workspace" ]; then cp "$D/workspace" pnpm-workspace.yaml; fi
cp "$D/pkg-before" package.json
B_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$D/seed-lock" ]; then
  cp "$D/seed-lock" pnpm-lock.yaml
  cp "$D/seed-lock" "$D/before"
  echo "phase 1 skipped: before is seed-lock" > "$D/pnpm-before.log"
  B=seeded
else
  inputs
  run before "$D/pnpm-before.log" "${PH1[@]}" "${BARGS[@]}"
  B=$?
  [ $B -eq 0 ] && [ -f pnpm-lock.yaml ] && cp pnpm-lock.yaml "$D/before"
  snapshot before
fi

[ -f "$D/npmrc-before" ] && rm -f .npmrc && [ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
[ -d "$D/tree" ] && cp -R "$D/tree/." .
[ -f "$D/workspace" ] && cp "$D/workspace" pnpm-workspace.yaml
cp "$D/pkg" package.json
cp pnpm-lock.yaml "$WORK/lock-before-after" 2>/dev/null
inputs
A_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run after "$D/pnpm-after.log" "${BASE[@]}" "${AARGS[@]}"
A=$?
[ $A -eq 0 ] && cp pnpm-lock.yaml "$D/after"
[ $A -ne 0 ] && [ -f pnpm-lock.yaml ] && ! cmp -s pnpm-lock.yaml "$WORK/lock-before-after" && cp pnpm-lock.yaml "$D/probes/after-lock-written-on-failure"
snapshot after

cp pnpm-lock.yaml "$WORK/lock-before-again" 2>/dev/null
inputs
G_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run again "$D/pnpm-again.log" "${BASE[@]}" "${AARGS[@]}"
G=$?
if [ $G -ne 0 ]; then S="no lock written"
elif cmp -s pnpm-lock.yaml "$WORK/lock-before-again"; then S="lock unchanged"
else S="lock changed"; fi
[ $G -ne 0 ] && ! cmp -s pnpm-lock.yaml "$WORK/lock-before-again" && S="lock written although the run failed"
[ $A -ne 0 ] && [ -f "$D/probes/after-lock-written-on-failure" ] && S="$S (over the lock the failed edit run wrote)"
printf 'pnpm %s, node %s, %s\nexit=%s\n%s\n' "$("$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" \
  "$G_AT" "$G" "$S" >> "$D/pnpm-again.log"
[ "$S" = "lock changed" ] && cp pnpm-lock.yaml "$D/again"
snapshot again

LIBC=""
[ "$(uname -s)" = "Linux" ] && LIBC="$(ldd --version 2>&1 | grep -qi musl && echo musl || echo glibc)"
{
  printf 'pnpm %s, node %s, %s\n' "$("$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'before exit=%s, after exit=%s\n' "$B" "$A"
  printf 'again exit=%s\n' "$G"
  printf 'phase times: before at %s, after at %s, again at %s\n' "$B_AT" "$A_AT" "$G_AT"
  printf 'platform os=%s cpu=%s libc=%s\n' "$("$NODE" -p process.platform)" "$("$NODE" -p process.arch)" "$LIBC"
  [ -f "$D/args" ] && printf 'phase 2 args: %s\n' "$(cat "$D/args")"
  [ -f "$D/args-before" ] && printf 'phase 1 args: %s\n' "$(cat "$D/args-before")"
  [ -f "$D/full-before" ] && printf 'phase 1: full install (not lock-only)\n'
  [ -n "${STORE_PER_PHASE:-}" ] && printf 'store: empty at the start of each phase\n'
} > "$D/recorded-with"
cd / && rm -rf "$WORK"
if [ -z "${NO_HTTP:-}" ]; then
  EXTRA=()
  [ -f "$D/http-extra" ] && while read -r l; do [ -n "$l" ] && EXTRA+=("$l"); done < "$D/http-extra"
  # shellcheck disable=SC2046
  "$NODE" "$BIN/fetch-http.js" "$D" $("$NODE" "$BIN/pnpm-lock-names.js" "$D") ${EXTRA[@]+"${EXTRA[@]}"}
fi
echo "$(basename "$D") before=$B after=$A again=$G ($S)"

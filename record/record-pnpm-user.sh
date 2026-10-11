#!/bin/bash
# record-pnpm-lockdir.sh with the user's own config: a scenario's `user-npmrc` becomes the scratch HOME's .npmrc and
# its `user-config-yaml` pnpm's global config.yaml ($XDG_CONFIG_HOME/pnpm), for every phase; without either the user
# config is /dev/null as before. Usage: bash record/record-pnpm-user.sh <scenario-dir>
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
if [ -f "$D/user-npmrc" ] || [ -f "$D/user-config-yaml" ]; then
  unset npm_config_userconfig pnpm_config_userconfig pnpm_config_npmrc_auth_file NPM_CONFIG_USERCONFIG
  [ -f "$D/user-npmrc" ] && cp "$D/user-npmrc" "$HOME/.npmrc"
  if [ -f "$D/user-config-yaml" ]; then
    mkdir -p "$XDG_CONFIG_HOME/pnpm" && cp "$D/user-config-yaml" "$XDG_CONFIG_HOME/pnpm/config.yaml"
  fi
else
  export npm_config_userconfig=/dev/null pnpm_config_userconfig=/dev/null pnpm_config_npmrc_auth_file=/dev/null
fi
export pnpm_config_update_notifier=false
unset CI PNPM_HOME npm_config_registry
printf '#!/bin/bash\necho "git $*" >> "$GITLOG"\nexec "%s" "$@"\n' "$REAL_GIT" > "$WORK/bin/git"
chmod +x "$WORK/bin/git"
export PATH="$WORK/bin:$PATH"
STORE="$WORK/store"
LOCKDIR=""
[ -f "$D/lock-dir" ] && LOCKDIR="$(tr -d '[:space:]' < "$D/lock-dir")"
LOCK="pnpm-lock.yaml"
[ -n "$LOCKDIR" ] && LOCK="$LOCKDIR/pnpm-lock.yaml"
RUN=""
[ -f "$D/run-dir" ] && RUN="$(tr -d '[:space:]' < "$D/run-dir")"
rm -rf "$D/probes" "$D/before" "$D/after" "$D/again" "$D/pnpm-again.log"
mkdir -p "$D/probes"

snapshot() { # <phase>
  local ph="$1"
  (cd "$P" && find . -path '*/node_modules' -prune -o -type f -print | sort) > "$D/probes/$ph-files.txt"
  for f in package.json pnpm-workspace.yaml .npmrc; do
    if [ -f "$P/$f" ] && ! cmp -s "$P/$f" "$WORK/in-$f"; then
      mkdir -p "$D/probes/$ph-changed" && cp "$P/$f" "$D/probes/$ph-changed/$f"
    fi
  done
  [ -f "$P/pnpm-lock.yaml" ] && cp "$P/pnpm-lock.yaml" "$D/probes/$ph-root-lock"
  # every project's lock of the phase, by its path in the project
  (cd "$P" && find . -path '*/node_modules' -prune -o -name pnpm-lock.yaml -print) | while read -r f; do
    mkdir -p "$(dirname "$D/probes/$ph-locks/$f")" && cp "$P/$f" "$D/probes/$ph-locks/$f"
  done
  [ -d "$WORK/cache-$ph" ] && cp -R "$WORK/cache-$ph" "$D/probes/$ph-cache"
  find "$STORE" -type f 2>/dev/null | sort > "$WORK/store-after-$ph"
  comm -13 "$WORK/store-before-$ph" "$WORK/store-after-$ph" | sed "s#^$STORE/##" > "$D/probes/$ph-store.txt"
}

inputs() {
  for f in package.json pnpm-workspace.yaml .npmrc; do
    rm -f "$WORK/in-$f"
    [ -f "$P/$f" ] && cp "$P/$f" "$WORK/in-$f"
  done
}

run() { # <phase> <log> <args...>
  local ph="$1" log="$2"
  shift 2
  find "$STORE" -type f 2>/dev/null | sort > "$WORK/store-before-$ph"
  export GITLOG="$D/probes/$ph-git.log"
  : > "$GITLOG"
  (cd "$P/$RUN" && "$PNPM" "$@" --cache-dir="$WORK/cache-$ph") > "$log" 2>&1
}

BASE=(install --lockfile-only --no-color --store-dir="$STORE")
AARGS=()
[ -f "$D/args" ] && read -r -a AARGS < "$D/args"

cd "$P" || exit 1
[ -f "$D/npmrc" ] && cp "$D/npmrc" .npmrc
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
if [ -f "$D/workspace-before" ]; then cp "$D/workspace-before" pnpm-workspace.yaml
elif [ -f "$D/workspace" ]; then cp "$D/workspace" pnpm-workspace.yaml; fi
cp "$D/pkg-before" package.json
B_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
inputs
SAVED_RUN="$RUN"
# a `run-dir-before` file makes phase 1 run in run-dir too
[ -f "$D/run-dir-before" ] || RUN=""
run before "$D/pnpm-before.log" "${BASE[@]}"
B=$?
if [ $B -eq 0 ] && [ -f "$D/seed-ignore-workspace" ]; then
  RUN="$LOCKDIR"
  run before "$D/pnpm-before-own.log" "${BASE[@]}" --ignore-workspace
  B=$?
fi
RUN="$SAVED_RUN"
[ $B -eq 0 ] && [ -f "$LOCK" ] && cp "$LOCK" "$D/before"
snapshot before

[ -d "$D/tree" ] && cp -R "$D/tree/." .
[ -f "$D/workspace" ] && cp "$D/workspace" pnpm-workspace.yaml
cp "$D/pkg" package.json
cp "$LOCK" "$WORK/lock-before-after" 2>/dev/null
inputs
A_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run after "$D/pnpm-after.log" "${BASE[@]}" "${AARGS[@]}"
A=$?
[ $A -eq 0 ] && [ -f "$LOCK" ] && cp "$LOCK" "$D/after"
snapshot after

cp "$LOCK" "$WORK/lock-before-again" 2>/dev/null
inputs
G_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run again "$D/pnpm-again.log" "${BASE[@]}" "${AARGS[@]}"
G=$?
if [ $G -ne 0 ]; then S="no lock written"
elif cmp -s "$LOCK" "$WORK/lock-before-again"; then S="lock unchanged"
else S="lock changed"; fi
printf 'pnpm %s, node %s, %s\nexit=%s\n%s\n' "$("$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" \
  "$G_AT" "$G" "$S" >> "$D/pnpm-again.log"
[ "$S" = "lock changed" ] && cp "$LOCK" "$D/again"
snapshot again

{
  printf 'pnpm %s, node %s, %s\n' "$(cd / && "$PNPM" --version 2>/dev/null | tail -1)" "$("$NODE" --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'before exit=%s, after exit=%s\n' "$B" "$A"
  printf 'again exit=%s\n' "$G"
  printf 'phase times: before at %s, after at %s, again at %s\n' "$B_AT" "$A_AT" "$G_AT"
  printf 'platform os=%s cpu=%s libc=%s\n' "$("$NODE" -p process.platform)" "$("$NODE" -p process.arch)" ""
  [ -n "$LOCKDIR" ] && printf 'lock: %s\n' "$LOCK"
  [ -n "$RUN" ] && printf 'pnpm run in: %s\n' "$RUN"
  [ -f "$D/args" ] && printf 'phase 2 args: %s\n' "$(cat "$D/args")"
  [ -f "$D/user-npmrc" ] && printf 'user config: user-npmrc as ~/.npmrc\n'
  [ -f "$D/user-config-yaml" ] && printf 'user config: user-config-yaml as $XDG_CONFIG_HOME/pnpm/config.yaml\n'
} > "$D/recorded-with"
cd / && rm -rf "$WORK"
echo "$(basename "$D") before=$B after=$A again=$G ($S)"

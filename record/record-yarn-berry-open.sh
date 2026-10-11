#!/bin/bash
# Records an open-* yarn-berry scenario: record-yarn-berry.sh's two phases plus the second install and a request log.
# Inputs as record-yarn-berry.sh (pkg-before, pkg, about; optional yarnrc, yarnrc-after, tree-before/, tree/, lock-seed,
# before-commands, http-names), plus optional:
#   overlay.json   hand-made registry documents (make-berry-overlay.js); implies the logging registry
#   args-after     extra `yarn install` arguments for the edit and the second install (one line)
#   install-before the phase-one yarn arguments instead of `install --mode=update-lockfile` (Yarn 2 has no --mode)
#   no-pm-check    allow manifests without a packageManager field (corepack then runs its default Yarn)
# Phases, each with its own empty Yarn cache and global folder:
#   before     install pkg-before over lock-seed (or an empty lock)               -> before, yarn-before.log
#   after      install pkg over before, same directory                             -> after, yarn-after.log
#   again      after succeeded: install pkg over after, same directory and files   -> berry-again.log, again if changed
#              after failed: install pkg over before again (does the failure repeat) -> berry-again.log
#   immutable  install pkg over after with --immutable --mode=skip-build, fresh directory -> yarn-immutable.log
#   fresh      FRESH=1: install pkg from an empty lock                             -> fresh, yarn-fresh.log
# With PROXY=1 or an overlay.json, Yarn talks to yarn-berry-registry.js on 127.0.0.1 (a free port per phase, or $PORT when
# a scenario's lock must name it; set in the scratch home's .yarnrc.yml, so the project's own files are untouched) and
# every request lands in requests-<phase>.log.
# cache-<phase>.list names the archives each phase added to its cache (what it fetched); KEEP_CACHE=1 copies the edit
# phase's archives into cache-after/. Each phase starts from an empty cache, except with WARM_CACHE=1, where before, after
# and again share one, as in a project directory a user installs in (Yarn needs the cached archive of an unchanged
# file: dependency it re-resolves: probes/berry-open/cold-cache).
# Usage: bash record/record-yarn-berry-open.sh <scenario-dir>
set -u
D="$(cd "$1" && pwd)" || exit 1
REAL_HOME="$HOME"
BIN="$(cd "$(dirname "$0")" && pwd)"
trap 'HOME="$REAL_HOME" node "$BIN/redact-paths.js" "$D"; HOME="$REAL_HOME" node "$BIN/strip-registry-people.js" "$D" > /dev/null' EXIT
ROOT="$(cd "$BIN/.." && pwd)"
PORT="${PORT:-0}"
WORK="$(mktemp -d)"
PROJECT="$WORK/project"
mkdir -p "$PROJECT" "$WORK/home"

if [ ! -f "$D/no-pm-check" ]; then
  for f in pkg-before pkg; do
    if ! grep -q '"packageManager" *: *"yarn@' "$D/$f"; then
      echo "$D/$f has no packageManager yarn@<version> field" >&2
      exit 2
    fi
  done
fi

USE_PROXY=""
if [ -f "$D/overlay.json" ]; then
  node "$BIN/make-berry-overlay.js" "$D" || exit 1
  USE_PROXY=1
fi
[ -n "${PROXY:-}" ] && USE_PROXY=1
rm -f "$D"/requests-*.log "$D"/cache-*.list

export HOME="$WORK/home"
export COREPACK_HOME="$ROOT/.cache/corepack"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
export COREPACK_ENABLE_STRICT=1
export YARN_ENABLE_TELEMETRY=0
export YARN_ENABLE_GLOBAL_CACHE=false
export YARN_ENABLE_IMMUTABLE_INSTALLS=false
export YARN_ENABLE_PROGRESS_BARS=false
export YARN_ENABLE_COLORS=false
unset CI

ARGS=""
[ -f "$D/args-after" ] && ARGS="$(head -1 "$D/args-after")"

PROXY_PID=""
start_phase() {
  export YARN_CACHE_FOLDER="$WORK/cache-$1"
  case "$1" in before|after|again) [ -n "${WARM_CACHE:-}" ] && export YARN_CACHE_FOLDER="$WORK/cache-shared" ;; esac
  export YARN_GLOBAL_FOLDER="$WORK/global-$1"
  mkdir -p "$YARN_CACHE_FOLDER" "$YARN_GLOBAL_FOLDER"
  (cd "$YARN_CACHE_FOLDER" && ls -1 | sort) > "$WORK/cache-pre-$1"
  if [ -n "$USE_PROXY" ]; then
    : > "$D/requests-$1.log"
    node "$BIN/yarn-berry-registry.js" "$PORT" "$D/requests-$1.log" "$D/registry" > "$WORK/proxy-$1.out" 2>&1 &
    PROXY_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      grep -q 'listening\|failed' "$WORK/proxy-$1.out" 2>/dev/null && break
      sleep 0.25
    done
    P="$(sed -n 's/^listening //p' "$WORK/proxy-$1.out")"
    if [ -z "$P" ]; then
      echo "$(basename "$D"): registry did not start on port $PORT ($(cat "$WORK/proxy-$1.out"))" >&2
      kill "$PROXY_PID" 2>/dev/null
      rm -rf "$WORK"
      exit 3
    fi
    printf 'npmRegistryServer: "http://127.0.0.1:%s"\nunsafeHttpWhitelist:\n  - "127.0.0.1"\n' "$P" > "$WORK/home/.yarnrc.yml"
  fi
}
end_phase() {
  (cd "$YARN_CACHE_FOLDER" && ls -1 | sort) > "$WORK/cache-post-$1"
  comm -13 "$WORK/cache-pre-$1" "$WORK/cache-post-$1" | grep -v '^\.' > "$D/cache-$1.list"
  [ -s "$D/cache-$1.list" ] || rm -f "$D/cache-$1.list"
  if [ -n "${KEEP_CACHE:-}" ] && [ "$1" = after ]; then
    rm -rf "$D/cache-after" && mkdir -p "$D/cache-after" && cp "$YARN_CACHE_FOLDER"/*.zip "$D/cache-after/" 2>/dev/null
  fi
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; PROXY_PID=""; fi
}

cd "$PROJECT" || exit 1
[ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
[ -f "$D/yarnrc" ] && cp "$D/yarnrc" .yarnrc.yml
if [ -f "$D/lock-seed" ]; then cp "$D/lock-seed" yarn.lock; else : > yarn.lock; fi
cp "$D/pkg-before" package.json
start_phase before
YB="$(corepack yarn --version 2>&1 | tail -1)"
INSTALL_BEFORE="install --mode=update-lockfile"
[ -f "$D/install-before" ] && INSTALL_BEFORE="$(head -1 "$D/install-before")"
# shellcheck disable=SC2086
corepack yarn $INSTALL_BEFORE > "$D/yarn-before.log" 2>&1
B=$?
if [ $B -eq 0 ] && [ -f "$D/before-commands" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    echo "+ yarn $line" >> "$D/yarn-before.log"
    # shellcheck disable=SC2086
    corepack yarn $line >> "$D/yarn-before.log" 2>&1 || B=$?
  done < "$D/before-commands"
fi
end_phase before
rm -f "$D/before" "$D/pkg-before.written" "$D/yarnrc-before.written"
[ $B -eq 0 ] && cp yarn.lock "$D/before"
cmp -s package.json "$D/pkg-before" || cp package.json "$D/pkg-before.written"
if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$D/yarnrc" 2>/dev/null; then cp .yarnrc.yml "$D/yarnrc-before.written"; fi

[ -d "$D/tree" ] && cp -R "$D/tree/." .
[ -f "$D/yarnrc-after" ] && cp "$D/yarnrc-after" .yarnrc.yml
cp "$D/pkg" package.json
cp .yarnrc.yml "$WORK/yarnrc-in" 2>/dev/null || : > "$WORK/yarnrc-in"
start_phase after
YA="$(corepack yarn --version 2>&1 | tail -1)"
A=skipped
rm -f "$D/after" "$D/pkg.written" "$D/yarnrc.written" "$D/again" "$D/berry-again.log" "$D/yarn-immutable.log"
if [ $B -eq 0 ]; then
  cp yarn.lock "$WORK/before-lock"
  # shellcheck disable=SC2086
  corepack yarn install --mode=update-lockfile $ARGS > "$D/yarn-after.log" 2>&1
  A=$?
  [ $A -eq 0 ] && cp yarn.lock "$D/after"
  cmp -s package.json "$D/pkg" || cp package.json "$D/pkg.written"
  if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$WORK/yarnrc-in"; then cp .yarnrc.yml "$D/yarnrc.written"; fi
fi
end_phase after

G=skipped
CHANGED=no
if [ $B -eq 0 ]; then
  [ "$A" != 0 ] && cp "$WORK/before-lock" yarn.lock
  cp yarn.lock "$WORK/again-in"
  cp package.json "$WORK/pkg-again-in"
  cp .yarnrc.yml "$WORK/yarnrc-again-in" 2>/dev/null || : > "$WORK/yarnrc-again-in"
  start_phase again
  # shellcheck disable=SC2086
  corepack yarn install --mode=update-lockfile $ARGS > "$D/berry-again.log" 2>&1
  G=$?
  end_phase again
  if [ $G -ne 0 ]; then S="no lock written"; elif cmp -s yarn.lock "$WORK/again-in"; then S="lock unchanged"; else S="lock changed"; fi
  printf 'over=%s\nexit=%s\n%s\n' "$([ "$A" = 0 ] && echo after || echo before)" "$G" "$S" >> "$D/berry-again.log"
  cmp -s package.json "$WORK/pkg-again-in" || echo "package.json changed" >> "$D/berry-again.log"
  if [ -f .yarnrc.yml ] && ! cmp -s .yarnrc.yml "$WORK/yarnrc-again-in"; then echo ".yarnrc.yml changed" >> "$D/berry-again.log"; fi
  if [ "$S" = "lock changed" ]; then CHANGED=yes; cp yarn.lock "$D/again"; fi
fi
cd / && rm -rf "$PROJECT"

I=skipped
if [ "$A" = 0 ]; then
  mkdir -p "$PROJECT" && cd "$PROJECT" || exit 1
  [ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
  [ -d "$D/tree" ] && cp -R "$D/tree/." .
  if [ -f "$D/yarnrc.written" ]; then cp "$D/yarnrc.written" .yarnrc.yml
  elif [ -f "$D/yarnrc-after" ]; then cp "$D/yarnrc-after" .yarnrc.yml
  elif [ -f "$D/yarnrc-before.written" ]; then cp "$D/yarnrc-before.written" .yarnrc.yml
  elif [ -f "$D/yarnrc" ]; then cp "$D/yarnrc" .yarnrc.yml; fi
  if [ -f "$D/pkg.written" ]; then cp "$D/pkg.written" package.json; else cp "$D/pkg" package.json; fi
  cp "$D/after" yarn.lock
  start_phase immutable
  YARN_ENABLE_IMMUTABLE_INSTALLS=true YARN_ENABLE_SCRIPTS=false corepack yarn install --immutable --mode=skip-build > "$D/yarn-immutable.log" 2>&1
  I=$?
  end_phase immutable
  cd / && rm -rf "$PROJECT"
fi

F=skipped
if [ -n "${FRESH:-}" ]; then
  mkdir -p "$PROJECT" && cd "$PROJECT" || exit 1
  [ -d "$D/tree-before" ] && cp -R "$D/tree-before/." .
  [ -d "$D/tree" ] && cp -R "$D/tree/." .
  if [ -f "$D/yarnrc-after" ]; then cp "$D/yarnrc-after" .yarnrc.yml; elif [ -f "$D/yarnrc" ]; then cp "$D/yarnrc" .yarnrc.yml; fi
  cp "$D/pkg" package.json
  : > yarn.lock
  start_phase fresh
  # shellcheck disable=SC2086
  corepack yarn install --mode=update-lockfile $ARGS > "$D/yarn-fresh.log" 2>&1
  F=$?
  end_phase fresh
  rm -f "$D/fresh"
  [ $F -eq 0 ] && cp yarn.lock "$D/fresh"
  cd / && rm -rf "$PROJECT"
fi

REGLINE="registry: default (registry.yarnpkg.com)"
[ -n "${WARM_CACHE:-}" ] && REGLINE="cache: one Yarn cache for before, after and again; $REGLINE"
[ -n "$USE_PROXY" ] && REGLINE="registry: yarn-berry-registry.js on 127.0.0.1:$([ "$PORT" = 0 ] && echo '<free port>' || echo "$PORT") via the scratch home .yarnrc.yml$([ -f "$D/overlay.json" ] && echo ", overlay.json documents first")"
printf 'yarn %s then %s (corepack %s), node %s, %s %s (node %s), %s\nbefore exit=%s, after exit=%s\nagain exit=%s changed=%s; immutable exit=%s; fresh exit=%s%s\n%s\n' \
  "$YB" "$YA" "$(corepack --version)" "$(node --version)" "$(uname -s)" "$(uname -m)" \
  "$(node -p 'process.platform + "-" + process.arch')" "$(date -u +%Y-%m-%d)" "$B" "$A" "$G" "$CHANGED" "$I" "$F" \
  "$([ -n "$ARGS" ] && echo "; install args: $ARGS")" "$REGLINE" > "$D/recorded-with"
rm -rf "$WORK"
[ -z "${NO_HTTP:-}" ] && node "$BIN/yarn-berry-http.js" "$D"
echo "$(basename "$D") before=$B after=$A again=$G changed=$CHANGED immutable=$I fresh=$F"

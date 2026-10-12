// The recording's clock for a pnpm that is a native executable (pnpm 12), where NODE_OPTIONS=--require fake-clock.js
// has nothing to load into: a small library that dyld inserts into the process (DYLD_INSERT_LIBRARIES) and that
// answers the wall clock (clock_gettime(CLOCK_REALTIME), gettimeofday, time, clock_gettime_nsec_np) shifted so that
// it starts at SWEEP_NOW_EPOCH_MS and runs on from there. Monotonic clocks and file times are left alone.
// macOS only; needs the command line tools' clang. The executable must not be signed with the hardened runtime
// (pnpm 12's is ad-hoc signed without it), or dyld ignores the variable.
// Usage: node pnpm-native-clock.js <sweep shared dir>      writes <dir>/_native/fake-clock.dylib (and its source)
//        node pnpm-native-clock.js <sweep shared dir> --check <executable>   prints the date the executable's
//                                                                           process sees through /bin/date's twin
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const SOURCE = `#include <stdint.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#define INTERPOSE(replacement, replacee) \\
  __attribute__((used)) static struct { const void *a; const void *b; } interpose_##replacee \\
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&replacement, (const void *)(unsigned long)&replacee };

/* fake = real + offset_ns; inside this library the real functions are called (dyld does not interpose its caller) */
static int64_t offset_ns = 0;

__attribute__((constructor)) static void sweep_clock_init(void) {
  const char *want = getenv("SWEEP_NOW_EPOCH_MS");
  if (!want || !*want) return;
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  offset_ns = atoll(want) * 1000000LL - ((int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec);
}

static int sweep_clock_gettime(clockid_t id, struct timespec *tp) {
  int r = clock_gettime(id, tp);
  if (r == 0 && tp && id == CLOCK_REALTIME && offset_ns) {
    int64_t ns = (int64_t)tp->tv_sec * 1000000000LL + tp->tv_nsec + offset_ns;
    tp->tv_sec = (time_t)(ns / 1000000000LL);
    tp->tv_nsec = (long)(ns % 1000000000LL);
  }
  return r;
}

static uint64_t sweep_clock_gettime_nsec_np(clockid_t id) {
  uint64_t v = clock_gettime_nsec_np(id);
  return id == CLOCK_REALTIME && v ? (uint64_t)((int64_t)v + offset_ns) : v;
}

static int sweep_gettimeofday(struct timeval *tv, void *tz) {
  int r = gettimeofday(tv, tz);
  if (r == 0 && tv && offset_ns) {
    int64_t us = (int64_t)tv->tv_sec * 1000000LL + tv->tv_usec + offset_ns / 1000LL;
    tv->tv_sec = (time_t)(us / 1000000LL);
    tv->tv_usec = (suseconds_t)(us % 1000000LL);
  }
  return r;
}

static time_t sweep_time(time_t *out) {
  struct timespec ts;
  sweep_clock_gettime(CLOCK_REALTIME, &ts);
  if (out) *out = ts.tv_sec;
  return ts.tv_sec;
}

INTERPOSE(sweep_clock_gettime, clock_gettime)
INTERPOSE(sweep_clock_gettime_nsec_np, clock_gettime_nsec_np)
INTERPOSE(sweep_gettimeofday, gettimeofday)
INTERPOSE(sweep_time, time)
`

const PROBE = `#include <stdio.h>
#include <sys/time.h>
#include <time.h>
int main(void) {
  struct timespec ts;
  struct timeval tv;
  clock_gettime(CLOCK_REALTIME, &ts);
  gettimeofday(&tv, 0);
  printf("clock_gettime=%lld gettimeofday=%lld time=%lld nsec_np=%llu\\n", (long long)ts.tv_sec, (long long)tv.tv_sec,
         (long long)time(0), (unsigned long long)(clock_gettime_nsec_np(CLOCK_REALTIME) / 1000000000ULL));
  return 0;
}
`

const dir = path.join(path.resolve(process.argv[2]), '_native')
const lib = path.join(dir, 'fake-clock.dylib')
fs.mkdirSync(dir, { recursive: true })
const cc = args => {
  const r = spawnSync('/usr/bin/clang', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`clang ${args.join(' ')}: ${r.stderr}`)
}
fs.writeFileSync(path.join(dir, 'fake-clock.c'), SOURCE)
cc(['-O2', '-dynamiclib', '-o', lib + '.tmp', path.join(dir, 'fake-clock.c')])
fs.renameSync(lib + '.tmp', lib)
fs.writeFileSync(path.join(dir, 'probe.c'), PROBE)
cc(['-O2', '-o', path.join(dir, 'probe'), path.join(dir, 'probe.c')])
// the probe under the library must see the time it was given
const want = Date.parse('2026-10-07T01:50:09Z')
const r = spawnSync(path.join(dir, 'probe'), [], { encoding: 'utf8', env: { DYLD_INSERT_LIBRARIES: lib, SWEEP_NOW_EPOCH_MS: String(want) } })
const seen = (r.stdout || '').trim()
const ok = seen.split(' ').every(kv => Math.abs(Number(kv.split('=')[1]) - want / 1000) <= 2)
console.log(`${lib}\n  probe under it: ${seen} (asked ${want / 1000}): ${ok ? 'ok' : 'NOT SHIFTED'}`)
if (!ok) process.exitCode = 1

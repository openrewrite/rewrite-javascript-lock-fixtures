// The recording's clock for bun, a native executable (pnpm-native-clock.js, for the Bun sweep): a small library that
// dyld inserts into the process (DYLD_INSERT_LIBRARIES) and that answers the wall clock (clock_gettime(CLOCK_REALTIME),
// gettimeofday, time, clock_gettime_nsec_np) shifted so that it starts at SWEEP_NOW_EPOCH_MS and runs on from there.
// Monotonic clocks and file times are left alone. Every bun release is signed with the hardened runtime and entitled
// to dyld environment variables and unsigned libraries (bun-smoke.js), so dyld honours the variable.
// It then checks that bun itself sees the shifted time, on both of its clocks:
//   JavaScriptCore's Date      `bun -e 'console.log(Date.now())'`
//   the install's std.time     the expiry bun writes into a cached manifest (npm.zig: now + 300 s), read back from the
//                              cache file of a lock-only install against a one-package registry on 127.0.0.1
// Usage: node bun-native-clock.js <sweep shared dir> [--check <bun executable> ...]
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawnSync, spawn } = require('child_process')

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
console.log(lib)

const want = Date.parse('2026-10-05T12:00:00Z')
const checks = process.argv.includes('--check') ? process.argv.slice(process.argv.indexOf('--check') + 1).map(f => path.resolve(f)) : []

// a registry with one package, whose packument bun caches with an expiry it computes from its own clock
const DOC = JSON.stringify({ name: 'zz-clock', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'zz-clock', version: '1.0.0',
  dist: { tarball: 'http://127.0.0.1:0/zz-clock/-/zz-clock-1.0.0.tgz', integrity: 'sha512-AAAA' } } } })

const main = async () => {
  for (const exe of checks) {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bun-clock-'))
    const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, NO_COLOR: '1', DYLD_INSERT_LIBRARIES: lib, SWEEP_NOW_EPOCH_MS: String(want) }
    const js = spawnSync(exe, ['-e', 'console.log(Date.now())'], { cwd: home, env, encoding: 'utf8' })
    const jsSeen = Number((js.stdout || '').trim())
    // the install's clock: a manifest cached by a lock-only install holds an expiry of now + 300 s (u32, little endian)
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' })
      res.end(DOC.replace('127.0.0.1:0', `127.0.0.1:${server.address().port}`))
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    const proj = path.join(home, 'proj')
    fs.mkdirSync(proj)
    fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"p","dependencies":{"zz-clock":"1.0.0"}}')
    fs.writeFileSync(path.join(proj, 'bunfig.toml'), `[install]\nregistry = "http://127.0.0.1:${server.address().port}/"\n`)
    const cache = path.join(home, 'cache')
    // bun 1.3 writes the manifest cache on a worker thread and may exit before it is on disk: try until it is
    const cached = () => fs.existsSync(cache) && fs.readdirSync(cache).some(f => f.endsWith('.npm'))
    for (let attempt = 0; attempt < 12 && !cached(); attempt++) {
      fs.rmSync(path.join(proj, 'bun.lock'), { force: true })
      fs.rmSync(path.join(proj, 'bun.lockb'), { force: true })
      await new Promise(resolve => {
        const child = spawn(exe, ['install', '--lockfile-only', '--no-progress', '--save-text-lockfile'], { cwd: proj, env: { ...env, BUN_INSTALL_CACHE_DIR: cache } })
        child.on('close', resolve)
      })
    }
    server.close()
    // every u32 in the cached manifest within a day of the shifted time + 300 s
    const near = []
    const walk = d => {
      if (!fs.existsSync(d)) return
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.npm')) {
          const b = fs.readFileSync(p)
          for (let i = 0; i + 4 <= b.length; i++) {
            const v = b.readUInt32LE(i)
            if (Math.abs(v - (want / 1000 + 300)) < 86400) near.push(v)
          }
        }
      }
    }
    walk(cache)
    const realNear = []
    const jsOk = Math.abs(jsSeen - want) < 60000
    const zigOk = near.some(v => Math.abs(v - (want / 1000 + 300)) < 120)
    console.log(`${exe}\n  JavaScriptCore Date.now: ${new Date(jsSeen).toISOString()} ${jsOk ? 'shifted' : 'NOT SHIFTED'}\n  install manifest expiry: ${near.length ? near.map(v => new Date(v * 1000).toISOString()).join(' ') : 'none near the shifted time'} ${zigOk ? 'shifted' : 'NOT SHIFTED'}`)
    if (!jsOk || !zigOk) process.exitCode = 1
    fs.rmSync(home, { recursive: true, force: true })
    void realNear
  }
}
main()

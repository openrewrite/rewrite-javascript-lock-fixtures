// Replays recorded Bun scenarios with other Bun releases against a frozen registry (bun-registry.js): each scenario's
// own http/ (and http-<label>/ for another registry host), so every release sees the registry the recording saw. For
// each release and scenario it runs the phases of the recorder that made the scenario, with its command line
// (`bun install --lockfile-only --no-progress`), environment and cache use, and the sweep's own:
//   before        pkg-before installed from scratch (lock-before: the lock is given and the phase is skipped)
//   after         pkg installed in the same directory over that lock, with the same install cache
//   frozen        --frozen-lockfile over after, in a copy of the project       (record-bun.sh, -open.sh, -user.sh)
//   again         the edit's command again over after, in a copy of the project, warm cache (after-again when the
//                 lock changed); record-bun-open.sh runs it over before when the edit failed
//   cold          the edit again from the edit's start with an empty cache and --verbose (cold when its lock is
//                 another than after)                                          (record-bun-open.sh, -user.sh)
//   fresh         pkg installed from scratch in another directory, same cache   (record-bun.sh, -open.sh, -user.sh)
//   before-again  the install over this release's before, in a fresh project with before's inputs, cold cache
//                 (again-bun-lock.sh)
//   cross         pkg installed over the fixture's own before (the lock the ported release wrote), fresh project
//   cross-again   the edit's command again over the cross lock, when that is another lock than after
// Which recorder made a scenario is read from what it holds:
//   user        record-bun-user.sh   user-npmrc or user-npmrc-before: $HOME/.npmrc, XDG_CONFIG_HOME unset
//   lockdir     (no recorder in record/; "run in <dir>")   lock-dir and above/: the project and its lock in lock-dir,
//               phase one alone there, the edit with above/ laid out above it, run in lock-dir
//   rundir      (no recorder in record/; "edit run in <dir>")   run-dir: phase one at the root, the edit run in run-dir
//   open        record-bun-open.sh   recorded-with names `again exit=` and `empty-cache rerun exit=`
//   plain       record-bun.sh        any other recorded-with; the fixtures' bun-again.log says `mode=warm`
//   downloaded  no recorded-with: the downloaded fixtures' layout (pkg-after, pkg-root, pkg-<member>[-before|-after]),
//               placed by again-bun-lock.sh's bun-place-manifests.js rule; phases as plain
// Releases without bun.lock as their default (1.1.39 - 1.1.45) get --save-text-lockfile on every run (from scratch they
// write bun.lockb without it; over a text lock it changes nothing); releases without --lockfile-only (1.1.39 -
// 1.1.42) are given the recorder's command line as it is, which they take as a full install.
// The clock is the recording's (the edit's start, else the end of the recording's day), interposed into the
// executable by bun-native-clock.js's library (<shared>/_native/fake-clock.dylib, which must exist); --clock real
// leaves the machine's. No scenario sets minimumReleaseAge (bunfig) or --minimum-release-age, the only settings
// through which bun's resolution reads the clock, so either clock writes the same locks (checked on the control).
// Output: <out>/<release>/<scenario>/
//   before, after, after-again, fresh, cold, before-again(-lock), cross, cross-again   locks as written
//   locks/<phase>/<path>   every bun.lock of the project after the phase (lockdir and rundir)
//   <phase>.log, requests.log, result.json (exits, what equals the fixture, second-install statuses, overlay)
//
// Usage: node sweep-bun.js --scenarios <lock/bun> --pm <pm/bun> --out <dir> --releases 1.3.10,1.2.23 | --releases-file <f>
//          [--only <regex> | --only-file <file>] [--jobs 4] [--timeout 120] [--work <dir>] [--shared <dir>]
//          [--clock real|recording] [--no-text-flag] [--force] [--keep]
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { ensureCa, startRegistry } = require('./bun-registry.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)

const SCENARIOS = path.resolve(arg('scenarios'))
const PM = path.resolve(arg('pm'))
const OUT = path.resolve(arg('out'))
const JOBS = Number(arg('jobs', 4))
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const ONLY_NAMES = arg('only-file') ? new Set(fs.readFileSync(arg('only-file'), 'utf8').split('\n').map(l => l.split(/\s+/)[0]).filter(l => l && !l.startsWith('#'))) : null
const FORCE = flag('force')
const KEEP = flag('keep')
const TIMEOUT = Number(arg('timeout', 120)) * 1000
// A run whose CPU time and output have not moved for STALL seconds while the registry answers nothing is stalled:
// several releases wait in their event loop forever on some peer graphs (0% CPU, no socket). It is killed then and
// marked; such a cell is to be run again alone with --stall 0 (only the timeout) before it is called a hang.
const STALL = Number(arg('stall', 30)) * 1000
const CLOCK = arg('clock', 'recording')
// --no-text-flag: run 1.1.39 - 1.1.45 without --save-text-lockfile (to show what the flag does)
const TEXT_FLAG = !flag('no-text-flag')
const WORKROOT = fs.realpathSync(arg('work', os.tmpdir()))
const SHARED = path.resolve(arg('shared', OUT))
const NAMESPACE = `${path.basename(SCENARIOS)}-${crypto.createHash('sha1').update(SCENARIOS).digest('hex').slice(0, 8)}`
const NATIVE_CLOCK = path.join(SHARED, '_native', 'fake-clock.dylib')
const RELEASES = arg('releases-file')
  ? fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean)
  : arg('releases').split(',')

const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null
const readBuf = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null
const isDir = f => fs.existsSync(f) && fs.statSync(f).isDirectory()
const cmpV = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const atLeast = (v, w) => cmpV(v, w) >= 0

// what a release takes on its command line (bun-format-facts.js, from each tag's source)
const capabilities = release => ({
  // bun.lock is written from scratch only with --save-text-lockfile before 1.2.0
  textByFlag: atLeast(release, '1.1.39') && !atLeast(release, '1.2.0'),
  lockfileOnly: atLeast(release, '1.1.43'),
  textLock: atLeast(release, '1.1.39'),
})

const LOCKS = ['before', 'after', 'fresh']
const discover = () => fs.readdirSync(SCENARIOS, { withFileTypes: true })
  .filter(e => e.isDirectory() && LOCKS.some(l => fs.existsSync(path.join(SCENARIOS, e.name, l))))
  .map(e => e.name).sort()

// files under a directory by path relative to it
const treeOf = (dir, skipModules) => {
  const out = []
  const walk = (d, rel) => {
    if (!isDir(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!(skipModules && e.name === 'node_modules')) walk(path.join(d, e.name), r)
      } else if (e.isFile()) {
        out.push(r)
      }
    }
  }
  walk(dir, '')
  return out.sort()
}

// the last line of a recorded second install (`lock unchanged` | `lock changed` | `no lock written`), and its exit
const statusOf = log => {
  if (log == null) return null
  const lines = log.trimEnd().split('\n')
  const exitLine = lines.map(l => l.match(/^exit=(\S+)$/)).filter(Boolean).pop()
  return { status: lines[lines.length - 1].replace(/ \(.*\)$/, ''), exit: exitLine ? exitLine[1] : null }
}

// what the recorder was given for the scenario, or why the sweep leaves it out
const shape = name => {
  const d = path.join(SCENARIOS, name)
  const has = f => fs.existsSync(path.join(d, f))
  const recorded = read(path.join(d, 'recorded-with'))
  if (has('link')) return { skip: 'link/: the recorder registers packages with `bun link` (not swept)' }
  // the downloaded fixtures' http/ documents are hand-made (no version carries dist.integrity, none has `modified`; four
  // scenarios hold none): the locks were written against another registry than the one recorded, which no frozen
  // registry reproduces (the control writes "" for every integrity). --downloaded sweeps them anyway.
  if (recorded == null && !flag('downloaded')) return { skip: 'not a recording (no recorded-with): a downloaded fixture whose http/ documents are hand-made (no integrity)' }
  let kind
  if (recorded == null) kind = 'downloaded'
  else if (has('lock-dir')) kind = 'lockdir'
  else if (has('run-dir')) kind = 'rundir'
  else if (has('user-npmrc') || has('user-npmrc-before')) kind = 'user'
  else if (/again exit=/.test(recorded) && /empty-cache rerun exit=/.test(recorded)) kind = 'open'
  else kind = 'plain'
  const pkg = has('pkg') ? 'pkg' : has('pkg-after') ? 'pkg-after' : has('pkg-root') ? 'pkg-root' : null
  if (!pkg) return { skip: 'no edited manifest' }
  const started = recorded && recorded.match(/^edit started (\S+)$/m)
  const day = recorded && recorded.split('\n')[0].match(/, (\d{4}-\d{2}-\d{2})\s*$/)
  const exits = {}
  for (const m of (recorded || '').matchAll(/(before|after|frozen-over-after|fresh|again|empty-cache rerun) exit=([^,\s]+)/g)) exits[m[1]] = m[2]
  return {
    dir: d, kind, has, pkg,
    lockDir: (read(path.join(d, 'lock-dir')) || '').trim(),
    runDir: (read(path.join(d, 'run-dir')) || '').trim(),
    seeded: has('lock-before'),
    at: started ? started[1] : day ? `${day[1]}T23:59:59Z` : null,
    atDay: !started && !!day,
    fixtureExits: exits,
  }
}

// cp -R <from>/. <to>
const copyTree = (from, to) => {
  if (isDir(from)) fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
}

// The downloaded fixtures' manifests for a phase (bun-place-manifests.js): the root's, and each pkg-<member> where the
// lock's workspaces name the member
const placeManifests = (s, phase, lockText, P) => {
  const rootFile = phase === 'before'
    ? (s.has('pkg-before') ? 'pkg-before' : s.has('pkg-root') ? 'pkg-root' : null)
    : (s.has('pkg') ? 'pkg' : s.has('pkg-after') ? 'pkg-after' : s.has('pkg-root') ? 'pkg-root' : null)
  if (!rootFile) return false
  fs.copyFileSync(path.join(s.dir, rootFile), path.join(P, 'package.json'))
  let lock = null
  try {
    lock = JSON.parse(String(lockText || '').replace(/^\s*\/\/.*$/mg, '').replace(/,(\s*[}\]])/g, '$1'))
  } catch (e) {
    lock = null
  }
  const members = {}
  for (const f of fs.readdirSync(s.dir)) {
    const m = /^pkg-(.+?)(?:-(before|after))?$/.exec(f)
    if (!m || ['before', 'after', 'root'].includes(m[1]) || !s.has(f) || isDir(path.join(s.dir, f))) continue
    if (m[2] && m[2] !== phase) continue
    if (!m[2] && members[m[1]]) continue
    members[m[1]] = f
  }
  const workspaces = (lock && lock.workspaces) || {}
  for (const [name, f] of Object.entries(members)) {
    const loc = Object.keys(workspaces).find(k => k !== '' && workspaces[k].name === name)
    if (!loc) continue
    fs.mkdirSync(path.join(P, loc), { recursive: true })
    fs.copyFileSync(path.join(s.dir, f), path.join(P, loc, 'package.json'))
  }
  return true
}

// the error lines bun printed (what a failure is compared by)
const errorsIn = text => [...new Set((text || '').split('\n').map(l => l.trim()).filter(l => /^error: |^[A-Za-z]+: failed to parse lockfile|^warn: Ignoring lockfile/.test(l))
  .map(l => l.replace(/\s+\[[\d.]+m?s\]$/, '')))]

const sweepOne = async (release, name, ca) => {
  const outDir = path.join(OUT, release, name)
  if (!FORCE && fs.existsSync(path.join(outDir, 'result.json'))) return 'cached'
  const s = shape(name)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const exe = path.join(PM, release, 'package', 'bin', 'bun')
  const cap = capabilities(release)
  const result = { release, scenario: name, exits: {}, errors: {}, same: {} }
  const finish = outcome => {
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1) + '\n')
    return outcome
  }
  if (s.skip) {
    result.skip = s.skip
    return finish('skipped')
  }
  result.kind = s.kind
  result.recordedAt = s.at
  result.command = ['install', ...(cap.textByFlag && TEXT_FLAG ? ['--save-text-lockfile'] : []), '--lockfile-only', '--no-progress']
  if (!cap.lockfileOnly) result.lockfileOnly = 'not a flag of this release: the recorder\'s command line is a full install'
  result.clock = CLOCK
  const fixture = f => read(path.join(s.dir, f))
  const keep = (label, text) => {
    fs.mkdirSync(path.dirname(path.join(outDir, label)), { recursive: true })
    fs.writeFileSync(path.join(outDir, label), text)
  }

  const works = []
  const newWork = () => {
    const w = fs.mkdtempSync(path.join(WORKROOT, 'bun-sweep-'))
    works.push(w)
    const dirs = s.kind === 'user' ? ['home', 'cache', 'cache-req', 'tmp', 'proj', 'fresh'] : ['home/.config', 'cache', 'cache-req', 'tmp', 'proj', 'fresh']
    for (const d of dirs) fs.mkdirSync(path.join(w, d), { recursive: true })
    return w
  }
  const log = { requests: [], overlay: new Set(), live: new Set() }
  const server = await startRegistry({ scenarioDir: s.dir, scenario: `${NAMESPACE}/${name}`, shared: SHARED, at: s.at, atDay: s.atDay, ca, log })
  const redact = text => {
    let out = text
    for (const w of works) out = out.split(w).join('<tmp>').split(w.replace(/^\/private/, '')).join('<tmp>')
    return out.split(`127.0.0.1:${server.port}`).join('127.0.0.1:<proxy>')
  }

  // the recorder's run_bun, with the frozen registry's proxy and CA added to the environment
  const run = (w, cwd, cache, extra, label, now) => new Promise(resolve => {
    const proxy = `http://127.0.0.1:${server.port}`
    const env = {
      PATH: '/usr/bin:/bin', HOME: path.join(w, 'home'),
      ...(s.kind === 'user' ? {} : { XDG_CONFIG_HOME: path.join(w, 'home', '.config') }),
      XDG_CACHE_HOME: path.join(w, 'home', '.cache'), BUN_INSTALL_CACHE_DIR: cache, TMPDIR: path.join(w, 'tmp'), NO_COLOR: '1',
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NODE_EXTRA_CA_CERTS: ca.caFile,
    }
    if (CLOCK === 'recording' && now && fs.existsSync(NATIVE_CLOCK)) {
      env.DYLD_INSERT_LIBRARIES = NATIVE_CLOCK
      env.SWEEP_NOW_EPOCH_MS = String(Date.parse(now))
      ;(result.clockStarts = result.clockStarts || {})[label] = now
    }
    const args = [...result.command, ...extra]
    log.requests.push(`# ${label}`)
    const child = spawn(exe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    let lastOutput = Date.now()
    child.stdout.on('data', c => { out.push(c); lastOutput = Date.now() })
    child.stderr.on('data', c => { out.push(c); lastOutput = Date.now() })
    const started = Date.now()
    let stalled = null
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT)
    // the child's CPU time, from ps (`[[dd-]hh:]mm:ss.cc`)
    let lastCpu = null
    let lastCpuChange = Date.now()
    const watch = STALL > 0 ? setInterval(() => {
      const r = require('child_process').spawnSync('ps', ['-o', 'time=', '-p', String(child.pid)], { encoding: 'utf8' })
      const cpu = (r.stdout || '').trim()
      if (!cpu) return
      if (cpu !== lastCpu) {
        lastCpu = cpu
        lastCpuChange = Date.now()
        return
      }
      const now = Date.now()
      if (now - lastCpuChange >= STALL && now - lastOutput >= STALL && server.inflight() === 0) {
        stalled = `stalled: no CPU time, no output and no registry request for ${STALL / 1000}s (cpu ${cpu}, after ${Math.round((now - started) / 1000)}s)`
        child.kill('SIGKILL')
      }
    }, 5000) : null
    child.on('error', e => out.push(Buffer.from(`spawn error: ${e.message}\n`)))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (watch) clearInterval(watch)
      const exit = code == null ? `signal:${signal}` : code
      if (code == null) (result.hung = result.hung || {})[label] = stalled || `killed at the ${TIMEOUT / 1000}s timeout`
      ;(result.ms = result.ms || {})[label] = Date.now() - started
      const text = redact(Buffer.concat(out).toString('utf8'))
      result.exits[label] = exit
      const errs = errorsIn(text)
      if (errs.length) result.errors[label] = errs
      keep(`${label}.log`, text)
      resolve(exit)
    })
  })

  const seedConfig = (P, phase, w) => {
    fs.rmSync(path.join(P, '.npmrc'), { force: true })
    fs.rmSync(path.join(P, 'bunfig.toml'), { force: true })
    const pre = s.kind === 'open' || s.kind === 'user'
    if (pre && phase === 'before' && s.has('npmrc-before')) fs.copyFileSync(path.join(s.dir, 'npmrc-before'), path.join(P, '.npmrc'))
    else if (s.has('npmrc')) fs.copyFileSync(path.join(s.dir, 'npmrc'), path.join(P, '.npmrc'))
    if (pre && phase === 'before' && s.has('bunfig-before')) fs.copyFileSync(path.join(s.dir, 'bunfig-before'), path.join(P, 'bunfig.toml'))
    else if (s.has('bunfig')) fs.copyFileSync(path.join(s.dir, 'bunfig'), path.join(P, 'bunfig.toml'))
    if (s.kind === 'user') {
      const home = path.join(w, 'home', '.npmrc')
      fs.rmSync(home, { force: true })
      if (phase === 'before' && s.has('user-npmrc-before')) {
        if ((fixture('user-npmrc-before') || '').length) fs.copyFileSync(path.join(s.dir, 'user-npmrc-before'), home)
      } else if (s.has('user-npmrc')) {
        fs.copyFileSync(path.join(s.dir, 'user-npmrc'), home)
      }
    }
  }
  // where the lock is, and where bun runs, relative to the project root
  const lockRel = s.kind === 'lockdir' ? path.join(s.lockDir, 'bun.lock') : 'bun.lock'
  const editDir = P => path.join(P, s.kind === 'lockdir' ? s.lockDir : s.kind === 'rundir' ? s.runDir : '')
  const beforeDir = P => path.join(P, s.kind === 'lockdir' ? s.lockDir : '')
  const lockOf = P => read(path.join(P, lockRel))
  const binaryOf = P => fs.existsSync(path.join(P, path.dirname(lockRel), 'bun.lockb'))
  const locksOf = P => Object.fromEntries(treeOf(P, true).filter(f => path.basename(f) === 'bun.lock').map(f => [f, read(path.join(P, f))]))
  const noteBinary = (P, label) => {
    if (binaryOf(P)) result.binary = [...new Set([...(result.binary || []), label])]
  }
  // The project's manifests and files of a phase, as the recorder lays them out:
  //   fresh    a new directory: config, tree-before/, (tree/,) the phase's manifest
  //   inPlace  the edit over phase one's directory: record-bun-open.sh and -user.sh seed the edit's config again
  //            (removing phase one's .npmrc and bunfig.toml first), record-bun.sh does not; then tree/ and pkg
  const lay = (P, w, phase, lockText, inPlace) => {
    const root = s.kind === 'lockdir' ? path.join(P, s.lockDir) : P
    fs.mkdirSync(root, { recursive: true })
    if (s.kind === 'lockdir' && phase === 'after') copyTree(path.join(s.dir, 'above'), P)
    if (!inPlace || s.kind === 'open' || s.kind === 'user') seedConfig(root, phase, w)
    if (!inPlace) copyTree(path.join(s.dir, 'tree-before'), root)
    if (phase === 'after') copyTree(path.join(s.dir, 'tree'), root)
    if (s.kind === 'downloaded') placeManifests(s, phase, lockText, root)
    else fs.copyFileSync(path.join(s.dir, phase === 'before' ? 'pkg-before' : s.pkg), path.join(root, 'package.json'))
  }
  const locksChange = (beforeLocks, P) => {
    const now = locksOf(P)
    const lines = []
    for (const f of [...new Set([...Object.keys(beforeLocks), ...Object.keys(now)])].sort()) {
      if (!(f in now)) lines.push(`${f} removed`)
      else if (!(f in beforeLocks)) lines.push(`${f} created`)
      else lines.push(`${f} ${now[f] === beforeLocks[f] ? 'unchanged' : 'changed'}`)
    }
    return lines
  }
  const keepLocks = (P, phase) => {
    for (const [f, text] of Object.entries(locksOf(P))) keep(`locks/${phase}/${f}`, text)
  }
  // A second install over the lock in P: `lock unchanged` | `lock changed` | `no lock written`, by the recorder's rule:
  //   file  record-bun-open.sh and -user.sh (and the fixtures' bun-again.log of record-bun.sh scenarios): the lock
  //         file alone decides, whatever bun exited with (a failed run over an untouched lock is `lock unchanged`)
  //   exit  again-bun-lock.sh: a run that exits non-zero is `no lock written`
  const secondInstall = async (w, P, cache, label, keepAs, now, rule, ref) => {
    const start = ref === undefined ? lockOf(P) : ref
    const g = await run(w, editDir(P), cache, [], label, now)
    const again = lockOf(P)
    noteBinary(P, label)
    const status = again == null || (rule === 'exit' && g !== 0) ? 'no lock written' : again === start ? 'lock unchanged' : 'lock changed'
    if (again != null && again !== start && (rule !== 'exit' || g === 0)) keep(keepAs, again)
    return status
  }

  try {
    if (!fs.existsSync(exe)) throw new Error(`no bun ${release} under ${PM}`)
    const pre = s.has('pkg-before') || s.has('pkg-root')
    const fixtureBefore = fixture('before')
    // ---- before: pkg-before from scratch, or the given lock
    const w = newWork()
    const P = path.join(w, 'proj')
    lay(P, w, 'before', fixtureBefore, false)
    let before = null
    if (s.seeded) {
      fs.copyFileSync(path.join(s.dir, 'lock-before'), path.join(P, lockRel))
      result.exits.before = 'seeded'
      before = fixture('lock-before')
      keep('before', before)
    } else if (pre) {
      const b = await run(w, beforeDir(P), path.join(w, 'cache'), [], 'before', s.at)
      before = b === 0 ? lockOf(P) : null
      noteBinary(P, 'before')
      if (before != null) keep('before', before)
      if (fixtureBefore != null) result.same.before = before === fixtureBefore
    }
    if (s.kind === 'lockdir' || s.kind === 'rundir') keepLocks(P, 'before')
    // the edit's starting state, for the empty-cache rerun
    const req = path.join(w, 'req')
    fs.cpSync(P, req, { recursive: true, verbatimSymlinks: true })

    // ---- after: pkg over that lock, in the same directory and cache
    const locksBeforeEdit = locksOf(P)
    lay(P, w, 'after', fixture('after') || fixtureBefore, true)
    const a = await run(w, editDir(P), path.join(w, 'cache'), [], 'after', s.at)
    let after = a === 0 ? lockOf(P) : null
    // the lockdir recorder keeps `after` only when the lock in lock-dir changed ("again exit=skipped" otherwise)
    if (s.kind === 'lockdir' && after != null && after === before) {
      after = null
      result.afterUnchanged = true
    }
    noteBinary(P, 'after')
    if (after != null) keep('after', after)
    result.fixtureHasAfter = fixture('after') != null
    if (result.fixtureHasAfter) result.same.after = after === fixture('after')
    if (s.kind === 'open' || s.kind === 'user') {
      result.filesAfter = fs.readdirSync(P).filter(f => f !== 'node_modules').sort()
      if (fixture('files-after') != null) result.same.filesAfter = JSON.stringify(result.filesAfter) === JSON.stringify(fixture('files-after').split('\n').filter(Boolean).sort())
    }
    if (s.kind === 'lockdir' || s.kind === 'rundir') {
      result.locksAfter = locksChange(locksBeforeEdit, P)
      keepLocks(P, 'after')
      if (fixture('locks-after') != null) result.same.locksAfter = JSON.stringify(result.locksAfter) === JSON.stringify(fixture('locks-after').trim().split('\n'))
    }
    if (a !== 0 && fixture('after') == null && fixture('bun-after.log') != null) {
      result.same.afterErrors = JSON.stringify(result.errors.after || []) === JSON.stringify(errorsIn(fixture('bun-after.log')))
    }

    // ---- frozen: --frozen-lockfile over after
    if (['plain', 'open', 'user'].includes(s.kind) && after != null) {
      const F = path.join(w, 'frozen')
      fs.cpSync(P, F, { recursive: true, verbatimSymlinks: true })
      await run(w, editDir(F), path.join(w, 'cache'), ['--frozen-lockfile'], 'frozen', s.at)
    }

    // ---- again: the second install over after (record-bun-open.sh: over before when the edit failed)
    const fixtureAgain = statusOf(fixture('bun-again.log'))
    let againOver = null
    const overBefore = s.kind === 'open' || s.kind === 'plain'
    if (after != null) againOver = 'after'
    else if (overBefore && a !== 0 && before != null) againOver = 'before (the edit failed)'
    else if (overBefore && a === 0) againOver = 'none (the edit left no lock file)'
    if (againOver) {
      const G = path.join(w, 'again')
      // over the project as the edit left it, compared with after, with before when the edit failed, or with nothing
      fs.cpSync(P, G, { recursive: true, verbatimSymlinks: true })
      const ref = againOver === 'after' ? after : againOver.startsWith('before') ? before : null
      result.again = await secondInstall(w, G, path.join(w, 'cache'), 'again', 'after-again', s.at, 'file', ref)
      result.againOver = againOver
      if (againOver.startsWith('none') && lockOf(G) != null) result.again = 'lock changed'
      if (fixtureAgain) {
        result.same.again = result.again === fixtureAgain.status &&
          (result.again !== 'lock changed' || fixture('again') == null || read(path.join(outDir, 'after-again')) === fixture('again'))
      }
    }

    // ---- cold: the edit from its starting state with an empty cache, --verbose (record-bun-open.sh, -user.sh)
    if (s.kind === 'open' || s.kind === 'user') {
      lay(req, w, 'after', fixture('after') || fixtureBefore, true)
      // (the recorder's rule: the lock file alone decides, against the after lock of this run)
      await run(w, editDir(req), path.join(w, 'cache-req'), ['--verbose'], 'cold', s.at)
      const cold = lockOf(req)
      result.cold = cold == null ? 'no lock written' : after != null && cold === after ? 'lock same as after' : 'lock differs from after'
      if (cold != null && cold !== after) keep('cold', cold)
      const theirs = (fixture('requests-after.log') || '').trim().split('\n').pop() || ''
      const m = theirs.match(/^exit=\S+, (.*)$/)
      if (m) result.same.cold = m[1] === result.cold
      // the requests the verbose rerun made, as the recorder lists them
      const verbose = read(path.join(outDir, 'cold.log')) || ''
      const asked = []
      let u = null
      let acc = '-'
      for (const line of verbose.split('\n')) {
        const r = line.match(/^> HTTP\/1\.1 (\S+) (\S+)/) || line.match(/^> (GET) (\S+) HTTP\/1\.1/)
        if (r) {
          if (u) asked.push(`${u} accept=${acc}`)
          u = `${r[1]} ${r[2]}`
          acc = '-'
        }
        const h = line.match(/^> Accept: (.*)$/i)
        if (h) acc = h[1]
      }
      if (u) asked.push(`${u} accept=${acc}`)
      result.coldRequests = asked
    }

    // ---- fresh: pkg from scratch in another directory, the same cache
    if (['plain', 'open', 'user'].includes(s.kind)) {
      const Fr = path.join(w, 'fresh')
      lay(Fr, w, 'after', fixture('after') || fixtureBefore, false)
      const r = await run(w, editDir(Fr), path.join(w, 'cache'), [], 'fresh', s.at)
      const fresh = r === 0 ? lockOf(Fr) : null
      noteBinary(Fr, 'fresh')
      if (fresh != null) keep('fresh', fresh)
      if (fixture('fresh') != null) result.same.fresh = fresh === fixture('fresh')
    }

    // ---- before-again: the install over this release's before, fresh project, cold cache (again-bun-lock.sh)
    if (before != null) {
      const w2 = newWork()
      const P2 = path.join(w2, 'proj')
      lay(P2, w2, 'before', before)
      fs.mkdirSync(path.dirname(path.join(P2, lockRel)), { recursive: true })
      fs.writeFileSync(path.join(P2, lockRel), before)
      result.beforeAgain = await secondInstall(w2, P2, path.join(w2, 'cache'), 'before-again', 'before-again-lock', s.at, 'exit')
      const theirs = statusOf(fixture('bun-before-again.log'))
      if (theirs && (s.seeded || result.same.before)) {
        result.same.beforeAgain = result.beforeAgain === theirs.status &&
          (result.beforeAgain !== 'lock changed' || fixture('before-again') == null || read(path.join(outDir, 'before-again-lock')) === fixture('before-again'))
      }
    }

    // ---- cross: the edit over the fixture's own before, in a fresh project
    if (fixtureBefore != null) {
      const w3 = newWork()
      const P3 = path.join(w3, 'proj')
      lay(P3, w3, 'after', fixture('after') || fixtureBefore)
      fs.mkdirSync(path.dirname(path.join(P3, lockRel)), { recursive: true })
      fs.writeFileSync(path.join(P3, lockRel), fixtureBefore)
      const locks3 = locksOf(P3)
      const c = await run(w3, editDir(P3), path.join(w3, 'cache'), [], 'cross', s.at)
      const cross = c === 0 ? lockOf(P3) : null
      noteBinary(P3, 'cross')
      if (cross != null) keep('cross', cross)
      if (result.fixtureHasAfter) result.same.cross = cross === fixture('after')
      if (s.kind === 'lockdir' || s.kind === 'rundir') {
        result.locksCross = locksChange(locks3, P3)
        keepLocks(P3, 'cross')
      }
      // ---- cross-again: the second install over the cross lock; the same lock as after gets after's
      if (cross != null) {
        if (cross === after && result.again !== undefined) {
          result.crossAgain = result.again
          result.crossAgainFrom = 'again'
        } else {
          result.crossAgain = await secondInstall(w3, P3, path.join(w3, 'cache'), 'cross-again', 'cross-again', s.at, 'file')
        }
      }
    }
    // what the recording's exit codes say of the same phases
    const fx = s.fixtureExits
    const pairs = [['before', 'before'], ['after', 'after'], ['frozen-over-after', 'frozen'], ['fresh', 'fresh'], ['again', 'again'], ['empty-cache rerun', 'cold']]
      .filter(([theirs, mine]) => fx[theirs] !== undefined && fx[theirs] !== 'skipped' && fx[theirs] !== 'seeded' && result.exits[mine] !== undefined)
    if (pairs.length) result.same.exits = pairs.every(([theirs, mine]) => String(result.exits[mine]) === fx[theirs])
  } catch (e) {
    result.error = String(e && e.stack || e)
  } finally {
    server.close()
    if (!KEEP) for (const w of works) fs.rmSync(w, { recursive: true, force: true })
    else result.kept = works
  }
  result.overlay = [...log.overlay].sort()
  result.live = [...log.live].sort()
  fs.writeFileSync(path.join(outDir, 'requests.log'), log.requests.join('\n') + '\n')
  return finish('ran')
}

const main = async () => {
  const scenarios = discover().filter(n => (!ONLY || ONLY.test(n)) && (!ONLY_NAMES || ONLY_NAMES.has(n)))
  fs.mkdirSync(OUT, { recursive: true })
  if (CLOCK === 'recording' && !fs.existsSync(NATIVE_CLOCK)) {
    console.error(`no ${NATIVE_CLOCK}: run bun-native-clock.js ${SHARED} first, or pass --clock real`)
    process.exit(1)
  }
  const ca = ensureCa(path.join(SHARED, '_ca'))
  const tasks = []
  for (const release of RELEASES) {
    if (!fs.existsSync(path.join(PM, release, 'package', 'bin', 'bun'))) {
      console.error(`no bun ${release} under ${PM}`)
      process.exitCode = 1
      continue
    }
    for (const name of scenarios) tasks.push([release, name])
  }
  const total = tasks.length
  const started = Date.now()
  const tally = { ran: 0, cached: 0, skipped: 0 }
  let done = 0
  const worker = async () => {
    for (;;) {
      const t = tasks.shift()
      if (!t) return
      let outcome
      try {
        outcome = await sweepOne(t[0], t[1], ca)
      } catch (e) {
        console.error(`${t[0]} ${t[1]}: ${e && e.stack || e}`)
        outcome = 'ran'
      }
      tally[outcome]++
      done++
      if (done % 50 === 0 || done === total) {
        const secs = Math.round((Date.now() - started) / 1000)
        console.log(`${done}/${total} in ${secs}s  (ran ${tally.ran}, cached ${tally.cached}, skipped ${tally.skipped})  ${t[0]}`)
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker))
}
main()

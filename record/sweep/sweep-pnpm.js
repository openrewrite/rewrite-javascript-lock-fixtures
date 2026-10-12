// Replays recorded pnpm scenarios with other pnpm releases against a frozen registry (pnpm-registry.js): each
// scenario's own http/, so every release sees the registry the recording saw. For each release and scenario it runs
// the recorder's phases, as the recorder that made the scenario ran them, and one more:
//   before       pkg-before installed from scratch             (seed-lock: the lock is given and the phase is skipped)
//   after        pkg installed in the same directory over that lock
//   again        the edit's command again over `after`         (after-again when the lock changed)
//   cross        pkg installed over the fixture's own `before`, the lock the recording release wrote, in a fresh
//                project (where the release's own `before` phase left exactly that, the after phase is this install)
//   cross-again  the edit's command again over the cross lock, when that is another lock than `after`
// The clock of each run is the recording's (pnpm-run-with-clock.js; pnpm-native-clock.js for pnpm 12's executable).
// Which recorder made a scenario is read from what it holds:
//   user     record-pnpm-user.sh     user-npmrc or user-config-yaml
//   lockdir  record-pnpm-lockdir.sh  recorded-with has `again exit=`, and lock-dir, run-dir, seed-ignore-workspace or probes
//   open     record-pnpm-open.sh     recorded-with has `again exit=`
//   plain    record-pnpm.sh          otherwise, with again-pnpm.sh's fresh project for the second install
// Output: <out>/<release>/<scenario>/
//   before, after, after-again, cross, cross-again   the lock of the scenario (lock-dir's, else the root's), paths redacted
//   <phase>.log, requests.log, git-<phase>.log pnpm's output, what the registry served, the git commands pnpm ran
//   changed/<phase>/<file>                     package.json, pnpm-workspace.yaml or .npmrc as pnpm left it changed
//   locks/<phase>/<path>                       every project's lock of the phase (lockdir and user scenarios)
//   result.json                                exit codes, error codes, what equals the fixture, `again` and `crossAgain`
//                                              (lock unchanged | lock changed | no lock written), the project's files
//                                              after each phase, what the registry added
// A release that asks for the tarball of another pnpm (packageManager, devEngines.packageManager) is refused it:
// no other pnpm than the release swept runs, and result.json's pm.refused names what it asked for.
//
// Usage: node sweep-pnpm.js --scenarios <dir of scenarios> --pm <dir of unpacked releases> --out <dir>
//          --releases 11.2.2,10.34.6 | --releases-file <file>
//          [--only <regex> | --only-file <file of scenario names>] [--jobs 4] [--node <binary>] [--work <scratch root>]
//          [--shared <dir>] [--cross always] [--env KEY=VALUE ...] [--no-clock] [--force] [--keep]
//   --shared  where the CA, today's registry documents and the as-of packuments are kept (default: <out>), so a
//             second run into another <out> (a repeat, another scenario directory) asks the registry nothing again
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { ensureCa, startRegistry } = require('./pnpm-registry.js')
const { errorsIn } = require('./pnpm-cell.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)

const SCENARIOS = path.resolve(arg('scenarios'))
const PM = path.resolve(arg('pm'))
const OUT = path.resolve(arg('out'))
const JOBS = Number(arg('jobs', 4))
const NODE = path.resolve(arg('node', process.execPath))
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const ONLY_NAMES = arg('only-file') ? new Set(fs.readFileSync(arg('only-file'), 'utf8').split('\n').map(l => l.split(/\s+/)[0]).filter(l => l && !l.startsWith('#'))) : null
const FORCE = flag('force')
const KEEP = flag('keep')
const USE_CLOCK = !flag('no-clock')
// `always`: run the cross phase even where the after phase was the same install
const CROSS = arg('cross', 'when-needed')
// --env KEY=VALUE (repeatable): a variable added to every run's environment and named in result.json, for a sweep
// that departs from the recorder's on purpose (pnpm_config_pm_on_fail=ignore: the release installs the project
// itself whatever release the manifest names)
const EXTRA_ENV = Object.fromEntries(process.argv.map((a, i) => a === '--env' ? process.argv[i + 1] : null).filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
// a real path: macOS's /var/folders is a symlink
const WORKROOT = fs.realpathSync(arg('work', os.tmpdir()))
const RELEASES = arg('releases-file')
  ? fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean)
  : arg('releases').split(',')
// what every release and every run reuses: the CA, today's registry documents, tarballs, the as-of packuments
const SHARED = path.resolve(arg('shared', OUT))
// the as-of packuments are a scenario's own, and two scenario directories may hold scenarios of one name
const NAMESPACE = `${path.basename(SCENARIOS)}-${require('crypto').createHash('sha1').update(SCENARIOS).digest('hex').slice(0, 8)}`
const CLOCK_RUNNER = path.join(__dirname, 'pnpm-run-with-clock.js')
const NATIVE_CLOCK = path.join(SHARED, '_native', 'fake-clock.dylib')
const TIMEOUT = Number(arg('timeout', 300)) * 1000
const IDLE_AFTER_ERROR = Number(arg('idle-after-error', 30)) * 1000
const REAL_GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', '/usr/bin/git'].find(f => fs.existsSync(f))
const NODE_VERSION = spawnSync(NODE, ['--version'], { encoding: 'utf8' }).stdout.trim()

const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null
const isDir = f => fs.existsSync(f) && fs.statSync(f).isDirectory()
const words = text => (text || '').trim().split(/\s+/).filter(Boolean)

// Two scenarios were recorded when record-pnpm-lockdir.sh still ran phase 1 in run-dir: their `before` is the lock a
// run in packages/b writes (their lockfileDir "." names the directory pnpm runs in), and they hold no run-dir-before
// file, which the recorder asks for today. A run at the root writes no lock there, for the recording release either.
const PHASE1_IN_RUN_DIR = new Set(['open-ws-lockfile-dir-member-run', 'open-ws-lockfile-dir-shared-member-run'])

const LOCKS = ['before', 'after', 'seed-lock', 'again']
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

// what the recorder was given for the scenario, or why the sweep leaves it out
const shape = name => {
  const d = path.join(SCENARIOS, name)
  const has = f => fs.existsSync(path.join(d, f))
  const recorded = read(path.join(d, 'recorded-with'))
  if (recorded == null) return { skip: 'not a recording (no recorded-with: a downloaded fixture with a hand-made registry)' }
  if (!has('pkg')) return { skip: 'no edited manifest (pkg)' }
  const lockDir = (read(path.join(d, 'lock-dir')) || '').trim()
  const runDir = (read(path.join(d, 'run-dir')) || '').trim()
  const user = has('user-npmrc') || has('user-config-yaml')
  const three = /^again exit=/m.test(recorded)
  const kind = user ? 'user' : !three ? 'plain'
    : lockDir || runDir || has('seed-ignore-workspace') || has('run-dir-before') || isDir(path.join(d, 'probes')) ? 'lockdir' : 'open'
  const first = recorded.split('\n')[0]
  const recordedAt = (first.match(/, (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/) || [])[1] || null
  const at = phase => {
    const m = recorded.match(new RegExp(`${phase} at (\\S+?),?(?:\\s|$)`))
    return m ? m[1] : recordedAt
  }
  const againLog = read(path.join(d, 'pnpm-again.log'))
  let againAt = at('again')
  let fixtureAgain = null
  let fixtureAgainExit = null
  if (againLog != null) {
    const lines = againLog.trimEnd().split('\n')
    fixtureAgain = lines[lines.length - 1]
    fixtureAgainExit = (lines[lines.length - 2] || '').replace(/^exit=/, '')
    const trailer = lines[lines.length - 3] || ''
    const t = trailer.match(/^pnpm \S*, node \S+, (\S+)$/)
    if (t && kind === 'plain') againAt = t[1]
  }
  const exits = recorded.match(/^before exit=(\S+), after exit=(\S+)$/m) || []
  const env = {}
  for (const line of (read(path.join(d, 'env')) || '').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    dir: d, kind, lockDir, runDir, has, env,
    recordedBy: (first.match(/^pnpm (\S*),/) || [])[1] || '',
    runDirBefore: has('run-dir-before') || !!runDir && PHASE1_IN_RUN_DIR.has(name),
    seedIgnoreWorkspace: has('seed-ignore-workspace'),
    seedLock: has('seed-lock') && (kind === 'plain' || kind === 'open'),
    fullBefore: has('full-before') && kind === 'open',
    storePerPhase: /^store: empty at the start of each phase/m.test(recorded),
    bargs: kind === 'open' ? words((read(path.join(d, 'args-before')) || '').split('\n')[0]) : [],
    // record-pnpm.sh splits the whole file into words; the others read its first line
    aargs: kind === 'plain' ? words(read(path.join(d, 'args'))) : words((read(path.join(d, 'args')) || '').split('\n')[0]),
    beforeAt: at('before'), afterAt: at('after'), againAt,
    fixtureExits: { before: exits[1], after: exits[2], again: fixtureAgainExit == null ? undefined : fixtureAgainExit },
    fixtureAgain,
  }
}

const cliOf = release => {
  const root = path.join(PM, release)
  const scoped = path.join(root, '@pnpm')
  if (isDir(scoped)) {
    const exe = fs.readdirSync(scoped).map(d => path.join(scoped, d, 'pnpm')).find(f => fs.existsSync(f))
    if (exe) return { native: true, file: exe }
  }
  const manifestFile = path.join(root, 'package', 'package.json')
  if (!fs.existsSync(manifestFile)) return null
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if ((manifest.optionalDependencies || {})[`@pnpm/exe.${process.platform}-${process.arch}`]) return { missingNative: true }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin || {}).pnpm
  return bin ? { native: false, file: path.join(root, 'package', bin) } : null
}

// cp -R <from>/. <to>
const copyTree = (from, to) => {
  if (isDir(from)) fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true })
}

const sweepOne = async (release, name, ca) => {
  const outDir = path.join(OUT, release, name)
  if (!FORCE && fs.existsSync(path.join(outDir, 'result.json'))) return 'cached'
  const s = shape(name)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const cli = cliOf(release)
  const result = { release, scenario: name, node: cli && cli.native ? `native (node on PATH ${NODE_VERSION})` : NODE_VERSION, exits: {}, errors: {}, same: {} }
  const finish = outcome => {
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1) + '\n')
    return outcome
  }
  if (s.skip) {
    result.skip = s.skip
    return finish('skipped')
  }
  result.kind = s.kind
  if (Object.keys(EXTRA_ENV).length) result.extraEnv = EXTRA_ENV
  result.recordedBy = s.recordedBy
  result.fixtureExits = s.fixtureExits
  result.fixtureAgain = s.fixtureAgain
  result.clock = !USE_CLOCK ? 'real' : cli.native ? (fs.existsSync(NATIVE_CLOCK) ? 'recording (interposed)' : 'real') : 'recording'

  const works = []
  const newWork = () => {
    const w = fs.mkdtempSync(path.join(WORKROOT, 'pnpm-sweep-'))
    works.push(w)
    for (const d of ['project', 'home', 'bin', 'tmp']) fs.mkdirSync(path.join(w, d))
    // the recorder's wrapper, which logs each git command; git itself asks its hosts directly
    fs.writeFileSync(path.join(w, 'bin', 'git'), `#!/bin/bash\necho "git $*" >> "$GITLOG"\nunset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NODE_OPTIONS DYLD_INSERT_LIBRARIES\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 })
    // the same for node: a Node process pnpm starts from PATH is logged (it runs on the machine's clock)
    fs.writeFileSync(path.join(w, 'bin', 'node'), `#!/bin/bash\nfirst="$*"\nprintf 'node %s\\n' "\${first%%$'\\n'*}" >> "$NODELOG"\nunset DYLD_INSERT_LIBRARIES\nexec "${NODE}" "$@"\n`, { mode: 0o755 })
    if (s.kind === 'user') {
      if (s.has('user-npmrc')) fs.copyFileSync(path.join(s.dir, 'user-npmrc'), path.join(w, 'home', '.npmrc'))
      if (s.has('user-config-yaml')) {
        fs.mkdirSync(path.join(w, 'home', '.config', 'pnpm'), { recursive: true })
        fs.copyFileSync(path.join(s.dir, 'user-config-yaml'), path.join(w, 'home', '.config', 'pnpm', 'config.yaml'))
      }
    }
    return w
  }
  const log = { requests: [], overlay: new Set(), live: new Set(), pmMetadata: new Set(), pmRefused: new Set() }
  const server = await startRegistry({ scenarioDir: s.dir, scenario: `${NAMESPACE}/${name}`, shared: SHARED, at: s.afterAt, ca, log })
  // as record/redact-paths.js writes a recording's paths
  const redact = text => {
    let out = text
    for (const w of works) out = out.split(w).join('<tmp>').split(w.replace(/^\/private/, '')).join('<tmp>')
    return out.replace(/<tmp>\/home(?=[/\s'"`:,;)\]}]|$)/gm, '<home>').split(`127.0.0.1:${server.port}`).join('127.0.0.1:<proxy>')
  }
  // a recording's redacted path, in a file given to pnpm, is this run's
  const unredact = (dir, w) => {
    for (const f of treeOf(dir, true)) {
      const file = path.join(dir, f)
      const buf = fs.readFileSync(file)
      if (buf.includes(0) || !(buf.includes('<tmp>') || buf.includes('<home>'))) continue
      fs.writeFileSync(file, buf.toString('utf8').split('<home>').join(path.join(w, 'home')).split('<tmp>').join(w))
      result.unredacted = [...new Set([...(result.unredacted || []), f])]
    }
  }
  const fixture = f => read(path.join(s.dir, f))
  const keep = (label, text) => {
    fs.mkdirSync(path.dirname(path.join(outDir, label)), { recursive: true })
    fs.writeFileSync(path.join(outDir, label), text)
  }
  const ran = new Set()
  // where each project's clock stood when its last run ended
  const clocks = new Map()

  const run = (w, cwd, args, label, now) => new Promise(resolve => {
    const home = path.join(w, 'home')
    const proxy = `http://127.0.0.1:${server.port}`
    const gitLog = path.join(w, `git-${label}.log`)
    const env = {
      PATH: `${path.join(w, 'bin')}:${path.dirname(NODE)}:/usr/bin:/bin`,
      HOME: home, TMPDIR: path.join(w, 'tmp'), LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
      // the recorder's setting, and the same one under the name pnpm 9 and 10 read
      pnpm_config_update_notifier: 'false', npm_config_update_notifier: 'false',
      HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
      NODE_EXTRA_CA_CERTS: ca.caFile,
      GITLOG: gitLog, NODELOG: `${gitLog}.node`,
      // where V8's code cache of the release's bundle is kept between runs; it changes nothing but the start time
      NODE_COMPILE_CACHE: path.join(SHARED, '_compile-cache', release),
      V8_COMPILE_CACHE_CACHE_DIR: path.join(SHARED, '_compile-cache', release),
      ...s.env,
      ...EXTRA_ENV,
    }
    if (s.kind !== 'user') {
      env.npm_config_userconfig = '/dev/null'
      env.pnpm_config_userconfig = '/dev/null'
      env.pnpm_config_npmrc_auth_file = '/dev/null'
    }
    // The clock starts at the recorded time of the phase, and never before the clock of the run before it in the
    // same project ended: a slower replay must not run a phase in the past of what the last one left behind.
    let started = null
    let entry = cli.native ? [] : [cli.file]
    if (USE_CLOCK && now) {
      started = Math.max(Date.parse(now), (clocks.get(w) || 0) + 1)
      env.SWEEP_NOW = new Date(started).toISOString()
      ;(result.clockStarts = result.clockStarts || {})[label] = env.SWEEP_NOW
      if (!cli.native) {
        // a wrapper that sets the clock and then runs the CLI as the main module; not a --require preload, which
        // Node resolves from the working directory, failing on a malformed package.json there before pnpm runs
        entry = [CLOCK_RUNNER, cli.file]
      } else if (fs.existsSync(NATIVE_CLOCK)) {
        // pnpm-native-clock.js: the same clock for an executable that is no Node script
        env.DYLD_INSERT_LIBRARIES = NATIVE_CLOCK
        env.SWEEP_NOW_EPOCH_MS = String(started)
      }
    }
    const realStart = Date.now()
    // pnpm 12's command line takes no --cache-dir: the recorder's directory is given as the setting's environment name
    const cacheFlag = cli.native ? args.find(x => x.startsWith('--cache-dir=')) : undefined
    if (cacheFlag) {
      args = args.filter(x => x !== cacheFlag)
      env.pnpm_config_cache_dir = cacheFlag.slice('--cache-dir='.length)
      result.cacheDir = 'pnpm_config_cache_dir (this release has no --cache-dir flag)'
    }
    log.requests.push(`# ${label}`)
    fs.writeFileSync(gitLog, '')
    // stdin: an open pipe nobody writes to (the default), or with SWEEP_STDIN=ignore /dev/null
    const stdio = [process.env.SWEEP_STDIN === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe']
    const child = cli.native ? spawn(cli.file, args, { cwd, env, stdio }) : spawn(NODE, [...entry, ...args], { cwd, env, stdio })
    const out = []
    // pnpm 10.16 and later print some errors (a config dependency without an integrity) and then never exit: a run
    // that has printed an error and stays silent for IDLE_AFTER_ERROR is killed as the overall timeout would kill it
    let lastOutput = Date.now()
    let printedError = false
    const onData = c => {
      out.push(c)
      lastOutput = Date.now()
      if (/ERR_PNPM_|\bERROR\b/.test(c.toString('utf8'))) printedError = true
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT)
    const idle = setInterval(() => {
      if (printedError && Date.now() - lastOutput > IDLE_AFTER_ERROR) {
        ;(result.hung = result.hung || {})[label] = `killed after printing an error and staying silent ${IDLE_AFTER_ERROR / 1000}s`
        child.kill('SIGKILL')
      }
    }, 2000)
    child.on('error', e => out.push(Buffer.from(`spawn error: ${e.message}\n`)))
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearInterval(idle)
      if (code == null && !(result.hung || {})[label]) (result.hung = result.hung || {})[label] = `killed at the ${TIMEOUT / 1000}s timeout`
      if (started != null) clocks.set(w, started + (Date.now() - realStart))
      const text = redact(Buffer.concat(out).toString('utf8'))
      const exit = code == null ? `signal:${signal}` : code
      result.exits[label] = exit
      const errs = errorsIn(text)
      if (errs.length) result.errors[label] = errs
      for (const m of text.matchAll(/using pnpm v(\S+)/g)) ran.add(m[1])
      keep(`${label}.log`, text)
      const git = read(gitLog)
      if (git) {
        keep(`git-${label}.log`, redact(git))
        ;(result.git = result.git || {})[label] = git.trimEnd().split('\n').length
      }
      const nodes = read(`${gitLog}.node`)
      if (nodes) (result.nodeChildren = result.nodeChildren || {})[label] = redact(nodes).trimEnd().split('\n')
      resolve(exit)
    })
  })

  const WATCHED = ['package.json', 'pnpm-workspace.yaml', '.npmrc']
  const inputsOf = P => Object.fromEntries(WATCHED.map(f => [f, read(path.join(P, f))]))
  const locksOf = P => Object.fromEntries(treeOf(P, true).filter(f => path.basename(f) === 'pnpm-lock.yaml').map(f => [f, redact(read(path.join(P, f)))]))
  const snapshot = (P, phase, inputs) => {
    ;(result.files = result.files || {})[phase] = treeOf(P, true)
    for (const f of WATCHED) {
      const now = read(path.join(P, f))
      if (now === inputs[f]) continue
      ;(result.changed = result.changed || {})[phase] = [...((result.changed || {})[phase] || []), now == null ? `${f} (removed)` : f]
      keep(`changed/${phase}/${f}`, now == null ? '' : redact(now))
    }
    const locks = locksOf(P)
    const names = Object.keys(locks)
    if (s.kind === 'lockdir' || s.kind === 'user' || names.length > 1 || (names.length === 1 && names[0] !== 'pnpm-lock.yaml')) {
      for (const [f, text] of Object.entries(locks)) keep(`locks/${phase}/${f}`, text)
    }
    const probes = path.join(s.dir, 'probes', `${phase}-locks`)
    if (isDir(probes)) {
      const theirs = Object.fromEntries(treeOf(probes).map(f => [f, read(path.join(probes, f))]))
      result.same[`locks-${phase}`] = JSON.stringify(Object.keys(theirs).sort()) === JSON.stringify(names.sort()) &&
        names.every(f => theirs[f] === locks[f])
    }
  }

  try {
    if (!cli || cli.missingNative) throw new Error(cli ? 'the native executable of this release is not unpacked' : 'no pnpm CLI in this release')
    const lockRel = s.lockDir ? path.join(s.lockDir, 'pnpm-lock.yaml') : 'pnpm-lock.yaml'
    const cacheArg = (w, ph) => s.kind === 'plain' ? [] : [`--cache-dir=${path.join(w, `cache-${ph}`)}`]
    const baseOf = (w, ph) => ['install', '--lockfile-only', '--no-color', `--store-dir=${s.storePerPhase && !s.fullBefore ? path.join(w, `store-${ph}`) : path.join(w, 'store')}`]
    const place = (file, to) => {
      if (s.has(file)) fs.copyFileSync(path.join(s.dir, file), to)
      return s.has(file)
    }
    const lockOf = P => {
      const text = read(path.join(P, lockRel))
      return text == null ? null : redact(text)
    }

    // ---- before: pkg-before from scratch
    const w = newWork()
    const P = path.join(w, 'project')
    if (!(s.kind === 'open' && place('npmrc-before', path.join(P, '.npmrc')))) place('npmrc', path.join(P, '.npmrc'))
    copyTree(path.join(s.dir, 'tree-before'), P)
    if (!place('workspace-before', path.join(P, 'pnpm-workspace.yaml'))) place('workspace', path.join(P, 'pnpm-workspace.yaml'))
    place('pkg-before', path.join(P, 'package.json'))
    if (s.seedLock) fs.copyFileSync(path.join(s.dir, 'seed-lock'), path.join(P, 'pnpm-lock.yaml'))
    unredact(P, w)
    if (s.seedLock) {
      result.exits.before = 'seeded'
      keep('before', fixture('seed-lock'))
    } else {
      const inputs = inputsOf(P)
      const first = s.fullBefore ? ['install', '--ignore-scripts', '--no-color', `--store-dir=${path.join(w, 'store')}`] : baseOf(w, 'before')
      let b = await run(w, path.join(P, s.runDirBefore ? s.runDir : ''), [...first, ...s.bargs, ...cacheArg(w, 'before')], 'before', s.beforeAt)
      if (b === 0 && s.seedIgnoreWorkspace) {
        b = await run(w, path.join(P, s.lockDir), [...baseOf(w, 'before'), '--ignore-workspace', ...cacheArg(w, 'before')], 'before-own', s.beforeAt)
        result.exits.before = b
      }
      const lock = lockOf(P)
      if (b === 0 && lock != null) {
        keep('before', lock)
        if (fixture('before') != null) result.same.before = lock === fixture('before')
      } else if (fixture('before') != null) {
        result.same.before = false
      }
      snapshot(P, 'before', inputs)
    }

    // ---- after: pkg over that lock, in the same directory
    if (s.kind === 'open' && s.has('npmrc-before')) {
      fs.rmSync(path.join(P, '.npmrc'), { force: true })
      place('npmrc', path.join(P, '.npmrc'))
    }
    copyTree(path.join(s.dir, 'tree'), P)
    place('workspace', path.join(P, 'pnpm-workspace.yaml'))
    place('pkg', path.join(P, 'package.json'))
    unredact(P, w)
    const lockBeforeAfter = lockOf(P)
    // whether the project held another lock than the scenario's when the edit started
    const lockBeforeAfterOthers = Object.keys(locksOf(P)).some(f => f !== lockRel)
    const afterInputs = inputsOf(P)
    const a = await run(w, path.join(P, s.runDir), [...baseOf(w, 'after'), ...s.aargs, ...cacheArg(w, 'after')], 'after', s.afterAt)
    const after = lockOf(P)
    result.fixtureHasAfter = fixture('after') != null
    if (a === 0 && after != null) {
      keep('after', after)
      if (result.fixtureHasAfter) result.same.after = after === fixture('after')
    } else {
      if (result.fixtureHasAfter) result.same.after = false
      if (a !== 0 && after != null && after !== lockBeforeAfter) keep('after-lock-written-on-failure', after)
    }
    snapshot(P, 'after', afterInputs)

    // The edit's command once more over the lock an install left in project P of w: in that same project for the
    // three-phase recorders, in a fresh project holding the edit's inputs and that lock for record-pnpm.sh, whose
    // second install is again-pnpm.sh. Returns the status the recorders write, and keeps the lock when it changed.
    const secondInstall = async (label, keepAs, w1, P1, overFailedEdit) => {
      const start = lockOf(P1)
      if (s.kind !== 'plain') {
        const inputs = inputsOf(P1)
        const g = await run(w1, path.join(P1, s.runDir), [...baseOf(w1, label), ...s.aargs, ...cacheArg(w1, label)], label, s.againAt)
        const again = lockOf(P1)
        let status = g !== 0 ? 'no lock written' : again === start ? 'lock unchanged' : 'lock changed'
        // record-pnpm-open.sh alone says more of a failed run
        if (s.kind === 'open' && g !== 0 && again !== start) status = 'lock written although the run failed'
        if (s.kind === 'open' && overFailedEdit) status += ' (over the lock the failed edit run wrote)'
        if (again != null && again !== start) keep(keepAs, again)
        snapshot(P1, label, inputs)
        return status
      }
      const w2 = newWork()
      const P2 = path.join(w2, 'project')
      place('npmrc', path.join(P2, '.npmrc'))
      copyTree(path.join(s.dir, 'tree-before'), P2)
      copyTree(path.join(s.dir, 'tree'), P2)
      if (!place('workspace', path.join(P2, 'pnpm-workspace.yaml'))) place('workspace-before', path.join(P2, 'pnpm-workspace.yaml'))
      place('pkg', path.join(P2, 'package.json'))
      unredact(P2, w2)
      // the lock this release wrote, with its paths in this project
      fs.writeFileSync(path.join(P2, 'pnpm-lock.yaml'), read(path.join(P1, lockRel)).split(w1).join(w2))
      const inputs = inputsOf(P2)
      const g = await run(w2, P2, baseOf(w2, label), label, s.againAt)
      const again = lockOf(P2)
      if (g === 0 && again != null && again !== start) keep(keepAs, again)
      snapshot(P2, label, inputs)
      return g !== 0 ? 'no lock written' : again === start ? 'lock unchanged' : 'lock changed'
    }

    // ---- again: the second install over `after` (the three-phase recorders run it over whatever the edit left)
    let againStatus = null
    if (s.kind !== 'plain' || (a === 0 && after != null)) {
      againStatus = await secondInstall('again', 'after-again', w, P, a !== 0 && after != null && after !== lockBeforeAfter)
    }
    if (againStatus != null) {
      result.again = againStatus
      if (s.fixtureAgain != null) {
        result.same.again = againStatus === s.fixtureAgain &&
          (againStatus !== 'lock changed' || fixture('again') == null || read(path.join(outDir, 'after-again')) === fixture('again'))
      }
    }

    // ---- cross: the edit over the lock the recording release wrote, with the inputs the scenario's test gives
    // Where this release wrote that very lock itself (and every other lock of the project, and rewrote no file), the
    // after phase was that install already: its outcome is kept as cross's, unless --cross always asks for the run.
    // (Run both ways for pnpm 11.2.2 and 11.28.5, the two never differed but in scenarios whose outcome varies.)
    // (a project that holds other locks than the scenario's counts only where the recording kept them all: the
    // cross project is given the recording's, and without them it holds none)
    const beforeIsFixtures = (result.same.before === true || s.seedLock) && !(result.changed || {}).before &&
      (result.same['locks-before'] === true || result.same['locks-before'] === undefined && !lockBeforeAfterOthers)
    if (fixture('before') != null && beforeIsFixtures && CROSS !== 'always') {
      result.crossFrom = 'after (the before phase left the fixture\'s own locks and files)'
      result.exits.cross = result.exits.after
      if (result.errors.after) result.errors.cross = result.errors.after
      if (result.same.after !== undefined) result.same.cross = result.same.after
      if (after != null && a === 0) keep('cross', after)
      for (const kind of ['changed', 'locks']) {
        if (isDir(path.join(outDir, kind, 'after'))) fs.cpSync(path.join(outDir, kind, 'after'), path.join(outDir, kind, 'cross'), { recursive: true })
      }
      if ((result.changed || {}).after) result.changed.cross = result.changed.after
      if ((result.files || {}).after) result.files.cross = result.files.after
      // the same lock gets the same second install (a failed edit leaves no cross lock to install over)
      if (after != null && a === 0) result.crossAgain = result.again === undefined ? null : result.again
    } else if (fixture('before') != null) {
      const w3 = newWork()
      const P3 = path.join(w3, 'project')
      copyTree(path.join(s.dir, 'tree-before'), P3)
      copyTree(path.join(s.dir, 'tree'), P3)
      if (!fs.existsSync(path.join(P3, 'pnpm-workspace.yaml'))) {
        for (const f of ['workspace', 'workspace-before', 'workspace-yaml']) if (place(f, path.join(P3, 'pnpm-workspace.yaml'))) break
      }
      if (!fs.existsSync(path.join(P3, '.npmrc'))) place('npmrc', path.join(P3, '.npmrc'))
      place('pkg', path.join(P3, 'package.json'))
      const others = path.join(s.dir, 'probes', 'before-locks')
      for (const f of treeOf(others)) {
        fs.mkdirSync(path.dirname(path.join(P3, f)), { recursive: true })
        fs.copyFileSync(path.join(others, f), path.join(P3, f))
      }
      fs.mkdirSync(path.dirname(path.join(P3, lockRel)), { recursive: true })
      fs.copyFileSync(path.join(s.dir, 'before'), path.join(P3, lockRel))
      unredact(P3, w3)
      const inputs = inputsOf(P3)
      const c = await run(w3, path.join(P3, s.runDir), [...baseOf(w3, 'cross'), ...s.aargs, ...cacheArg(w3, 'cross')], 'cross', s.afterAt)
      const cross = lockOf(P3)
      if (c === 0 && cross != null) {
        keep('cross', cross)
        if (result.fixtureHasAfter) result.same.cross = cross === fixture('after')
      } else if (result.fixtureHasAfter) {
        result.same.cross = false
      }
      snapshot(P3, 'cross', inputs)
      // ---- cross-again: the second install over the cross lock; the same lock as `after` gets after's
      if (c === 0 && cross != null) {
        if (a === 0 && cross === after && result.again !== undefined) result.crossAgain = result.again
        else result.crossAgain = await secondInstall('cross-again', 'cross-again', w3, P3, false)
      }
    }
    // what the recording's own logs and exit codes say of the same phases
    for (const phase of ['after', 'again']) {
      const theirs = fixture(`pnpm-${phase}.log`)
      if (theirs != null && result.exits[phase] !== undefined) {
        result.same[`errors-${phase}`] = JSON.stringify(result.errors[phase] || []) === JSON.stringify(errorsIn(theirs))
      }
    }
    const exits = Object.entries(s.fixtureExits).filter(([phase, code]) => code !== undefined && code !== 'seeded' && result.exits[phase] !== undefined)
    if (exits.length) result.same.exits = exits.every(([phase, code]) => String(result.exits[phase]) === code)
  } catch (e) {
    result.error = String(e && e.stack || e)
  } finally {
    server.close()
    if (!KEEP) for (const w of works) fs.rmSync(w, { recursive: true, force: true })
    else result.kept = works
  }
  result.overlay = [...log.overlay].sort()
  result.live = [...log.live].sort()
  result.pm = { metadata: [...log.pmMetadata].sort(), refused: [...log.pmRefused].sort(), ranOther: [...ran].filter(v => v !== release).sort() }
  fs.writeFileSync(path.join(outDir, 'requests.log'), log.requests.join('\n') + '\n')
  return finish('ran')
}

const main = async () => {
  const scenarios = discover().filter(n => (!ONLY || ONLY.test(n)) && (!ONLY_NAMES || ONLY_NAMES.has(n)))
  fs.mkdirSync(OUT, { recursive: true })
  const ca = ensureCa(path.join(SHARED, '_ca'))
  const tasks = []
  for (const release of RELEASES) {
    const cli = cliOf(release)
    if (!cli || cli.missingNative) {
      console.error(`no pnpm ${release} under ${PM}${cli ? ' (its native executable is not unpacked)' : ''}`)
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

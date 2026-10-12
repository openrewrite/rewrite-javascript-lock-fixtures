// Replays recorded Yarn Berry scenarios with other Yarn releases against a frozen registry: each scenario's own
// http/ (yarn-berry-stub.js), so every release sees the registry the recording saw. For each release and scenario it
// runs the recorders' phases (record/record-yarn-berry.sh, -open.sh, -user.sh, again-yarn-berry.sh) and one more:
//   before   pkg-before installed over lock-seed or an empty lock, then before-commands   (skipped with before-given)
//   after    pkg installed in the same directory over that lock
//   again    the edit's command again: over `after` when it was written (after-again when the lock changed), over the
//            start lock again when the edit failed and the open recorder recorded the scenario
//   cross    pkg installed over the fixture's own `before`, the lock the recording release wrote, in a fresh directory
//   cross-again  the edit's command again over `cross`, where and how the scenario's recorder ran its second install
//            (cross-again when the lock changed). Left out, and crossAgain taken from `again`, only where the cross
//            phase ended with the lock and the .yarnrc.yml the after phase ended with: the same second install.
// Output: <out>/<release>/<scenario>/{before,after,after-again,cross,cross-again,<phase>.log,*.written,requests.log,result.json}
//
// How a release is made to run. The recorders ran `corepack yarn`, and corepack picked the release each manifest's
// packageManager names. Here the release under test is named by the sweep and started as corepack starts one
// (yarn-berry-run.js loads <pm>/<release>/package/bin/yarn.js into its process as the main module), with the
// scenario's files byte for byte as recorded: no Yarn Berry release reads the root manifest's packageManager to
// choose or to check itself (yarn-berry-bundle-facts.js), so the pin is inert once corepack does not choose.
// COREPACK_ROOT is not set, so a Yarn that starts `yarn` again starts its own bundle. The launcher records the bundle
// it loads and every child process the CLI starts; a Node child that runs another script than the release under
// test, a yarnPath in the scenario's settings, or a "· Yarn <other>" header in a log lands in result.json as
// otherYarn. --control runs each phase with the release the recording ran it with (recorded-with): the control.
//
// What the sweep changes per release, each named in result.json's `adaptations`:
//   - a YARN_* variable of the recorders that a release does not define is left out (an unknown setting is a usage
//     error in Yarn Berry): YARN_ENABLE_TELEMETRY before 2.2;
//   - a release without `install --mode` (Yarn 2) runs `install` with YARN_ENABLE_SCRIPTS=false, which is how the
//     recorders ran Yarn 2 (install-before), minus dependency build scripts;
//   - a scenario whose recording ends in V8's heap exhaustion (exit 134 after a minute and 4 GB) runs every phase
//     under `node --max-old-space-size=512`, --heavy-jobs such cells at a time (1 unless given).
// The Node a release runs under is --node-for's (yarn-berry-rest.js gives the sweep's: Yarn 2 and 3.1+ under Node
// 20.19.5, 3.0.x under 16.20.2, Yarn 4 under 24.21.0), else --node; result.json says which ran each phase.
// The environment of a run is the recorders' YARN_* variables, PATH, HOME, TMPDIR and LANG, plus what makes the
// stub reachable: YARN_HTTP_PROXY, YARN_HTTPS_PROXY and NODE_EXTRA_CA_CERTS. No NODE_OPTIONS.
// Left out of every run: the open recorder's `immutable` and `fresh` phases (no lock of theirs is kept), and the
// scenarios in LEFT_OUT.
//
// Usage: node sweep-yarn-berry.js --scenarios <lock/yarn-berry> --pm <dir of unpacked releases> --out <dir>
//          --releases 4.10.3,4.9.4 | --releases-file <file> | --control [--label control]
//          [--only <regex>] [--jobs 4] [--heavy-jobs 1] [--node <binary>] [--node-for <release, minor or major>=<binary>,...]
//          [--cells-file <file of "release scenario" lines>] [--force] [--timeout 600]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const stub = require('./yarn-berry-stub.js')
const { failureOf } = require('./yarn-berry-failure.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)

const SCENARIOS = path.resolve(arg('scenarios'))
const PM = path.resolve(arg('pm'))
const OUT = path.resolve(arg('out'))
const JOBS = Number(arg('jobs', 4))
const NODE = arg('node', process.execPath)
const NODE_FOR = Object.fromEntries((arg('node-for', '') || '').split(',').filter(Boolean).map(s => s.split('=')))
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const FORCE = flag('force')
const CONTROL = flag('control')
const LABEL = arg('label', 'control')
const TIMEOUT = Number(arg('timeout', 600)) * 1000
const HEAVY_JOBS = Number(arg('heavy-jobs', 1))
const CELLS = arg('cells-file')
const RELEASES = CONTROL ? [LABEL]
  : arg('releases-file') ? fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean)
    : arg('releases').split(',')
const RUNNER = path.join(__dirname, 'yarn-berry-run.js')
// a port nothing listens on and no stub is given (below the ephemeral range): the recorder's registry when the
// recording did not keep its port
const FREE_PORT = 49151
const UNRECORDED_RELEASE = '4.5.3'
const HEAVY_HEAP_MB = 512
// hand-made packages (record/make-berry-overlay.js) that a first phase installed and no http/ keeps
const HANDMADE = [['lwb-leaf', '1.0.0'], ['lwc-base', '1.0.0'], ['lws-b', '1.0.0'], ['lwt-dist', '1.0.0']]

// scenarios no Yarn release decides
const LEFT_OUT = {
  'open-corepack-devengines-mismatch': 'corepack rejects the project before any Yarn runs (packageManager against devEngines.packageManager)',
  'open-corepack-member-names-pnpm': 'corepack rejects the project before any Yarn runs (a member names pnpm)',
  'open-corepack-member-names-range': 'corepack rejects the project before any Yarn runs (a member names a range)',
  'open-corepack-root-manifest-bom': 'corepack rejects the project before any Yarn runs (package.json starts with a byte order mark)',
  'small-manifest-unparseable': 'corepack rejects the project before any Yarn runs (package.json is not JSON)',
}
// scenarios that reach a host the stub does not stand for
const NETWORK = {
  'git-dependency': 'git: github.com (ls-remote, clone; Yarn packs the clone with itself)',
  'rejection-beside-unknown-git': 'git: github.com (ls-remote)',
}

const exists = f => fs.existsSync(f)
const isDir = f => exists(f) && fs.statSync(f).isDirectory()
const isVersion = s => /^\d+\.\d+\.\d+$/.test(s || '')

const discover = () => fs.readdirSync(SCENARIOS, { withFileTypes: true })
  .filter(e => e.isDirectory() && ['before', 'after', 'before-given'].some(f => exists(path.join(SCENARIOS, e.name, f))))
  .map(e => e.name).sort()

// ---- what the recorder was given for the scenario ----------------------------------------------------------------
const shape = name => {
  const d = path.join(SCENARIOS, name)
  const has = f => exists(path.join(d, f))
  const bytes = f => has(f) && !isDir(path.join(d, f)) ? fs.readFileSync(path.join(d, f)) : null
  const text = f => {
    const b = bytes(f)
    return b == null ? null : b.toString('utf8')
  }
  if (LEFT_OUT[name]) return { skip: LEFT_OUT[name] }
  const recordedWith = text('recorded-with')
  const lines = recordedWith ? recordedWith.split('\n') : []
  const head = lines[0] ? lines[0].match(/^yarn (.*?) then (.*?) \(corepack ([^)]*)\), node (\S+), .*?, (\d{4}-\d{2}-\d{2})\s*$/) : null
  const recorder = !recordedWith ? 'unrecorded'
    : /^again exit=/.test(lines[2] || '') ? 'open'
      : /again exit=/.test(lines[1] || '') ? 'user'
        : /before exit=given/.test(lines[1] || '') ? 'given' : 'two-phase'
  const exitOf = (label, from) => {
    const m = (from || '').match(new RegExp(`${label} exit=([^,;\\s]+)`))
    return m ? (/^-?\d+$/.test(m[1]) ? Number(m[1]) : m[1]) : null
  }
  const registryLine = lines.find(l => /registry: /.test(l)) || ''
  const local = registryLine.match(/yarn-berry-registry\.js on 127\.0\.0\.1:(<free port>|\d+)/)
  const pmOf = f => {
    try {
      const m = String(JSON.parse(text(f).replace(/^﻿/, '')).packageManager || '').match(/^yarn@(\d+\.\d+\.\d+)/)
      return m ? m[1] : null
    } catch (e) {
      return null
    }
  }
  const rootBefore = has('pkg-before') ? 'pkg-before' : has('pkg-root') ? 'pkg-root' : null
  const rootAfter = has('pkg') ? 'pkg' : has('pkg-after') ? 'pkg-after' : has('pkg-root') && recorder === 'unrecorded' && has('after') ? 'pkg-root' : null
  // a downloaded fixture's pkg-<member>[-before|-after] sits at packages/<member>
  const members = phase => recorder !== 'unrecorded' ? [] : fs.readdirSync(d)
    .filter(f => f.startsWith('pkg-') && !['pkg-before', 'pkg-after', 'pkg-root'].includes(f) && !f.endsWith('.written') &&
      !f.endsWith(phase === 'after' ? '-before' : '-after'))
    .map(f => [f, `packages/${f.slice(4).replace(/-(before|after)$/, '')}/package.json`])
  const given = has('before-given')
  // the release each phase was recorded with: recorded-with, else the manifest corepack read
  // (a fixture with neither is one of the first, which name yarn@4.5.3 wherever they name a release)
  const named = [pmOf(rootBefore || 'pkg-before'), pmOf(rootAfter || 'pkg')]
  const recordedBefore = head && isVersion(head[1]) ? head[1] : given ? null : named[0] || named[1] || (recordedWith ? null : UNRECORDED_RELEASE)
  const recordedAfter = head && isVersion(head[2]) ? head[2] : named[1] || named[0] || (recordedWith ? null : UNRECORDED_RELEASE)
  const guessed = []
  const why = n => `${recordedWith ? 'recorded-with does not name it' : 'no recorded-with'}; ${n ? 'from packageManager' : `assumed, as the other fixtures without recorded-with name yarn@${UNRECORDED_RELEASE}`}`
  if (!(head && isVersion(head[1])) && !given && rootBefore) guessed.push(`before: ${recordedBefore || 'unknown'} (${why(named[0] || named[1])})`)
  if (!(head && isVersion(head[2])) && rootAfter) guessed.push(`after: ${recordedAfter || 'unknown'} (${why(named[1] || named[0])})`)
  const day = head ? head[5] : null
  const againLog = text('berry-again.log') || text('yarn-again.log')
  return {
    name, dir: d, has, bytes, text, recorder, guessed,
    rootBefore, rootAfter, members, given,
    rcBefore: has('yarnrc') ? 'yarnrc' : recorder === 'unrecorded' && has('workspace-yarnrc') ? 'workspace-yarnrc' : null,
    rcAfter: has('yarnrc-after') ? 'yarnrc-after' : null,
    seed: has('lock-seed') ? 'lock-seed' : null,
    beforeCommands: (text('before-commands') || '').split('\n').filter(l => l.trim()),
    installBefore: has('install-before') ? text('install-before').split('\n')[0].trim().split(/\s+/).filter(Boolean) : null,
    argsAfter: has('args-after') ? text('args-after').split('\n')[0].trim().split(/\s+/).filter(Boolean) : [],
    runDir: has('run-dir') ? text('run-dir').trim() : '',
    userRc: has('user-yarnrc-yml') ? 'user-yarnrc-yml' : null,
    localPort: local ? (local[1] === '<free port>' ? FREE_PORT : Number(local[1])) : null,
    warm: /cache: one Yarn cache/.test(registryLine),
    recordedBefore, recordedAfter,
    recordedNode: head ? head[4] : null,
    now: day ? `${day}T12:00:00Z` : null,
    recordedExits: { before: exitOf('before', lines[1]), after: exitOf('after', lines[1]), again: exitOf('again', lines[1] + '\n' + (lines[2] || '')) },
    recordedAgain: againLog ? (againLog.match(/^(lock unchanged|lock changed|no lock written)$/m) || [null])[0] : null,
    recordedAgainOver: againLog ? (againLog.match(/^over=(\w+)$/m) || [null, null])[1] : null,
    network: NETWORK[name] || null,
    // a yarnPath in any settings file of the scenario would make the release under test start another Yarn
    yarnPath: fs.readdirSync(d, { recursive: true }).map(String).filter(f => !f.startsWith('http') && /(^|\/)(\.yarnrc\.yml|yarnrc[^/]*|user-yarnrc-yml|workspace-yarnrc)$/.test(f))
      .filter(f => !isDir(path.join(d, f)) && /^\s*yarnPath\s*:/m.test(fs.readFileSync(path.join(d, f), 'utf8'))),
    heavy:/heap out of memory/.test(text('expect') || '') || [134].includes(exitOf('after', lines[1])),
  }
}

// ---- the Node a release runs under ---------------------------------------------------------------------------------
const nodeVersions = new Map()
const versionOf = node => {
  if (!nodeVersions.has(node)) nodeVersions.set(node, node === process.execPath ? process.version : execFileSync(node, ['--version'], { encoding: 'utf8' }).trim())
  return nodeVersions.get(node)
}

// ---- what a release defines (read once from its bundle) ----------------------------------------------------------
const releaseFacts = new Map()
const factsOf = release => {
  if (!releaseFacts.has(release)) {
    const cli = path.join(PM, release, 'package', 'bin', 'yarn.js')
    const s = fs.readFileSync(cli, 'utf8')
    const defines = k => new RegExp(`[{,\\s]${k}:\\s*\\{\\s*description:`).test(s)
    releaseFacts.set(release, {
      cli,
      mode: /update-lockfile/.test(s),
      defines: Object.fromEntries(['enableTelemetry', 'enableGlobalCache', 'enableImmutableInstalls', 'enableProgressBars', 'enableColors',
        'globalFolder', 'cacheFolder', 'httpProxy', 'httpsProxy', 'enableScripts', 'unsafeHttpWhitelist'].map(k => [k, defines(k)])),
    })
  }
  return releaseFacts.get(release)
}

// a stopped sweep leaves no Yarn running and no scratch directory behind
const children = new Set()
const scratches = new Set()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const c of children) c.kill('SIGKILL')
    for (const d of scratches) fs.rmSync(d, { recursive: true, force: true })
    process.exit(130)
  })
}

const run = ({ node, nodeArgs = [], cli, args, cwd, env }) => new Promise(resolve => {
  const child = spawn(node, [...nodeArgs, RUNNER, cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  child.on('close', () => children.delete(child))
  const out = []
  let timedOut = false
  child.stdout.on('data', c => out.push(c))
  child.stderr.on('data', c => out.push(c))
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, TIMEOUT)
  child.on('error', e => {
    clearTimeout(timer)
    resolve({ code: `spawn:${e.code}`, log: String(e), timedOut })
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    // a shell reports a signalled process as 128 + the signal's number, which is what the recorders kept (134: SIGABRT)
    const number = signal && os.constants.signals[signal]
    resolve({ code: code != null ? code : number && !timedOut ? 128 + number : `signal:${signal}`, log: Buffer.concat(out).toString('utf8'), timedOut })
  })
})

let shared
let ca
const SCRATCH_ROOT = fs.realpathSync(os.tmpdir())

const sweepOne = async (release, name) => {
  const outDir = path.join(OUT, release, name)
  const resultFile = path.join(outDir, 'result.json')
  if (!FORCE && exists(resultFile)) {
    try {
      const prior = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      if (!prior.error && !prior.inconclusive) return 'cached'
    } catch (e) {
      // an unreadable result is run again
    }
  }
  const s = shape(name)
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const result = { release, scenario: name, recorder: s.recorder, releases: {}, node: {}, exits: {}, ms: {}, same: {}, fail: {}, adaptations: [], otherYarn: [], spawned: [] }
  const finish = outcome => {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 1) + '\n')
    return outcome
  }
  if (s.skip) {
    result.skip = s.skip
    return finish('skipped')
  }
  const releaseFor = phase => CONTROL ? (phase === 'before' ? s.recordedBefore : s.recordedAfter) : release
  const phasesWanted = [...(s.rootBefore && !s.given ? ['before'] : []), ...(s.rootAfter ? ['after'] : [])]
  for (const ph of phasesWanted) {
    const r = releaseFor(ph)
    if (!r || !exists(path.join(PM, r, 'package', 'bin', 'yarn.js'))) {
      result.skip = `no release for the ${ph} phase (${r || 'the recording does not name one'})`
      return finish('skipped')
    }
  }
  if (!phasesWanted.length) {
    result.skip = 'no manifest to install'
    return finish('skipped')
  }
  if (CONTROL && s.guessed.length) result.guessed = s.guessed
  if (s.network) result.network = s.network
  result.recordedExits = s.recordedExits
  for (const f of s.yarnPath) result.otherYarn.push(`${f} names a yarnPath`)

  const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'ybs-'))
  scratches.add(scratch)
  const log = { requests: [], overlay: new Set(), unserved: [] }
  const overlayByPhase = {}
  const server = await stub.start({ shared, ca, scenario: name, scenarioDir: s.dir, at: s.now, log })
  const stubUrl = `http://127.0.0.1:${server.port}`
  const fixture = f => s.bytes(f)
  const keep = (label, buf) => fs.writeFileSync(path.join(outDir, label), buf)
  const same = (a, b) => a != null && b != null && Buffer.compare(a, b) === 0
  const readIf = f => exists(f) ? fs.readFileSync(f) : null
  const copyTree = (from, to) => {
    if (isDir(from)) fs.cpSync(from, to, { recursive: true })
  }

  // a recorder's scratch layout: $WORK/home, $WORK/project, caches beside them
  const workOf = label => {
    const w = path.join(scratch, label)
    fs.mkdirSync(path.join(w, 'home'), { recursive: true })
    fs.mkdirSync(path.join(w, 'project'), { recursive: true })
    fs.mkdirSync(path.join(w, 'tmp'), { recursive: true })
    return w
  }
  const homeRc = (w, phase) => {
    const file = path.join(w, 'home', '.yarnrc.yml')
    fs.rmSync(file, { force: true })
    // record-yarn-berry-open.sh with a registry of its own: the scratch home names it; record-yarn-berry-user.sh:
    // the edit and the second install read the user's
    if (s.localPort) fs.writeFileSync(file, `npmRegistryServer: "http://127.0.0.1:${s.localPort}"\nunsafeHttpWhitelist:\n  - "127.0.0.1"\n`)
    else if (s.userRc && phase !== 'before') fs.copyFileSync(path.join(s.dir, s.userRc), file)
  }
  const foldersOf = (w, phase) => {
    // record-yarn-berry-open.sh: a cache and a global folder per phase (one cache for before, after and again with
    // WARM_CACHE); the other recorders: one of each for the whole recording
    const cache = s.recorder === 'open' && !(s.warm && ['before', 'after', 'again'].includes(phase)) ? `cache-${phase}` : s.recorder === 'open' ? 'cache-shared' : 'cache'
    const global = s.recorder === 'open' ? `global-${phase}` : 'global'
    fs.mkdirSync(path.join(w, cache), { recursive: true })
    fs.mkdirSync(path.join(w, global), { recursive: true })
    return { cache: path.join(w, cache), global: path.join(w, global) }
  }
  const redact = (text, w) => text.split(path.join(w, 'home')).join('<home>').split(w).join('<tmp>').split(scratch).join('<scratch>')
    .split(`127.0.0.1:${server.port}`).join('127.0.0.1:<stub>')

  const yarn = async (label, phase, w, args, { append = false } = {}) => {
    const r = releaseFor(phase)
    const facts = factsOf(r)
    const node = NODE_FOR[r] || NODE_FOR[r.split('.').slice(0, 2).join('.')] || NODE_FOR[r.split('.')[0]] || NODE
    const nodeVersion = versionOf(node)
    result.releases[phase] = r
    result.node[phase] = nodeVersion
    const folders = foldersOf(w, label)
    const witness = path.join(scratch, `witness-${label}-${Date.now()}`)
    const env = {
      PATH: `${path.dirname(node)}:/usr/bin:/bin`,
      HOME: path.join(w, 'home'),
      TMPDIR: path.join(w, 'tmp'),
      LANG: 'en_US.UTF-8',
      YARN_ENABLE_TELEMETRY: '0',
      YARN_ENABLE_GLOBAL_CACHE: 'false',
      YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
      YARN_ENABLE_PROGRESS_BARS: 'false',
      YARN_ENABLE_COLORS: 'false',
      YARN_GLOBAL_FOLDER: folders.global,
      YARN_CACHE_FOLDER: folders.cache,
      YARN_HTTP_PROXY: stubUrl,
      YARN_HTTPS_PROXY: stubUrl,
      NODE_EXTRA_CA_CERTS: ca.caCert,
      // read and removed by yarn-berry-run.js before the CLI starts
      SWEEP_WITNESS: witness,
    }
    if (s.now) env.SWEEP_NOW = s.now
    const adapt = note => {
      if (!result.adaptations.includes(note)) result.adaptations.push(note)
    }
    const nodeArgs = []
    if (s.heavy) {
      // the recording ends in V8's heap exhaustion after a minute and 4 GB; a smaller heap ends the same way sooner
      nodeArgs.push(`--max-old-space-size=${HEAVY_HEAP_MB}`)
      adapt(`the scenario's recording runs Node out of heap: every phase runs under node --max-old-space-size=${HEAVY_HEAP_MB}`)
    }
    for (const [variable, setting] of [['YARN_ENABLE_TELEMETRY', 'enableTelemetry'], ['YARN_ENABLE_GLOBAL_CACHE', 'enableGlobalCache'],
      ['YARN_ENABLE_IMMUTABLE_INSTALLS', 'enableImmutableInstalls'], ['YARN_ENABLE_PROGRESS_BARS', 'enableProgressBars'], ['YARN_ENABLE_COLORS', 'enableColors']]) {
      if (!facts.defines[setting]) {
        delete env[variable]
        adapt(`${r}: ${variable} left out (the release does not define ${setting})`)
      }
    }
    if (!facts.mode && args.includes('--mode=update-lockfile')) {
      args = args.filter(a => a !== '--mode=update-lockfile')
      env.YARN_ENABLE_SCRIPTS = 'false'
      adapt(`${r}: install without --mode=update-lockfile (the release has no --mode), with YARN_ENABLE_SCRIPTS=false`)
    }
    log.requests.push(`# ${label}: yarn ${args.join(' ')}`)
    const before = new Set(log.overlay)
    const cwd = phase === 'before' ? path.join(w, 'project') : path.join(w, 'project', s.runDir)
    const t0 = Date.now()
    const res = await run({ node, nodeArgs, cli: facts.cli, args, cwd, env })
    result.ms[label] = (result.ms[label] || 0) + Date.now() - t0
    overlayByPhase[label] = [...log.overlay].filter(o => !before.has(o)).concat(overlayByPhase[label] || [])
    const text = redact(res.log, w)
    if (append) fs.appendFileSync(path.join(outDir, `${label}.log`), `+ yarn ${args.join(' ')}\n${text}`)
    else fs.writeFileSync(path.join(outDir, `${label}.log`), text)
    if (res.timedOut) result.inconclusive = `${label}: killed after ${TIMEOUT / 1000}s`
    // no other Yarn than the release under test: the bundle the launcher loaded, and what the CLI started
    const seen = exists(witness) ? fs.readFileSync(witness, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
    const mains = seen.filter(e => e.main !== undefined)
    if (mains.length !== 1 || mains[0].main !== facts.cli) result.otherYarn.push(`${label}: the launcher reports ${mains.map(m => m.main).join(', ') || 'nothing'}`)
    for (const e of seen.filter(e => e.spawn !== undefined)) {
      const argv = (e.args || []).map(String)
      const what = redact([e.spawn, ...argv.slice(1)].join(' '), w).slice(0, 200)
      if (!result.spawned.includes(`${label}: ${what}`)) result.spawned.push(`${label}: ${what}`)
      // a Node child must run the release under test; `yarn` on the PATH Yarn gives its children is its own shim
      const isNode = /(^|\/)node$/.test(String(e.spawn)) || e.spawn === node
      const script = argv.slice(1).find(a => !a.startsWith('-'))
      if (isNode && script && script !== facts.cli) result.otherYarn.push(`${label}: started node ${redact(script, w)}`)
      if (/(^|\/)(corepack|npm|pnpm|bun)$/.test(String(e.spawn))) result.otherYarn.push(`${label}: started ${e.spawn}`)
    }
    const header = res.log.match(/^➤ YN0000: · Yarn (\S+)/m)
    if (header && header[1] !== r) result.otherYarn.push(`${label}: the log is headed "Yarn ${header[1]}"`)
    return { code: res.code, log: text }
  }

  const INSTALL = ['install', '--mode=update-lockfile']
  const lay = (w, phase) => {
    // what the recorder copied into the project before the phase's install
    const p = path.join(w, 'project')
    if (phase === 'before') {
      copyTree(path.join(s.dir, 'tree-before'), p)
      if (s.rcBefore) fs.copyFileSync(path.join(s.dir, s.rcBefore), path.join(p, '.yarnrc.yml'))
      for (const [file, at] of s.members('before')) {
        fs.mkdirSync(path.dirname(path.join(p, at)), { recursive: true })
        fs.copyFileSync(path.join(s.dir, file), path.join(p, at))
      }
      fs.copyFileSync(path.join(s.dir, s.rootBefore), path.join(p, 'package.json'))
    } else {
      copyTree(path.join(s.dir, 'tree'), p)
      if (s.rcAfter) fs.copyFileSync(path.join(s.dir, s.rcAfter), path.join(p, '.yarnrc.yml'))
      for (const [file, at] of s.members('after')) {
        fs.mkdirSync(path.dirname(path.join(p, at)), { recursive: true })
        fs.copyFileSync(path.join(s.dir, file), path.join(p, at))
      }
      fs.copyFileSync(path.join(s.dir, s.rootAfter), path.join(p, 'package.json'))
    }
  }
  // what the release wrote besides the lock: package.json and .yarnrc.yml when it changed them
  const written = (label, w, pkgIn, rcIn, pkgName, rcName, check) => {
    const p = path.join(w, 'project')
    const pkg = readIf(path.join(p, 'package.json'))
    const rc = readIf(path.join(p, '.yarnrc.yml'))
    const pkgWritten = pkg && !same(pkg, pkgIn) ? pkg : null
    const rcWritten = rc && !same(rc, rcIn) ? rc : null
    if (pkgWritten) keep(pkgName, pkgWritten)
    if (rcWritten) keep(rcName, rcWritten)
    // record-yarn-berry.sh and -open.sh keep what Yarn rewrote; the user recorder and the first fixtures do not
    if (check && s.recorder !== 'user' && s.recorder !== 'unrecorded') {
      const fp = fixture(check.pkg)
      const fr = fixture(check.rc)
      if (fp || pkgWritten) result.same[`${label}:package.json`] = fp && pkgWritten ? same(fp, pkgWritten) : false
      if (fr || rcWritten) result.same[`${label}:.yarnrc.yml`] = fr && rcWritten ? same(fr, rcWritten) : false
    }
  }
  const lockOf = w => readIf(path.join(w, 'project', 'yarn.lock'))
  // an install the recording saw fail must fail the same way: the exit code and what the log gives as the reason
  const failed = (label, r, recordedLog) => {
    result.exits[label] = r.code
    if (r.code !== 0) result.fail[label] = failureOf(r.log)
    if (recordedLog != null) {
      const recordedExit = s.recordedExits[label === 'cross' ? 'after' : label]
      result.same[`${label}:failure`] = r.code !== 0 && result.fail[label] === failureOf(recordedLog) && (typeof recordedExit !== 'number' || recordedExit === r.code)
    }
  }

  // Where a second install runs. record-yarn-berry-open.sh and -user.sh ran it in the directory of the install it
  // follows; for the other recordings again-yarn-berry.sh ran it in a fresh directory left as the edit left it (the
  // phase's trees, the .yarnrc.yml, package.json and lock the install ended with), with a cold cache. Both second
  // installs of a cell, over `after` and over `cross`, follow the scenario's own.
  const SAME_DIRECTORY = s.recorder === 'open' || s.recorder === 'user'
  const freshAsLeft = (from, label) => {
    const fw = workOf(label)
    const fp = path.join(fw, 'project')
    copyTree(path.join(s.dir, 'tree-before'), fp)
    copyTree(path.join(s.dir, 'tree'), fp)
    for (const [file, at] of s.members('after')) {
      fs.mkdirSync(path.dirname(path.join(fp, at)), { recursive: true })
      fs.copyFileSync(path.join(s.dir, file), path.join(fp, at))
    }
    for (const f of ['.yarnrc.yml', 'package.json', 'yarn.lock']) {
      if (exists(path.join(from, 'project', f))) fs.copyFileSync(path.join(from, 'project', f), path.join(fp, f))
    }
    homeRc(fw, label)
    return fw
  }

  try {
    const hasAfterFixture = fixture('after') != null
    result.fixtureHasAfter = hasAfterFixture
    // ---- the recording's own chain: before, after, again -----------------------------------------------------------
    const w = workOf('w')
    const p = path.join(w, 'project')
    let started = false
    let afterEnd = null
    if (s.given) {
      lay(w, 'before')
      fs.copyFileSync(path.join(s.dir, 'before'), path.join(p, 'yarn.lock'))
      started = true
    } else if (s.rootBefore) {
      lay(w, 'before')
      if (s.seed) fs.copyFileSync(path.join(s.dir, s.seed), path.join(p, 'yarn.lock'))
      else fs.writeFileSync(path.join(p, 'yarn.lock'), '')
      homeRc(w, 'before')
      const pkgIn = readIf(path.join(p, 'package.json'))
      const rcIn = readIf(path.join(p, '.yarnrc.yml'))
      let b = await yarn('before', 'before', w, s.installBefore || INSTALL)
      let code = b.code
      let text = b.log
      if (code === 0) {
        for (const line of s.beforeCommands) {
          const c = await yarn('before', 'before', w, line.trim().split(/\s+/), { append: true })
          text += c.log
          if (c.code !== 0) code = c.code
        }
      }
      failed('before', { code, log: text }, s.recordedExits.before !== 0 ? s.text('yarn-before.log') : null)
      const lock = lockOf(w)
      if (code === 0 && lock) {
        keep('before', lock)
        if (fixture('before')) result.same.before = same(lock, fixture('before'))
        started = true
      } else if (fixture('before') && s.recordedExits.before !== 'given') {
        result.same.before = false
      }
      written('before', w, pkgIn, rcIn, 'pkg-before.written', 'yarnrc-before.written', { pkg: 'pkg-before.written', rc: 'yarnrc-before.written' })
    }
    if (started && s.rootAfter) {
      lay(w, 'after')
      homeRc(w, 'after')
      const startLock = lockOf(w)
      const pkgIn = readIf(path.join(p, 'package.json'))
      const rcIn = readIf(path.join(p, '.yarnrc.yml'))
      const a = await yarn('after', 'after', w, [...INSTALL, ...s.argsAfter])
      failed('after', a, hasAfterFixture ? null : s.text('yarn-after.log'))
      const after = a.code === 0 ? lockOf(w) : null
      if (after) keep('after', after)
      if (hasAfterFixture) result.same.after = same(after, fixture('after'))
      else if (after) result.same.after = false
      written('after', w, pkgIn, rcIn, 'pkg.written', 'yarnrc.written', { pkg: 'pkg.written', rc: 'yarnrc.written' })
      afterEnd = { lock: after, rc: readIf(path.join(p, '.yarnrc.yml')) }
      // the second install, where and over what the scenario's recorder ran it
      let over = null
      let aw = w
      if (after && !SAME_DIRECTORY) {
        aw = freshAsLeft(w, 'again')
        over = 'after'
      } else if (after) {
        over = 'after'
      } else if (s.recorder === 'open' && startLock) {
        fs.writeFileSync(path.join(p, 'yarn.lock'), startLock)
        over = 'before'
      }
      if (over) {
        const input = lockOf(aw)
        const g = await yarn('again', 'after', aw, [...INSTALL, ...s.argsAfter])
        result.exits.again = g.code
        if (g.code !== 0) result.fail.again = failureOf(g.log)
        const again = lockOf(aw)
        result.again = g.code !== 0 ? 'no lock written' : same(again, input) ? 'lock unchanged' : 'lock changed'
        result.againOver = over
        if (g.code === 0 && again && !same(again, input)) keep('after-again', again)
        if (s.recordedAgain) result.same.again = s.recordedAgain === result.again && (s.recordedExits.again == null || s.recordedExits.again === g.code)
      }
    }
    // ---- the edit over the lock the recording release wrote --------------------------------------------------------
    if (s.rootAfter && fixture('before') && !s.given) {
      const x = workOf('x')
      const xp = path.join(x, 'project')
      copyTree(path.join(s.dir, 'tree-before'), xp)
      // the .yarnrc.yml the recording's first phase left, which its second phase started from
      const left = s.has('yarnrc-before.written') ? 'yarnrc-before.written' : s.rcBefore
      if (left) fs.copyFileSync(path.join(s.dir, left), path.join(xp, '.yarnrc.yml'))
      lay(x, 'after')
      fs.copyFileSync(path.join(s.dir, 'before'), path.join(xp, 'yarn.lock'))
      homeRc(x, 'cross')
      const pkgIn = readIf(path.join(xp, 'package.json'))
      const rcIn = readIf(path.join(xp, '.yarnrc.yml'))
      const c = await yarn('cross', 'after', x, [...INSTALL, ...s.argsAfter])
      failed('cross', c, hasAfterFixture ? null : s.text('yarn-after.log'))
      const cross = c.code === 0 ? lockOf(x) : null
      if (cross) keep('cross', cross)
      if (hasAfterFixture) result.same.cross = same(cross, fixture('after'))
      else if (cross) result.same.cross = false
      written('cross', x, pkgIn, rcIn, 'cross.pkg.written', 'cross.yarnrc.written', { pkg: 'pkg.written', rc: 'yarnrc.written' })
      // The second install over the lock this phase wrote, run as `again` is. Where the phase ended with the lock and
      // the .yarnrc.yml the after phase ended with, and `again` ran over that, it is the same install and its
      // outcome is `again`'s; anywhere else it runs.
      if (cross) {
        const crossRc = readIf(path.join(xp, '.yarnrc.yml'))
        const asAfter = afterEnd && result.againOver === 'after' && same(cross, afterEnd.lock) &&
          (crossRc == null && afterEnd.rc == null ? true : same(crossRc, afterEnd.rc))
        if (asAfter) {
          result.crossAgain = result.again
          result.crossAgainFrom = 'again'
        } else {
          const xw = SAME_DIRECTORY ? x : freshAsLeft(x, 'cross-again')
          const g = await yarn('cross-again', 'after', xw, [...INSTALL, ...s.argsAfter])
          result.exits['cross-again'] = g.code
          if (g.code !== 0) result.fail['cross-again'] = failureOf(g.log)
          const again = lockOf(xw)
          result.crossAgain = g.code !== 0 ? 'no lock written' : same(again, cross) ? 'lock unchanged' : 'lock changed'
          result.crossAgainFrom = 'cross-again'
          if (g.code === 0 && again && !same(again, cross)) keep('cross-again', again)
        }
        // the recording's second install was over this lock where the cross phase reproduces `after`
        if (s.recordedAgain && s.recordedAgainOver !== 'before' && result.same.cross === true) result.same.crossAgain = result.crossAgain === s.recordedAgain
      }
    }
  } catch (e) {
    result.error = String((e && e.stack) || e)
  } finally {
    server.close()
    fs.rmSync(scratch, { recursive: true, force: true })
    scratches.delete(scratch)
  }
  result.overlay = [...log.overlay].sort()
  result.overlayByPhase = overlayByPhase
  result.unserved = log.unserved
  if (log.unserved.some(u => u.startsWith('stub-error'))) result.error = result.error || `the stub failed: ${log.unserved.find(u => u.startsWith('stub-error'))}`
  if (!result.otherYarn.length) delete result.otherYarn
  fs.writeFileSync(path.join(outDir, 'requests.log'), log.requests.join('\n') + '\n')
  return finish('ran')
}

const main = async () => {
  // nothing above the scratch directories may look like a project or carry Yarn settings
  for (let d = SCRATCH_ROOT; ; d = path.dirname(d)) {
    for (const f of ['package.json', 'yarn.lock', '.yarnrc.yml', '.yarnrc', '.pnp.cjs', '.pnp.js']) {
      if (exists(path.join(d, f))) throw new Error(`${path.join(d, f)} would be read by every Yarn the sweep starts`)
    }
    if (d === path.dirname(d)) break
  }
  fs.mkdirSync(OUT, { recursive: true })
  // the hand-made packages the recordings do not keep, made again by the recorders' own tool (yarn-berry-stub.js
  // says how the control checks them)
  const handmade = path.join(OUT, '_handmade')
  if (!exists(path.join(handmade, 'http'))) {
    fs.mkdirSync(handmade, { recursive: true })
    fs.writeFileSync(path.join(handmade, 'overlay.json'), JSON.stringify({ packages: HANDMADE.map(([name, version]) => ({ name, version })) }, null, 2) + '\n')
    execFileSync(process.execPath, [path.join(SCENARIOS, '..', '..', 'record', 'make-berry-overlay.js'), handmade], { stdio: 'ignore' })
  }
  shared = stub.makeShared(OUT)
  ca = stub.ensureCa(path.join(OUT, '_ca'))
  const scenarios = discover().filter(n => !ONLY || ONLY.test(n))
  let tasks = []
  for (const release of RELEASES) {
    if (!CONTROL && !exists(path.join(PM, release, 'package', 'bin', 'yarn.js'))) {
      console.error(`no yarn ${release} under ${PM}`)
      process.exitCode = 1
      continue
    }
    for (const name of scenarios) tasks.push([release, name])
  }
  // --cells-file: these cells only, in the file's order (yarn-berry-plan.js names the cells that say where an outcome
  // changes inside a minor, to be swept before the rest of its patch releases)
  if (CELLS) {
    const known = new Set(tasks.map(t => t.join(' ')))
    tasks = fs.readFileSync(CELLS, 'utf8').split('\n').map(l => l.trim().split(/\s+/)).filter(t => t.length === 2 && known.has(t.join(' ')))
  }
  const total = tasks.length
  const started = Date.now()
  const tally = { ran: 0, cached: 0, skipped: 0 }
  let done = 0
  // the scenarios that run Node out of heap have a lane of their own, a few cells at a time, so the other jobs go on
  const heavyNames = new Set(scenarios.filter(n => shape(n).heavy))
  const heavy = tasks.filter(t => heavyNames.has(t[1]))
  const light = tasks.filter(t => !heavyNames.has(t[1]))
  const worker = lanes => async () => {
    for (;;) {
      const lane = lanes.find(l => l.length)
      if (!lane) return
      const t = lane.shift()
      let outcome
      try {
        outcome = await sweepOne(t[0], t[1])
      } catch (e) {
        console.error(`${t[0]} ${t[1]}: ${e.stack || e}`)
        outcome = 'ran'
      }
      tally[outcome]++
      done++
      if (done % 50 === 0 || done === total) {
        const secs = Math.round((Date.now() - started) / 1000)
        console.log(`${done}/${total} in ${secs}s  (ran ${tally.ran}, cached ${tally.cached}, skipped ${tally.skipped}); ${light.length ? `at ${light[0][0]}` : 'the last cells'}`)
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, (_, i) => (i < HEAVY_JOBS ? worker([heavy, light]) : worker([light]))()))
}
main().catch(e => {
  console.error(e)
  process.exit(1)
})

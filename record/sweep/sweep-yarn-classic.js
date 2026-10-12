// Replays recorded Yarn classic scenarios with other Yarn 1 releases against a frozen registry: each scenario's own
// http/ (yarn-classic-stub.js), so every release sees the registry the recording saw. For each release and scenario it
// runs the phases of the scenario's own recorder, with the recorder's command line, and one more (cross):
//   before    pkg-before installed from scratch                     (skipped where the recording was given a lock)
//   after     pkg installed in the same directory over that lock    (node_modules removed first)
//   frozen    record-yarn-classic.sh's third phase over `after`: --frozen-lockfile in $WORK/frozen (a clean
//             directory beside the project, the recording's home and cache), then
//   fixpoint  a plain install there                                 (after-fixpoint when the lock changed)
//   again     again-yarn-classic.sh: the edit's command again over `after` (over the start lock when the edit
//             failed) in a fresh directory with a cold cache        (after-again when the lock changed)
//   cross     pkg installed over the fixture's own `before` (the lock yarn 1.22.22 wrote) in a fresh directory, then
//             the recorder's own second installs over the lock it wrote (cross-frozen, cross-fixpoint, cross-again);
//             left out where the recording was given its start lock (its after phase is that install)
// Output: <out>/<release>/<scenario>/{before,after,after-fixpoint,after-again,cross,cross-fixpoint,cross-again,
//         <phase>.log,requests.log,result.json}. Every file of a cell goes through the recorders' redact-paths.js, as
//         the recordings did, before it is compared with the fixture.
//
// The recorders, recognized by what a scenario holds (recorded-with, the logs):
//   two-phase    record/record-yarn-classic.sh: before, after, frozen, fixpoint
//   open         record/record-yarn-classic-open.sh (a `platform` line), or record-yarn-classic.sh followed by
//                again-yarn-classic.sh (yarnclassic-again.log): the same, then again
//   user         record/record-yarn-classic-user.sh: before without the user's config, the later phases with
//                user-npmrc / user-yarnrc as $HOME/.npmrc / $HOME/.yarnrc
//   layout       recorded-with `layout repo/mid/app (parent/ = repo/mid, grandparent/ = repo)`: before, after, again,
//                the project at repo/mid/app under parent/ and grandparent/ (no script of it is kept; the layout and
//                phases are what its recorded-with, logs and YarnClassicScenarios.java say)
//   cwd          recorded-with `run in <dir>` (the `cwd` file): before, after, again, each run in <dir> under the
//                project; with user-npmrc as the user recorder gives it, to the edit and its second install
//   unrecorded   no recorded-with (the first downloaded fixtures): before, after, frozen, fixpoint
// How yarn runs: <node> yarn-classic-run.js <release>/package/bin/yarn.js install --ignore-scripts --non-interactive
// --no-progress, in the recorders' environment (env -i, PATH=<node dir>:<release bin dir>:/usr/bin:/bin, HOME,
// YARN_CACHE_FOLDER and TMPDIR in the scratch directory), plus what reaches the stub: npm_config_proxy and
// npm_config_https_proxy (the user recorder's own way to a proxy) and NODE_EXTRA_CA_CERTS. The scratch directory is
// made as `mktemp -d` made the recorders' (directly under $TMPDIR, by the path $TMPDIR gives, not its real path):
// yarn writes paths relative to its cache into some locks, and the recordings hold them as redact-paths.js left them.
//
// Usage: node sweep-yarn-classic.js --scenarios <lock/yarn-classic> --pm <dir of unpacked releases> --out <dir>
//          --releases 1.22.22,1.21.1 | --releases-file <file>  [--label <dir name for a single release's run>]
//          [--only <regex>] [--jobs 4] [--node <binary>] [--node-for <release|minor|major>=<binary>,...] [--force]
//          [--cells-file <file of "release scenario" lines>] [--timeout 180] [--record <fixtures record/ dir>]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const stub = require('./yarn-classic-stub.js')

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
const NODE_FOR = Object.fromEntries((arg('node-for', '') || '').split(',').filter(Boolean).map(s => s.split('=')).map(([k, v]) => [k, path.resolve(v)]))
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const FORCE = flag('force')
const LABEL = arg('label')
const TIMEOUT = Number(arg('timeout', 180)) * 1000
const CELLS = arg('cells-file')
const RELEASES = arg('releases-file') ? fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean) : arg('releases').split(',')
if (LABEL && RELEASES.length !== 1) throw new Error('--label names the run of one release')
const RUNNER = path.join(__dirname, 'yarn-classic-run.js')
const REDACT = path.join(path.resolve(arg('record', path.join(__dirname, '..', 'fixtures', 'record'))), 'redact-paths.js')
const ARGS = ['install', '--ignore-scripts', '--non-interactive', '--no-progress']
// mktemp -d's parent: $TMPDIR as given, not its real path
const SCRATCH_ROOT = (process.env.TMPDIR || os.tmpdir()).replace(/\/+$/, '')

const exists = f => fs.existsSync(f)
const isDir = f => exists(f) && fs.statSync(f).isDirectory()
const read = f => exists(f) && !isDir(f) ? fs.readFileSync(f, 'utf8') : null
const readBytes = f => exists(f) && !isDir(f) ? fs.readFileSync(f) : null

const discover = () => fs.readdirSync(SCENARIOS, { withFileTypes: true })
  .filter(e => e.isDirectory() && ['before', 'after', 'before-given'].some(f => exists(path.join(SCENARIOS, e.name, f))))
  .map(e => e.name).sort()

// ---- what the recorder was given and did --------------------------------------------------------------------------
const shape = name => {
  const d = path.join(SCENARIOS, name)
  const has = f => exists(path.join(d, f))
  const text = f => read(path.join(d, f))
  const rw = text('recorded-with')
  const lines = rw ? rw.split('\n') : []
  const head = lines[0] ? lines[0].match(/^yarn (\S+), node (\S+), (\d{4}-\d{2}-\d{2})/) : null
  const value = v => /^-?\d+$/.test(v) ? Number(v) : v
  const exitOf = label => {
    const m = (lines[1] || '').match(new RegExp(`(?:^|, )${label} exit=([^,\\s]+)`))
    return m ? value(m[1]) : null
  }
  const layout = (rw || '').match(/^layout repo\/(\S+)/m)
  const runIn = (rw || '').match(/^run in (\S+)/m)
  const cwdFile = (text('cwd') || '').trim()
  const editStarted = (rw || '').match(/^edit started (\S+)/m)
  const user = has('user-npmrc') || has('user-yarnrc')
  const againLog = text('yarnclassic-again.log')
  const recorder = !rw ? 'unrecorded'
    : layout ? 'layout'
      : runIn || cwdFile ? 'cwd'
        : user ? 'user'
          : againLog ? 'open' : 'two-phase'
  const given = has('before-given') || exitOf('before') === 'given'
  const recordedAgain = againLog ? {
    over: (againLog.match(/^over=(\w+)$/m) || [])[1] || null,
    exit: (m => m ? Number(m[1]) : null)(againLog.match(/^exit=(-?\d+)$/m)),
    status: (againLog.match(/^(lock unchanged|lock changed|no lock written|lock removed)$/m) || [])[1] || null,
  } : null
  const day = head ? head[3] : null
  const fixpoint = (lines[1] || '').match(/re-install=([^,\s]+)/)
  return {
    name, dir: d, has, text, recorder, user, given,
    pkg: has('pkg') ? 'pkg' : has('pkg-after') ? 'pkg-after' : null,
    start: given ? (has('before-given') ? 'before-given' : 'before') : null,
    layout: layout ? layout[1] : null,
    cwd: runIn ? runIn[1] : cwdFile,
    recordedRelease: head ? head[1] : null,
    recordedNode: head ? head[2] : null,
    // the clock: the edit's own start where the recorder kept it, else noon of the recording's day
    nowBefore: day ? `${day}T12:00:00Z` : null,
    nowAfter: editStarted ? editStarted[1] : day ? `${day}T12:00:00Z` : null,
    recorded: {
      before: exitOf('before'), after: exitOf('after'), frozen: exitOf('frozen'),
      fixpoint: fixpoint ? value(fixpoint[1]) : null,
      again: recordedAgain,
    },
    memberLockWritten: /^member lock written$/m.test(text('yarn-after.log') || ''),
    repoLock: has('logs/after-repo-yarn.lock') ? 'logs/after-repo-yarn.lock' : null,
    // which second installs the recorder ran over the lock an install wrote
    frozen: ['two-phase', 'open', 'user', 'unrecorded'].includes(recorder),
    again: ['open', 'layout', 'cwd'].includes(recorder),
  }
}

// what a failed install gives as its reason: yarn's first `error` line, else the first line naming an Error; the name
// yarn gives its workspace aggregator is random per run
const failureOf = log => {
  const lines = (log || '').split('\n')
  const e = lines.find(l => /^error /.test(l)) || lines.find(l => /\b[A-Za-z]*Error\b/.test(l))
  return e ? e.trim().replace(/workspace-aggregator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'workspace-aggregator-<uuid>') : null
}

// ---- the Node a release runs under ----------------------------------------------------------------------------------
const nodeFor = release => NODE_FOR[release] || NODE_FOR[release.split('.').slice(0, 2).join('.')] || NODE_FOR[release.split('.')[0]] || NODE
const nodeVersions = new Map()
const versionOf = node => {
  if (!nodeVersions.has(node)) nodeVersions.set(node, execFileSync(node, ['--version'], { encoding: 'utf8' }).trim())
  return nodeVersions.get(node)
}

// a stopped sweep leaves no yarn running and no scratch directory behind
const children = new Set()
const scratches = new Set()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const c of children) c.kill('SIGKILL')
    for (const d of scratches) fs.rmSync(d, { recursive: true, force: true })
    process.exit(130)
  })
}

const run = ({ node, cli, args, cwd, env }) => new Promise(resolve => {
  const child = spawn(node, [RUNNER, cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
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
    children.delete(child)
    resolve({ code: `spawn:${e.code}`, log: String(e), timedOut })
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    children.delete(child)
    resolve({ code: code != null ? code : `signal:${signal}`, log: Buffer.concat(out).toString('utf8'), timedOut })
  })
})

let shared
let ca

const sweepOne = async (release, name) => {
  const outDir = path.join(OUT, LABEL || release, name)
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
  const node = nodeFor(release)
  const cli = path.join(PM, release, 'package', 'bin', 'yarn.js')
  const result = { release, scenario: name, recorder: s.recorder, node: versionOf(node), exits: {}, second: {}, ms: {}, fail: {}, same: {}, spawned: [] }
  const finish = outcome => {
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 1) + '\n')
    return outcome
  }
  if (!s.pkg) {
    result.skip = 'no edited manifest'
    return finish('skipped')
  }
  result.recorded = s.recorded

  const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'tmp.'))
  scratches.add(scratch)
  const log = { requests: [], overlay: new Set(), unserved: [] }
  const server = await stub.start({ shared, ca, scenario: name, scenarioDir: s.dir, at: s.nowAfter, log })
  const stubUrl = `http://127.0.0.1:${server.port}`
  const copyTree = (from, to) => {
    if (isDir(from)) fs.cpSync(from, to, { recursive: true })
  }
  const keep = (label, buf) => fs.writeFileSync(path.join(outDir, label), buf)
  const same = (a, b) => a != null && b != null && Buffer.compare(a, b) === 0

  // a recorder's $WORK: home and cache beside the project; the project is $WORK/project, $WORK/repo/<layout> for the
  // layout recorder, and $WORK/frozen for the frozen phase
  let works = 0
  const workOf = () => {
    const w = scratch + (works++ ? `-${works}` : '')
    if (w !== scratch) {
      fs.mkdirSync(w)
      scratches.add(w)
    }
    fs.mkdirSync(path.join(w, 'home'), { recursive: true })
    fs.mkdirSync(path.join(w, 'cache'), { recursive: true })
    return w
  }
  const projectOf = (w, frozen = false) => frozen ? path.join(w, 'frozen') : s.layout ? path.join(w, 'repo', s.layout) : path.join(w, 'project')
  // a project laid out fresh: the config files, parent/ and grandparent/ above it, tree-before/, then tree/ and the
  // manifest of the phase
  const layFresh = (p, phase) => {
    fs.mkdirSync(p, { recursive: true })
    if (s.layout) {
      copyTree(path.join(s.dir, 'grandparent'), path.join(path.dirname(path.dirname(p))))
      copyTree(path.join(s.dir, 'parent'), path.dirname(p))
    }
    if (s.has('yarnrc')) fs.copyFileSync(path.join(s.dir, 'yarnrc'), path.join(p, '.yarnrc'))
    if (s.has('npmrc')) fs.copyFileSync(path.join(s.dir, 'npmrc'), path.join(p, '.npmrc'))
    copyTree(path.join(s.dir, 'tree-before'), p)
    if (phase !== 'before') copyTree(path.join(s.dir, 'tree'), p)
    fs.copyFileSync(path.join(s.dir, phase === 'before' ? 'pkg-before' : s.pkg), path.join(p, 'package.json'))
    return p
  }
  const userConfig = (w, on) => {
    for (const [file, as] of [['user-npmrc', '.npmrc'], ['user-yarnrc', '.yarnrc']]) {
      fs.rmSync(path.join(w, 'home', as), { force: true })
      if (on && s.has(file)) fs.copyFileSync(path.join(s.dir, file), path.join(w, 'home', as))
    }
  }

  const yarn = async (label, w, p, extra = [], now = s.nowAfter) => {
    const witness = path.join(w, `witness-${label}`)
    const env = {
      PATH: `${path.dirname(node)}:${path.dirname(cli)}:/usr/bin:/bin`,
      HOME: path.join(w, 'home'),
      YARN_CACHE_FOLDER: path.join(w, 'cache'),
      TMPDIR: w,
      npm_config_proxy: stubUrl,
      npm_config_https_proxy: stubUrl,
      NODE_EXTRA_CA_CERTS: ca.caCert,
      SWEEP_WITNESS: witness,
    }
    if (now) env.SWEEP_NOW = now
    log.requests.push(`# ${label}: yarn ${[...ARGS, ...extra].join(' ')}`)
    const t0 = Date.now()
    const res = await run({ node, cli, args: [...ARGS, ...extra], cwd: path.join(p, s.cwd), env })
    result.ms[label] = Date.now() - t0
    fs.writeFileSync(path.join(outDir, `${label}.log`), res.log.split(`127.0.0.1:${server.port}`).join('127.0.0.1:<stub>'))
    result.exits[label] = res.code
    if (res.code !== 0) result.fail[label] = failureOf(res.log)
    if (res.timedOut) result.inconclusive = `${label}: killed after ${TIMEOUT / 1000}s`
    const seen = exists(witness) ? fs.readFileSync(witness, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
    fs.rmSync(witness, { force: true })
    const mains = seen.filter(e => e.main !== undefined)
    if (mains.length !== 1 || mains[0].main !== cli) (result.otherYarn = result.otherYarn || []).push(`${label}: the launcher loaded ${mains.map(m => m.main).join(', ') || 'nothing'}`)
    for (const e of seen.filter(e => e.spawn !== undefined)) {
      const what = `${label}: ${[e.command, ...e.args].join(' ').split(w).join('<work>').slice(0, 240)}`
      if (!result.spawned.includes(what)) result.spawned.push(what)
    }
    const header = res.log.match(/^yarn install v(\S+)/m)
    if (header && header[1] !== release) (result.otherYarn = result.otherYarn || []).push(`${label}: the log is headed "yarn install v${header[1]}"`)
    return res
  }

  // The recorder's second installs over a lock an install wrote (`after`, `cross`), from that install's $WORK:
  // record-yarn-classic.sh's frozen and fixpoint phases in $WORK/frozen with the same home and cache, and
  // again-yarn-classic.sh's install in a fresh $WORK with a cold cache.
  const secondInstalls = async (prefix, w, lock) => {
    const out = {}
    if (s.frozen) {
      const f = projectOf(w, true)
      fs.rmSync(f, { recursive: true, force: true })
      layFresh(f, 'after')
      fs.writeFileSync(path.join(f, 'yarn.lock'), lock)
      const fr = await yarn(`${prefix}frozen`, w, f, ['--frozen-lockfile'])
      out.frozen = fr.code
      fs.rmSync(path.join(f, 'node_modules'), { recursive: true, force: true })
      const fx = await yarn(`${prefix}fixpoint`, w, f)
      const written = readBytes(path.join(f, 'yarn.lock'))
      out.fixpoint = fx.code !== 0 ? fx.code : same(written, lock) ? 'same' : 'changed'
      if (out.fixpoint === 'changed' && written) keep(`${prefix || 'after-'}fixpoint`, written)
    }
    if (s.again) {
      const a = workOf()
      userConfig(a, s.user)
      const p = layFresh(projectOf(a), 'after')
      fs.writeFileSync(path.join(p, 'yarn.lock'), lock)
      const g = await yarn(`${prefix}again`, a, p)
      const written = readBytes(path.join(p, 'yarn.lock'))
      out.again = !written ? 'lock removed' : same(written, lock) ? (g.code !== 0 ? 'no lock written' : 'lock unchanged') : 'lock changed'
      out.againExit = g.code
      if (g.code === 0 && out.again === 'lock changed') keep(`${prefix || 'after-'}again`, written)
    }
    return out
  }

  try {
    // ---- the recording's own chain ---------------------------------------------------------------------------------
    const w = workOf()
    userConfig(w, false)
    const p = layFresh(projectOf(w), 'before')
    if (s.given) {
      fs.copyFileSync(path.join(s.dir, s.start), path.join(p, 'yarn.lock'))
    } else {
      const b = await yarn('before', w, p, [], s.nowBefore)
      const lock = readBytes(path.join(p, 'yarn.lock'))
      if (b.code === 0 && lock) keep('before', lock)
    }
    // record-yarn-classic.sh: rm -rf node_modules, tree/ over the project, the edited manifest
    fs.rmSync(path.join(p, 'node_modules'), { recursive: true, force: true })
    fs.rmSync(path.join(p, s.cwd, 'node_modules'), { recursive: true, force: true })
    copyTree(path.join(s.dir, 'tree'), p)
    fs.copyFileSync(path.join(s.dir, s.pkg), path.join(p, 'package.json'))
    userConfig(w, s.user)
    const startLock = readBytes(path.join(p, 'yarn.lock'))
    const a = await yarn('after', w, p)
    const after = a.code === 0 ? readBytes(path.join(p, 'yarn.lock')) : null
    if (after) keep('after', after)
    if (s.cwd) {
      const member = readBytes(path.join(p, s.cwd, 'yarn.lock'))
      if (member) {
        result.memberLockWritten = true
        keep('after-member-lock', member)
      }
    }
    if (s.layout && exists(path.join(w, 'repo', 'yarn.lock'))) keep('after-repo-lock', readBytes(path.join(w, 'repo', 'yarn.lock')))
    // the second installs over `after`; again-yarn-classic.sh's over the start lock when the edit failed
    if (after) {
      result.second.after = { over: 'after', ...(await secondInstalls('', w, after)) }
    } else if (s.again && startLock) {
      const r = await secondInstalls('', w, startLock)
      result.second.after = { over: 'before', again: r.again, againExit: r.againExit }
    }
    // ---- the edit over the lock 1.22.22 wrote --------------------------------------------------------------------
    if (!s.given && s.has('before')) {
      const x = workOf()
      userConfig(x, s.user)
      const xp = layFresh(projectOf(x), 'after')
      fs.copyFileSync(path.join(s.dir, 'before'), path.join(xp, 'yarn.lock'))
      const c = await yarn('cross', x, xp)
      const cross = c.code === 0 ? readBytes(path.join(xp, 'yarn.lock')) : null
      if (cross) {
        keep('cross', cross)
        // the same lock as `after` gets the same second installs; another lock gets its own
        if (same(cross, after) && result.second.after && result.second.after.over === 'after') {
          result.second.cross = { ...result.second.after, from: 'after' }
        } else {
          result.second.cross = { over: 'cross', ...(await secondInstalls('cross-', x, cross)) }
        }
      }
    }
  } catch (e) {
    result.error = String((e && e.stack) || e)
  } finally {
    server.close()
    for (const d of [...scratches].filter(d => d === scratch || d.startsWith(`${scratch}-`))) {
      fs.rmSync(d, { recursive: true, force: true })
      scratches.delete(d)
    }
  }
  // ---- what the recorders did to everything they kept, then the comparisons with the fixture ---------------------------
  fs.writeFileSync(path.join(outDir, 'requests.log'), log.requests.join('\n') + '\n')
  try {
    execFileSync(process.execPath, [REDACT, outDir], { stdio: 'ignore', env: { ...process.env, TMPDIR: `${SCRATCH_ROOT}/` } })
  } catch (e) {
    result.error = result.error || `redact-paths.js: ${e.message}`
  }
  for (const label of Object.keys(result.fail)) result.fail[label] = failureOf(read(path.join(outDir, `${label}.log`)))
  const mine = f => readBytes(path.join(outDir, f))
  const fixture = f => readBytes(path.join(s.dir, f))
  const recordedAfterLog = read(path.join(s.dir, 'yarn-after.log'))
  for (const phase of ['before', 'after', 'cross']) {
    if (result.exits[phase] === undefined) continue
    const fx = fixture(phase === 'cross' ? 'after' : phase)
    const got = mine(phase)
    if (fx) result.same[phase] = same(got, fx)
    else if (got) result.same[phase] = false
    else if (phase !== 'before' && recordedAfterLog != null) {
      // the recording failed: the same failure
      result.same[`${phase}:failure`] = result.exits[phase] !== 0 && result.fail[phase] === failureOf(recordedAfterLog)
    }
  }
  if (result.exits.before !== undefined && typeof s.recorded.before === 'number') result.same['before:exit'] = result.exits.before === s.recorded.before
  if (result.exits.after !== undefined && typeof s.recorded.after === 'number') result.same['after:exit'] = result.exits.after === s.recorded.after
  const second = result.second.after || {}
  if (second.frozen !== undefined && s.recorded.frozen != null) result.same.frozen = second.frozen === s.recorded.frozen
  if (second.fixpoint !== undefined && s.recorded.fixpoint != null) result.same.fixpoint = second.fixpoint === s.recorded.fixpoint
  if (second.again !== undefined && s.recorded.again) {
    result.same.again = second.again === s.recorded.again.status && second.againExit === s.recorded.again.exit && second.over === s.recorded.again.over
    if (s.has('again')) result.same['again:lock'] = same(mine('after-again'), fixture('again'))
  }
  if (s.memberLockWritten || result.memberLockWritten) result.same.memberLock = !!s.memberLockWritten === !!result.memberLockWritten
  if (s.repoLock) result.same.repoLock = same(mine('after-repo-lock'), fixture(s.repoLock))
  result.overlay = [...log.overlay].sort()
  result.unserved = log.unserved
  if (log.unserved.some(u => u.startsWith('stub-error'))) result.error = result.error || `the stub failed: ${log.unserved.find(u => u.startsWith('stub-error'))}`
  if (!result.spawned.length) delete result.spawned
  return finish('ran')
}

const main = async () => {
  // nothing above the scratch directories may look like a project or carry yarn or npm settings
  for (let d = SCRATCH_ROOT; ; d = path.dirname(d)) {
    for (const f of ['package.json', 'yarn.lock', '.yarnrc', '.npmrc', '.yarnrc.yml']) {
      if (exists(path.join(d, f))) throw new Error(`${path.join(d, f)} would be read by every yarn the sweep starts`)
    }
    if (d === path.dirname(d)) break
  }
  for (const f of ['/etc/yarnrc', '/etc/yarn/config', '/etc/npmrc']) if (exists(f)) throw new Error(`${f} would be read by every yarn the sweep starts`)
  if (!exists(REDACT)) throw new Error(`no ${REDACT}`)
  fs.mkdirSync(OUT, { recursive: true })
  shared = stub.makeShared(OUT)
  ca = stub.ensureCa(path.join(OUT, '_ca'))
  const scenarios = discover().filter(n => !ONLY || ONLY.test(n))
  let tasks = []
  for (const release of RELEASES) {
    if (!exists(path.join(PM, release, 'package', 'bin', 'yarn.js'))) {
      console.error(`no yarn ${release} under ${PM}`)
      process.exitCode = 1
      continue
    }
    for (const name of scenarios) tasks.push([release, name])
  }
  if (CELLS) {
    const known = new Set(tasks.map(t => t.join(' ')))
    tasks = fs.readFileSync(CELLS, 'utf8').split('\n').map(l => l.trim().split(/\s+/)).filter(t => t.length === 2 && known.has(t.join(' ')))
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
        outcome = await sweepOne(t[0], t[1])
      } catch (e) {
        console.error(`${t[0]} ${t[1]}: ${e.stack || e}`)
        outcome = 'ran'
      }
      tally[outcome]++
      done++
      if (done % 50 === 0 || done === total) {
        const secs = Math.round((Date.now() - started) / 1000)
        console.log(`${done}/${total} in ${secs}s  (ran ${tally.ran}, cached ${tally.cached}, skipped ${tally.skipped}); at ${t[0]}`)
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker))
}
main().catch(e => {
  console.error(e)
  process.exit(1)
})

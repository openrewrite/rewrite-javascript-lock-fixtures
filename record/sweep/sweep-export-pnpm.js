// Writes the pnpm sweep's findings into a copy of the fixtures, as sweep-export.js does npm's and
// sweep-export-yarn-berry.js Yarn Berry's: for every scenario, which releases write the recorded outcome, and each
// other outcome some releases write.
//   <scenario>/releases                 the releases that write the scenario's own outcome (node-semver ranges, one a
//                                       line, over the releases in release order)
//   <scenario>/release/<first>/         an outcome other releases write, named by its first release:
//       releases                        the releases that write it
//       recorded-with                   the release, Node, clock and machine of the replay, as the recorders write it
//       before, after, again            what the release wrote from scratch, for the edit, and on the second install
//                                       over `after` when that changed it (the fixture's own names; absent when the
//                                       phase wrote none)
//       cross, cross-again              what it wrote for the edit over the scenario's own `before`, and on the
//                                       second install over that when it changed it
//       probes/<phase>-locks/<path>     every project's lock of a phase, where the scenario has several (the
//                                       recorders' probes/before-locks and probes/after-locks)
//       probes/<phase>-changed/<file>   package.json, pnpm-workspace.yaml or .npmrc as pnpm rewrote it in a phase
//       probes/after-lock-written-on-failure  the lock a failed edit left behind (record-pnpm-open.sh's name)
//       pnpm-<phase>.log                pnpm's output for a phase that failed; pnpm-again.log and pnpm-cross-again.log
//                                       for each second install, ending as again-pnpm.sh ends its log
//       expect, expect-cross            the outcome of the edit and of the cross edit when it is not the lock byte
//                                       for byte
//   <scenario>/http/<name>, <name>@full the packuments a replay of an exported release asked for that the recording
//                                       did not keep, as the sweep's stub served them: today's document cut back to
//                                       the recording's time (live), or the recording's abbreviated one filled out
//                                       to the full one as of the recording (as-of)
//   <scenario>/http-url/<host><path>    a document outside the registry a replay fetched that does not change once
//                                       published (a Node.js release file, a commit's archive)
//
// Each scenario's baseline is the release that recorded it (its recorded-with). A release's outcome is what it wrote
// in every phase (locks, other locks, files it rewrote, exits, the second installs) and what its edits mean for the
// engine (the expect lines); a range joins releases only when every stable release between them was swept and has the
// same outcome. The cross phase of a cell whose sweep took the edit phase's outcome for it is the real one, run by
// pnpm-export-cross.js (--cross).
//
// Left out, and listed: the scenarios the sweep's control does not reproduce with the release that recorded them
// (and those with no recording); the scenarios and cells whose outcome varied between runs (--unstable, and every
// repeat run under --repeats whose outcome differs from the sweep's); cells whose cross phase was the edit phase's
// outcome with no real cross phase to check it; cells in whose replayed phases the stub could not answer; cells whose
// edit ends well without writing a lock where the scenario's lock is (no expect line says that).
//
// Expect lines, for a phase that is not the lock byte for byte (the kinds PnpmScenarioTest knows):
//   - the release asked for another pnpm's tarball (packageManager, devEngines.packageManager), which the sweep
//     refuses: `cannot-know the pnpm release that installs the project: pnpm <release> ...`, `exact-or` it where the
//     phase still wrote a lock the second install keeps;
//   - a failure the recording release also ended the phase with: the scenario's own expect line;
//   - pnpm's own code (ERR_PNPM_...) in its output: `pm-rejects <code>`. pnpm prints some of its errors without their
//     code (11.2.2 prints the named registry's `[ERROR] The named registry alias ...` in one run and
//     `[ERR_PNPM_INVALID_NAMED_REGISTRY_URL] ...` in another): a message without one is `pm-rejects <code>` where the
//     release's own bundle constructs that error with the code (pnpm-export-source.js), else where pnpm prints the
//     message with a code elsewhere (another release, another phase, or the recording whose fixture's expect line names
//     it); a message the bundle constructs as a plain Error is `pm-fails <message>`;
//   - pnpm 10.0 to 10.5 failing to switch to the release the manifest names: cannot-know the release that installs;
//   - Node's code (ERR_INVALID_ARG_TYPE, ...): `pm-fails <code>`; a filesystem errno: `cannot-know the filesystem pnpm
//     ran on (<errno>)`; any other message: `pm-fails <message>`, cut where it names a scratch path; nothing printed: a
//     bare `pm-fails`. A run killed after printing its error and staying silent (it never ends) is classified by that
//     error;
//   - a written lock where the recording's line is `not-reproduced` or `malformed`: that line; `cannot-know`: `exact-or`
//     it where the second install keeps the lock;
//   - a written lock the second install rewrites or rejects: `second-install-rejects`, with pnpm's code when it
//     rejected it with one.
//
// Usage: node sweep-export-pnpm.js --sweep <sweep>/pnpm --cross <pnpm-export-cross.js out> --fixtures <copy of lock/pnpm>
//          --created-list <file> --report <file> [--unstable <sweep>/pnpm/_report/unstable.txt]
//          [--repeats <dir>,<dir>] [--sweep-scenarios <the sweep's --scenarios>] [--shared <dir>,<dir>] [--pm <pm/pnpm>]
//          [--baseline 11.2.2] [--only <regex>] [--dry]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PHASES, LOCK_FILE, loadCell, reproduces, tree, read, sha, errorsIn } = require('./pnpm-cell.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
// the working directory: the one above bin/ as this script was started (bin/ links to record/sweep, and __dirname is
// the link's target)
const ROOT = path.resolve(path.dirname(process.argv[1]), '..')
const SWEEP = path.resolve(arg('sweep'))
const CROSS = arg('cross') ? path.resolve(arg('cross')) : null
const FIXTURES = path.resolve(arg('fixtures'))
const DRY = process.argv.includes('--dry')
const CREATED_LIST = arg('created-list') ? path.resolve(arg('created-list')) : null
const REPORT = arg('report') ? path.resolve(arg('report')) : null
const UNSTABLE = arg('unstable') ? path.resolve(arg('unstable')) : null
const REPEATS = (arg('repeats') || '').split(',').filter(Boolean).map(d => path.resolve(d))
// the as-of and live documents the stub served are kept under the namespace of the scenario directory it swept: its
// name and a hash of its absolute path, so this must be the path exactly as the sweep was given it
const SWEEP_SCENARIOS = path.resolve(arg('sweep-scenarios', path.join(ROOT, 'fixtures', 'lock', 'pnpm')))
const NAMESPACE = `${path.basename(SWEEP_SCENARIOS)}-${crypto.createHash('sha1').update(SWEEP_SCENARIOS).digest('hex').slice(0, 8)}`
// where the stub kept what it served: the cross runs' copy first, then the sweep's
const SHARED = (arg('shared') ? arg('shared').split(',') : [CROSS && path.join(path.dirname(CROSS), 'shared'), SWEEP])
  .filter(Boolean).map(d => path.resolve(d))
const RUN_REPLAYED = new Set(['after', 'again', 'cross', 'cross-again'])
// the ported release: the baseline of a scenario whose recorded-with names none
const BASELINE = arg('baseline', '11.2.2')

const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const write = (f, data) => {
  if (DRY) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, data)
}
const isDir = d => fs.existsSync(d) && fs.statSync(d).isDirectory()

const master = fs.readdirSync(SWEEP).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
// --only <regex>: a subset of the scenarios, to try the export out
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const scenarios = fs.readdirSync(FIXTURES, { withFileTypes: true })
  .filter(e => e.isDirectory() && ['before', 'after', 'seed-lock', 'again'].some(f => fs.existsSync(path.join(FIXTURES, e.name, f))))
  .map(e => e.name).filter(n => !ONLY || ONLY.test(n)).sort()

// the files an earlier export created, by path in the fixtures repository (lock/pnpm/...); removed first, so that an
// export writes only what this sweep says
const created = []
const createdFile = f => created.push(path.join('lock', 'pnpm', path.relative(FIXTURES, f)))
if (CREATED_LIST && fs.existsSync(CREATED_LIST) && !DRY) {
  for (const rel of fs.readFileSync(CREATED_LIST, 'utf8').split('\n').filter(Boolean)) {
    if (rel.startsWith('lock/pnpm/')) fs.rmSync(path.join(FIXTURES, rel.slice('lock/pnpm/'.length)), { force: true })
  }
}

const ranges = releases => {
  const set = new Set(releases)
  const out = []
  let run = null
  for (const v of master) {
    if (set.has(v)) {
      if (run) run[1] = v
      else run = [v, v]
    } else if (run) {
      out.push(run)
      run = null
    }
  }
  if (run) out.push(run)
  return out.map(([a, b]) => a === b ? a : `${a} - ${b}`)
}

// ---- the rules this export had to decide, with the scenarios each was needed for ----------------------------------
const rules = new Map()
const rule = (name, text, scenario, detail) => {
  if (!rules.has(name)) rules.set(name, { text, scenarios: new Map() })
  const r = rules.get(name)
  const list = r.scenarios.get(scenario) || []
  if (detail && !list.includes(detail) && list.length < 6) list.push(detail)
  r.scenarios.set(scenario, list)
}

// ---- outcomes that varied between runs ---------------------------------------------------------------------------
const unstableScenarios = new Set()
const variedCells = new Map()
const varied = (release, scenario, why) => variedCells.set(`${release} ${scenario}`, why)
if (UNSTABLE && fs.existsSync(UNSTABLE)) {
  for (const f of fs.readFileSync(UNSTABLE, 'utf8').split('\n').map(l => l.trim().split(/\s+/)).filter(f => f[0] && !f[0].startsWith('#'))) {
    if (f.length === 1) unstableScenarios.add(f[0])
    else if (f[1] === 'errors' && /^\d+\.\d+\.\d+\.\.\d+\.\d+\.\d+$/.test(f[2])) {
      const [from, to] = f[2].split('..')
      for (const r of master) if (cmp(r, from) >= 0 && cmp(r, to) <= 0) varied(r, f[0], `its error varies between runs (${path.basename(UNSTABLE)})`)
    }
  }
}
// a repeat run of a cell that ended otherwise than the sweep's (its first three phases, and the cross phase where
// both ran it)
for (const root of REPEATS) {
  for (const r of fs.readdirSync(root).filter(v => /^\d+\.\d+\.\d+$/.test(v))) {
    for (const s of fs.readdirSync(path.join(root, r))) {
      const a = loadCell(path.join(root, r, s))
      const b = loadCell(path.join(SWEEP, r, s))
      if (!a || !b || a.r.skip || b.r.skip) continue
      const phases = ['before', 'after', 'again', ...(!a.r.crossFrom && !b.r.crossFrom ? ['cross', 'cross-again'] : [])]
      const differ = phases.filter(ph => a.sig[ph] !== b.sig[ph])
      if (differ.length) varied(r, s, `a repeat run (${path.relative(SWEEP, root)}) ended otherwise in ${differ.join(', ')}`)
    }
  }
}

// ---- what pnpm's messages mean -----------------------------------------------------------------------------------
// a message as a key: quoted strings, versions and scratch paths made alike
const messageKey = message => String(message)
  .replace(/"[^"]*"/g, '"<s>"').replace(/'[^']*'/g, "'<s>'")
  .replace(/v?<this release>/g, '<v>')
  .replace(/[\^~]?\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g, '<v>')
  .replace(/<(tmp|home)>\S*/g, '<path>').replace(/\s+/g, ' ').trim()
// a message as an expect line names it: cut where it names a path of the machine it ran on
const cut = message => {
  const at = String(message).search(/<(tmp|home|proxy)>|\/(private\/)?(tmp|var\/folders)\//)
  const head = at < 0 ? String(message) : String(message).slice(0, at)
  return head.replace(/[\s"'`(:,]+$/, '').trim()
}
// the code pnpm gives a message, wherever it printed both: "[ERR_PNPM_X] message" (pnpm 11),
// " ERR_PNPM_X  message" (pnpm 9 and 10); and the code the fixtures' own expect lines give the message their recording
// printed without one
const codeOfMessage = new Map()
const codeConflicts = new Map()
const learn = (message, code, where) => {
  const key = messageKey(message)
  if (!key) return
  if (!codeOfMessage.has(key)) codeOfMessage.set(key, { code, where })
  else if (codeOfMessage.get(key).code !== code) codeConflicts.set(key, [...new Set([...(codeConflicts.get(key) || [codeOfMessage.get(key).code]), code])])
}
const learnFromLog = (log, where) => {
  for (const line of String(log || '').split('\n')) {
    const m = line.match(/^\s*\[(ERR_PNPM_[A-Z0-9_]+)\]\s+(.+)$/) || line.match(/^\s*(ERR_PNPM_[A-Z0-9_]+)\s{2,}(.+)$/)
    if (m) learn(m[2], m[1], where)
  }
}
// every fixture's, whichever scenarios this export writes
for (const s of fs.readdirSync(FIXTURES).filter(n => isDir(path.join(FIXTURES, n)))) {
  const expect = (read(path.join(FIXTURES, s, 'expect')) || '').trim()
  const m = expect.match(/^pm-rejects (ERR_PNPM_[A-Z0-9_]+)$/)
  if (!m) continue
  for (const e of errorsIn(read(path.join(FIXTURES, s, 'pnpm-after.log')) || '')) {
    if (e.startsWith('ERROR: ')) learn(e.slice('ERROR: '.length), m[1], `the recording of ${s}, whose expect line says ${m[1]}`)
  }
}

const FILESYSTEM = /\b(ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|EEXIST|ENOTEMPTY|EBUSY|EMFILE)\b/

// the codes the releases' own bundles give the messages they printed without one, looked up once per release before
// any phase is classified (pnpm-export-source.js); and where that and a code printed elsewhere disagree
const { codesOf } = require('./pnpm-export-source.js')
const PM = path.resolve(arg('pm', path.join(ROOT, 'pm', 'pnpm')))
const sourceCodes = new Map()
const sourceDisagrees = new Set()

// ---- a cell: the sweep's, with the real cross phase where the sweep took the edit phase's for it ----------------
const loadMerged = (release, scenario) => {
  const dir = path.join(SWEEP, release, scenario)
  const c = loadCell(dir)
  if (!c) return { leftOut: 'not swept' }
  if (c.r.skip) return { leftOut: `not swept (${c.r.skip})` }
  if (c.r.error) return { leftOut: `the sweep's run failed (${String(c.r.error).split('\n')[0]})` }
  const at = { before: dir, after: dir, again: dir, cross: dir, 'cross-again': dir }
  let reuse = null
  if (c.r.crossFrom) {
    const x = CROSS && path.join(CROSS, release, scenario)
    const xc = x && loadCell(x)
    if (!xc || xc.r.skip) return { leftOut: 'its cross phase was the edit phase\'s outcome, and no real cross phase checks it' }
    if (xc.r.error) return { leftOut: `its real cross phase failed to run (${String(xc.r.error).split('\n')[0]})` }
    const before = { cross: c.sig.cross, crossAgain: c.sig['cross-again'] }
    c.sig.cross = xc.sig.cross
    c.wrote.cross = xc.wrote.cross
    c.r.exits.cross = xc.r.exits.cross
    if (xc.r.errors.cross) c.r.errors.cross = xc.r.errors.cross
    else delete c.r.errors.cross
    at.cross = x
    if (xc.r.exits['cross-again'] !== undefined) {
      c.sig['cross-again'] = xc.sig['cross-again']
      c.wrote['cross-again'] = xc.wrote['cross-again']
      c.r.exits['cross-again'] = xc.r.exits['cross-again']
      if (xc.r.errors['cross-again']) c.r.errors['cross-again'] = xc.r.errors['cross-again']
      c.crossAgainIsAgain = false
      at['cross-again'] = x
    } else if (xc.r.crossAgain != null) {
      // the cross lock is the after lock, and gets the after lock's second install
      c.sig['cross-again'] = c.sig.again
      c.wrote['cross-again'] = c.wrote.again
      c.crossAgainIsAgain = true
    } else {
      c.sig['cross-again'] = xc.sig['cross-again']
      c.wrote['cross-again'] = xc.wrote['cross-again']
      c.crossAgainIsAgain = false
    }
    c.r.crossAgain = xc.r.crossAgain
    c.r.clockStarts = { ...(c.r.clockStarts || {}), ...(xc.r.clockStarts || {}) }
    c.r.hung = { ...(c.r.hung || {}), ...(xc.r.hung || {}) }
    for (const k of Object.keys(c.r.hung)) if (k.startsWith('cross') && !(xc.r.hung || {})[k]) delete c.r.hung[k]
    delete c.r.crossFrom
    reuse = before.cross === c.sig.cross && before.crossAgain === c.sig['cross-again'] ? 'held' : 'did not hold'
  }
  c.at = at
  c.reuse = reuse
  return { cell: c }
}
const lockText = (c, ph) => read(path.join(c.at[ph], ph === 'cross-again' && c.crossAgainIsAgain ? LOCK_FILE.again : LOCK_FILE[ph]))
const logOf = (c, ph) => read(path.join(c.at[ph === 'before-own' ? 'before' : ph], `${ph}.log`))
// the requests of each phase a cell's replay made, by phase
const requestsOf = c => {
  const out = []
  for (const dir of new Set(Object.values(c.at))) {
    let phase = null
    for (const line of (read(path.join(dir, 'requests.log')) || '').split('\n')) {
      if (line.startsWith('# ')) {
        phase = line.slice(2)
        continue
      }
      // a phase is the cross run's where that run made it, else the sweep's
      if (phase && c.at[phase.replace(/-own$/, '')] === dir) out.push({ phase, line })
    }
  }
  return out
}

// ---- the outcome of one phase of a cell when it is not the lock byte for byte ----------------------------------
// what classify returns for a phase whose outcome no expect line says: the cell is left out with the reason after it
const LEAVE = '\u0000leave '
const classify = ({ c, ph, base, rootExpect, scenario, release }) => {
  const exit = c.r.exits[ph]
  if (exit === undefined) return null
  const sig = String(c.sig[ph])
  const lock = lockText(c, ph)
  const again = ph === 'cross' ? (c.crossAgainIsAgain ? c.r.again : c.r.crossAgain) : c.r.again
  const kind = (rootExpect || 'exact').split(/\s+/)[0]
  const over = sig.match(/^hands over to (\S+)/)
  if (over) {
    rule('hands-over', 'a phase in which the release asked for another pnpm\'s tarball (refused by the sweep) is what that other release does: cannot-know the release that installs, exact-or it where the phase still wrote a lock the second install keeps',
      scenario, `${release} ${ph}: hands over to ${over[1]}`)
    const line = `cannot-know the pnpm release that installs the project: pnpm ${over[1]}, which this release downloads and hands the install over to`
    return exit === 0 && lock != null && again === 'lock unchanged' ? `exact-or ${line}` : line
  }
  if (exit !== 0) {
    const errors = c.r.errors[ph] || []
    const baseExit = base.r.exits[ph]
    if (rootExpect && baseExit !== undefined && baseExit !== 0 && JSON.stringify(base.r.errors[ph] || []) === JSON.stringify(errors)) {
      return rootExpect
    }
    const log = logOf(c, ph) || ''
    const hung = (c.r.hung || {})[ph]
    if (hung) rule('hang', 'a run killed after printing its error and staying silent (it never ends) is classified by the error it printed', scenario, `${release} ${ph}: ${hung}`)
    const code = (log.match(/\bERR_PNPM_[A-Z0-9_]+\b/) || [])[0]
    if (code) return `pm-rejects ${code}`
    const nodeCode = errors.find(e => /^ERR_[A-Z0-9_]+$/.test(e))
    if (nodeCode) {
      rule('node-code', 'a failure that names Node\'s code and no code of pnpm\'s is pm-fails <code>, as small-manifest-not-json\'s own line says', scenario, `${release} ${ph}: ${nodeCode}`)
      return `pm-fails ${nodeCode}`
    }
    const message = (errors.find(e => e.startsWith('ERROR: ')) || '').slice('ERROR: '.length)
    // pnpm 10.0 to 10.5 switch to the release the manifest names through their tools directory, which the sweep's
    // fresh HOME holds empty (and a lock-only install fills with a lock, no pnpm): what runs depends on the machine
    const switched = message.match(/^Failed to switch pnpm to v(\d+\.\d+\.\d+\S*?)\./)
    if (switched) {
      rule('switch-failed', 'a release that fails to switch to the pnpm release the manifest names (its tools directory holds no such pnpm) is what that release does on a machine whose tools directory holds it: cannot-know the release that installs',
        scenario, `${release} ${ph}: ${cut(message).slice(0, 90)}`)
      return `cannot-know the pnpm release that installs the project: pnpm ${switched[1]}, which this release switches to from its tools directory`
    }
    const errno = message.match(FILESYSTEM)
    if (errno) {
      rule('filesystem', 'a failure on an errno of the filesystem is cannot-know the filesystem pnpm ran on, as sweep-export.js says it for npm', scenario, `${release} ${ph}: ${errno[1]}`)
      return `cannot-know the filesystem pnpm ran on (${errno[1]})`
    }
    if (!message) {
      rule('silent-failure', 'a failure with no error printed is a bare pm-fails: pnpm fails and says nothing the engine could name', scenario, `${release} ${ph}: exit ${exit}`)
      return 'pm-fails'
    }
    // the release's own source first: the error its bundle constructs with this message (pnpm-export-source.js)
    const src = sourceCodes.get(`${release}\u0000${message}`)
    const known = codeOfMessage.get(messageKey(message))
    if (src && src.code) {
      rule('source-code', 'a failure pnpm prints without a code is pm-rejects <code> where the release\'s own bundle constructs the error with that code (pnpm-export-source.js)',
        scenario, `${release} ${ph}: "${cut(message).slice(0, 70)}" is ERR_PNPM_${src.code} (${src.how})`)
      if (known && known.code !== `ERR_PNPM_${src.code}`) sourceDisagrees.add(`${release}: "${cut(message).slice(0, 80)}": the bundle says ERR_PNPM_${src.code}, ${known.where} printed ${known.code}`)
      return `pm-rejects ERR_PNPM_${src.code}`
    }
    if (src && src.code === null && /^new \w*Error\(/.test(src.how)) {
      rule('source-plain', 'a failure pnpm prints without a code, whose error the release\'s own bundle constructs as a plain Error (no code), is pm-fails <message>',
        scenario, `${release} ${ph}: "${cut(message).slice(0, 70)}" (${src.how})`)
      if (known) sourceDisagrees.add(`${release}: "${cut(message).slice(0, 80)}": the bundle constructs a plain Error, ${known.where} printed ${known.code}`)
    } else if (known && codeConflicts.has(messageKey(message))) {
      rule('message-code-conflict', 'a message pnpm prints with several codes in several places names none of them: pm-fails <message>', scenario, `${release} ${ph}: ${codeConflicts.get(messageKey(message)).join(', ')}`)
    } else if (known) {
      rule('message-code', 'a failure whose message pnpm prints without a code is pm-rejects <code> where the same message is printed with that code elsewhere (another release, another phase), or the fixture whose recording printed it names the code in its expect line',
        scenario, `${release} ${ph}: "${cut(message).slice(0, 80)}" is ${known.code} (${known.where})`)
      return `pm-rejects ${known.code}`
    }
    const rest = cut(message)
    if (rest !== message.trim()) rule('cut', 'a message an expect line names is cut where it names a path of the machine pnpm ran on', scenario, `${release} ${ph}: ${rest.slice(0, 80)}`)
    return `pm-fails ${rest}`
  }
  if (kind === 'not-reproduced' || kind === 'malformed') return rootExpect
  if (kind === 'cannot-know') return again === 'lock unchanged' || again == null ? `exact-or ${rootExpect}` : rootExpect
  if (lock == null) {
    rule('no-lock', 'an install that ends well but writes no lock where the scenario\'s lock is (its lock-dir, or the root) has no expect line the tests know: the cell is left out', scenario, `${release} ${ph}`)
    return LEAVE + `pnpm ends the ${ph === 'after' ? 'edit' : 'cross edit'} well and writes no lock where the scenario's lock is`
  }
  if (again && again !== 'lock unchanged') {
    const againPhase = ph === 'cross' && !c.crossAgainIsAgain ? 'cross-again' : 'again'
    const againCode = (((logOf(c, againPhase) || '').match(/\bERR_PNPM_[A-Z0-9_]+\b/)) || [])[0]
    if (againCode) rule('second-install-code', 'a second install that rejects the lock with pnpm\'s code names it after second-install-rejects', scenario, `${release} ${ph}: ${againCode}`)
    return againCode && again === 'no lock written' ? `second-install-rejects ${againCode}` : 'second-install-rejects'
  }
  return 'exact'
}

// a scratch directory of the sweep (<root>/pnpm-sweep-XXXXXX) that the redaction missed because pnpm 12 wrapped the
// line inside it: the path is read on across each line break and its indentation
const unwrapScratch = text => {
  let out = ''
  let i = 0
  const start = /(?:\/private)?\/(?:tmp|var\/folders)\//g
  for (;;) {
    start.lastIndex = i
    const m = start.exec(text)
    if (!m) return out + text.slice(i)
    // the path's characters, skipping a line break and the indentation after it
    let j = m.index
    let seen = ''
    while (j < text.length) {
      if (text[j] === '\n') {
        let k = j + 1
        while (k < text.length && text[k] === ' ') k++
        j = k
        continue
      }
      if (/[\s'"`]/.test(text[j])) break
      seen += text[j]
      j++
      const done = seen.match(/pnpm-sweep-[A-Za-z0-9]{6}$/)
      if (done) break
    }
    if (/pnpm-sweep-[A-Za-z0-9]{6}$/.test(seen)) {
      out += text.slice(i, m.index) + '<tmp>'
    } else {
      out += text.slice(i, m.index + m[0].length)
      j = m.index + m[0].length
    }
    i = j
  }
}

// pnpm's output for a failed phase without what differs from run to run and machine to machine
const stableLog = log => {
  const text = unwrapScratch(String(log || '').replace(/\x1b\[[0-9;]*m/g, ''))
  return text.split('\n')
    .filter(l => !/DeprecationWarning: `url\.parse\(\)`|^\(Use `node --trace-deprecation/.test(l))
    .map(l => l.replace(/\(node:\d+\)/g, '(node:<pid>)').replace(/\b\d+(\.\d+)?m?s ago\b/g, '<time> ago').replace(/\bin \d+(\.\d+)?m?s\b/g, 'in <time>'))
    .join('\n').trim() + '\n'
}

// ---- the registry documents a replay asked for that the recording did not keep -----------------------------------
const flat = p => p.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 150) + '-' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 10)
const sharedFile = rel => {
  for (const root of SHARED) {
    const f = path.join(root, rel)
    if (fs.existsSync(f)) return f
  }
  return null
}

const main = () => {
  const perRelease = Object.fromEntries(master.map(r => [r, { root: 0, other: 0, out: 0 }]))
  const leftOut = new Map()
  const leave = (scenario, release, why) => {
    const key = `${scenario}\t${why}`
    if (!leftOut.has(key)) leftOut.set(key, [])
    leftOut.get(key).push(release)
    perRelease[release].out++
  }
  const report = []
  const review = []
  const expectKinds = new Map()
  const tally = (kind, line) => {
    const k = line.split(/\s+/)[0]
    if (!expectKinds.has(k)) expectKinds.set(k, new Map())
    expectKinds.get(k).set(line, (expectKinds.get(k).get(line) || 0) + 1)
  }
  const reuseHeld = { held: 0, 'did not hold': 0 }
  const reuseBroken = []
  const added = new Map()
  // documents outside the registry a replay fetched that the engine never reads
  const notAdded = new Set()
  let exported = 0
  let groupsWritten = 0

  for (const scenario of scenarios) {
    const dir = path.join(FIXTURES, scenario)
    if (!DRY) {
      fs.rmSync(path.join(dir, 'release'), { recursive: true, force: true })
      fs.rmSync(path.join(dir, 'releases'), { force: true })
    }
    const recorded = read(path.join(dir, 'recorded-with'))
    let baseline = recorded == null ? null : (recorded.split('\n')[0].match(/^pnpm (\d+\.\d+\.\d+),/) || [])[1]
    if (recorded != null && !baseline && /^pnpm , /.test(recorded)) {
      // the recorder's `pnpm --version` failed in the scenario's directory (pnpm reads the project's settings first):
      // the release that recorded it is the ported one, as sweep-export.js takes npm's for a fixture that does not say
      baseline = BASELINE
      rule('baseline-default', `a scenario whose recorded-with names no release (the recorder's \`pnpm --version\` failed there) was recorded with pnpm ${BASELINE}, the ported release, as sweep-export.js takes npm 11.17.0 where a fixture does not say`, scenario, recorded.split('\n')[0])
    }
    const scenarioOut = why => {
      for (const r of master) leave(scenario, r, why)
      report.push(`${scenario}  not exported: ${why}`)
    }
    if (recorded == null) {
      scenarioOut('no recording (a downloaded fixture with no recorded-with)')
      continue
    }
    if (!baseline) {
      scenarioOut('its recorded-with names no pnpm release')
      continue
    }
    if (unstableScenarios.has(scenario)) {
      scenarioOut(`its outcome varied between runs (${path.basename(UNSTABLE)})`)
      continue
    }
    const baseLoad = loadMerged(baseline, scenario)
    if (!baseLoad.cell) {
      scenarioOut(`the cell of the release that recorded it (${baseline}) is left out: ${baseLoad.leftOut}`)
      continue
    }
    const base = baseLoad.cell
    if (!reproduces(base)) {
      const failing = Object.entries(base.r.same || {}).filter(([, v]) => !v).map(([k]) => k)
      scenarioOut(`the control (pnpm ${baseline}, which recorded it) does not reproduce ${failing.join(', ') || 'it'}`)
      continue
    }
    const rootExpect = (read(path.join(dir, 'expect')) || '').trim() || null
    const groups = new Map()
    const cells = []
    for (const r of master) {
      const v = variedCells.get(`${r} ${scenario}`)
      if (v) {
        leave(scenario, r, `varied between runs: ${v}`)
        rule('varied-cell', 'a cell whose outcome varied between runs of its release is left out', scenario, `${r}: ${v}`)
        continue
      }
      const m = loadMerged(r, scenario)
      if (!m.cell) {
        leave(scenario, r, m.leftOut)
        continue
      }
      const c = m.cell
      if (c.reuse) {
        reuseHeld[c.reuse]++
        if (c.reuse === 'did not hold') reuseBroken.push(`${r} ${scenario}`)
      }
      const requests = requestsOf(c)
      const unserved = requests.filter(q => RUN_REPLAYED.has(q.phase) && / (unserved|stub-error)\b/.test(q.line))
      if (unserved.length) {
        leave(scenario, r, `the stub could not answer: ${unserved[0].line.slice(0, 160)}`)
        rule('unserved', 'a cell in whose replayed phases the stub could not answer a request (a registry of the recording machine with no recording of the package) is left out', scenario, `${r}: ${unserved[0].line.slice(0, 120)}`)
        continue
      }
      c.requests = requests
      const expect = classify({ c, ph: 'after', base, rootExpect, scenario, release: r })
      const expectCross = classify({ c, ph: 'cross', base, rootExpect, scenario, release: r })
      const unsaid = [expect, expectCross].find(x => x && x.startsWith(LEAVE))
      if (unsaid) {
        leave(scenario, r, unsaid.slice(LEAVE.length))
        continue
      }
      cells.push(c)
      const failed = read(path.join(c.at.after, 'after-lock-written-on-failure'))
      const key = sha(JSON.stringify([PHASES.map(ph => c.wrote[ph]), sha(failed), expect, expectCross]))
      c.expect = expect
      c.expectCross = expectCross
      c.key = key
      if (!groups.has(key)) groups.set(key, { first: c, releases: [] })
      groups.get(key).releases.push(r)
    }
    const baseKey = (cells.find(c => c.r.release === baseline) || {}).key
    if (!baseKey) {
      for (const r of master) if (cells.some(c => c.r.release === r)) leave(scenario, r, 'the release that recorded it is left out')
      report.push(`${scenario}  not exported: the release that recorded it (${baseline}) is left out`)
      continue
    }
    exported++
    for (const c of cells) perRelease[c.r.release][c.key === baseKey ? 'root' : 'other']++
    write(path.join(dir, 'releases'), ranges(groups.get(baseKey).releases).join('\n') + '\n')
    const recordedAt = (recorded.split('\n')[0].match(/, (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/) || [])[1] || '-'
    for (const [key, g] of groups) {
      const c = g.first
      if (key === baseKey) continue
      const label = c.r.release
      const gdir = path.join(dir, 'release', label)
      const spans = ranges(g.releases)
      write(path.join(gdir, 'releases'), spans.join('\n') + '\n')
      const exit = ph => c.r.exits[ph] === undefined ? '-' : c.r.exits[ph]
      const node = (String(c.r.node).match(/v\d+\.\d+\.\d+/) || ['-'])[0]
      const times = ['before', 'after', 'again', 'cross', 'cross-again'].filter(ph => (c.r.clockStarts || {})[ph])
        .map(ph => `${ph} at ${c.r.clockStarts[ph]}`).join(', ')
      write(path.join(gdir, 'recorded-with'),
        `pnpm ${label}, node ${node}, ${recordedAt}\n` +
        `before exit=${exit('before')}, after exit=${exit('after')}\n` +
        `again exit=${exit('again')}\n` +
        `cross exit=${exit('cross')}, cross-again exit=${exit('cross-again')}\n` +
        (times ? `phase times: ${times}\n` : '') +
        'platform os=darwin cpu=arm64 libc=\n' +
        `swept: ${String(c.r.node).startsWith('native') ? 'the native executable (@pnpm/exe.darwin-arm64), Node from PATH for its children, ' : ''}replayed against the scenario's http/ by sweep-pnpm.js${c.at.cross !== c.at.after ? ', the cross phases by pnpm-export-cross.js' : ''}\n`)
      // the locks, as the fixture names its own
      const files = { before: 'before', after: 'after', again: 'again', cross: 'cross', 'cross-again': 'cross-again' }
      for (const [ph, name] of Object.entries(files)) {
        if (ph === 'cross-again' && c.crossAgainIsAgain) continue
        const text = read(path.join(c.at[ph], LOCK_FILE[ph]))
        if (text != null) write(path.join(gdir, name), text)
      }
      if ((read(path.join(c.at.after, 'after-again')) || null) != null) {
        rule('again-name', 'the lock the second install over `after` rewrote it to is `again`, the fixture\'s own name (the sweep keeps it as after-again)', scenario, label)
      }
      const failed = read(path.join(c.at.after, 'after-lock-written-on-failure'))
      if (failed != null) write(path.join(gdir, 'probes', 'after-lock-written-on-failure'), failed)
      for (const ph of PHASES) {
        if (ph === 'cross-again' && c.crossAgainIsAgain) continue
        for (const [kind, probe] of [['locks', 'locks'], ['changed', 'changed']]) {
          const from = path.join(c.at[ph], kind, ph)
          for (const f of tree(from)) {
            write(path.join(gdir, 'probes', `${ph}-${probe}`, f), fs.readFileSync(path.join(from, f)))
            rule(`probes-${kind}`, kind === 'locks' ? 'every project\'s lock of a phase is under probes/<phase>-locks/, as the recorders keep before\'s and after\'s'
              : 'a file pnpm rewrote in a phase is under probes/<phase>-changed/, as record-pnpm-open.sh keeps them', scenario, `${label} ${ph}/${f}`)
          }
        }
      }
      for (const ph of ['before', 'before-own', 'after', 'cross']) {
        const e = c.r.exits[ph]
        if (e !== undefined && e !== 0 && e !== 'seeded') write(path.join(gdir, `pnpm-${ph}.log`), stableLog(logOf(c, ph)))
      }
      const at = (c.r.clockStarts || {})
      if (c.r.exits.again !== undefined) {
        write(path.join(gdir, 'pnpm-again.log'), `${stableLog(logOf(c, 'again'))}pnpm ${label}, node ${node}, ${at.again || recordedAt}\nexit=${c.r.exits.again}\n${c.r.again}\n`)
      }
      if (c.r.exits['cross-again'] !== undefined && !c.crossAgainIsAgain) {
        write(path.join(gdir, 'pnpm-cross-again.log'), `${stableLog(logOf(c, 'cross-again'))}pnpm ${label}, node ${node}, ${at['cross-again'] || recordedAt}\nexit=${c.r.exits['cross-again']}\n${c.r.crossAgain}\n`)
      }
      if (c.expect && c.expect !== 'exact') {
        write(path.join(gdir, 'expect'), c.expect + '\n')
        tally('expect', c.expect)
      }
      if (c.expectCross && c.expectCross !== 'exact') {
        write(path.join(gdir, 'expect-cross'), c.expectCross + '\n')
        tally('expect-cross', c.expectCross)
      }
      groupsWritten++
      report.push(`${scenario}  release/${label}  [${spans.join(', ')}]  after: ${c.expect || '-'}  cross: ${c.expectCross || '-'}`)
    }

    // ---- what the replays of the exported releases asked the registry for that the recording did not keep: in the
    // phases the engine is to reproduce (a phase whose expect line is cannot-know ends there, before it needs any)
    for (const c of cells) {
      const expectOf = { after: c.expect, again: c.expect, cross: c.expectCross, 'cross-again': c.expectCross }
      for (const { phase, line } of c.requests) {
        if (!RUN_REPLAYED.has(phase)) continue
        if (String(expectOf[phase] || '').startsWith('cannot-know')) {
          if (/ (abbreviated|full|url) (live|as-of|fixed-url)/.test(line)) {
            rule('cannot-know-documents', 'what a phase whose expect line is cannot-know asked the registry for is not added: the engine ends that edit before it needs it', scenario, `${c.r.release} ${phase}: ${line.split(' ')[1].slice(0, 90)}`)
          }
          continue
        }
        const m = line.match(/^GET (https?):\/\/([^/\s]+)(\/\S*) (abbreviated|full|url) (.*)$/)
        if (!m) continue
        const [, scheme, hostPort, urlPath, kind, how] = m
        const [host, port] = hostPort.split(':')
        const key = !port || Number(port) === (scheme === 'https' ? 443 : 80) ? host : `${host}+${port}`
        if (kind === 'url') {
          if (how !== 'fixed-url') continue
          const own = path.join(dir, 'http-url', key + urlPath.split('?')[0])
          if (fs.existsSync(own) || fs.existsSync(own + '.gz') || added.has(own) || notAdded.has(own)) continue
          const kept = sharedFile(path.join('_live', key, '-url', flat(urlPath)))
          if (!kept) {
            review.push(`${scenario}: ${c.r.release} ${phase} was served ${scheme}://${hostPort}${urlPath} (fixed-url) but no copy is kept`)
            continue
          }
          // a document the engine reads (a checksum list, a release list); an archive or a signature it never does
          const head = Buffer.alloc(65536)
          const fd = fs.openSync(kept, 'r')
          const n = fs.readSync(fd, head, 0, head.length, 0)
          fs.closeSync(fd)
          if (head.subarray(0, n).includes(0) || /\.(tgz|tar\.gz|zip|tar\.xz|sig)$/.test(urlPath.split('?')[0]) || /\/tar\.gz\//.test(urlPath)) {
            rule('binary-url', 'a document outside the registry that is an archive or a signature (a Node.js release tarball, a commit\'s archive, SHASUMS256.txt.sig) is not added: the engine reads no archive', scenario, `${key}${urlPath.split('?')[0]}`)
            notAdded.add(own)
            continue
          }
          write(own, fs.readFileSync(kept))
          added.set(own, 'url')
          rule('fixed-url', 'a document outside the registry that never changes once published (a Node.js release file, a commit\'s archive) is added under http-url/ as the stub served it', scenario, `${key}${urlPath}`)
          continue
        }
        if (how === 'recorded-full' && kind === 'abbreviated') {
          // an abbreviated packument asked where the recording kept only the full one, which the stub served for it
          const name = decodeURIComponent(urlPath.split('?')[0].slice(1))
          const own = path.join(dir, 'http', name)
          if (!fs.existsSync(own) && !added.has(own) && fs.existsSync(own + '@full')) {
            write(own, fs.readFileSync(own + '@full'))
            added.set(own, 'packument (the recording\'s full one, served for an abbreviated request)')
            rule('recorded-full', 'an abbreviated packument a replay asked for where the recording kept only the full one is added as that full one, which the stub served for it', scenario, `${c.r.release} ${phase}: ${name}`)
          }
          continue
        }
        if (/^recorded(-404|-full)?$/.test(how)) continue
        if (/^(absent|unserved)/.test(how)) continue
        const name = decodeURIComponent(urlPath.split('?')[0].slice(1))
        if (!name || name.startsWith('-/')) continue
        const own = path.join(dir, 'http', kind === 'full' ? `${name}@full` : name)
        if (fs.existsSync(own) || added.has(own)) continue
        const kept = sharedFile(path.join('_overlay', NAMESPACE, scenario, key, kind === 'full' ? `${name}@full` : name))
        if (!kept) {
          review.push(`${scenario}: ${c.r.release} ${phase} was served ${name} ${kind} (${how}) but no copy is kept`)
          continue
        }
        if (key !== 'registry.npmjs.org') rule('other-host', 'a packument of another registry host is added under http/ beside the npm registry\'s, as the recordings keep them', scenario, `${key}/${name}`)
        write(own, fs.readFileSync(kept))
        added.set(own, `packument (${how.replace(/cut at [^,]+, /, '')})`)
        if (/latest tag lost|[1-9]\d* later versions dropped/.test(how)) {
          review.push(`${scenario}: ${path.relative(dir, own)} is today's document cut back to the recording (${how}): REGISTRY NEWER THAN RECORDING`)
        }
      }
    }
  }
  for (const f of added.keys()) createdFile(f)

  // ---- the report
  const lines = []
  lines.push(`pnpm sweep export (${new Date().toISOString().slice(0, 10)}): ${exported} of ${scenarios.length} scenarios exported, ${groupsWritten} other outcomes; ${added.size} files added to http/ and http-url/`)
  lines.push(`each scenario's baseline is the release that recorded it (recorded-with); ${master.length} releases, ${master[0]} .. ${master[master.length - 1]}`)
  lines.push(`cells whose sweep took the edit phase's outcome for the cross phase, checked by a real cross phase: the reuse held in ${reuseHeld.held}, did not hold in ${reuseHeld['did not hold']}`)
  lines.push('', 'release      recorded-outcome  another  left-out')
  for (const r of master) lines.push(`${r.padEnd(12)} ${String(perRelease[r].root).padEnd(17)} ${String(perRelease[r].other).padEnd(8)} ${perRelease[r].out}`)
  lines.push('', 'expect lines written, by kind (expect and expect-cross of the release/ outcomes):')
  for (const [kind, m] of [...expectKinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
    const total = [...m.values()].reduce((x, y) => x + y, 0)
    lines.push(`  ${kind}: ${total}`)
    for (const [line, n] of [...m].sort((a, b) => b[1] - a[1])) lines.push(`    ${String(n).padStart(4)}  ${line.slice(0, 200)}`)
  }
  lines.push('', 'rules this export decided, with the scenarios each was needed for:')
  for (const [name, r] of rules) {
    lines.push(`  [${name}] ${r.text}`)
    lines.push(`      ${r.scenarios.size} scenarios: ${[...r.scenarios.keys()].join(' ')}`)
    for (const [s, details] of [...r.scenarios].slice(0, 12)) if (details.length) lines.push(`        ${s}: ${details.slice(0, 3).join('; ').slice(0, 300)}`)
  }
  lines.push('', 'left out, by scenario and reason (releases as ranges of the swept releases):')
  const byScenario = new Map()
  for (const [key, releases] of leftOut) {
    const [scenario, why] = key.split('\t')
    if (!byScenario.has(scenario)) byScenario.set(scenario, [])
    byScenario.get(scenario).push(`${why}: ${releases.length === master.length ? 'every release' : ranges(releases).join(', ')}`)
  }
  for (const [s, whys] of [...byScenario].sort()) for (const w of whys) lines.push(`  ${s}  ${w}`)
  if (sourceDisagrees.size) lines.push('', 'messages whose code the release\'s bundle and a code printed elsewhere give otherwise (the bundle\'s is taken):', ...[...sourceDisagrees].map(x => `  ${x}`))
  if (reuseBroken.length) lines.push('', `cells whose real cross phase ended otherwise than their edit phase (${reuseBroken.length}):`, ...reuseBroken.map(x => `  ${x}`))
  const kinds = {}
  for (const k of added.values()) kinds[k] = (kinds[k] || 0) + 1
  lines.push('', 'added to http/ and http-url/:', ...Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`))
  lines.push('', 'outcomes other releases write:', ...report.map(l => `  ${l}`))
  if (review.length) lines.push('', 'to review:', ...[...new Set(review)].map(l => `  ${l}`))
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true })
    fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  }
  if (CREATED_LIST && !DRY) fs.writeFileSync(CREATED_LIST, created.sort().join('\n') + (created.length ? '\n' : ''))
  console.log(lines.slice(0, 3).join('\n'))
  console.log(`${new Set(review).size} to review${REPORT ? ` -> ${REPORT}` : ''}`)
}

// the messages pnpm printed with a code anywhere in the sweep, before any phase is classified
for (const r of master) {
  for (const s of fs.readdirSync(path.join(SWEEP, r))) {
    const d = path.join(SWEEP, r, s)
    if (!isDir(d)) continue
    for (const f of fs.readdirSync(d).filter(f => /\.log$/.test(f) && !/^(git-|requests)/.test(f))) {
      const text = fs.readFileSync(path.join(d, f), 'utf8')
      if (text.includes('ERR_PNPM_')) learnFromLog(text, `pnpm ${r} in ${s} (${f.replace(/\.log$/, '')})`)
    }
  }
}
// the messages each release printed without a code in an edit it failed, looked up in its own bundle
{
  const lookups = new Map()
  for (const s of scenarios) {
    for (const r of master) {
      const m = loadMerged(r, s)
      if (!m.cell) continue
      for (const ph of ['after', 'cross']) {
        const e = m.cell.r.exits[ph]
        if (e === undefined || e === 0 || String(m.cell.sig[ph]).startsWith('hands over')) continue
        const errors = m.cell.r.errors[ph] || []
        if (errors.some(x => /^ERR_/.test(x))) continue
        const message = (errors.find(x => x.startsWith('ERROR: ')) || '').slice('ERROR: '.length)
        if (!message) continue
        if (!lookups.has(r)) lookups.set(r, new Set())
        lookups.get(r).add(message)
      }
    }
  }
  for (const [r, messages] of lookups) for (const [m, found] of codesOf(PM, r, [...messages])) sourceCodes.set(`${r}\u0000${m}`, found)
}
main()

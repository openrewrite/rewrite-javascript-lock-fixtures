// Reads the Yarn classic sweep and finds where along the release line each scenario's outcome changes.
//   <out>/_report/summary.txt       per release and phase, among the scenarios whose phase the control reproduces:
//                                   same as the baseline (1.22.22) / the lock differs only in a header line naming
//                                   the release / only in integrity lines / in entries otherwise / another outcome
//   <out>/_report/boundaries.txt    each pair of consecutive swept releases whose outcomes differ, nearest the
//                                   baseline first, the scenarios grouped by what changed in the lock's own terms
//   <out>/_report/boundaries-detail.txt   the same with every concrete change (pattern, field, old and new value)
//   <out>/_report/health.txt        every cell checked: harness errors, timeouts, another yarn, unserved requests,
//                                   answers beyond the recording, the Node and the child processes per release
//   <out>/_report/summary.json, boundaries.json   the same for tooling
// Phases: before, after, second (the recorder's second installs over `after`: frozen, fixpoint, again), cross (the
// edit over the fixture's own `before`), crossSecond (the second installs over `cross`). A phase counts for a scenario
// where the control (the baseline's own run, compared with the fixture by sweep-yarn-classic.js) reproduces it.
// Usage: node sweep-matrix-yarn-classic.js <sweep out dir> [--baseline 1.22.22] [--control 1.22.22]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const lock = require('./yarn-classic-lock.js')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '1.22.22')
const CONTROL = arg('control', BASE)
const PHASES = ['before', 'after', 'second', 'cross', 'crossSecond']
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)

const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const all = fs.readdirSync(path.join(path.dirname(out), '..', 'pm', 'yarn-classic')).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const cells = {}
const scenarioSet = new Set()
for (const r of releases) {
  cells[r] = {}
  for (const name of fs.readdirSync(path.join(out, r))) {
    const rj = path.join(out, r, name, 'result.json')
    if (!fs.existsSync(rj)) continue
    const res = JSON.parse(fs.readFileSync(rj, 'utf8'))
    // the name yarn gives its workspace aggregator is random per run (cells swept before the sweep normalized it), and
    // a message naming the running release ("the current global version of Yarn is 1.22.21") names each release
    for (const k of Object.keys(res.fail || {})) {
      res.fail[k] = res.fail[k] == null ? '(no error line)' : res.fail[k]
        .replace(/workspace-aggregator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'workspace-aggregator-<uuid>')
        .replace(new RegExp(`(current global version of Yarn is )${r.replace(/\./g, '\\.')}(?!\\d|\\.\\d)`, 'g'), '$1<release>')
    }
    const file = f => read(path.join(out, r, name, f))
    res.file = file
    cells[r][name] = res
    scenarioSet.add(name)
  }
}
const scenarios = [...scenarioSet].sort()

// ---- what each phase of a cell came to ----------------------------------------------------------------------------
// the lock a second install wrote (fixpoint or again) over `after` or `cross`: a `cross` that wrote the lock `after`
// wrote shares its second installs (from: 'after'), whose locks are kept under the after- names
const secondLock = (res, which, kind) => {
  const s = (res.second || {})[which]
  return res.file(`${which === 'after' || (s && s.from === 'after') ? 'after-' : 'cross-'}${kind}`)
}
const secondOf = (res, which) => {
  const s = (res.second || {})[which]
  if (!s) return null
  return {
    // the second installs over `cross` ran over the cross lock, shared or not
    over: which === 'cross' ? 'cross' : s.over,
    frozen: s.frozen,
    fixpoint: s.fixpoint,
    fixpointLock: sha(secondLock(res, which, 'fixpoint')),
    again: s.again,
    againExit: s.againExit,
    againLock: sha(secondLock(res, which, 'again')),
  }
}
const outcome = (res, phase) => {
  if (!res || res.skip) return null
  if (phase === 'second' || phase === 'crossSecond') {
    const s = secondOf(res, phase === 'second' ? 'after' : 'cross')
    return s ? JSON.stringify(s) : res.exits[phase === 'second' ? 'after' : 'cross'] === undefined ? null : 'none'
  }
  if (res.exits[phase] === undefined) return null
  const extra = phase === 'after' ? `|member:${sha(res.file('after-member-lock'))}|repo:${sha(res.file('after-repo-lock'))}` : ''
  return `${res.exits[phase]}:${sha(res.file(phase))}${res.exits[phase] !== 0 ? `:${(res.fail || {})[phase]}` : ''}${extra}`
}

// ---- which phases count: the control reproduces them ----------------------------------------------------------------
const control = cells[CONTROL] || {}
const counts = {}
for (const name of scenarios) {
  const c = control[name]
  const ok = {}
  if (c && !c.skip && !c.error && !c.inconclusive) {
    const s = c.same
    ok.before = c.exits.before !== undefined && (s.before === true || (s.before === undefined && s['before:exit'] === true))
    ok.after = (s.after === true || s['after:failure'] === true) && s['after:exit'] !== false && s.memberLock !== false && s.repoLock !== false
    const recordedSecond = ['frozen', 'fixpoint', 'again', 'again:lock'].filter(k => s[k] !== undefined)
    ok.second = ok.after && outcome(c, 'second') != null && recordedSecond.every(k => s[k] === true) && (recordedSecond.length > 0 || c.recorder === 'unrecorded')
    ok.cross = s.cross === true || s['cross:failure'] === true
    ok.crossSecond = ok.cross && outcome(c, 'crossSecond') != null
  }
  counts[name] = ok
}
const counted = phase => scenarios.filter(n => counts[n][phase])

// ---- how two outcomes of one phase differ ---------------------------------------------------------------------------
const lockFile = { before: 'before', after: 'after', cross: 'cross' }
const describe = (ra, rb, phase) => {
  if (phase === 'second' || phase === 'crossSecond') {
    const [x, y] = [secondOf(ra, phase === 'second' ? 'after' : 'cross'), secondOf(rb, phase === 'second' ? 'after' : 'cross')]
    if (!x || !y) return { kinds: [`${x ? 'second install no longer run' : 'second install now run'} (the install before it ${x ? 'failed' : 'wrote a lock'})`], detail: [] }
    const kinds = []
    const detail = []
    // a second install that runs over another lock (the edit now fails or now writes) is described by what it did
    // where both ran; the recorder's frozen and fixpoint phases run only over a lock the edit wrote
    if (x.over !== y.over) kinds.push(`over ${x.over} -> ${y.over}`)
    const both = k => x[k] !== undefined && y[k] !== undefined
    if (both('frozen') && x.frozen !== y.frozen) kinds.push(`--frozen-lockfile exit ${x.frozen} -> ${y.frozen}`)
    if (both('fixpoint') && x.fixpoint !== y.fixpoint) kinds.push(`fixpoint ${x.fixpoint} -> ${y.fixpoint}`)
    else if (both('fixpoint') && x.fixpointLock !== y.fixpointLock) {
      const which = phase === 'second' ? 'after' : 'cross'
      const d = lock.diff(secondLock(ra, which, 'fixpoint'), secondLock(rb, which, 'fixpoint'))
      kinds.push(`fixpoint lock: ${d.kinds.join(', ')}`)
      detail.push(...d.detail.map(l => `fixpoint ${l}`))
    }
    if (both('again') && (x.again !== y.again || x.againExit !== y.againExit)) kinds.push(`again ${x.again} (exit ${x.againExit}) -> ${y.again} (exit ${y.againExit})`)
    else if (both('again') && x.againLock !== y.againLock) {
      const which = phase === 'second' ? 'after' : 'cross'
      const d = lock.diff(secondLock(ra, which, 'again'), secondLock(rb, which, 'again'))
      kinds.push(`again lock: ${d.kinds.join(', ')}`)
      detail.push(...d.detail.map(l => `again ${l}`))
    }
    return { kinds: kinds.length ? kinds : ['the same outcome, the locks written over it differ'], detail }
  }
  const [ea, eb] = [ra.exits[phase], rb.exits[phase]]
  if (ea !== eb) {
    const why = r => r.exits[phase] === 0 ? 'writes' : `fails: ${(r.fail || {})[phase] || '?'}`
    return { kinds: [`exit ${ea} -> ${eb}`], detail: [`${why(ra)} -> ${why(rb)}`] }
  }
  if (ea !== 0) {
    const [fa, fb] = [(ra.fail || {})[phase], (rb.fail || {})[phase]]
    if (fa !== fb) return { kinds: ['fails otherwise'], detail: [`fails: ${fa} -> fails: ${fb}`] }
  }
  const d = lock.diff(ra.file(lockFile[phase]), rb.file(lockFile[phase]))
  const kinds = [...d.kinds]
  const detail = [...d.detail]
  if (phase === 'after') {
    for (const [f, what] of [['after-member-lock', 'member lock'], ['after-repo-lock', 'workspace root lock']]) {
      const [x, y] = [ra.file(f), rb.file(f)]
      if (x !== y) {
        const md = lock.diff(x, y)
        kinds.push(`${what}: ${md.kinds.join(', ')}`)
        detail.push(...md.detail.map(l => `${what} ${l}`))
      }
    }
  }
  return { kinds: kinds.length ? kinds : ['formatting only'], detail }
}
// the kind of a difference from the baseline, for the summary
const categoryOf = (rec, base, phase) => {
  const [o, b] = [outcome(rec, phase), outcome(base, phase)]
  if (o === b) return 'same'
  if (o == null || b == null) return 'out'
  if (phase === 'second' || phase === 'crossSecond') {
    const [x, y] = [JSON.parse(o === 'none' ? 'null' : o), JSON.parse(b === 'none' ? 'null' : b)]
    if (!x || !y) return 'out'
    const shape = s => JSON.stringify([s.over, s.frozen, s.fixpoint, s.again, s.againExit])
    return shape(x) === shape(y) ? 'entr' : 'out'
  }
  if (rec.exits[phase] !== base.exits[phase]) return 'out'
  // the same failure (exit code) with another message
  if (rec.exits[phase] !== 0) return 'msg'
  const d = describe(base, rec, phase)
  if (d.kinds.every(k => /^header: .* names another version$/.test(k))) return 'hdr'
  if (d.kinds.every(k => /^integrity |^header: .* names another version$/.test(k))) return 'intg'
  return 'entr'
}

// ---- summary ------------------------------------------------------------------------------------------------------
const report = path.join(out, '_report')
fs.mkdirSync(report, { recursive: true })
const COLS = ['same', 'hdr', 'intg', 'entr', 'msg', 'out', '?']
const summary = {}
const lines = [
  `baseline yarn ${BASE} (control: the ${CONTROL} run compared with every fixture); ${scenarios.length} scenarios; ${releases.length} of ${all.length} releases swept`,
  `phases the control reproduces: ${PHASES.map(p => `${p} ${counted(p).length}`).join(', ')}`,
  'per phase, among those scenarios, against the baseline: same = its bytes (or its failure) / hdr = the lock differs only in a header',
  'line naming the release (yarn-enable-lockfile-versions) / intg = only in integrity lines (and such a header line) / entr = entries',
  'differ otherwise (for second installs: the same outcomes, other locks written) / msg = the same exit code, another failure message',
  '/ out = another exit code or second-install outcome / ? = the cell is missing. second = the recorder\'s second installs over',
  '`after`; crossSecond = over `cross`.',
  '',
  'release  node      cells ' + PHASES.map(p => `| ${p.padEnd(11)}: ${COLS.map(c => c.padStart(4)).join(' ')} `).join(''),
]
for (const r of releases) {
  const row = {}
  const nodes = new Set(Object.values(cells[r]).map(c => c.node).filter(Boolean))
  for (const p of PHASES) {
    row[p] = Object.fromEntries(COLS.map(c => [c, 0]))
    for (const s of counted(p)) {
      const rec = cells[r][s]
      if (!rec || rec.skip) {
        row[p]['?']++
        continue
      }
      row[p][categoryOf(rec, control[s], p)]++
    }
  }
  summary[r] = { node: [...nodes], cells: Object.keys(cells[r]).length, phases: row }
  lines.push(`${r.padEnd(8)} ${[...nodes].join(',').padEnd(9)} ${String(Object.keys(cells[r]).length).padStart(5)} ` +
    PHASES.map(p => `| ${''.padEnd(11)}  ${COLS.map(c => String(row[p][c]).padStart(4)).join(' ')} `).join(''))
}
const notSwept = all.filter(v => !releases.includes(v))
if (notSwept.length) lines.push('', `not swept: ${notSwept.join(' ')}`)
fs.writeFileSync(path.join(report, 'summary.txt'), lines.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'summary.json'), JSON.stringify({ baseline: BASE, counted: Object.fromEntries(PHASES.map(p => [p, counted(p)])), releases: summary }, null, 1) + '\n')

// ---- boundaries ---------------------------------------------------------------------------------------------------
const boundaries = []
for (let i = 1; i < releases.length; i++) {
  const [a, b] = [releases[i - 1], releases[i]]
  const between = all.filter(v => cmp(v, a) > 0 && cmp(v, b) < 0)
  const byScenario = {}
  for (const s of scenarios) {
    const [ra, rb] = [cells[a][s], cells[b][s]]
    if (!ra || !rb || ra.skip || rb.skip) continue
    const what = []
    const detail = []
    for (const p of PHASES) {
      if (!counts[s][p]) continue
      if (outcome(ra, p) === outcome(rb, p)) continue
      const d = describe(ra, rb, p)
      what.push(`${p}: ${d.kinds.join(', ')}`)
      detail.push(...d.detail.map(l => `${p} ${l}`))
    }
    if (what.length) byScenario[s] = { what: what.join(' || '), detail }
  }
  const groups = {}
  for (const [s, { what }] of Object.entries(byScenario)) (groups[what] = groups[what] || []).push(s)
  const list = Object.entries(groups).map(([what, ss]) => ({ what, scenarios: ss.sort() })).sort((x, y) => y.scenarios.length - x.scenarios.length || x.what.localeCompare(y.what))
  if (list.length) boundaries.push({ from: a, to: b, between, groups: list, detail: Object.fromEntries(Object.entries(byScenario).map(([s, v]) => [s, v.detail])) })
}
// nearest the baseline first
const distance = bd => Math.abs(releases.indexOf(bd.to) - releases.indexOf(BASE))
boundaries.sort((x, y) => distance(x) - distance(y) || cmp(y.to, x.to))
fs.writeFileSync(path.join(report, 'boundaries.json'), JSON.stringify(boundaries, null, 1) + '\n')
const wrap = (items, indent) => {
  const rows = []
  let row = ''
  for (const it of items) {
    if (row && (row + ', ' + it).length > 112) {
      rows.push(indent + row + ',')
      row = it
    } else row = row ? `${row}, ${it}` : it
  }
  if (row) rows.push(indent + row)
  return rows
}
const headerOnly = g => /^((after|before|cross): header: [^|]* names another version( \|\| )?)+$/.test(g.what)
// the upstream files the port names that changed between two releases (inventory/yarn-classic-source.txt's data)
const inventoryFile = path.join(path.dirname(out), '..', 'pm', 'yarn-classic', 'source-inventory.json')
const inventory = fs.existsSync(inventoryFile) ? JSON.parse(fs.readFileSync(inventoryFile, 'utf8')) : null
const upstreamChanges = (a, b) => {
  if (!inventory) return null
  const files = new Map()
  const libs = []
  for (const p of inventory.pairs.filter(p => cmp(p.from, a) >= 0 && cmp(p.to, b) <= 0)) {
    for (const f of p.files) {
      const prior = files.get(f.file) || { plus: 0, minus: 0 }
      files.set(f.file, { plus: prior.plus + f.plus, minus: prior.minus + f.minus })
    }
    libs.push(...p.libs)
  }
  return { files: [...files].map(([f, n]) => `${f} (+${n.plus} -${n.minus})`), libs }
}
const text = [`boundaries between consecutive swept releases, nearest ${BASE} first; ${releases.length} releases swept, ${boundaries.length} boundaries`,
  'A phase is compared only for the scenarios whose phase the control reproduces. "header: ... names another version" is the',
  '`# yarn v<release>` line yarn-enable-lockfile-versions writes: it changes at every release and is listed apart.', '']
const detailText = []
for (const bd of boundaries) {
  const real = bd.groups.filter(g => !headerOnly(g))
  const total = new Set(real.flatMap(g => g.scenarios)).size
  text.push(`=== ${bd.from} -> ${bd.to}${bd.between.length ? ` (not swept between: ${bd.between.join(' ')})` : ''}: ${total} scenarios change${bd.groups.length !== real.length ? ` (and ${new Set(bd.groups.filter(headerOnly).flatMap(g => g.scenarios)).size} only in the header naming the release)` : ''}`)
  for (const g of real) {
    text.push(`  [${g.scenarios.length}] ${g.what}`)
    // an outcome that changed: each scenario with what it did before and after the boundary
    if (/exit -?\w+ -> |fails otherwise/.test(g.what) && g.scenarios.length <= 20) {
      for (const s of g.scenarios) {
        const lines = bd.detail[s].filter(l => /^(before|after|cross) /.test(l) && / -> /.test(l) && /fails|writes/.test(l))
        text.push(`        ${s}`)
        for (const l of lines.slice(0, 3)) text.push(`          ${l.length > 220 ? l.slice(0, 220) + '...' : l}`)
      }
    } else {
      text.push(...wrap(g.scenarios, '        '))
    }
  }
  for (const g of bd.groups.filter(headerOnly)) text.push(`  [${g.scenarios.length}] (header only) ${g.scenarios.join(', ')}`)
  const up = upstreamChanges(bd.from, bd.to)
  if (up && real.length) {
    text.push(`  upstream files the port names that changed ${bd.from} -> ${bd.to}: ${up.files.length ? '' : 'none'}`)
    text.push(...wrap(up.files, '        '))
    if (up.libs.length) text.push(`  bundled libraries: ${up.libs.join('; ')}`)
  }
  text.push('')
  detailText.push(`=== ${bd.from} -> ${bd.to}`)
  for (const g of real) {
    detailText.push(`  [${g.scenarios.length}] ${g.what}`)
    for (const s of g.scenarios) {
      detailText.push(`    ${s}`)
      for (const l of bd.detail[s].slice(0, 40)) detailText.push(`      ${l}`)
      if (bd.detail[s].length > 40) detailText.push(`      ... ${bd.detail[s].length - 40} more`)
    }
  }
  detailText.push('')
}
fs.writeFileSync(path.join(report, 'boundaries.txt'), text.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'boundaries-detail.txt'), detailText.join('\n') + '\n')

// ---- health -------------------------------------------------------------------------------------------------------
const health = [`every cell of ${releases.length} releases x ${scenarios.length} scenarios`, '', 'release  node      cells  skip  error  timeout  otherYarn  unserved  overlay  spawned']
const spawnedBy = {}
for (const r of releases) {
  const cs = Object.values(cells[r])
  const n = f => cs.filter(f).length
  for (const c of cs) for (const sp of c.spawned || []) {
    const k = sp.replace(/^[\w-]+: /, '').replace(/\S*\/pm\/node\/[^/]+\/bin\/node/, '<node>').replace(/\/private<work>/g, '<work>')
    ;(spawnedBy[k] = spawnedBy[k] || new Set()).add(c.scenario)
  }
  health.push(`${r.padEnd(8)} ${[...new Set(cs.map(c => c.node))].join(',').padEnd(9)} ${String(cs.length).padStart(5)} ${String(n(c => c.skip)).padStart(5)} ${String(n(c => c.error)).padStart(6)} ${String(n(c => c.inconclusive)).padStart(8)} ` +
    `${String(n(c => c.otherYarn)).padStart(10)} ${String(n(c => (c.unserved || []).length)).padStart(9)} ${String(n(c => (c.overlay || []).length)).padStart(8)} ${String(n(c => (c.spawned || []).length)).padStart(8)}`)
}
// what the stub answered beyond what the recordings kept, by kind, over every release
const overlayKinds = {}
for (const r of releases) for (const c of Object.values(cells[r])) for (const o of c.overlay || []) {
  const kind = o.replace(/^[^:]+:[^:]+: /, '').replace(/cut at \S+/, 'cut at the recording\'s time').replace(/\d+ later versions dropped/, 'N later versions dropped')
    .replace(/^(\S+?)\/\S*: fetched once/, '$1/...: fetched once').replace(/; not on the registry today: .*\)/, ')')
  const k = `${kind}`
  overlayKinds[k] = overlayKinds[k] || { scenarios: new Set(), releases: new Set() }
  overlayKinds[k].scenarios.add(c.scenario)
  overlayKinds[k].releases.add(r)
}
health.push('', 'answers beyond the recordings (result.json overlay), by kind: the scenarios, and in how many releases:')
for (const [k, v] of Object.entries(overlayKinds).sort((a, b) => b[1].scenarios.size - a[1].scenarios.size)) {
  health.push(`  ${k}: ${v.scenarios.size} scenarios, ${v.releases.size} releases`)
  health.push(...wrap([...v.scenarios].sort(), '      '))
}
health.push('', 'child processes the releases started (any release), with their scenarios:')
for (const [k, v] of Object.entries(spawnedBy)) health.push(`  ${k}\n      ${[...v].sort().join(', ')}`)
const problems = []
for (const r of releases) for (const c of Object.values(cells[r])) {
  if (c.error) problems.push(`  ${r} ${c.scenario}: error ${c.error.split('\n')[0]}`)
  if (c.inconclusive) problems.push(`  ${r} ${c.scenario}: ${c.inconclusive}`)
  if (c.otherYarn) problems.push(`  ${r} ${c.scenario}: another yarn: ${c.otherYarn.join('; ')}`)
  if ((c.unserved || []).length) problems.push(`  ${r} ${c.scenario}: unserved ${c.unserved.join('; ')}`)
}
health.push('', `cells with a harness error, a timeout, another yarn or an unserved request: ${problems.length}`, ...problems.slice(0, 400))
fs.writeFileSync(path.join(report, 'health.txt'), health.join('\n') + '\n')
console.log(`${releases.length} releases, ${scenarios.length} scenarios (${PHASES.map(p => `${p} ${counted(p).length}`).join(', ')}), ${boundaries.length} boundaries -> ${report}`)

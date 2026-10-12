// Reads a pnpm sweep (sweep-pnpm.js) and finds where along the release line each scenario's outcome changes.
//   <out>/_report/summary.txt     per release: how many scenarios do what the baseline does, phase by phase
//   <out>/_report/boundaries.txt  each pair of consecutive releases whose outcomes differ, the scenarios grouped by
//                                 what changed, in the lock's own terms (pnpm-lock-diff.js): documents, top-level
//                                 keys, importers, packages and snapshots entries, peer suffixes, fields
//   <out>/_report/boundaries.json the same with every scenario's detail, for further tooling
//   <out>/_report/scenarios.txt   per scenario: the runs of consecutive releases with one outcome
// An outcome of a phase is its exit code, its error codes, the lock it wrote, the other locks of the project, and
// the files pnpm rewrote beside the lock (pnpm-workspace.yaml, package.json, .npmrc). A phase in which the release
// asked for another pnpm's tarball (which the sweep refuses) is "hands over to <release>".
// Only scenarios the baseline release reproduces from the fixture count (the harness is faithful for those), less
// the ones listed as unstable (their outcome varies between runs of one release).
// Usage: node sweep-matrix-pnpm.js <sweep out dir> [--baseline 11.2.2] [--unstable <file>] [--min 11.0.0] [--max 11.99.99]
//          [--report <dir name under out, default _report>]
const fs = require('fs')
const path = require('path')
const { diff } = require('./pnpm-lock-diff.js')
const { PHASES, statusOf, phaseOf, lockText, loadCell, reproduces, tree, read } = require('./pnpm-cell.js')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '11.2.2')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const MIN = arg('min', '0.0.0')
const MAX = arg('max', '999.0.0')
// --unstable <file>: a line `<scenario>` leaves the scenario out (its outcome varies between runs of one release);
// a line `<scenario> errors <from>..<to>` keeps it but, in those releases, does not compare the error it prints
// (the text varies between runs of one release, measured), only its exits, locks and files
const unstableLines = arg('unstable') && fs.existsSync(arg('unstable'))
  ? fs.readFileSync(arg('unstable'), 'utf8').split('\n').map(l => l.trim().split(/\s+/)).filter(f => f[0] && !f[0].startsWith('#')) : []
const unstable = new Set(unstableLines.filter(f => f.length === 1).map(f => f[0]))
const errorsVary = unstableLines.filter(f => f[1] === 'errors' && /^\d+\.\d+\.\d+\.\.\d+\.\d+\.\d+$/.test(f[2]))
  .map(f => ({ scenario: f[0], from: f[2].split('..')[0], to: f[2].split('..')[1] }))
const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v) && cmp(v, MIN) >= 0 && cmp(v, MAX) <= 0).sort(cmp)
const scenarios = new Set()
const cell = {}
// the baseline is read even when the range leaves it out: it says which scenarios count
for (const release of releases.includes(BASE) || !fs.existsSync(path.join(out, BASE)) ? releases : [...releases, BASE]) {
  cell[release] = {}
  for (const e of fs.readdirSync(path.join(out, release), { withFileTypes: true })) {
    const rec = e.isDirectory() ? loadCell(path.join(out, release, e.name)) : null
    if (!rec) continue
    cell[release][e.name] = rec
    scenarios.add(e.name)
  }
}
if (!cell[BASE]) throw new Error(`no baseline ${BASE} in ${out}`)
// the error of a phase whose text varies between runs is one outcome in the releases where it does
const VARIES = 'the error varies between runs: unstable.txt'
for (const v of errorsVary) {
  for (const release of Object.keys(cell).filter(r => cmp(r, v.from) >= 0 && cmp(r, v.to) <= 0)) {
    const rec = cell[release][v.scenario]
    if (!rec || rec.r.skip) continue
    for (const ph of PHASES) {
      if (rec.sig[ph] === undefined || String(rec.sig[ph]).startsWith('hands over') || !((rec.r.errors || {})[phaseOf(rec, ph)] || []).length) continue
      rec.sig[ph] = `${rec.wrote[ph]}|${VARIES}`
      rec.r.errors[phaseOf(rec, ph)] = [VARIES]
    }
  }
}

// --only-file: the scenarios of a targeted sweep (the ones that differ among anchor releases, pnpm-differing.js)
const onlyFile = arg('only-file')
const onlyNames = onlyFile ? new Set(fs.readFileSync(onlyFile, 'utf8').split('\n').map(l => l.split(/\s+/)[0]).filter(l => l && !l.startsWith('#'))) : null

// the harness is faithful where the baseline writes the fixture's locks and fails as the recording did
// --valid recorded: for a scenario directory recorded with several releases, a scenario counts when the release
// its own recorded-with names reproduces it (pnpm-control-recorded.js), not when the baseline does
const recorderOf = s => {
  for (const r of Object.keys(cell)) if (cell[r][s] && cell[r][s].r.recordedBy) return cell[r][s].r.recordedBy
  return null
}
const controlOf = s => arg('valid') === 'recorded' ? (cell[recorderOf(s)] || {})[s] : cell[BASE][s]
const counted = [...scenarios].filter(s => reproduces(controlOf(s)) && !unstable.has(s)).sort()
const valid = counted.filter(s => !onlyNames || onlyNames.has(s))
const complete = releases.filter(r => valid.every(s => cell[r][s]))
const partial = releases.filter(r => !complete.includes(r))

const report = path.join(out, arg('report', '_report'))
fs.mkdirSync(report, { recursive: true })

// ---- summary
const wrote = rec => fs.existsSync(path.join(rec.dir, 'after')) || fs.existsSync(path.join(rec.dir, 'cross'))
const head = [
  `baseline pnpm ${BASE}; ${counted.length} of ${scenarios.size} scenarios count: ${arg('valid') === 'recorded' ? 'the release that recorded each reproduces its fixture' : 'the baseline reproduces their fixture'}${unstable.size ? ` and they are not among the ${unstable.size} listed as unstable` : ''}`,
  ...errorsVary.map(v => `${v.scenario}: in ${v.from}..${v.to} the error it prints varies between runs; there it is "${VARIES}"`),
  ...(onlyNames ? [`this report covers the ${valid.length} of them named in ${path.basename(onlyFile)} (a targeted sweep)`] : []),
  `${complete.length} releases swept over all of them${partial.length ? `; incomplete and left out of the boundaries: ${partial.join(' ')}` : ''}`,
  '',
  'identical      every phase has the baseline\'s outcome (exit, errors, lock, other locks, files pnpm rewrote)',
  'writes-same    every phase exits as the baseline\'s and writes its locks and files, whatever the error it prints',
  '               (releases word and code the same failure differently)',
  '=fixture       the release writes the fixture\'s own locks and fails as the recording did (what the control checks)',
  'same-<phase>   that phase has the baseline\'s outcome',
  'fails-new      the baseline writes a lock in the edit, the release does not;  writes-new: the reverse',
  'hands-over     the release asked for another pnpm\'s tarball in some phase (refused)',
  'added          cells where the registry answered beyond the recording with today\'s documents (overlay or live)',
  '',
  'release     node       ran  identical writes-same =fixture ' + PHASES.map(p => `same-${p}`.padEnd(17)).join('') + 'fails-new writes-new hands-over added',
]
const lines = [...head]
// summary-compact.txt: consecutive releases whose rows are the same, as one row
const compact = []
let previous = null
for (const r of releases) {
  const row = { ran: 0, identical: 0, writes: 0, fixture: 0, failsNew: 0, writesNew: 0, over: 0, added: 0 }
  for (const p of PHASES) row[p] = 0
  let node = ''
  for (const s of valid) {
    const rec = cell[r][s]
    const base = cell[BASE][s]
    if (!rec) continue
    row.ran++
    node = rec.r.node || node
    let all = true
    for (const p of PHASES) {
      if (rec.sig[p] === base.sig[p]) row[p]++
      else all = false
    }
    if (all) row.identical++
    if (PHASES.every(p => rec.wrote[p] === base.wrote[p])) row.writes++
    if (reproduces(rec)) row.fixture++
    if (wrote(base) && !wrote(rec)) row.failsNew++
    if (!wrote(base) && wrote(rec)) row.writesNew++
    if (rec.over || Object.values(rec.sig).some(x => String(x).startsWith('hands over'))) row.over++
    if ((rec.r.overlay || []).length || (rec.r.live || []).length) row.added++
  }
  const rest = `${String(node).replace(/^native.*/, 'native').padEnd(9)} ${String(row.ran).padStart(4)}  ${String(row.identical).padEnd(9)} ${String(row.writes).padEnd(11)} ${String(row.fixture).padEnd(8)} ${PHASES.map(p => String(row[p]).padEnd(17)).join('')}${String(row.failsNew).padEnd(10)}${String(row.writesNew).padEnd(11)}${String(row.over).padEnd(11)}${row.added}${partial.includes(r) ? '  (incomplete)' : ''}`
  lines.push(`${r.padEnd(10)} ${rest}`)
  // the identities of the cells, not only their counts, decide whether two releases share a row
  const key = `${rest}|${valid.map(s => cell[r][s] ? PHASES.map(p => cell[r][s].sig[p]).join(';') : '-').join('\n')}`
  if (previous && previous.key === key && previous.major === r.split('.')[0]) previous.to = r
  else compact.push(previous = { key, rest, from: r, to: r, major: r.split('.')[0] })
}
fs.writeFileSync(path.join(report, 'summary-compact.txt'), [...head.slice(0, -1), 'releases           ' + head[head.length - 1].slice('release    '.length),
  ...compact.map(c => `${(c.from === c.to ? c.from : `${c.from}..${c.to}`).padEnd(18)} ${c.rest}`)].join('\n') + '\n')
fs.writeFileSync(path.join(report, 'summary.txt'), lines.join('\n') + '\n')

// ---- what changed in one phase between two cells
const describe = (ra, rb, ph) => {
  const [sa, sb] = [ra.sig[ph], rb.sig[ph]]
  if (String(sa).startsWith('hands over') || String(sb).startsWith('hands over')) {
    const say = (x, rec) => String(x).startsWith('hands over') ? x : rec.r.exits[ph] === undefined ? 'not run' : `runs (exit ${rec.r.exits[ph]})`
    return { general: [`${say(sa, ra)} -> ${say(sb, rb)}`], detail: [] }
  }
  const general = []
  const detail = []
  // a second install whose lock is the after lock's is kept under the again phase
  const [pa, pb] = [phaseOf(ra, ph), phaseOf(rb, ph)]
  const second = ph === 'again' || ph === 'cross-again'
  const [ea, eb] = [ra.r.exits[pa], rb.r.exits[pb]]
  const [xa, xb] = [((ra.r.errors || {})[pa] || []).join(','), ((rb.r.errors || {})[pb] || []).join(',')]
  if (ea !== eb) general.push(`exit ${ea === undefined ? 'not run' : ea}${xa ? ` [${xa}]` : ''} -> ${eb === undefined ? 'not run' : eb}${xb ? ` [${xb}]` : ''}`)
  else if (xa !== xb) general.push(`errors [${xa}] -> [${xb}]`)
  if (second && (statusOf(ra.r, ph) || '-') !== (statusOf(rb.r, ph) || '-')) general.push(`${statusOf(ra.r, ph) || 'not run'} -> ${statusOf(rb.r, ph) || 'not run'}`)
  const [la, lb] = [lockText(ra, ph), lockText(rb, ph)]
  // a second install keeps its lock only when it changed it: one side absent is the status change above
  if (la !== lb && !(second && (la == null || lb == null))) {
    const d = la == null ? { general: ['lock appears'], detail: [] } : lb == null ? { general: ['lock disappears'], detail: [] } : diff(la, lb)
    general.push(...d.general.map(g => `lock: ${g}`))
    detail.push(...d.detail)
  }
  for (const kind of ['changed', 'locks']) {
    const files = new Set([...tree(path.join(ra.dir, kind, pa)), ...tree(path.join(rb.dir, kind, pb))])
    for (const f of files) {
      const [ta, tb] = [read(path.join(ra.dir, kind, pa, f)), read(path.join(rb.dir, kind, pb, f))]
      if (ta === tb) continue
      // the scenario's own lock is described above
      if (kind === 'locks' && (ta === la && tb === lb)) continue
      const label = kind === 'changed' ? `${f} as pnpm rewrites it` : `lock of ${path.dirname(f) === '.' ? 'the root' : 'another project'}`
      if (ta == null || tb == null) {
        general.push(`${label}: ${ta == null ? 'appears' : 'disappears'}`)
        if (kind === 'changed') detail.push(`${f}: ${ta == null ? 'pnpm rewrites it' : 'pnpm leaves it alone'}`)
      } else if (/\.ya?ml$/.test(f)) {
        const d = diff(ta, tb)
        general.push(...d.general.map(g => `${label}: ${g}`))
        detail.push(...d.detail.map(x => `${f}: ${x}`))
      } else {
        general.push(`${label}: differs`)
      }
    }
  }
  if (!general.length) general.push('outcome differs')
  return { general: [...new Set(general)], detail }
}

// ---- boundaries: consecutive releases whose outcome differs for a scenario
// --scenarios <dir>: the scenarios' own directory, read for the pnpm release a root manifest names (packageManager,
// devEngines.packageManager). Such a scenario's outcome under another release is what that release does about the
// name (it hands over, refuses, or goes on), not that release's install: it is reported apart, in pins.txt.
const scenariosDir = arg('scenarios')
const pinOf = s => {
  if (!scenariosDir) return null
  const found = new Set()
  for (const f of ['pkg-before', 'pkg']) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(scenariosDir, s, f), 'utf8'))
      if (typeof m.packageManager === 'string') found.add(`packageManager ${m.packageManager}`)
      const de = m.devEngines && m.devEngines.packageManager
      if (de) found.add(`devEngines.packageManager ${de.name} ${de.version}${de.onFail ? ` onFail ${de.onFail}` : ''}`)
    } catch (e) {
      // a manifest that is absent or no JSON names nothing
    }
  }
  return found.size ? [...found].join(', ') : null
}
const pins = new Map(valid.map(s => [s, pinOf(s)]).filter(([, pin]) => pin))
const unpinned = valid.filter(s => !pins.has(s))

const boundariesOver = names => {
 const boundaries = []
 for (let i = 1; i < complete.length; i++) {
  const [a, b] = [complete[i - 1], complete[i]]
  const groups = new Map()
  for (const s of names) {
    const [ra, rb] = [cell[a][s], cell[b][s]]
    const byWhat = new Map()
    const byDetail = new Map()
    for (const ph of PHASES) {
      if (ra.sig[ph] === rb.sig[ph]) continue
      // a second install that one side did not run follows from its edit failing, which is said under the edit
      if ((ph === 'again' || ph === 'cross-again') && (statusOf(ra.r, ph) == null || statusOf(rb.r, ph) == null) &&
        PHASES.some(p => p !== 'again' && p !== 'cross-again' && ra.sig[p] !== rb.sig[p])) continue
      const d = describe(ra, rb, ph)
      const key = d.general.join('; ')
      byWhat.set(key, [...(byWhat.get(key) || []), ph])
      // phases that change in the same entries are shown once
      const shown = [...d.detail.slice(0, 12), ...(d.detail.length > 12 ? [`... ${d.detail.length - 12} more`] : [])].join('\n')
      if (shown) byDetail.set(shown, [...(byDetail.get(shown) || []), ph])
    }
    if (!byWhat.size) continue
    const details = [...byDetail].flatMap(([shown, phases]) => shown.split('\n').map(x => `${phases.join('+')}: ${x}`))
    const what = [...byWhat].map(([k, phases]) => `${phases.join('+')}: ${k}`).join(' | ')
    if (!groups.has(what)) groups.set(what, { what, scenarios: [], examples: {} })
    groups.get(what).scenarios.push(s)
    groups.get(what).examples[s] = details
  }
  if (groups.size) boundaries.push({ from: a, to: b, groups: [...groups.values()].sort((x, y) => y.scenarios.length - x.scenarios.length) })
 }
 return boundaries
}
const boundaries = boundariesOver(unpinned)
fs.writeFileSync(path.join(report, 'boundaries.json'), JSON.stringify(boundaries, null, 1) + '\n')
const wrap = (words, indent, width = 118) => {
  const rows = []
  let row = ''
  for (const w of words) {
    if (row && (row + ' ' + w).length > width - indent.length) {
      rows.push(indent + row)
      row = w
    } else {
      row = row ? `${row} ${w}` : w
    }
  }
  if (row) rows.push(indent + row)
  return rows
}
const render = (list, head) => {
  const text = [...head]
  for (const bd of list) {
    const total = new Set(bd.groups.flatMap(g => g.scenarios)).size
    text.push('', `=== ${bd.from} -> ${bd.to}: ${total} scenario${total === 1 ? '' : 's'} change`)
    for (const g of bd.groups) {
      text.push(`  [${g.scenarios.length}] ${g.what.split(' | ').join('\n      ')}`)
      text.push(...wrap(g.scenarios, '        '))
      const first = g.scenarios.find(s => g.examples[s].length)
      if (first) {
        text.push(`        e.g. ${first}:`)
        text.push(...g.examples[first].slice(0, 10).map(x => `          ${x}`))
      }
    }
  }
  return text.join('\n') + '\n'
}
fs.writeFileSync(path.join(report, 'boundaries.txt'), render(boundaries, [
  `baseline pnpm ${BASE}; ${unpinned.length} scenarios${pins.size ? ` (${pins.size} more name a pnpm release in their manifest: pins.txt)` : ''}; ${complete.length} releases: ${complete[0]} .. ${complete[complete.length - 1]}`,
  `${boundaries.length} of ${Math.max(complete.length - 1, 0)} pairs of consecutive releases differ in some scenario`]))
if (pins.size) {
  const pinned = boundariesOver([...pins.keys()])
  fs.writeFileSync(path.join(report, 'pins.txt'), render(pinned, [
    `scenarios whose root manifest names a pnpm release, along ${complete.length} releases: what each release does about the name`,
    ...[...pins].map(([s, pin]) => `  ${s}: ${pin}`),
    `${pinned.length} of ${Math.max(complete.length - 1, 0)} pairs of consecutive releases differ in some of them`]))
}

// ---- per scenario: the runs of consecutive releases with one outcome
const runs = []
for (const s of valid) {
  const spans = []
  for (const r of complete) {
    const sig = PHASES.map(p => cell[r][s].sig[p]).join('\n')
    const last = spans[spans.length - 1]
    if (last && last.sig === sig) last.to = r
    else spans.push({ sig, from: r, to: r })
  }
  const baseSig = PHASES.map(p => cell[BASE][s].sig[p]).join('\n')
  runs.push(`${s}: ${spans.map(sp => `${sp.from === sp.to ? sp.from : `${sp.from}..${sp.to}`}${sp.sig === baseSig ? '*' : ''}`).join(' | ')}`)
}
fs.writeFileSync(path.join(report, 'scenarios.txt'), [`runs of consecutive releases with one outcome; * marks the baseline's (${BASE})`, '', ...runs].join('\n') + '\n')
console.log(`${complete.length} complete releases (${partial.length} incomplete), ${valid.length} valid scenarios, ${boundaries.length} boundaries -> ${report}`)

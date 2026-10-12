// Reads a Bun sweep and finds where along the release line each scenario's outcome changes.
//   <out>/_report/summary.txt            per release and phase: how many scenarios do what the baseline release does
//   <out>/_report/boundaries.txt         each pair of consecutive releases whose outcomes differ, nearest the baseline
//                                        first, the scenarios grouped by what changed, in bun.lock's own terms
//   <out>/_report/boundaries-detail.txt  the same boundaries with every concrete change (entry, tuple part, field, values)
//   <out>/_report/boundaries.json        the same, for further tooling
// A scenario counts only where the control counts it (<out>/_report/control.json, bun-control.js): every check the
// fixture allows passes, and its outcome does not vary between runs of the control.
// A change between two cells of a phase is one of
//   header    the locks differ only in lockfileVersion / configVersion
//   text      the same lock written otherwise (key order, layout), besides any header change
//   entries   an entry of the lock appeared, disappeared, or a part of one changed (bun-lock.js)
//   outcome   another exit, another failure (bun's error lines), a lock written or not (bun.lockb instead), or a second
//             install that changes or rejects the lock
// Phases: before, after, again (second install over after), frozen (--frozen-lockfile over after), cold (the edit
// from an empty cache), fresh (pkg from scratch), beforeAgain (second install over before), cross (pkg over the
// fixture's before), crossAgain (second install over cross).
// A cell's phase is undecided where the run hung, the harness failed, or the registry had no answer (absent,
// unserved) for a request the control never made; undecided cells are left out of the counts and listed.
// Usage: node sweep-matrix-bun.js <sweep out dir> [--baseline 1.3.10] [--control <control.json>]
const fs = require('fs')
const path = require('path')
const L = require('./bun-lock.js')
const { PHASES, loadCell, read } = require('./bun-cell.js')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '1.3.10')
// --runs <dir> ...: further passes of the same sweep; a phase whose outcome differs between passes varies (timing),
// and is undecided wherever it varies
const RUNS = []
// --repeat <tally.json> ...: bun-repeat.js's tallies; a phase with more than one outcome there varies too
const REPEATS = []
process.argv.forEach((a, i) => {
  const list = a === '--runs' ? RUNS : a === '--repeat' ? REPEATS : null
  if (list) for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) list.push(path.resolve(process.argv[j]))
})
const report = path.join(out, '_report')
const control = JSON.parse(fs.readFileSync(arg('control', path.join(report, 'control.json')), 'utf8'))
const SECOND = { again: 'after', crossAgain: 'cross', beforeAgain: 'before' }
const CLASSES = ['same', 'header', 'text', 'entries', 'outcome']
const rank = Object.fromEntries(CLASSES.map((c, i) => [c, i]))
const LOGS = { before: 'before', after: 'after', again: 'again', frozen: 'frozen', cold: 'cold', fresh: 'fresh', beforeAgain: 'before-again', cross: 'cross', crossAgain: 'cross-again' }
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

const scenarios = Object.keys(control).filter(s => control[s].count).sort()
const has = (v, s) => fs.existsSync(path.join(out, v, s, 'result.json'))
const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v) && scenarios.some(s => has(v, s))).sort(cmp)
if (!releases.includes(BASE)) throw new Error(`no baseline ${BASE} in ${out}`)
const cells = {}
// release -> scenario -> phase -> how many outcomes the passes saw
const varies = {}
for (const rel of releases) {
  cells[rel] = {}
  varies[rel] = {}
  for (const s of scenarios) {
    cells[rel][s] = has(rel, s) ? loadCell(path.join(out, rel, s)) : null
    const c = cells[rel][s]
    if (!c || c.skip) continue
    for (const run of RUNS) {
      if (!fs.existsSync(path.join(run, rel, s, 'result.json'))) continue
      const o = loadCell(path.join(run, rel, s))
      if (!o || o.skip || o.r.error) continue
      for (const ph of PHASES) {
        const hungHere = p => (p.r.hung || {})[LOGS[ph]]
        if (hungHere(c) || hungHere(o)) continue
        if (o.phase[ph].sig !== c.phase[ph].sig) {
          varies[rel][s] = varies[rel][s] || {}
          varies[rel][s][ph] = new Set([...(varies[rel][s][ph] || []), c.phase[ph].sig, o.phase[ph].sig])
        }
      }
    }
  }
}

// scenario -> phase -> the releases where it varied, between passes or in bun-repeat.js's tallies
const timing = {}
const noteTiming = (s, ph, rel) => {
  timing[s] = timing[s] || {}
  timing[s][ph] = [...new Set([...(timing[s][ph] || []), rel])].sort(cmp)
}
for (const rel of releases) for (const [s, phs] of Object.entries(varies[rel])) for (const ph of Object.keys(phs)) noteTiming(s, ph, rel)
for (const file of REPEATS) {
  const tally = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const [key, phases] of Object.entries(tally)) {
    const [rel, s] = key.split('/')
    for (const [ph, outcomes] of Object.entries(phases)) if (Object.keys(outcomes).length > 1) noteTiming(s, ph, rel)
  }
}

// the registry's answers of each phase that are no answer (requests.log: `GET <url> <kind> <how>` under `# <phase>`)
const noAnswers = c => {
  if (!c || c.noAnswers) return c ? c.noAnswers : {}
  const by = {}
  let phase = null
  for (const line of String(read(path.join(c.dir, 'requests.log')) || '').split('\n')) {
    const h = line.match(/^# (\S+)/)
    if (h) {
      phase = h[1]
      continue
    }
    const m = line.match(/^(?:GET|HEAD) (\S+) \S+ (absent|unserved|stub-error|live-url-absent|fixed-url-absent)/)
    if (m && phase) (by[phase] = by[phase] || new Set()).add(m[1])
  }
  c.noAnswers = by
  return by
}
// the phases a phase builds on: a phase over the project an earlier phase left, or over the lock it wrote
const BUILDS_ON = { after: ['before'], again: ['before', 'after'], frozen: ['before', 'after'], cold: ['before'], beforeAgain: ['before'], crossAgain: ['cross'] }
const undecided = (rel, s, ph) => {
  const c = cells[rel][s]
  if (!c) return 'not swept'
  if (c.skip) return c.skip
  if (c.r.error) return `harness error: ${c.r.error.split('\n')[0]}`
  const log = LOGS[ph]
  if (c.r.hung && c.r.hung[log]) return `hung: ${c.r.hung[log].replace(/ \(cpu .*\)$/, '')}`
  for (const earlier of BUILDS_ON[ph] || []) {
    if (c.r.hung && c.r.hung[LOGS[earlier]]) return `the ${earlier} phase it builds on hung`
  }
  if ((varies[rel][s] || {})[ph]) return `varies between passes (${varies[rel][s][ph].size} outcomes in ${RUNS.length + 1} passes)`
  for (const earlier of BUILDS_ON[ph] || []) {
    if ((varies[rel][s] || {})[earlier]) return `the ${earlier} phase it builds on varies between passes`
  }
  // a phase seen to vary in any release follows timing: one run of it decides nothing in any release
  if ((timing[s] || {})[ph]) return `follows timing (varies in ${timing[s][ph].join(' ')})`
  for (const earlier of BUILDS_ON[ph] || []) {
    if ((timing[s] || {})[earlier]) return `the ${earlier} phase it builds on follows timing`
  }
  const base = cells[BASE][s]
  const known = new Set(Object.values(noAnswers(base)).flatMap(x => [...x]))
  const mine = [...(noAnswers(c)[log] || [])].filter(u => !known.has(u))
  if (mine.length) return `the registry has no answer for ${mine.join(', ')}`
  return null
}

const firstErrors = p => (p.errors || []).slice(0, 2).join(' / ').slice(0, 240)
const lockChange = (x, y) => {
  const d = L.diff(x, y)
  return { cls: L.scope(d), what: L.signature(d).join('; '), detail: L.describe(d) }
}
// what differs between two cells in a phase: { cls, what, detail }
const compare = (a, b, ph) => {
  const x = a.phase[ph]
  const y = b.phase[ph]
  if (x.sig === y.sig) return { cls: 'same' }
  if (x.ran !== y.ran) return { cls: 'outcome', what: x.ran ? 'no longer runs' : 'now runs', detail: [] }
  if (SECOND[ph]) {
    if (x.status !== y.status || x.exit !== y.exit) {
      return { cls: 'outcome', what: `second install: ${x.status} (exit ${x.exit}) -> ${y.status} (exit ${y.exit})${y.errors.length ? `: ${firstErrors(y)}` : ''}`, detail: [] }
    }
    if ((x.lock || null) !== (y.lock || null)) {
      // the same status: the lock it rewrites to differs, classed as that lock's change
      const c = lockChange(x.lock, y.lock)
      const cls = x.lock == null || y.lock == null ? 'outcome' : c.cls === 'same' ? 'text' : c.cls
      return { cls, what: `the lock the second install rewrites: ${c.what}`, detail: c.detail }
    }
    return { cls: 'outcome', what: `second install fails differently: ${firstErrors(x)} => ${firstErrors(y)}`, detail: [] }
  }
  if (x.exit !== y.exit) {
    return { cls: 'outcome', what: `exit ${x.exit}->${y.exit}${y.errors.length ? `: ${firstErrors(y)}` : x.errors.length ? ` (failed with: ${firstErrors(x)})` : ''}`, detail: [] }
  }
  if (ph === 'cold' && x.status !== y.status) return { cls: 'outcome', what: `the empty-cache rerun: ${x.status} -> ${y.status}`, detail: [] }
  if ((x.lock == null) !== (y.lock == null)) {
    return { cls: 'outcome', what: x.lock == null ? 'now writes bun.lock' : 'no longer writes bun.lock', detail: [] }
  }
  const parts = []
  const detail = []
  let cls = 'same'
  if ((x.lock || null) !== (y.lock || null)) {
    const c = lockChange(x.lock, y.lock)
    cls = c.cls === 'same' ? 'text' : c.cls
    parts.push(c.what)
    detail.push(...c.detail)
  }
  // the other locks of a lockdir or rundir project (every bun.lock but the scenario's own), and what the edit did to
  // each (created, changed, unchanged)
  const others = p => Object.fromEntries(Object.entries(p.locks || {}).filter(([, v]) => v !== p.lock))
  const [ox, oy] = [others(x), others(y)]
  for (const f of [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort()) {
    if (ox[f] === oy[f]) continue
    const c = lockChange(ox[f] === undefined ? null : ox[f], oy[f] === undefined ? null : oy[f])
    const k = c.cls === 'same' ? 'text' : c.cls
    if (rank[cls] < rank[k]) cls = k
    parts.push(`${f}: ${c.what}`)
    detail.push(...c.detail.map(d => `${f}: ${d}`))
  }
  if (x.extra !== y.extra) {
    if (rank[cls] < rank.entries) cls = 'entries'
    parts.push(`the locks the edit wrote: ${x.extra || '-'} -> ${y.extra || '-'}`)
  }
  if (JSON.stringify(x.errors) !== JSON.stringify(y.errors)) {
    cls = 'outcome'
    parts.push(`another failure: ${firstErrors(x)} => ${firstErrors(y)}`)
  }
  return cls === 'same' ? { cls: 'same' } : { cls, what: parts.join('; '), detail }
}

fs.mkdirSync(report, { recursive: true })

// ---- summary -----------------------------------------------------------------------------------------------------
const SUMMARY_PHASES = ['before', 'after', 'again', 'cross', 'crossAgain', 'beforeAgain', 'fresh', 'frozen', 'cold']
// the header of the locks a release writes from scratch
const headerOf = rel => {
  const counts = {}
  for (const s of scenarios) {
    const c = cells[rel][s]
    if (!c || c.skip || !c.phase.before.lock) continue
    const p = L.parse(c.phase.before.lock)
    if (!p) continue
    const k = `v${p.lockfileVersion}${p.configVersion === undefined ? '' : `/c${p.configVersion}`}`
    counts[k] = (counts[k] || 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || '-'
}
const lines = [
  `baseline bun ${BASE}; ${scenarios.length} scenarios the control counts (bun-control.js); ${releases.length} releases swept`,
  'per phase, among those scenarios, against the baseline: same = its bytes (or its failure) / hdr = the lock differs only in',
  'lockfileVersion or configVersion / text = the same lock written otherwise (key order, layout) / entr = entries differ /',
  'out = another exit, failure, lock written or not, or second install / ? = undecided (hung, harness, no registry answer).',
  'lock = lockfileVersion (v) and configVersion (c) of the locks the release writes from scratch. command: + = --save-text-lockfile',
  'given (1.1.39 - 1.1.45), full = --lockfile-only not a flag of the release, a full install. Second installs: again over after,',
  'crossAgain over cross, beforeAgain over before. frozen: --frozen-lockfile over after. cold: the edit from an empty cache.',
  '',
  `${'release'.padEnd(8)} ${'lock'.padEnd(6)} ${'cmd'.padEnd(6)}${SUMMARY_PHASES.map(p => `${p.padEnd(11)}: same  hdr text entr  out    ?`).join(' | ')}`,
]
const summary = {}
for (const rel of releases) {
  const row = {}
  for (const ph of SUMMARY_PHASES) {
    row[ph] = { same: 0, header: 0, text: 0, entries: 0, outcome: 0, undecided: 0 }
    for (const s of scenarios) {
      const c = cells[rel][s]
      const base = cells[BASE][s]
      if (!c || !base) continue
      if (undecided(rel, s, ph) || undecided(BASE, s, ph)) {
        row[ph].undecided++
        continue
      }
      row[ph][compare(base, c, ph).cls]++
    }
  }
  summary[rel] = row
  const any = scenarios.map(s => cells[rel][s]).find(c => c && !c.skip)
  const cmd = any ? `${any.r.command.includes('--save-text-lockfile') ? '+' : ''}${any.r.lockfileOnly ? 'full' : ''}` || '-' : '?'
  lines.push(`${rel.padEnd(8)} ${headerOf(rel).padEnd(6)} ${cmd.padEnd(6)}${SUMMARY_PHASES.map(p => {
    const r = row[p]
    return `${' '.repeat(12)}${[r.same, r.header, r.text, r.entries, r.outcome, r.undecided].map(n => String(n).padStart(5)).join('')}`
  }).join(' | ')}`)
}
fs.writeFileSync(path.join(report, 'summary.txt'), lines.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'summary.json'), JSON.stringify(summary, null, 1) + '\n')

// ---- boundaries --------------------------------------------------------------------------------------------------
const boundaries = []
for (let i = 1; i < releases.length; i++) {
  const [a, b] = [releases[i - 1], releases[i]]
  const groups = {}
  const undecidedHere = {}
  const perScenario = {}
  for (const s of scenarios) {
    const [ca, cb] = [cells[a][s], cells[b][s]]
    if (!ca || !cb) continue
    const parts = []
    const detail = []
    let worst = 'same'
    for (const ph of PHASES) {
      const why = undecided(a, s, ph) || undecided(b, s, ph)
      if (why) {
        if (ca.phase[ph].sig !== cb.phase[ph].sig) (undecidedHere[`${ph}: ${why}`] = undecidedHere[`${ph}: ${why}`] || []).push(s)
        continue
      }
      const c = compare(ca, cb, ph)
      if (c.cls === 'same') continue
      // a phase that stops or starts running follows from the phase before it
      if (/^(no longer runs|now runs)$/.test(c.what) && worst !== 'same') continue
      parts.push(`${ph}: ${c.what}`)
      detail.push(...c.detail.map(d => `${ph}: ${d}`))
      if (rank[c.cls] > rank[worst]) worst = c.cls
    }
    if (worst === 'same') continue
    const key = parts.join(' || ')
    groups[key] = groups[key] || { what: key, cls: worst, scenarios: [] }
    groups[key].scenarios.push(s)
    perScenario[s] = { cls: worst, parts, detail }
  }
  const list = Object.values(groups).sort((x, y) => rank[y.cls] - rank[x.cls] || y.scenarios.length - x.scenarios.length)
  if (list.length || Object.keys(undecidedHere).length) boundaries.push({ from: a, to: b, groups: list, undecided: undecidedHere, perScenario })
}
fs.writeFileSync(path.join(report, 'boundaries.json'), JSON.stringify(boundaries, null, 1) + '\n')

const newer = boundaries.filter(bd => cmp(bd.from, BASE) >= 0)
const older = boundaries.filter(bd => cmp(bd.to, BASE) <= 0).reverse()
const wrap = (names, indent) => {
  const out2 = []
  let line = ''
  for (const n of names) {
    if (line && (line + ', ' + n).length > 112) {
      out2.push(indent + line + ',')
      line = n
    } else {
      line = line ? `${line}, ${n}` : n
    }
  }
  if (line) out2.push(indent + line)
  return out2
}
const text = [
  `Boundaries of the Bun sweep: consecutive releases whose outcome differs for a scenario the control counts (${scenarios.length}).`,
  `Nearest ${BASE} first: the newer side outward, then the older side outward. Each group: [scenarios] (class) what changed,`,
  'per phase, in bun.lock\'s terms (packages[<pkg>] a hoisted entry, packages[<nested>] a nested one, workspaces[<root>|<member>],',
  'an npm tuple\'s parts id, registry, info, integrity). boundaries-detail.txt has every concrete change.',
]
const detailText = []
const section = (title, list) => {
  text.push('', `##### ${title}`)
  detailText.push('', `##### ${title}`)
  for (const bd of list) {
    const n = cls => new Set(bd.groups.filter(g => g.cls === cls).flatMap(g => g.scenarios)).size
    const total = new Set(bd.groups.flatMap(g => g.scenarios)).size
    text.push('', `=== ${bd.from} -> ${bd.to}: ${total} scenarios change: outcome ${n('outcome')}, entries ${n('entries')}, text ${n('text')}, header only ${n('header')}`)
    detailText.push('', `=== ${bd.from} -> ${bd.to}`)
    for (const g of bd.groups) {
      text.push(`  [${g.scenarios.length}] (${g.cls}) ${g.what}`)
      const brief = g.cls === 'header' && g.scenarios.length > 12
      text.push(...wrap(brief ? [...g.scenarios.slice(0, 12), `... ${g.scenarios.length - 12} more (boundaries.json)`] : g.scenarios, '        '))
    }
    for (const [why, names] of Object.entries(bd.undecided)) {
      text.push(`  [${names.length}] (undecided) ${why}`)
      text.push(...wrap(names, '        '))
    }
    for (const [s, c] of Object.entries(bd.perScenario)) {
      if (c.cls === 'header') continue
      detailText.push(`  ${s} (${c.cls})`)
      for (const p of c.parts) detailText.push(`      ${p}`)
      for (const d of c.detail) detailText.push(`        ${d.length > 300 ? d.slice(0, 300) + ' ...' : d}`)
    }
  }
}
section(`newer than ${BASE}, nearest first`, newer)
section(`older than ${BASE}, nearest first`, older)

// the phases that follow timing, by scenario
const vText = [`Phases whose outcome differs between runs of one release: between the ${RUNS.length + 1} passes of the sweep (${[out, ...RUNS].map(d => path.relative(out, d) || '.').join(', ')})`,
  `or in the repeated runs of bun-repeat.js (${REPEATS.map(f => path.relative(out, f)).join(', ') || 'none'}), with the releases where it was seen to differ.`,
  'Such a phase (and a phase built on it) is undecided in summary.txt and boundaries.txt for every release: one run of it decides nothing.',
  'The scenarios the control already leaves out because their outcome varies at the baseline are in control.txt.', '']
for (const [s, phs] of Object.entries(timing).sort()) {
  vText.push(s)
  for (const [ph, rels] of Object.entries(phs)) vText.push(`  ${ph.padEnd(12)} varies in ${rels.length} releases: ${rels.join(' ')}`)
}
fs.writeFileSync(path.join(report, 'varies.txt'), vText.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'boundaries.txt'), text.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'boundaries-detail.txt'), detailText.join('\n') + '\n')
console.log(`${releases.length} releases, ${scenarios.length} scenarios, ${boundaries.length} boundaries -> ${report}`)

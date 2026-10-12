// Reads a Yarn Berry sweep and finds where along the release line each scenario's outcome changes.
//   <out>/_report/summary.txt            per release and phase: how many scenarios do what the baseline release does
//   <out>/_report/boundaries.txt         each pair of consecutive releases whose outcomes differ, nearest the baseline
//                                        first, the scenarios grouped by what changed, in the lock's own terms
//   <out>/_report/boundaries-detail.txt  the same boundaries with every concrete change (entry by resolution, field, values)
//   <out>/_report/boundaries.json        the same, for further tooling
// A phase of a scenario counts only where the control reproduced it (<out>/_report/control.json, yarn-berry-control.js):
// the harness is faithful for those. A change between two cells of a phase is one of
//   metadata   the locks differ only in the __metadata block (version, cacheKey) and in the cache key written on checksums
//   settings   besides that, the release writes another .yarnrc.yml (the settings a lockfile migration adds)
//   entries    an entry of the lock appeared, disappeared, or a field of one changed (a checksum's hash counts)
//   outcome    another exit code, or the same failure worded differently (yarn-berry-failure.js), or a second
//              install that changes or rejects the lock
// A cell is undecided where the stub answered 404 for a package the control was never asked for in that phase (a
// hand-made package of the recording that no http/ keeps), where a phase was killed, or where the harness failed;
// undecided cells are left out of the counts and listed.
// The settings a release writes are the ones it adds to the .yarnrc.yml the phase started from (--scenarios names the
// fixtures, for that file).
// Usage: node sweep-matrix-yarn-berry.js <sweep out dir> [--baseline 4.10.3] [--control control] [--scenarios <lock/yarn-berry>]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const L = require('./yarn-berry-lock.js')
const { failureOf } = require('./yarn-berry-failure.js')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '4.10.3')
const CONTROL = arg('control', 'control')
const SCENARIOS = path.resolve(arg('scenarios', path.join(out, '..', '..', 'fixtures', 'lock', 'yarn-berry')))
// again and crossAgain are the second installs: over the lock the after phase wrote, and over the cross phase's
const PHASES = ['before', 'after', 'again', 'cross', 'crossAgain']
const SECOND = { again: 'after', crossAgain: 'cross' }
const CLASSES = ['same', 'metadata', 'settings', 'entries', 'outcome']
const rank = Object.fromEntries(CLASSES.map((c, i) => [c, i]))
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const read = f => fs.existsSync(f) ? fs.readFileSync(f) : null
const sha = b => b == null ? '-' : crypto.createHash('sha1').update(b).digest('hex').slice(0, 12)
const report = path.join(out, '_report')
const valid = JSON.parse(fs.readFileSync(path.join(report, 'control.json'), 'utf8'))

const scenarios = Object.keys(valid).filter(s => !valid[s].skip).sort()
// A release may be swept in part: the cells yarn-berry-plan.js names (the scenarios that differ between the swept
// releases around it) before the rest. A scenario's line runs through the releases that have its cell, and a change
// is put at the first release that shows it, with the releases between it and the last cell before named when the
// scenario was not swept there.
const has = (v, s) => fs.existsSync(path.join(out, v, s, 'result.json'))
const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v) && fs.statSync(path.join(out, v)).isDirectory() && scenarios.some(s => has(v, s))).sort(cmp)
const incomplete = releases.filter(v => !scenarios.every(s => has(v, s)))
if (!releases.includes(BASE) || incomplete.includes(BASE)) throw new Error(`no complete baseline ${BASE} in ${out}`)

const absent = list => (list || []).filter(o => /: absent$/.test(o))
const FILES = { before: ['before', 'yarnrc-before.written'], after: ['after', 'yarnrc.written'], cross: ['cross', 'cross.yarnrc.written'] }
// the settings a .yarnrc.yml holds, by top-level key
const settingsOf = text => {
  const out2 = {}
  let key = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (m) {
      key = m[1]
      out2[key] = m[2]
    } else if (key && line.trim()) {
      out2[key] += ` ${line.trim()}`
    }
  }
  return out2
}
// the .yarnrc.yml a phase started from, as sweep-yarn-berry.js lays it out
const rcInput = (scenario, dir, ph) => {
  const fx = f => read(path.join(SCENARIOS, scenario, f))
  const first = fx('yarnrc') || (fs.existsSync(path.join(SCENARIOS, scenario, 'recorded-with')) ? null : fx('workspace-yarnrc')) ||
    read(path.join(SCENARIOS, scenario, 'tree-before', '.yarnrc.yml'))
  if (ph === 'before') return first
  const tree = read(path.join(SCENARIOS, scenario, 'tree', '.yarnrc.yml'))
  if (ph === 'after') return fx('yarnrc-after') || tree || read(path.join(dir, 'yarnrc-before.written')) || first
  return fx('yarnrc-after') || tree || fx('yarnrc-before.written') || first
}
const loadCell = (release, scenario) => {
  const dir = path.join(out, release, scenario)
  const rj = path.join(dir, 'result.json')
  if (!fs.existsSync(rj)) return null
  const r = JSON.parse(fs.readFileSync(rj, 'utf8'))
  if (r.skip) return { skip: r.skip }
  const cell = { r, dir, phase: {} }
  const failure = ph => r.exits[ph] !== undefined && r.exits[ph] !== 0 ? failureOf(String(read(path.join(dir, `${ph}.log`)) || '')) : null
  for (const ph of ['before', 'after', 'cross']) {
    const [lock, rc] = FILES[ph].map(f => read(path.join(dir, f)))
    // the settings the release added to, or changed in, the .yarnrc.yml the phase started from
    const added = {}
    if (rc) {
      // (Yarn writes the file again in its own quoting and indentation)
      const plain = v => v.replace(/["']/g, '').replace(/\s+/g, ' ').trim()
      const had = settingsOf(String(rcInput(scenario, dir, ph) || ''))
      for (const [k, v] of Object.entries(settingsOf(rc.toString('utf8')))) if (had[k] === undefined || plain(had[k]) !== plain(v)) added[k] = plain(v)
    }
    cell.phase[ph] = { ran: r.exits[ph] !== undefined, exit: r.exits[ph], lock, lockHash: sha(lock), fail: failure(ph), rc: rc ? sha(JSON.stringify(added)) : '-', added: rc ? added : null }
  }
  const again = read(path.join(dir, 'after-again'))
  cell.phase.again = { ran: r.exits.again !== undefined, exit: r.exits.again, status: r.again || null, lock: again, lockHash: sha(again), fail: failure('again'), over: r.againOver || null }
  // the second install over the cross lock ran on its own, or is `again`'s where its inputs were the same
  if (r.crossAgainFrom === 'again') {
    cell.phase.crossAgain = { ...cell.phase.again, over: 'cross' }
  } else {
    const crossAgain = read(path.join(dir, 'cross-again'))
    cell.phase.crossAgain = { ran: r.exits['cross-again'] !== undefined, exit: r.exits['cross-again'], status: r.crossAgain || null, lock: crossAgain, lockHash: sha(crossAgain), fail: failure('cross-again'), over: 'cross' }
  }
  return cell
}
const cells = {}
for (const rel of [...releases, CONTROL]) {
  cells[rel] = {}
  for (const s of scenarios) cells[rel][s] = loadCell(rel, s)
}

// why a cell's phase cannot be decided, or null
const undecided = (rel, s, ph) => {
  const c = cells[rel][s]
  if (!c) return 'not run'
  if (c.skip) return c.skip
  if (c.r.error) return `harness error: ${c.r.error.split('\n')[0]}`
  if (c.r.inconclusive) return c.r.inconclusive
  if (c.r.otherYarn) return `another Yarn ran: ${c.r.otherYarn[0]}`
  const ctl = cells[CONTROL][s]
  // what the control was answered 404 for is the registry's own 404
  const known = new Set(ctl && ctl.r ? absent(Object.values(ctl.r.overlayByPhase || {}).flat()) : [])
  const byPhase = c.r.overlayByPhase || {}
  const label = ph === 'crossAgain' ? (c.r.crossAgainFrom === 'again' ? 'again' : 'cross-again') : ph
  const beyond = absent(byPhase[label]).filter(o => !known.has(o))
  if (beyond.length) return `the stub has no ${beyond.map(o => o.replace(/: absent$/, '')).join(', ')}`
  // a phase that follows one the stub could not answer inherits it
  const earlier = { after: ['before'], again: ['before', 'after'], crossAgain: c.r.crossAgainFrom === 'again' ? ['before', 'after'] : ['cross'] }[ph] || []
  const first = earlier.flatMap(e => absent(byPhase[e])).filter(o => !known.has(o))
  if (first.length) return `an earlier phase could not be answered (${[...new Set(first)].map(o => o.replace(/: absent$/, '')).join(', ')})`
  return null
}
// a phase counts where the control reproduced it; a second install the recording kept no outcome of counts where the
// control reproduced the phase whose lock it is over
const isValid = (s, ph) => valid[s] && (SECOND[ph] ? valid[s][ph] !== false && valid[s][SECOND[ph]] === true : valid[s][ph] === true)

const sigOf = (c, ph) => {
  if (!c || c.skip) return 'missing'
  const p = c.phase[ph]
  if (!p.ran) return 'not run'
  if (SECOND[ph]) return `${p.exit}|${p.status}|${p.lockHash}|${sha(p.fail)}|${p.over}`
  return `${p.exit}|${p.lockHash}|${sha(p.fail)}|${p.rc}`
}

// two releases' additions to .yarnrc.yml in a phase (null: the release left the file alone)
const rcChange = (x, y) => {
  const show = o => Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') || 'a rewrite of what it held'
  if (x == null) return `.yarnrc.yml now written, adding ${show(y)}`
  if (y == null) return `.yarnrc.yml no longer written (it added ${show(x)})`
  const parts = []
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!(k in x)) parts.push(`now also ${k}: ${y[k]}`)
    else if (!(k in y)) parts.push(`no longer ${k}`)
    else if (x[k] !== y[k]) parts.push(`${k}: ${x[k]} -> ${y[k]}`)
  }
  return `.yarnrc.yml written: ${parts.join(', ') || 'another layout'}`
}

// what differs between two cells in a phase: { cls, what, detail: [lines] }
// the reason a failure gives, without the usage synopsis and the request details that follow it
const first = text => (text || '').split('\n').filter(l => !/Response Code|Request Method|Request URL|^\s*\$ yarn |Yarn Package Manager|Please report this issue|^You can also print|flag right after the command name/.test(l))
  .slice(0, 2).join(' / ').slice(0, 260)
const lockChange = (x, y) => {
  const d = L.diff(x.lock && x.lock.toString('utf8'), y.lock && y.lock.toString('utf8'))
  const scope = L.scope(d)
  return { cls: scope === 'metadata only' || scope === 'metadata and checksum cache keys' || scope === 'checksum cache keys' ? 'metadata' : 'entries', what: L.signature(d).join('; '), detail: L.describe(d) }
}
const compare = (a, b, ph) => {
  if (sigOf(a, ph) === sigOf(b, ph)) return { cls: 'same' }
  const x = a.phase[ph]
  const y = b.phase[ph]
  if (x.ran !== y.ran) return { cls: 'outcome', what: x.ran ? 'no longer runs' : 'now runs', detail: [] }
  if (SECOND[ph]) {
    if (x.status !== y.status || x.exit !== y.exit) return { cls: 'outcome', what: `second install: ${x.status} (exit ${x.exit}) -> ${y.status} (exit ${y.exit})${y.fail ? `: ${first(y.fail)}` : ''}`, detail: [] }
    if (x.over !== y.over) return { cls: 'outcome', what: `second install over ${x.over} -> over ${y.over}`, detail: [] }
    if (x.lockHash !== y.lockHash) {
      const c = lockChange(x, y)
      return { cls: 'outcome', what: `the lock the second install rewrites: ${c.what}`, detail: c.detail }
    }
    if (x.fail !== y.fail) return { cls: 'outcome', what: `second install fails differently: ${first(x.fail)} => ${first(y.fail)}`, detail: [] }
    return { cls: 'same' }
  }
  if (x.exit !== y.exit) {
    const wrote = p => p.exit === 0
    return { cls: 'outcome', what: `exit ${x.exit}->${y.exit}${wrote(x) && !wrote(y) ? `: ${first(y.fail)}` : !wrote(x) && wrote(y) ? ` (failed with: ${first(x.fail)})` : `: ${first(x.fail)} => ${first(y.fail)}`}`, detail: [] }
  }
  if (x.exit !== 0) {
    if (x.fail !== y.fail) return { cls: 'outcome', what: `fails differently: ${first(x.fail)} => ${first(y.fail)}`, detail: [] }
    return { cls: 'same' }
  }
  const parts = []
  const detail = []
  let cls = 'same'
  if (x.lockHash !== y.lockHash) {
    const c = lockChange(x, y)
    cls = c.cls
    parts.push(c.what)
    detail.push(...c.detail)
  }
  if (x.rc !== y.rc) {
    if (rank[cls] < rank.settings) cls = 'settings'
    parts.push(rcChange(x.added, y.added))
  }
  return cls === 'same' ? { cls: 'same' } : { cls, what: parts.join('; '), detail }
}

fs.mkdirSync(report, { recursive: true })

// ---- summary -----------------------------------------------------------------------------------------------------
const counts = ph => scenarios.filter(s => isValid(s, ph)).length
const lines = [
  `baseline yarn ${BASE}; ${scenarios.length} scenarios; phases the control reproduces: ${PHASES.map(p => `${p} ${counts(p)}`).join(', ')}; ${releases.length} releases swept`,
  'per phase, among the scenarios the control reproduces, against the baseline: same = its bytes (or its failure) / meta = the lock differs only',
  'in __metadata and the cache key of checksums / sett = that, and another .yarnrc.yml is written / entr = entries differ / out = another exit,',
  'failure or second install / ? = undecided. again and crossAgain are the second installs over the after and the cross lock.',
  'lock = the __metadata version and cacheKey the release writes. cells = the scenarios swept with the release: where fewer than all,',
  'they are the ones that differ between the fully swept releases around it (yarn-berry-plan.js), and the counts are over those.',
  '',
  `${'release'.padEnd(8)} ${'node'.padEnd(9)} ${'lock'.padEnd(9)} ${'cells'.padEnd(6)}${PHASES.map(p => `${p.padEnd(10)}: same meta sett entr  out    ?`).join(' | ')}`,
]
const summary = {}
for (const rel of releases) {
  const row = {}
  const meta = {}
  let node = ''
  for (const ph of PHASES) {
    row[ph] = { same: 0, metadata: 0, settings: 0, entries: 0, outcome: 0, undecided: 0 }
    for (const s of scenarios) {
      if (!isValid(s, ph)) continue
      const c = cells[rel][s]
      const base = cells[BASE][s]
      if (!c) continue
      if (undecided(rel, s, ph) || undecided(BASE, s, ph) || !base) {
        row[ph].undecided++
        continue
      }
      row[ph][compare(base, c, ph).cls]++
      if ((ph === 'before' || ph === 'after') && c.phase[ph].lock) {
        const parsed = L.parse(c.phase[ph].lock.toString('utf8'))
        if (parsed && parsed.metadata) {
          const k = `v${parsed.metadata.version}/${parsed.metadata.cacheKey}`
          meta[k] = (meta[k] || 0) + 1
        }
        node = Object.values(c.r.node || {})[0] || node
      }
    }
  }
  summary[rel] = row
  const lock = Object.entries(meta).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || '-'
  lines.push(`${rel.padEnd(8)} ${String(node).padEnd(9)} ${lock.padEnd(9)} ${String(scenarios.filter(s => cells[rel][s]).length).padEnd(6)}${PHASES.map(p => {
    const r = row[p]
    return `${' '.repeat(11)}${[r.same, r.metadata, r.settings, r.entries, r.outcome, r.undecided].map(n => String(n).padStart(5)).join('')}`
  }).join(' | ')}`)
}
fs.writeFileSync(path.join(report, 'summary.txt'), lines.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'summary.json'), JSON.stringify(summary, null, 1) + '\n')

// ---- boundaries --------------------------------------------------------------------------------------------------
const boundaries = []
for (let i = 1; i < releases.length; i++) {
  const b = releases[i]
  const groups = {}
  const undecidedHere = {}
  const perScenario = {}
  for (const s of scenarios) {
    if (!cells[b][s]) continue
    // the last release before this one that has the scenario's cell
    let j = i - 1
    while (j >= 0 && !cells[releases[j]][s]) j--
    if (j < 0) continue
    const a = releases[j]
    const unswept = releases.slice(j + 1, i)
    const parts = unswept.length ? [`[the scenario was not swept with ${unswept.join(', ')}: since ${a}]`] : []
    const detail = []
    let worst = 'same'
    for (const ph of PHASES) {
      if (!isValid(s, ph)) continue
      const why = undecided(a, s, ph) || undecided(b, s, ph)
      if (why) {
        // only where the two sides would differ if taken at face value
        if (cells[a][s] && cells[b][s] && !cells[a][s].skip && !cells[b][s].skip && sigOf(cells[a][s], ph) !== sigOf(cells[b][s], ph)) (undecidedHere[`${ph}: ${why}`] = undecidedHere[`${ph}: ${why}`] || []).push(s)
        continue
      }
      const c = compare(cells[a][s], cells[b][s], ph)
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
  if (list.length || Object.keys(undecidedHere).length) {
    boundaries.push({ from: releases[i - 1], to: b, swept: scenarios.filter(s => cells[b][s]).length, of: scenarios.length, groups: list, undecided: undecidedHere, perScenario })
  }
}
fs.writeFileSync(path.join(report, 'boundaries.json'), JSON.stringify(boundaries, null, 1) + '\n')

// nearest the baseline first: the newer side outward, then the older side outward
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
const text = []
const detailText = []
const section = (title, list) => {
  text.push('', `##### ${title}`)
  detailText.push('', `##### ${title}`)
  for (const bd of list) {
    const n = cls => new Set(bd.groups.filter(g => g.cls === cls).flatMap(g => g.scenarios)).size
    const total = new Set(bd.groups.flatMap(g => g.scenarios)).size
    text.push('', `=== ${bd.from} -> ${bd.to}: ${total} scenarios change: outcome ${n('outcome')}, entries ${n('entries')}, settings written ${n('settings')}, only __metadata ${n('metadata')}` +
      `${bd.swept < bd.of ? `   (${bd.to} swept with ${bd.swept} of ${bd.of} scenarios)` : ''}`)
    detailText.push('', `=== ${bd.from} -> ${bd.to}`)
    for (const g of bd.groups) {
      text.push(`  [${g.scenarios.length}] (${g.cls}) ${g.what}`)
      const brief = (g.cls === 'metadata' || g.cls === 'settings') && g.scenarios.length > 12
      text.push(...wrap(brief ? [...g.scenarios.slice(0, 12), `... ${g.scenarios.length - 12} more (boundaries.json)`] : g.scenarios, '        '))
    }
    for (const [why, names] of Object.entries(bd.undecided)) {
      text.push(`  [${names.length}] (undecided) ${why}`)
      text.push(...wrap(names, '        '))
    }
    for (const [s, c] of Object.entries(bd.perScenario)) {
      if (c.cls === 'metadata' || c.cls === 'settings') continue
      detailText.push(`  ${s} (${c.cls})`)
      for (const p of c.parts) detailText.push(`      ${p}`)
      for (const d of c.detail) detailText.push(`        ${d.length > 300 ? d.slice(0, 300) + ' ...' : d}`)
    }
  }
}
section(`newer than ${BASE}, nearest first`, newer)
section(`older than ${BASE}, nearest first`, older)
fs.writeFileSync(path.join(report, 'boundaries.txt'), text.join('\n') + '\n')
fs.writeFileSync(path.join(report, 'boundaries-detail.txt'), detailText.join('\n') + '\n')
console.log(`${releases.length} releases, ${scenarios.length} scenarios, ${boundaries.length} boundaries -> ${report}${incomplete.length ? `\nswept in part: ${incomplete.map(v => `${v} (${scenarios.filter(s => cells[v][s]).length})`).join(' ')}` : ''}`)

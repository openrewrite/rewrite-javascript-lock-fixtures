// Reads a sweep and finds where along the release line each scenario's outcome changes.
//   <out>/_report/summary.txt     per release: how many scenarios write what the baseline writes
//   <out>/_report/boundaries.txt  each pair of consecutive releases whose outcomes differ, with the scenarios
//                                 grouped by what changed in the lock (a structural signature)
//   <out>/_report/boundaries.json the same, for further tooling
// Only scenarios the baseline release reproduces from the fixture count (the harness is faithful for those).
// Usage: node sweep-matrix.js <sweep out dir> [--baseline 11.17.0] [--phase after,cross,before]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '11.17.0')
const FIXTURES = path.resolve(arg('fixtures', path.join(out, '..', '..', 'fixtures', 'lock', 'npm')))
const PHASES = arg('phase', 'before,after,cross').split(',')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)

const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const scenarios = new Set()
const cell = {} // release -> scenario -> record
const walk = (release, dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    const name = rel ? `${rel}/${e.name}` : e.name
    const rj = path.join(p, 'result.json')
    if (fs.existsSync(rj)) {
      const r = JSON.parse(fs.readFileSync(rj, 'utf8'))
      const rec = { exits: r.exits || {}, again: r.again || '-', skip: r.skip, same: r.same || {}, overlay: r.overlay || [], hash: {}, fixtureHasAfter: r.fixtureHasAfter }
      for (const ph of ['before', 'after', 'cross', 'after-again']) rec.hash[ph] = sha(read(path.join(p, ph)))
      cell[release][name] = rec
      scenarios.add(name)
    } else {
      walk(release, p, name)
    }
  }
}
const complete = []
for (const r of releases) {
  cell[r] = {}
  walk(r, path.join(out, r), '')
  complete.push(r)
}
// the release that recorded a scenario is its baseline: recorded-with names it, and the oldest fixtures predate that
const recordedBy = scenario => {
  const m = (read(path.join(FIXTURES, scenario, 'recorded-with')) || '').match(/npm (\d+\.\d+\.\d+)/)
  return m ? m[1] : BASE
}
const baseOf = s => (cell[recordedBy(s)] || {})[s]

// the harness is faithful where the baseline writes the fixture's locks
// a recording in which npm failed is reproduced when its release fails the same way: no lock, npm's same code
const codeIn = text => ((text || '').match(/^npm (?:ERR!|error) code (\S+)/m) || [])[1] || null
const failsAlike = s => {
  const b = baseOf(s)
  if (!b || fs.existsSync(path.join(FIXTURES, s, 'after')) || !b.exits.after) return false
  const code = codeIn(read(path.join(out, recordedBy(s), s, 'after.log')))
  return code != null && code === codeIn(read(path.join(FIXTURES, s, 'npm-after.log')))
}
const valid = [...scenarios].filter(s => {
  const b = baseOf(s)
  if (!b || b.skip) return false
  const checks = Object.values(b.same)
  return checks.length > 0 ? checks.every(Boolean) : failsAlike(s)
}).sort()

const sig = (rec, phases) => rec == null ? 'missing' : phases.map(ph =>
  ph === 'again' ? rec.again : `${rec.exits[ph] === undefined ? '-' : rec.exits[ph]}:${rec.hash[ph]}`).join('|')

// what changed between two locks, with package locations and versions generalized
const shapeDiff = (aText, bText) => {
  if (aText == null && bText == null) return ['both absent']
  if (aText == null) return ['lock appears']
  if (bText == null) return ['lock disappears']
  let a, b
  try {
    a = JSON.parse(aText)
    b = JSON.parse(bText)
  } catch (e) {
    return ['unparseable']
  }
  const found = new Set()
  const gen = (section, k) => section === 'packages' ? (k === '' ? '<root>' : k.includes('node_modules/') ? '<pkg>' : '<link-target>') : '<dep>'
  const walkDiff = (x, y, where) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
    if (!isObj(x) || !isObj(y)) {
      const kind = v => v === undefined ? 'absent' : Array.isArray(v) ? 'array' : isObj(v) ? 'object' : typeof v
      const scalar = where.endsWith('lockfileVersion') ? `${x}->${y}` : kind(x) === kind(y) ? 'changed' : `${kind(x)}->${kind(y)}`
      found.add(`${where}: ${scalar}`)
      return
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    const section = where === 'packages' || where === 'dependencies' || /\.dependencies$/.test(where) && where.startsWith('dependencies') ? where.split('.')[0] : null
    if (JSON.stringify(Object.keys(x).filter(k => k in y)) !== JSON.stringify(Object.keys(y).filter(k => k in x))) found.add(`${where || '<top>'}: key order`)
    for (const k of keys) {
      const sub = section ? `${where}.${gen(section, k)}` : where ? `${where}.${k}` : k
      if (!(k in x)) found.add(`${sub}: added`)
      else if (!(k in y)) found.add(`${sub}: removed`)
      else walkDiff(x[k], y[k], sub)
    }
  }
  walkDiff(a, b, '')
  if (!found.size) found.add('formatting only')
  return [...found].sort()
}

const lockText = (release, scenario, phase) => read(path.join(out, release, scenario, phase))

const report = path.join(out, '_report')
fs.mkdirSync(report, { recursive: true })

// summary: per release, agreement with the baseline
const lines = [`${valid.length} of ${scenarios.size} scenarios are reproduced by the release that recorded them (npm ${BASE} where the fixture does not say); ${complete.length} releases swept`, '',
  'release     ran   ' + PHASES.map(p => `same-${p}`.padEnd(12)).join('') + 'fails-where-baseline-writes  writes-where-baseline-fails']
for (const r of complete) {
  const row = { ran: 0 }
  for (const p of PHASES) row[p] = 0
  let failsNew = 0
  let writesNew = 0
  for (const s of valid) {
    const rec = cell[r][s]
    const base = baseOf(s)
    if (!rec) continue
    row.ran++
    for (const p of PHASES) if (sig(rec, [p]) === sig(base, [p])) row[p]++
    const wrote = x => x.hash.after !== '-' || x.hash.cross !== '-'
    if (wrote(base) && !wrote(rec)) failsNew++
    if (!wrote(base) && wrote(rec)) writesNew++
  }
  lines.push(`${r.padEnd(10)} ${String(row.ran).padStart(4)}   ${PHASES.map(p => String(row[p]).padEnd(12)).join('')}${String(failsNew).padEnd(29)}${writesNew}`)
}
fs.writeFileSync(path.join(report, 'summary.txt'), lines.join('\n') + '\n')

// boundaries: consecutive releases whose outcome differs for a scenario
const boundaries = []
for (let i = 1; i < complete.length; i++) {
  const [a, b] = [complete[i - 1], complete[i]]
  const changed = {}
  for (const s of valid) {
    const [ra, rb] = [cell[a][s], cell[b][s]]
    if (!ra || !rb) continue
    for (const p of PHASES) {
      if (sig(ra, [p]) === sig(rb, [p])) continue
      let what
      if (ra.exits[p] !== rb.exits[p]) what = [`${p} exit ${ra.exits[p]}->${rb.exits[p]}`]
      else what = shapeDiff(lockText(a, s, p), lockText(b, s, p)).map(w => `${p} ${w}`)
      const key = what.join('; ')
      ;(changed[key] = changed[key] || new Set()).add(s)
    }
  }
  const groups = Object.entries(changed).map(([what, set]) => ({ what, scenarios: [...set].sort() }))
    .sort((x, y) => y.scenarios.length - x.scenarios.length)
  if (groups.length) boundaries.push({ from: a, to: b, groups })
}
fs.writeFileSync(path.join(report, 'boundaries.json'), JSON.stringify(boundaries, null, 1) + '\n')
const text = []
for (const bd of boundaries) {
  const total = new Set(bd.groups.flatMap(g => g.scenarios)).size
  text.push(`\n=== ${bd.from} -> ${bd.to}: ${total} scenarios change`)
  for (const g of bd.groups) {
    text.push(`  [${g.scenarios.length}] ${g.what}`)
    text.push(`        ${g.scenarios.slice(0, 6).join(', ')}${g.scenarios.length > 6 ? ', ...' : ''}`)
  }
}
fs.writeFileSync(path.join(report, 'boundaries.txt'), text.join('\n') + '\n')
console.log(`${complete.length} releases, ${valid.length} valid scenarios, ${boundaries.length} boundaries -> ${report}`)

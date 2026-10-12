// The control of the Bun sweep: the ported release (1.3.10) replayed through the frozen registry must write what the
// fixture recorded. Writes <out>/_report/control.txt and control.json (which scenarios count, and why the others do
// not). A scenario counts when every check the fixture allows passes (sweep-bun.js's result.same: before, after,
// the second installs over after and before with their statuses and rewritten locks, frozen, fresh, the cold rerun,
// cross against the fixture's after, files and locks the edit left, exit codes and error lines) and its outcome does
// not vary between runs of the control (the runs given with --runs, and bun-repeat.js's tally with --repeat).
// Usage: node bun-control.js <sweep out dir> [--release 1.3.10] [--runs <out dir> ...] [--repeat <tally.json>]
const fs = require('fs')
const path = require('path')
const { PHASES, loadCell } = require('./bun-cell.js')

const out = path.resolve(process.argv[2])
const argv = process.argv.slice(3)
const opt = name => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : null
const RELEASE = opt('release') || '1.3.10'
const runs = []
argv.forEach((a, i) => { if (a === '--runs') for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) runs.push(path.resolve(argv[j])) })
const repeat = opt('repeat') ? JSON.parse(fs.readFileSync(opt('repeat'), 'utf8')) : {}
const root = path.join(out, RELEASE)
const scenarios = fs.readdirSync(root).filter(s => fs.existsSync(path.join(root, s, 'result.json'))).sort()

const control = {}
const lines = []
const tally = { counted: 0, skipped: 0, varies: 0, differs: 0 }
for (const s of scenarios) {
  const c = loadCell(path.join(root, s))
  if (c.skip) {
    control[s] = { skip: c.skip }
    tally.skipped++
    continue
  }
  const r = c.r
  // the requests of the empty-cache rerun (record-bun-open.sh, -user.sh): the same documents with the same Accept
  // header as the recording's requests-after.log
  const theirs = path.join(path.resolve(out, '..', '..', 'snap', '7', 'lock', 'bun'), s, 'requests-after.log')
  const scenariosDir = opt('scenarios') ? path.join(path.resolve(opt('scenarios')), s, 'requests-after.log') : theirs
  if (r.coldRequests && fs.existsSync(scenariosDir)) {
    const recorded = fs.readFileSync(scenariosDir, 'utf8').trim().split('\n').slice(0, -1).sort()
    r.same.coldRequests = JSON.stringify(recorded) === JSON.stringify([...r.coldRequests].sort())
  }
  const failing = Object.entries(r.same).filter(([, v]) => !v).map(([k]) => k)
  // outcomes that differ between runs of the control
  const varying = new Set()
  for (const other of runs) {
    const o = loadCell(path.join(other, RELEASE, s))
    if (!o || o.skip) continue
    for (const ph of PHASES) if (o.phase[ph].sig !== c.phase[ph].sig) varying.add(ph)
  }
  const rep = repeat[`${RELEASE}/${s}`]
  const repeatNote = []
  if (rep) {
    for (const [ph, t] of Object.entries(rep)) {
      if (Object.keys(t).length > 1) {
        varying.add(ph)
        const fixtureRuns = Object.entries(t).filter(([k]) => /the fixture's after/.test(k)).reduce((n, [, v]) => n + v, 0)
        const total = Object.values(t).reduce((n, v) => n + v, 0)
        repeatNote.push(`${ph}: ${Object.keys(t).length} outcomes in ${total} runs, the fixture's after in ${fixtureRuns}`)
      }
    }
  }
  const entry = { kind: r.kind, checks: Object.keys(r.same), failing, varies: [...varying], overlay: r.overlay, live: r.live }
  if (r.error) entry.error = r.error.split('\n')[0]
  if (r.hung) entry.hung = r.hung
  let verdict
  if (entry.error || entry.hung) verdict = 'harness'
  else if (varying.size) verdict = 'varies'
  else if (failing.length) verdict = 'differs'
  else verdict = 'counted'
  entry.verdict = verdict
  // which phases count: a phase is the release's own outcome to compare where the scenario counts
  entry.count = verdict === 'counted'
  control[s] = entry
  if (verdict === 'counted') tally.counted++
  else if (verdict === 'varies') tally.varies++
  else tally.differs++
  if (verdict !== 'counted') {
    lines.push(`  ${verdict.padEnd(8)} ${s} (${r.kind}): ${failing.length ? `fails ${failing.join(', ')}; ` : ''}${varying.size ? `varies in ${[...varying].join(', ')}` : ''}` +
      `${repeatNote.length ? `\n             ${repeatNote.join('\n             ')}` : ''}${entry.error ? ` ERROR ${entry.error}` : ''}`)
  }
}
const report = path.join(out, '_report')
fs.mkdirSync(report, { recursive: true })
fs.writeFileSync(path.join(report, 'control.json'), JSON.stringify(control, null, 1) + '\n')
const kinds = {}
for (const e of Object.values(control)) if (!e.skip) kinds[e.kind] = (kinds[e.kind] || 0) + 1
const skips = {}
for (const [s, e] of Object.entries(control)) if (e.skip) (skips[e.skip] = skips[e.skip] || []).push(s)
const plainCut = o => /live \(cut at [^,]+, 0 later versions dropped\)\)?$/.test(o)
const live = Object.entries(control).filter(([, e]) => e.count && (e.overlay || []).some(o => !plainCut(o)))
const text = [
  `bun ${RELEASE} (the ported release) replayed over ${scenarios.length} scenarios through the frozen registry` + (runs.length ? `, compared with ${runs.length} more run(s)` : '') + (Object.keys(repeat).length ? ', and the repeated runs of bun-repeat.js' : ''),
  `  ${tally.counted} counted (every check the fixture allows passes, and the outcome is the same in every run)`,
  `  ${tally.varies} vary between runs (left out of the boundaries; their distribution is in _repeat/)`,
  `  ${tally.differs} differ from the fixture`,
  `  ${tally.skipped} not swept`,
  '',
  `by recorder (scenarios swept): ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}`,
  `checks (sweep-bun.js result.same) by how many scenarios had each, and passed it: ${(() => {
    const t = {}
    for (const e of Object.values(control)) if (!e.skip) for (const k of e.checks) { t[k] = t[k] || [0, 0]; t[k][0]++; if (!e.failing.includes(k)) t[k][1]++ }
    return Object.entries(t).map(([k, [n, ok]]) => `${k} ${ok}/${n}`).join(', ')
  })()}`,
  '',
  'not counted:',
  ...lines,
  '',
  'not swept:',
  ...Object.entries(skips).map(([why, names]) => `  ${names.length} ${why}\n      ${names.join(' ')}`),
  '',
  `counted scenarios answered from today's registry beyond a plain cut (a version dropped, or the recording's time unknown): ${live.length}`,
  ...live.map(([s, e]) => `  ${s}: ${e.overlay.filter(o => !plainCut(o)).join('; ')}`),
]
fs.writeFileSync(path.join(report, 'control.txt'), text.join('\n') + '\n')
console.log(text.join('\n'))

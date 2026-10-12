// Checks a control run (sweep-yarn-berry.js --control): each phase replayed with the release the recording ran it
// with must write the fixture's own lock, byte for byte, or fail as the recording failed (the same exit code and the
// same reasons in the log). Writes
//   <out>/_report/control.txt    the tally, then every scenario with a phase that is not reproduced, and why
//   <out>/_report/control.json   per scenario, which phases are reproduced (sweep-matrix-yarn-berry.js counts only those)
// A second control run (--against <label>) is compared cell by cell: outcomes that differ between two runs of the same
// release and scenario are listed.
// Usage: node yarn-berry-control.js <sweep out dir> [--label control] [--against control-2] [--reasons <json>] [--verbose]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const out = path.resolve(process.argv[2])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const { failureOf } = require('./yarn-berry-failure.js')
const LABEL = arg('label', 'control')
const AGAINST = arg('against')
const SCENARIOS = path.resolve(arg('scenarios', path.join(out, '..', '..', 'fixtures', 'lock', 'yarn-berry')))
const verbose = process.argv.includes('--verbose')
const reasonsFile = arg('reasons', path.join(__dirname, 'yarn-berry-control-reasons.json'))
const REASONS = fs.existsSync(reasonsFile) ? JSON.parse(fs.readFileSync(reasonsFile, 'utf8')) : {}
const sha = f => fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '-'

const load = label => {
  const root = path.join(out, label)
  const cells = {}
  if (!fs.existsSync(root)) return cells
  for (const name of fs.readdirSync(root).sort()) {
    const f = path.join(root, name, 'result.json')
    if (!fs.existsSync(f)) continue
    const r = JSON.parse(fs.readFileSync(f, 'utf8'))
    r.hash = {}
    for (const ph of ['before', 'after', 'after-again', 'cross', 'cross-again']) r.hash[ph] = sha(path.join(root, name, ph))
    // what a failed phase said, read again from its log (yarn-berry-failure.js), and compared again with the recording's
    r.fail = {}
    r.failRaw = {}
    for (const ph of ['before', 'after', 'again', 'cross', 'cross-again']) {
      if (!r.exits || r.exits[ph] === undefined || r.exits[ph] === 0) continue
      const log = fs.existsSync(path.join(root, name, `${ph}.log`)) ? fs.readFileSync(path.join(root, name, `${ph}.log`), 'utf8') : ''
      r.fail[ph] = failureOf(log)
      r.failRaw[ph] = failureOf(log, { raw: true })
    }
    for (const [ph, file] of [['before', 'yarn-before.log'], ['after', 'yarn-after.log'], ['cross', 'yarn-after.log']]) {
      if (!r.same || r.same[`${ph}:failure`] === undefined) continue
      const recorded = path.join(SCENARIOS, name, file)
      const recordedExit = (r.recordedExits || {})[ph === 'cross' ? 'after' : ph]
      r.same[`${ph}:failure`] = r.exits[ph] !== 0 && fs.existsSync(recorded) && r.fail[ph] === failureOf(fs.readFileSync(recorded, 'utf8')) &&
        (typeof recordedExit !== 'number' || recordedExit === r.exits[ph])
    }
    cells[name] = r
  }
  return cells
}

// per phase: true (reproduced), false (not), undefined (the recording has nothing for it, or the phase did not run)
const verdict = r => {
  const v = {}
  const s = r.same || {}
  const all = keys => {
    const present = keys.filter(k => s[k] !== undefined)
    return present.length ? present.every(k => s[k]) : undefined
  }
  v.before = all(['before', 'before:failure', 'before:package.json', 'before:.yarnrc.yml'])
  v.after = all(['after', 'after:failure', 'after:package.json', 'after:.yarnrc.yml'])
  // an edit that never ran because the first phase is not reproduced is not reproduced either
  if (v.after === undefined && r.fixtureHasAfter !== undefined && r.exits && r.exits.after === undefined && v.before === false) v.after = false
  v.again = s.again
  v.cross = all(['cross', 'cross:failure', 'cross:package.json', 'cross:.yarnrc.yml'])
  // the second install over the cross lock: the recording's own second install where cross reproduces `after`
  v.crossAgain = s.crossAgain
  return v
}

const cells = load(LABEL)
const names = Object.keys(cells)
const tally = { scenarios: names.length, 'left out': 0, 'every phase reproduced': 0, 'some phase not reproduced': 0 }
const perPhase = { before: [0, 0], after: [0, 0], again: [0, 0], cross: [0, 0], crossAgain: [0, 0] }
const lines = []
const json = {}
const releases = {}
for (const name of names) {
  const r = cells[name]
  if (r.skip) {
    tally['left out']++
    lines.push(`  left out  ${name}: ${r.skip}`)
    json[name] = { skip: r.skip }
    continue
  }
  const pair = `${r.releases.before || '-'} then ${r.releases.after || '-'}`
  releases[pair] = (releases[pair] || 0) + 1
  const v = verdict(r)
  json[name] = { ...v, releases: r.releases }
  for (const ph of Object.keys(perPhase)) {
    if (v[ph] === true) perPhase[ph][0]++
    else if (v[ph] === false) perPhase[ph][1]++
  }
  const bad = Object.entries(v).filter(([, ok]) => ok === false).map(([ph]) => ph)
  const flags = [
    ...(r.otherYarn ? [`ANOTHER YARN RAN: ${r.otherYarn.join('; ')}`] : []),
    ...(r.error ? [`HARNESS ERROR ${r.error.split('\n')[0]}`] : []),
    ...(r.inconclusive ? [`INCONCLUSIVE ${r.inconclusive}`] : []),
    ...(r.unserved && r.unserved.length ? [`unserved: ${[...new Set(r.unserved)].join(', ')}`] : []),
  ]
  if (!bad.length && !flags.length) {
    tally['every phase reproduced']++
    if (verbose) {
      lines.push(`  ok        ${name} [${pair}]${r.overlay.length ? `  beyond the recording: ${r.overlay.join('; ')}` : ''}${r.guessed ? `  (${r.guessed.join('; ')})` : ''}${r.network ? `  (network: ${r.network})` : ''}`)
    }
    continue
  }
  if (bad.length) tally['some phase not reproduced']++
  else tally['every phase reproduced']++
  const detail = Object.entries(r.same || {}).filter(([, ok]) => !ok).map(([k]) => k)
  lines.push(`  ${(bad.length ? 'differs' : 'flagged').padEnd(9)} ${name} [${pair}]: ${bad.length ? `not reproduced: ${bad.join(', ')} (${detail.join(', ') || 'did not run'})` : ''}` +
    ` exits=${JSON.stringify(r.exits)} recorded=${JSON.stringify(r.recordedExits || {})}`)
  if (REASONS[name]) lines.push(`            why: ${REASONS[name]}`)
  for (const f of flags) lines.push(`            ${f}`)
  for (const [ph, text] of Object.entries(r.fail || {})) {
    if (bad.includes(ph === 'again' ? 'again' : ph)) lines.push(`            ${ph} said: ${text.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`)
  }
  if (r.overlay && r.overlay.length) lines.push(`            beyond the recording: ${r.overlay.join('; ').slice(0, 600)}`)
  if (r.guessed) lines.push(`            release: ${r.guessed.join('; ')}`)
}

const text = [`control ${LABEL}: each phase with the release that recorded it`, '']
for (const [k, v] of Object.entries(tally)) text.push(`  ${String(v).padStart(4)}  ${k}`)
text.push('', '  phase     reproduced  not reproduced')
for (const [ph, [ok, no]] of Object.entries(perPhase)) text.push(`  ${ph.padEnd(9)} ${String(ok).padStart(10)}  ${String(no).padStart(14)}`)
text.push('', '  recorded with (before then after): ' + Object.entries(releases).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', '))
// the Node each recording release ran under
const nodeOf = {}
for (const n of names) for (const [ph, v] of Object.entries(cells[n].node || {})) (nodeOf[`${cells[n].releases[ph]} under Node ${v}`] = nodeOf[`${cells[n].releases[ph]} under Node ${v}`] || new Set()).add(n)
text.push('', '  releases and the Node they ran under: ' + Object.entries(nodeOf).sort().map(([k, set]) => `${k} (${set.size})`).join(', '))
const adaptations = new Set(names.flatMap(n => cells[n].adaptations || []))
if (adaptations.size) text.push('', '  what the harness changed for a release:', ...[...adaptations].sort().map(a => `    ${a}`))
// every child process a Yarn started, by program and first arguments, with the scenarios it was started in
const started = {}
for (const n of names) {
  for (const sp of cells[n].spawned || []) {
    const what = sp.replace(/^[\w-]+: /, '').split(' ').slice(0, 3).join(' ').replace(/<tmp>\S*/g, '<tmp>/...').replace(/[0-9a-f]{40}/g, '<commit>')
    ;(started[what] = started[what] || new Set()).add(n)
  }
}
if (Object.keys(started).length) {
  text.push('', '  child processes the releases started:', ...Object.entries(started).map(([w, set]) => `    ${w}   (${[...set].join(', ')})`))
} else {
  text.push('', '  child processes the releases started: none')
}
text.push('', ...lines)

if (AGAINST) {
  const other = load(AGAINST)
  const sig = r => r.skip ? 'skip' : JSON.stringify([r.exits, r.hash, r.again, r.crossAgain, r.fail])
  const differing = names.filter(n => other[n] && sig(cells[n]) !== sig(other[n]))
  text.push('', `two runs of the control (${LABEL} and ${AGAINST}): ${names.filter(n => other[n]).length} scenarios in both, ${differing.length} with another outcome`)
  for (const n of differing) {
    const a = cells[n]
    const b = other[n]
    const what = []
    for (const k of new Set([...Object.keys(a.exits || {}), ...Object.keys(b.exits || {})])) if ((a.exits || {})[k] !== (b.exits || {})[k]) what.push(`${k} exit ${(a.exits || {})[k]} / ${(b.exits || {})[k]}`)
    for (const k of Object.keys(a.hash)) if (a.hash[k] !== b.hash[k]) what.push(`${k} lock ${a.hash[k]} / ${b.hash[k]}`)
    for (const k of new Set([...Object.keys(a.fail || {}), ...Object.keys(b.fail || {})])) if ((a.fail || {})[k] !== (b.fail || {})[k]) what.push(`${k} failure text`)
    if (a.again !== b.again) what.push(`again ${a.again} / ${b.again}`)
    if (a.crossAgain !== b.crossAgain) what.push(`crossAgain ${a.crossAgain} / ${b.crossAgain}`)
    text.push(`  ${n}: ${what.join('; ')}`)
  }
  // what follows timing without changing the outcome: the lines a run reported before V8 aborted it, within a run
  // (the edit, its second install and the cross phase are the same install where the edit fails) and between the runs
  const racy = []
  for (const n of names) {
    const runs = [[LABEL, cells[n]], [AGAINST, other[n]]].filter(([, r]) => r && !r.skip)
    const texts = runs.flatMap(([label, r]) => Object.entries(r.failRaw || {}).filter(([ph]) => /heap out of memory/.test(r.fail[ph] || '')).map(([ph, t]) => [`${label} ${ph}`, t]))
    if (new Set(texts.map(([, t]) => t)).size > 1) {
      const longest = texts.map(([, t]) => t).sort((x, y) => y.length - x.length)[0].split('\n').filter(l => !/^FATAL ERROR/.test(l))
      racy.push(`  ${n}: before the abort, ${texts.filter(([, t]) => t.split('\n').length > 1).map(([w]) => w).join(', ') || 'no run'} reported ${JSON.stringify(longest.join(' | ').slice(0, 200))}; ${texts.filter(([, t]) => t.split('\n').length === 1).map(([w]) => w).join(', ')} did not`)
    }
  }
  text.push('', `runs that V8 aborted (heap exhaustion) and that differ in what Yarn had reported by then: ${racy.length}`, ...racy)
}

const report = path.join(out, '_report')
fs.mkdirSync(report, { recursive: true })
if (LABEL === 'control') {
  fs.writeFileSync(path.join(report, 'control.txt'), text.join('\n') + '\n')
  fs.writeFileSync(path.join(report, 'control.json'), JSON.stringify(json, null, 1) + '\n')
}
console.log(text.join('\n'))

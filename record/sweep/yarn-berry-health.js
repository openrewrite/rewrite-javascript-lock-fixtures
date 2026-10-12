// Checks every cell of a sweep for what would make it untrustworthy, and says which Node ran each release:
//   harness errors, phases killed by the timeout, another Yarn than the release under test (otherYarn), requests the
//   stub could not answer (unserved, stub errors), a package the stub answered 404 for that the control was never
//   answered 404 for (a gap in the recording), child processes the releases started, and the adaptations made.
// Also finds outcomes that come and go along the release line (A, B, A over three swept releases in a row), which is
// what a timing-dependent outcome looks like; each is listed for a second look.
// Usage: node yarn-berry-health.js <sweep out dir> [--control control]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { failureOf } = require('./yarn-berry-failure.js')

const out = path.resolve(process.argv[2])
const CONTROL = process.argv.includes('--control') ? process.argv[process.argv.indexOf('--control') + 1] : 'control'
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const sha = f => fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10) : '-'
const releases = fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const load = (v, s) => {
  const f = path.join(out, v, s, 'result.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}
const scenarios = fs.readdirSync(path.join(out, CONTROL)).filter(s => load(CONTROL, s)).sort()
const absent = list => (list || []).filter(o => /: absent$/.test(o))

const count = { cells: 0, skipped: 0 }
const issues = { error: [], inconclusive: [], otherYarn: [], unserved: [], gap: [] }
const nodes = {}
const spawned = {}
const adaptations = {}
for (const v of releases) {
  for (const s of scenarios) {
    const r = load(v, s)
    if (!r) {
      issues.error.push(`${v} ${s}: no result`)
      continue
    }
    count.cells++
    if (r.skip) {
      count.skipped++
      continue
    }
    for (const n of new Set(Object.values(r.node || {}))) (nodes[v] = nodes[v] || new Set()).add(n)
    if (r.error) issues.error.push(`${v} ${s}: ${r.error.split('\n')[0]}`)
    if (r.inconclusive) issues.inconclusive.push(`${v} ${s}: ${r.inconclusive}`)
    for (const o of r.otherYarn || []) issues.otherYarn.push(`${v} ${s}: ${o}`)
    for (const u of new Set(r.unserved || [])) issues.unserved.push(`${v} ${s}: ${u}`)
    const ctl = load(CONTROL, s)
    const known = new Set(ctl && !ctl.skip ? absent(Object.values(ctl.overlayByPhase || {}).flat()) : [])
    for (const o of absent(r.overlay)) if (!known.has(o)) issues.gap.push(`${v} ${s}: ${o}`)
    for (const sp of r.spawned || []) {
      const what = sp.replace(/^[\w-]+: /, '').split(' ').slice(0, 2).join(' ')
      ;(spawned[what] = spawned[what] || new Set()).add(`${v.split('.')[0]}.x ${s}`)
    }
    for (const a of r.adaptations || []) (adaptations[a.replace(/^\d+\.\d+\.\d+: /, '<release>: ')] = adaptations[a.replace(/^\d+\.\d+\.\d+: /, '<release>: ')] || new Set()).add(v)
  }
}
const lines = [`${releases.length} releases x ${scenarios.length} scenarios: ${count.cells} cells, ${count.skipped} left out (the scenarios corepack decides)`, '']
lines.push('Node per release:')
let run = null
const flushRun = () => run && lines.push(`  ${run.from}${run.to !== run.from ? ' .. ' + run.to : ''}: ${run.node}`)
for (const v of releases) {
  const n = [...(nodes[v] || [])].join(', ')
  if (run && run.node === n) run.to = v
  else {
    flushRun()
    run = { from: v, to: v, node: n }
  }
}
flushRun()
for (const [k, list] of Object.entries(issues)) {
  lines.push('', `${k}: ${list.length}`)
  for (const l of list.slice(0, 20)) lines.push(`  ${l}`)
  if (list.length > 20) lines.push(`  ... ${list.length - 20} more`)
}
lines.push('', 'child processes the releases started:')
for (const [w, set] of Object.entries(spawned)) lines.push(`  ${w}   (${[...new Set([...set].map(x => x.split(' ')[1]))].join(', ')}; in ${[...new Set([...set].map(x => x.split(' ')[0]))].join(', ')})`)
lines.push('', 'adaptations:')
for (const [a, set] of Object.entries(adaptations)) lines.push(`  ${a}   (${set.size} releases: ${[...set].sort(cmp)[0]} .. ${[...set].sort(cmp).slice(-1)[0]})`)

// outcomes that come and go: the signature of a phase at three consecutive releases reads A, B, A
const sigOf = (v, s) => {
  const r = load(v, s)
  if (!r || r.skip) return null
  const dir = path.join(out, v, s)
  const fail = Object.keys(r.exits || {}).filter(ph => r.exits[ph] !== 0).map(ph => {
    const log = path.join(dir, `${ph}.log`)
    return `${ph}:${failureOf(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')}`
  })
  return JSON.stringify([r.exits, r.again, r.crossAgain, fail, ['before', 'after', 'after-again', 'cross', 'cross-again'].map(f => sha(path.join(dir, f)))])
}
const flips = []
for (const s of scenarios) {
  const sigs = releases.map(v => sigOf(v, s))
  for (let i = 1; i + 1 < releases.length; i++) {
    if (sigs[i] && sigs[i - 1] && sigs[i] !== sigs[i - 1] && sigs[i - 1] === sigs[i + 1]) flips.push(`${s}: ${releases[i - 1]} / ${releases[i]} / ${releases[i + 1]}`)
  }
}
lines.push('', `outcomes that come and go (A, B, A over three releases in a row): ${flips.length}`, ...flips.map(f => `  ${f}`))
console.log(lines.join('\n'))

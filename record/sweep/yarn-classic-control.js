// Checks a control run of the Yarn classic sweep: yarn 1.22.22, the release that recorded every scenario, replayed
// against the frozen registry must do what the recording did, phase by phase (result.json `same`: the locks byte for
// byte, the exits, the failure's message, the second installs' outcomes). Lists every scenario where it does not,
// with what differs, and (with a second run) the scenarios whose outcome differs between two runs.
// Writes <out>/control.json (per scenario: the phases reproduced, and whether it counts) unless --no-write.
// Usage: node yarn-classic-control.js <sweep out dir> <run dir name> [<second run dir name>] [--reasons <json>] [--verbose]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const argv = process.argv.slice(2).filter(a => !a.startsWith('--'))
const [out, runA, runB] = argv
const flagArg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? null : process.argv[i + 1]
}
const verbose = process.argv.includes('--verbose')
const reasons = flagArg('reasons') ? JSON.parse(fs.readFileSync(flagArg('reasons'), 'utf8')) : {}
const load = run => {
  const dir = path.join(out, run)
  const results = {}
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name, 'result.json')
    if (fs.existsSync(f)) results[name] = JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  return results
}
const sha = f => fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '-'
// one cell's outcome: exits, locks and second installs
const outcomeOf = (run, name, r) => JSON.stringify({
  exits: r.exits,
  locks: Object.fromEntries(['before', 'after', 'after-fixpoint', 'after-again', 'cross', 'cross-fixpoint', 'cross-again'].map(f => [f, sha(path.join(out, run, name, f))])),
  second: r.second,
  fail: r.fail,
})
const a = load(runA)
const names = Object.keys(a).sort()
const lines = []
const control = {}
const tally = { scenarios: names.length, skipped: 0, 'every phase reproduced': 0, 'some phase not reproduced': 0, 'harness error': 0 }
const phaseTally = {}
for (const name of names) {
  const r = a[name]
  if (r.skip) {
    tally.skipped++
    lines.push(`  skip      ${name}: ${r.skip}`)
    control[name] = { counts: false, skip: r.skip }
    continue
  }
  if (r.error || r.inconclusive) {
    tally['harness error']++
    lines.push(`  error     ${name}: ${(r.error || r.inconclusive).split('\n')[0]}`)
    control[name] = { counts: false, error: r.error || r.inconclusive }
    continue
  }
  const checks = Object.entries(r.same)
  for (const [k, v] of checks) {
    phaseTally[k] = phaseTally[k] || { reproduced: 0, not: 0 }
    phaseTally[k][v ? 'reproduced' : 'not']++
  }
  const bad = checks.filter(([, v]) => !v).map(([k]) => k)
  control[name] = { counts: bad.length === 0 && checks.length > 0, reproduced: checks.filter(([, v]) => v).map(([k]) => k), not: bad, recorder: r.recorder }
  if (!checks.length) {
    lines.push(`  nothing   ${name}: no phase to compare (${r.recorder})`)
    continue
  }
  if (!bad.length) {
    tally['every phase reproduced']++
    if (verbose && r.overlay.length) lines.push(`  ok        ${name}: overlay ${r.overlay.join('; ')}`)
    continue
  }
  tally['some phase not reproduced']++
  lines.push(`  differs   ${name} [${r.recorder}]: ${bad.join(', ')}  exits=${JSON.stringify(r.exits)} recorded=${JSON.stringify({ before: r.recorded.before, after: r.recorded.after, frozen: r.recorded.frozen, fixpoint: r.recorded.fixpoint, again: r.recorded.again })}`)
  if (Object.keys(r.fail).length) lines.push(`            failures: ${Object.entries(r.fail).map(([k, v]) => `${k}: ${v}`).join(' | ')}`)
  if (reasons[name]) lines.push(`            why: ${reasons[name]}`)
  if (r.overlay.length) lines.push(`            beyond the recording: ${r.overlay.join('; ')}`)
  if (r.unserved.length) lines.push(`            unserved: ${r.unserved.join('; ')}`)
}
const text = [`control ${runA}: ${names.length} scenarios`, '']
for (const [k, v] of Object.entries(tally)) text.push(`  ${String(v).padStart(5)}  ${k}`)
text.push('', '  check            reproduced  not reproduced')
for (const [k, v] of Object.entries(phaseTally)) text.push(`  ${k.padEnd(16)} ${String(v.reproduced).padStart(10)}  ${String(v.not).padStart(14)}`)
text.push('', ...lines)
if (runB) {
  const b = load(runB)
  const differ = names.filter(n => b[n] && outcomeOf(runA, n, a[n]) !== outcomeOf(runB, n, b[n]))
  text.push('', `two runs (${runA} and ${runB}): ${names.filter(n => b[n]).length} scenarios in both, ${differ.length} with another outcome`)
  for (const n of differ) text.push(`  ${n}: ${outcomeOf(runA, n, a[n])}\n  ${' '.repeat(n.length)}  ${outcomeOf(runB, n, b[n])}`)
}
console.log(text.join('\n'))
if (!process.argv.includes('--no-write')) fs.writeFileSync(path.join(out, '_report', 'control.json'), JSON.stringify(control, null, 1) + '\n')

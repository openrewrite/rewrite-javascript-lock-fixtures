// Checks a control run: the recording release replayed against the frozen registry must write the fixture's own
// locks. Lists every scenario where it does not, with the phase, exit codes and what the overlay had to add.
// Usage: node sweep-control.js <sweep out dir> <release> [--verbose]
const fs = require('fs')
const path = require('path')
const [out, release] = process.argv.slice(2)
const verbose = process.argv.includes('--verbose')
const root = path.join(out, release)
const results = []
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    if (fs.existsSync(path.join(p, 'result.json'))) results.push(JSON.parse(fs.readFileSync(path.join(p, 'result.json'), 'utf8')))
    else walk(p)
  }
}
walk(root)
const tally = { reproduced: 0, skipped: 0, 'no fixture lock to compare': 0, differs: 0, 'fixture has after, replay failed': 0, 'fixture failed, replay wrote': 0 }
const lines = []
for (const r of results.sort((a, b) => a.scenario.localeCompare(b.scenario))) {
  if (r.skip) {
    tally.skipped++
    if (verbose) lines.push(`  skip      ${r.scenario}: ${r.skip}`)
    continue
  }
  const checks = Object.entries(r.same)
  const bad = checks.filter(([, same]) => !same).map(([phase]) => phase)
  const wroteAfter = fs.existsSync(path.join(root, r.scenario, 'after')) || fs.existsSync(path.join(root, r.scenario, 'cross'))
  let verdict
  if (bad.length) verdict = 'differs'
  else if (r.fixtureHasAfter && !wroteAfter) verdict = 'fixture has after, replay failed'
  else if (r.fixtureHasAfter === false && wroteAfter) verdict = 'fixture failed, replay wrote'
  else if (!checks.length && r.fixtureHasAfter) verdict = 'no fixture lock to compare'
  else verdict = 'reproduced'
  tally[verdict]++
  if (verdict !== 'reproduced') {
    lines.push(`  ${verdict.padEnd(9)} ${r.scenario}: ${bad.join(',')} exits=${JSON.stringify(r.exits)}${r.overlay.length ? ' overlay=' + r.overlay.join(',') : ''}${r.error ? ' ERROR ' + r.error.split('\n')[0] : ''}`)
  } else if (r.overlay.length && verbose) {
    lines.push(`  ok+overlay ${r.scenario}: ${r.overlay.join(',')}`)
  }
}
console.log(`npm ${release}: ${results.length} scenarios`)
for (const [k, v] of Object.entries(tally)) console.log(`  ${String(v).padStart(4)}  ${k}`)
console.log(lines.join('\n'))

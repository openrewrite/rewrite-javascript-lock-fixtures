// Runs the Bun sweep of some scenarios N times for each release, each run into its own directory, and tallies per
// scenario and phase how often each outcome came up, marking the fixture's own lock: how far an outcome follows
// timing (manifest arrival order) rather than the release.
//   <out>/run-<i>/<release>/<scenario>/   the runs (sweep-bun.js, --shared <shared>)
//   <out>/tally.txt, tally.json           the distribution
// Usage: node bun-repeat.js --scenarios <lock/bun> --pm <pm/bun> --out <dir> --shared <dir> --releases a,b --only <regex>
//          [--runs 20] [--jobs 4]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { loadCell, read, sha } = require('./bun-cell.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const SCENARIOS = path.resolve(arg('scenarios'))
const OUT = path.resolve(arg('out'))
const RUNS = Number(arg('runs', 20))
const releases = arg('releases').split(',')
const only = arg('only')
for (let i = 1; i <= RUNS; i++) {
  const dir = path.join(OUT, `run-${i}`)
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sweep-bun.js'), '--scenarios', SCENARIOS, '--pm', path.resolve(arg('pm')),
    '--out', dir, '--shared', path.resolve(arg('shared')), '--releases', releases.join(','), '--only', only, '--jobs', arg('jobs', '4')], { encoding: 'utf8' })
  if (r.status !== 0) console.error(r.stderr)
}
const lines = []
const json = {}
for (const release of releases) {
  const names = fs.readdirSync(path.join(OUT, 'run-1', release)).sort()
  for (const s of names) {
    const fixtureAfter = read(path.join(SCENARIOS, s, 'after'))
    const tally = {}
    for (let i = 1; i <= RUNS; i++) {
      const c = loadCell(path.join(OUT, `run-${i}`, release, s))
      if (!c || c.skip) continue
      for (const ph of ['after', 'cold', 'cross', 'fresh']) {
        const p = c.phase[ph]
        if (!p.ran) continue
        const key = `exit ${p.exit} lock ${sha(p.lock)}${p.lock != null && p.lock === fixtureAfter ? ' (the fixture\'s after)' : ''}${p.status ? ` ${p.status}` : ''}`
        tally[ph] = tally[ph] || {}
        tally[ph][key] = (tally[ph][key] || 0) + 1
      }
    }
    json[`${release}/${s}`] = tally
    lines.push(`${release} ${s}`)
    for (const [ph, t] of Object.entries(tally)) {
      lines.push(`  ${ph.padEnd(6)} ${Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x ${k}`).join(' | ')}`)
    }
  }
}
fs.writeFileSync(path.join(OUT, 'tally.txt'), lines.join('\n') + '\n')
fs.writeFileSync(path.join(OUT, 'tally.json'), JSON.stringify(json, null, 1) + '\n')
console.log(lines.join('\n'))

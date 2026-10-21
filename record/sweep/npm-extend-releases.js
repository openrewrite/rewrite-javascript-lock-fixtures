// Adds npm releases to an export from their sweep and their predecessors'. A new release joins the outcomes its
// predecessor on the release line writes, where every scenario's cell of the new release has the predecessor's
// outcome (npm-cell.js's sig). A range that ends at the predecessor then ends at the new release. Where any cell
// differs, nothing is written. That release marks a boundary, and the full export (refresh.sh) places it.
// Usage: node npm-extend-releases.js --sweep <sweep out> --fixtures <lock/npm> --packument <npm packument.json>
//          --releases 11.21.1,12.2.1 [--min-major 7] [--dry]
const fs = require('fs')
const path = require('path')
const { loadCell, cmp } = require('./npm-cell')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const SWEEP = path.resolve(arg('sweep'))
const FIXTURES = path.resolve(arg('fixtures'))
const MIN_MAJOR = Number(arg('min-major', 7))
const DRY = process.argv.includes('--dry')
const RELEASES = arg('releases').split(',')

const master = Object.keys(JSON.parse(fs.readFileSync(arg('packument'), 'utf8')).versions)
  .filter(v => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) >= MIN_MAJOR).sort(cmp)

const scenariosOf = (dir, rel, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const name = rel ? `${rel}/${e.name}` : e.name
    if (fs.existsSync(path.join(dir, e.name, 'result.json'))) out.push(name)
    else scenariosOf(path.join(dir, e.name), name, out)
  }
  return out
}

const releasesFiles = (dir, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) releasesFiles(p, out)
    else if (e.name === 'releases') out.push(p)
  }
  return out
}

const plan = []
let refused = false
for (const release of RELEASES) {
  const at = master.indexOf(release)
  if (at < 1) {
    console.error(`${release} is not a release of the packument after another`)
    process.exit(1)
  }
  const before = master[at - 1]
  const differ = []
  const scenarios = scenariosOf(path.join(SWEEP, before), '', [])
  for (const scenario of scenarios) {
    const a = loadCell(path.join(SWEEP, before, scenario))
    const b = loadCell(path.join(SWEEP, release, scenario))
    if (!b || (a.sig || a.skip) !== (b.sig || b.skip)) differ.push(scenario)
  }
  console.log(`${release} after ${before}: ${scenarios.length} scenarios, ${differ.length} with another outcome`)
  for (const s of differ) console.log(`  ${s}`)
  if (differ.length) refused = true
  else plan.push([before, release])
}
if (refused) {
  console.log('nothing written: sweep every release and export with refresh.sh')
  process.exit(1)
}

let extended = 0
for (const file of releasesFiles(FIXTURES, [])) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const range = lines[i].trim().split(/\s+-\s+/)
    if (!range[0]) continue
    for (const [before, release] of plan) {
      if (range[range.length - 1] === before) {
        lines[i] = `${range[0]} - ${release}`
        changed = true
        extended++
      }
    }
  }
  if (changed && !DRY) fs.writeFileSync(file, lines.join('\n'))
}
console.log(`${extended} ranges extended`)

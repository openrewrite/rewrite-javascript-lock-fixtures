// Runs every cell of a Bun sweep that hung (killed at the timeout, or stalled: no CPU time, output or registry request
// for --stall seconds) again, alone: one cell at a time, with the timeout only (--stall 0), into the same sweep, so a
// cell is called a hang only where it times out again. The first result of each cell is kept under
// <out>/_hung/<release>/<scenario>.json, and <out>/_hung/rerun.txt says what each re-run did.
// Usage: node bun-rerun-hung.js --scenarios <lock/bun> --pm <pm/bun> --out <sweep out> [--timeout 120] [--only <regex>]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const OUT = path.resolve(arg('out'))
const only = arg('only') ? new RegExp(arg('only')) : null
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const cells = []
for (const v of fs.readdirSync(OUT).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  for (const s of fs.readdirSync(path.join(OUT, v)).sort()) {
    const f = path.join(OUT, v, s, 'result.json')
    if (!fs.existsSync(f) || (only && !only.test(s))) continue
    const r = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (r.hung && !r.rerunAlone) cells.push([v, s, r])
  }
}
const log = path.join(OUT, '_hung', 'rerun.txt')
fs.mkdirSync(path.dirname(log), { recursive: true })
console.log(`${cells.length} hung cells`)
for (const [v, s, r] of cells) {
  const keep = path.join(OUT, '_hung', v, `${s}.json`)
  fs.mkdirSync(path.dirname(keep), { recursive: true })
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, JSON.stringify(r, null, 1) + '\n')
  const started = Date.now()
  spawnSync(process.execPath, [path.join(__dirname, 'sweep-bun.js'), '--scenarios', path.resolve(arg('scenarios')), '--pm', path.resolve(arg('pm')),
    '--out', OUT, '--releases', v, '--only', `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, '--jobs', '1', '--stall', '0', '--timeout', arg('timeout', '120'), '--force'], { encoding: 'utf8' })
  const f = path.join(OUT, v, s, 'result.json')
  const again = JSON.parse(fs.readFileSync(f, 'utf8'))
  again.rerunAlone = { first: r.hung, at: new Date().toISOString() }
  fs.writeFileSync(f, JSON.stringify(again, null, 1) + '\n')
  const line = `${v} ${s}: first ${JSON.stringify(r.hung)}; alone ${again.hung ? `hung again ${JSON.stringify(again.hung)}` : `finished (exits ${JSON.stringify(again.exits)})`} in ${Math.round((Date.now() - started) / 1000)}s`
  fs.appendFileSync(log, line + '\n')
  console.log(line)
}

// Under which Node does a Yarn release install at all? Runs sweep-yarn-berry.js for one scenario with each release
// under each of several Node builds (<pm>/../node/<version>/bin/node, or the Node running this script for "current")
// and prints, per release and Node, the exit codes and the first line of a failure.
//   <out>/_nodeprobe/<node>/<release>/<scenario>/   the cells, as the sweep writes them
// Usage: node yarn-berry-node-probe.js --scenarios <lock/yarn-berry> --pm <pm/yarn-berry> --out <sweep/yarn-berry>
//          --nodes 16.20.2,18.20.8,current --releases 3.0.0,3.0.2 [--scenario small-cascade] [--jobs 4]
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const pm = path.resolve(arg('pm'))
const out = path.resolve(arg('out'))
const scenario = arg('scenario', 'small-cascade')
const releases = arg('releases').split(',')
const nodes = arg('nodes').split(',')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
for (const n of nodes) {
  const node = n === 'current' ? process.execPath : path.join(pm, '..', 'node', n, 'bin', 'node')
  execFileSync(process.execPath, [path.join(__dirname, 'sweep-yarn-berry.js'), '--scenarios', path.resolve(arg('scenarios')), '--pm', pm,
    '--out', path.join(out, '_nodeprobe', n), '--releases', releases.join(','), '--only', `^${scenario}$`, '--jobs', arg('jobs', '4'), '--node', node], { stdio: 'ignore' })
}
for (const v of [...releases].sort(cmp)) {
  for (const n of nodes) {
    const r = JSON.parse(fs.readFileSync(path.join(out, '_nodeprobe', n, v, scenario, 'result.json'), 'utf8'))
    const failed = Object.values(r.fail || {}).map(f => f.split('\n')[0].slice(0, 110))
    console.log(`yarn ${v.padEnd(7)} node ${String(Object.values(r.node)[0] || n).padEnd(9)} ${JSON.stringify(r.exits)}${r.otherYarn ? ' OTHER: ' + r.otherYarn[0] : ''}${failed.length ? '  ' + failed[0] : ''}`)
  }
}

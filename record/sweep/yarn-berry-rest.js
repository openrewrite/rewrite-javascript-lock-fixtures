// Runs what is left of the sweep in order, each step once the one before has ended (a cell already swept is kept):
//   1. waits for a running sweep (its pid) to end, when one is given;
//   2. the first pass: the last patch of every minor (inventory/yarn-berry-first-pass.txt);
//   3. yarn-berry-plan.js over every major: the cells that pin each change between fully swept releases, then those;
//   4. every cell of every release.
// The Node each release runs under: Yarn 2 and Yarn 3.1 and later under Node 20.19.5 (under Node 23 and later their
// patch step calls util.isDate, which Node 23 removed; Node 22 prints deprecation warnings into the logs), Yarn 3.0.x
// under Node 16.20.2 (every fetch fails with ERR_STREAM_PREMATURE_CLOSE under Node 18 and later), Yarn 4 under the
// Node running this script (24.21.0). bin/yarn-berry-node-probe.js shows each of these.
// Every step's output goes to a log under sweep/yarn-berry. Usage: node yarn-berry-rest.js <pid to wait for | 0> [--jobs 10]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// the working directory: the one above bin/ as this script was started (bin/ links to record/sweep, and __dirname is
// the link's target)
const W = path.resolve(path.dirname(process.argv[1]), '..')
const pid = Number(process.argv[2] || 0)
const jobs = process.argv.includes('--jobs') ? process.argv[process.argv.indexOf('--jobs') + 1] : '10'
const out = path.join(W, 'sweep', 'yarn-berry')
const nodeOf = v => path.join(W, 'pm', 'node', v, 'bin', 'node')
const NODE_FOR = `2=${nodeOf('20.19.5')},3=${nodeOf('20.19.5')},3.0=${nodeOf('16.20.2')}`
const alive = p => {
  try {
    process.kill(p, 0)
    return true
  } catch (e) {
    return false
  }
}
const step = (label, args, logName, stdoutFile) => {
  fs.appendFileSync(path.join(out, 'rest.log'), `${new Date().toISOString()} ${label}: node ${args.join(' ')}\n`)
  const r = spawnSync(process.execPath, args, { cwd: W, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (stdoutFile) fs.writeFileSync(stdoutFile, r.stdout || '')
  fs.writeFileSync(path.join(out, logName), (stdoutFile ? '' : r.stdout || '') + (r.stderr || ''))
  fs.appendFileSync(path.join(out, 'rest.log'), `${new Date().toISOString()} ${label}: exit ${r.status}\n`)
}
const main = async () => {
  while (pid && alive(pid)) await new Promise(r => setTimeout(r, 30000))
  const sweep = releasesFile => ['bin/sweep-yarn-berry.js', '--scenarios', 'fixtures/lock/yarn-berry', '--pm', 'pm/yarn-berry', '--out', 'sweep/yarn-berry',
    '--releases-file', releasesFile, '--jobs', jobs, '--heavy-jobs', '2', '--node-for', NODE_FOR]
  step('first pass', sweep('inventory/yarn-berry-first-pass.txt'), 'sweep.log')
  step('plan', ['bin/yarn-berry-plan.js', 'sweep/yarn-berry', 'pm/yarn-berry'], 'plan-all.log', path.join(W, 'inventory', 'yarn-berry-cells-all.txt'))
  step('pinning cells', [...sweep('inventory/yarn-berry-sweep-order.txt'), '--cells-file', 'inventory/yarn-berry-cells-all.txt'], 'sweep-cells-all.log')
  step('every cell', sweep('inventory/yarn-berry-sweep-order.txt'), 'sweep-all.log')
}
main()

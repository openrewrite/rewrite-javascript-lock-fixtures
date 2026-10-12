// Runs what is left of the pnpm sweep, one sweep-pnpm.js after another, most telling first; every step skips the
// cells already swept, so it can be stopped and started again.
//   1  per major 12, 10, 9: the scenarios whose outcome differs between its first and last release (both swept
//      over everything before), over every release of the major
//   2  the from-9151 optional-peer scenarios over 12, 10 and 9, with the manifest's release pin ignored
//   3  every valid scenario over every release: 11, then 12, 10, 9   (the finished sweep)
//   4  the optional-peer scenarios over 12, 10 and 9 as recorded
// Usage: node pnpm-sweep-all.js <.lockwork dir> [--jobs 8] [--from <step>]     output: <.lockwork>/sweep/pnpm/sweep-all.log
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const L = path.resolve(process.argv[2])
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const JOBS = opt('jobs', '8')
const FROM = Number(opt('from', '1'))
const bin = f => path.join(L, 'bin', f)
const OUT = path.join(L, 'sweep', 'pnpm')
const FIXTURES = path.join(L, 'fixtures', 'lock', 'pnpm')
const PEERS = path.join(L, 'from-9151', 'pnpm-peers', 'scenarios', 'pnpm')
const NODE_RECORDED = path.join(L, 'pm', 'node', 'v24.19.0', 'bin', 'node')
const WORK = opt('work', '/private/tmp/claude-501/-Users-jon-Projects-github-openrewrite-rewrite/4188a488-5b8b-47b0-a1a5-92eea1c5fcfd/scratchpad/pw')
const log = path.join(OUT, 'sweep-all.log')
const say = line => fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`)
const node = (script, args) => {
  const fd = fs.openSync(log, 'a')
  const r = spawnSync(process.execPath, [bin(script), ...args], { stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  return r.status
}
const order = major => path.join(L, 'inventory', `pnpm-sweep-order-${major}.txt`)
const sweep = (label, args) => {
  say(`START ${label}`)
  const status = node('sweep-pnpm.js', ['--pm', path.join(L, 'pm', 'pnpm'), '--shared', OUT, '--jobs', JOBS, '--work', WORK, ...args])
  say(`END ${label} (exit ${status})`)
}
const unstable = new Set(fs.readFileSync(path.join(OUT, '_report', 'unstable.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#')))
const ENDS = { 12: ['12.0.0', '12.12.1'], 10: ['10.0.0', '10.34.6'], 9: ['9.0.0', '9.15.9'] }
const UNPIN = {
  12: ['--env', 'pnpm_config_pm_on_fail=ignore'],
  10: ['--env', 'npm_config_manage_package_manager_versions=false', '--env', 'npm_config_package_manager_strict=false'],
  9: ['--env', 'npm_config_manage_package_manager_versions=false', '--env', 'npm_config_package_manager_strict=false'],
}

if (FROM <= 1) {
  for (const major of [12, 10, 9]) {
    const all = path.join(OUT, '_report', `differing-${major}.txt`)
    node('pnpm-differing.js', [OUT, ...ENDS[major], '--write', all])
    const targeted = path.join(OUT, '_report', `targeted-${major}.txt`)
    fs.writeFileSync(targeted, fs.readFileSync(all, 'utf8').split('\n').filter(l => l && !unstable.has(l)).join('\n') + '\n')
    sweep(`1 targeted ${major}`, ['--scenarios', FIXTURES, '--out', OUT, '--releases-file', order(major), '--only-file', targeted, '--node', NODE_RECORDED])
  }
}
if (FROM <= 2) {
  for (const major of [12, 10, 9]) {
    sweep(`2 peers unpinned ${major}`, ['--scenarios', PEERS, '--out', path.join(L, 'sweep', 'pnpm-peers-unpinned'), '--releases-file', order(major), '--cross', 'always', ...UNPIN[major], '--node', opt('node-peers', process.execPath)])
  }
}
if (FROM <= 3) {
  for (const major of [11, 12, 10, 9]) {
    sweep(`3 full ${major}`, ['--scenarios', FIXTURES, '--out', OUT, '--releases-file', order(major), '--node', NODE_RECORDED])
  }
}
if (FROM <= 4) {
  for (const major of [12, 10, 9]) {
    sweep(`4 peers as recorded ${major}`, ['--scenarios', PEERS, '--out', path.join(L, 'sweep', 'pnpm-peers'), '--releases-file', order(major), '--cross', 'always', '--node', opt('node-peers', process.execPath)])
  }
}
say('ALL DONE')

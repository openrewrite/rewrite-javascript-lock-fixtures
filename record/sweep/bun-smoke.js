// pm-smoke.js for Bun, a native executable: runs `<pm dir>/<version>/package/bin/bun --version` (and --revision) for
// every unpacked release, in an empty scratch HOME, and reports which start and answer their own version. Also prints
// each release's code signature: the hardened runtime ignores DYLD_INSERT_LIBRARIES unless the binary is entitled to
// dyld environment variables (bun-native-clock.js needs that).
// Usage: node bun-smoke.js <pm dir> [--json <file>]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const dir = path.resolve(process.argv[2])
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bun-smoke-'))
const rows = []
for (const v of fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  const exe = path.join(dir, v, 'package', 'bin', 'bun')
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, NO_COLOR: '1' }
  const r = spawnSync(exe, ['--version'], { cwd: home, env, encoding: 'utf8', timeout: 60000 })
  const rev = spawnSync(exe, ['--revision'], { cwd: home, env, encoding: 'utf8', timeout: 60000 })
  const sig = spawnSync('codesign', ['-dv', exe], { encoding: 'utf8' }).stderr || ''
  const ents = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', exe], { encoding: 'utf8' }).stdout || ''
  const out = (r.stdout || '').trim()
  rows.push({
    version: v,
    ok: r.status === 0 && out === v,
    status: r.status,
    signal: r.signal,
    out,
    revision: (rev.stdout || '').trim(),
    err: (r.stderr || '').trim().split('\n').slice(0, 2).join(' | ').slice(0, 200),
    signature: (sig.match(/flags=(\S+)/) || [])[1] || '?',
    dyldEnv: /allow-dyld-environment-variables/.test(ents) || !/\(runtime\)/.test(sig),
  })
}
fs.rmSync(home, { recursive: true, force: true })
const ok = rows.filter(r => r.ok)
console.log(`${ok.length} of ${rows.length} releases start and answer their version`)
for (const r of rows) {
  console.log(`  ${r.ok ? 'ok ' : 'BAD'} ${r.version.padEnd(8)} ${r.revision.padEnd(18)} signature ${r.signature.padEnd(26)} dyld-env ${r.dyldEnv ? 'yes' : 'NO '}${r.ok ? '' : `  status=${r.status} signal=${r.signal} out=${JSON.stringify(r.out)} err=${JSON.stringify(r.err)}`}`)
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 1) + '\n')

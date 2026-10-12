// Runs `--version` for every unpacked pnpm release under <pm dir> and reports which start: the release's own CLI
// under the given Node (bin/pnpm.js, bin/pnpm.cjs or bin/pnpm.mjs, as its manifest names it), or its native
// executable (pnpm 12: @pnpm/exe.<platform>-<arch>/pnpm, which runs without Node).
// Usage: node pnpm-smoke.js <pm dir> [node binary] [min-major] [max-major]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const [dirArg, nodeArg = process.execPath, minMajor = '0', maxMajor = '999'] = process.argv.slice(2)
// the releases are run from a scratch directory, so their paths must not be relative
const dir = path.resolve(dirArg)
const node = nodeArg.includes('/') ? path.resolve(nodeArg) : nodeArg
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const cliOf = release => {
  const root = path.join(dir, release)
  const scoped = path.join(root, '@pnpm')
  if (fs.existsSync(scoped)) {
    const exe = fs.readdirSync(scoped).map(d => path.join(scoped, d, 'pnpm')).find(f => fs.existsSync(f))
    if (exe) return { native: true, file: exe }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package', 'package.json'), 'utf8'))
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin || {}).pnpm
  return bin ? { native: false, file: path.join(root, 'package', bin) } : null
}
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pnpm-smoke-'))
const ok = []
const bad = []
const kinds = {}
for (const v of fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  const major = Number(v.split('.')[0])
  if (major < Number(minMajor) || major > Number(maxMajor)) continue
  const cli = cliOf(v)
  if (!cli) {
    bad.push(`${v}: no CLI in the release`)
    continue
  }
  const env = { PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: home, TMPDIR: home, npm_config_update_notifier: 'false', pnpm_config_update_notifier: 'false' }
  const r = cli.native ? spawnSync(cli.file, ['--version'], { cwd: home, env, encoding: 'utf8', timeout: 120000 })
    : spawnSync(node, [cli.file, '--version'], { cwd: home, env, encoding: 'utf8', timeout: 120000 })
  const out = (r.stdout || '').trim().split('\n').pop()
  const kind = cli.native ? 'native executable' : path.relative(path.join(dir, v, 'package'), cli.file)
  if (r.status === 0 && out === v) {
    ok.push(v)
    kinds[v] = kind
  } else {
    bad.push(`${v} (${kind}): status=${r.status}${r.signal ? ` signal=${r.signal}` : ''} out=${JSON.stringify(out)} err=${JSON.stringify((r.stderr || '').trim().split('\n').slice(0, 3).join(' | ').slice(0, 300))}`)
  }
}
fs.rmSync(home, { recursive: true, force: true })
const spans = []
for (const v of ok) {
  const last = spans[spans.length - 1]
  if (last && last.major === v.split('.')[0] && last.kind === kinds[v]) last.to = v
  else spans.push({ major: v.split('.')[0], kind: kinds[v], from: v, to: v, n: 0 })
  spans[spans.length - 1].n++
}
console.log(`node ${spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim()}: ${ok.length} start, ${bad.length} do not`)
for (const s of spans) console.log(`  ok ${s.from} .. ${s.to} (${s.n}) ${s.kind}`)
for (const b of bad) console.log(`  BAD ${b}`)

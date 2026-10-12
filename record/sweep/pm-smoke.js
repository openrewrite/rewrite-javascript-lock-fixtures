// Runs `<node> <cli> --version` for every unpacked release under <dir> and reports which start under that Node.
// Usage: node pm-smoke.js <pm dir> <relative cli path> [node binary]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const os = require('os')

const [dir, cli, node = process.execPath] = process.argv.slice(2)
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-smoke-'))
const ok = []
const bad = []
for (const v of fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  const r = spawnSync(node, [path.join(dir, v, 'package', cli), '--version'], {
    cwd: home,
    env: { PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: home, npm_config_update_notifier: 'false' },
    encoding: 'utf8',
    timeout: 60000,
  })
  const out = (r.stdout || '').trim().split('\n').pop()
  if (r.status === 0 && out === v) ok.push(v)
  else bad.push(`${v}: status=${r.status} out=${JSON.stringify(out)} err=${JSON.stringify((r.stderr || '').trim().split('\n').slice(0, 2).join(' | ').slice(0, 200))}`)
}
fs.rmSync(home, { recursive: true, force: true })
const spans = []
for (const v of ok) {
  const last = spans[spans.length - 1]
  if (last && last.major === v.split('.')[0]) last.to = v
  else spans.push({ major: v.split('.')[0], from: v, to: v, n: 0 })
  spans[spans.length - 1].n++
}
console.log(`node ${spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim()}: ${ok.length} start, ${bad.length} do not`)
for (const s of spans) console.log(`  ok ${s.from} .. ${s.to} (${s.n})`)
for (const b of bad) console.log(`  BAD ${b}`)

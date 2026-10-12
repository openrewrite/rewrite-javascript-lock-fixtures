// Lists the sweep's cells in which npm was killed (a phase's exit is signal:SIGKILL: the sweep's timeout), by release,
// and writes one line per release for sweep-npm.js: "<release> <scenario regex>".
// Usage: node npm-killed-cells.js <sweep out> <out file>
const fs = require('fs')
const path = require('path')
const [out, file] = process.argv.slice(2).map(p => path.resolve(p))
const byRelease = {}
let cells = 0
for (const release of fs.readdirSync(out).filter(v => /^\d+\.\d+\.\d+$/.test(v))) {
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      const name = rel ? `${rel}/${e.name}` : e.name
      const rj = path.join(p, 'result.json')
      if (!fs.existsSync(rj)) {
        walk(p, name)
        continue
      }
      const r = JSON.parse(fs.readFileSync(rj, 'utf8'))
      const killed = Object.entries(r.exits || {}).filter(([, x]) => String(x).startsWith('signal:')).map(([ph]) => ph)
      if (killed.length) {
        ;(byRelease[release] = byRelease[release] || []).push(name)
        cells++
        console.log(`${release} ${name}: ${killed.join(',')}`)
      }
    }
  }
  walk(path.join(out, release), '')
}
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
fs.writeFileSync(file, Object.entries(byRelease).map(([r, names]) => `${r} ^(${names.map(escape).join('|')})$`).join('\n') + '\n')
console.log(`${cells} cells in ${Object.keys(byRelease).length} releases`)

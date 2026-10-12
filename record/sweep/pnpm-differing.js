// Names the scenarios whose outcome is not the same in every one of the given releases of a sweep: the ones that
// can hold a boundary between them. With these named, a sweep can run them over the releases in between first
// (sweep-pnpm.js --only-file), before it runs every scenario over every release.
// Usage: node pnpm-differing.js <sweep out dir> <release> <release> [...] [--write <file>]
const fs = require('fs')
const path = require('path')
const { PHASES, loadCell } = require('./pnpm-cell.js')

const args = process.argv.slice(2)
const writeAt = args.indexOf('--write')
const writeTo = writeAt >= 0 ? args[writeAt + 1] : null
const [out, ...releases] = writeAt >= 0 ? [...args.slice(0, writeAt), ...args.slice(writeAt + 2)] : args
const names = new Set()
for (const r of releases) for (const e of fs.readdirSync(path.join(out, r), { withFileTypes: true })) if (e.isDirectory()) names.add(e.name)
const differing = []
const missing = []
for (const name of [...names].sort()) {
  const cells = releases.map(r => loadCell(path.join(out, r, name)))
  if (cells.some(c => !c)) {
    missing.push(name)
    continue
  }
  if (cells[0].r.skip) continue
  const phases = PHASES.filter(ph => new Set(cells.map(c => c.sig[ph])).size > 1)
  if (phases.length) differing.push(`${name}\t${phases.join(',')}\t${releases.map((r, n) => `${r}:${new Set(cells.slice(0, n + 1).map(c => PHASES.map(p => c.sig[p]).join('\n'))).size}`).join(' ')}`)
}
console.log(`${differing.length} of ${names.size} scenarios differ among ${releases.join(', ')}${missing.length ? `; ${missing.length} are not swept in all of them` : ''}`)
for (const d of differing) console.log(`  ${d}`)
if (writeTo) fs.writeFileSync(writeTo, [`# scenarios whose outcome differs among pnpm ${releases.join(', ')} (pnpm-differing.js)`, ...differing.map(d => d.split('\t')[0]), ...missing].join('\n') + '\n')

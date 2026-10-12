// Orders the unpacked releases of a package manager for a sweep: the last patch of every minor first, newest
// first, then every other release, so the first results span every major.
// Usage: node release-order.js <pm dir> [min-major]
const fs = require('fs')
const [dir, minMajor = '0'] = process.argv.slice(2)
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const all = fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) >= Number(minMajor)).sort(cmp)
const lastOfMinor = new Map()
for (const v of all) lastOfMinor.set(v.split('.').slice(0, 2).join('.'), v)
const first = [...lastOfMinor.values()].reverse()
const rest = all.filter(v => !first.includes(v)).reverse()
console.log([...first, ...rest].join('\n'))

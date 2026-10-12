// Orders the unpacked pnpm releases of the given majors for a sweep, as release-order.js does for a whole package
// manager: the last patch of every minor first, newest first, then every other release, newest first.
// Usage: node pnpm-sweep-order.js <pm dir> <major> [major ...] [--first-pass] [--rest]
//   --first-pass prints only the last patch of every minor, --rest only the others
const fs = require('fs')
const [dir, ...rest] = process.argv.slice(2)
const majors = rest.filter(a => /^\d+$/.test(a))
const firstOnly = rest.includes('--first-pass')
const restOnly = rest.includes('--rest')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const all = fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v) && majors.includes(v.split('.')[0])).sort(cmp)
const lastOfMinor = new Map()
for (const v of all) lastOfMinor.set(v.split('.').slice(0, 2).join('.'), v)
const first = [...lastOfMinor.values()].reverse()
const others = all.filter(v => !first.includes(v)).reverse()
console.log([...(restOnly ? [] : first), ...(firstOnly ? [] : others)].join('\n'))

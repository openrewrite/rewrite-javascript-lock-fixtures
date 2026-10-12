// Summarizes pnpm's releases from its packument: stable releases per major.minor with dates, dist-tags, the Node
// each declares (engines.node), its bin and module type, and whether the manifest names dependencies (a bundled CLI
// names none).
// Usage: node pnpm-releases.js <packument.json> [--all] [--list <min-major>]
//   --list prints every stable release from that major on, one per line (for fetch-pm.js and the sweep)
const fs = require('fs')
const doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const all = process.argv.includes('--all')
const listAt = process.argv.indexOf('--list')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const stable = Object.keys(doc.versions).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
if (listAt >= 0) {
  const min = Number(process.argv[listAt + 1] || 0)
  console.log(stable.filter(v => Number(v.split('.')[0]) >= min).join('\n'))
  process.exit(0)
}
console.log('dist-tags', JSON.stringify(doc['dist-tags']))
console.log('stable releases', stable.length, 'of', Object.keys(doc.versions).length)
const byMajor = {}
for (const v of stable) {
  const major = Number(v.split('.')[0])
  if (major < 5 && !all) continue
  ;(byMajor[major] = byMajor[major] || []).push(v)
}
const binOf = m => typeof m.bin === 'string' ? m.bin : m.bin ? m.bin.pnpm : '-'
for (const [major, vs] of Object.entries(byMajor)) {
  const minors = {}
  for (const v of vs) {
    const minor = v.split('.').slice(0, 2).join('.')
    ;(minors[minor] = minors[minor] || []).push(v)
  }
  const deprecated = vs.filter(v => doc.versions[v].deprecated)
  console.log(`\npnpm ${major}: ${vs.length} releases, ${vs[0]} (${doc.time[vs[0]].slice(0, 10)}) .. ${vs[vs.length - 1]} (${doc.time[vs[vs.length - 1]].slice(0, 10)})${deprecated.length ? `, ${deprecated.length} deprecated${deprecated.length <= 12 ? `: ${deprecated.join(' ')}` : ''}` : ''}`)
  for (const [minor, ms] of Object.entries(minors)) {
    const last = ms[ms.length - 1]
    const m = doc.versions[last]
    const engines = m.engines ? m.engines.node : ''
    const deps = Object.keys(m.dependencies || {}).length
    console.log(`  ${minor}.x  ${String(ms.length).padStart(2)} patch(es)  ${ms[0].padEnd(9)} ${doc.time[ms[0]].slice(0, 10)} .. ${last.padEnd(9)} ${doc.time[last].slice(0, 10)}  node ${String(engines).padEnd(22)} bin ${binOf(m)}${m.type ? ` type=${m.type}` : ''}${deps ? ` deps=${deps}` : ''}`)
  }
}

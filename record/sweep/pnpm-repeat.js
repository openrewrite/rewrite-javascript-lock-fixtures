// Compares several runs of one release over the same scenarios (the control run twice or more): a scenario whose
// outcome differs between two runs follows something else than its inputs (timing, mostly), and is unstable.
// Prints each such scenario with the phases that differ and what differs in them, and writes the list.
// Usage: node pnpm-repeat.js <release> <sweep out dir> <another out dir> [...] [--write <file>]
const fs = require('fs')
const path = require('path')
const { diff } = require('./pnpm-lock-diff.js')
const { PHASES, lockText, loadCell, reproduces, read, tree } = require('./pnpm-cell.js')

const args = process.argv.slice(2)
const writeAt = args.indexOf('--write')
const writeTo = writeAt >= 0 ? args[writeAt + 1] : null
const [release, ...dirs] = writeAt >= 0 ? [...args.slice(0, writeAt), ...args.slice(writeAt + 2)] : args
const runs = dirs.map(d => path.join(path.resolve(d), release)).filter(d => fs.existsSync(d))
const names = new Set()
for (const run of runs) for (const e of fs.readdirSync(run, { withFileTypes: true })) if (e.isDirectory()) names.add(e.name)

const lines = [`pnpm ${release}: ${runs.length} runs of ${names.size} scenarios`]
const unstable = []
let compared = 0
for (const name of [...names].sort()) {
  const cells = runs.map(run => loadCell(path.join(run, name)))
  if (cells.some(c => !c) || cells[0].r.skip) continue
  compared++
  const differing = PHASES.filter(ph => new Set(cells.map(c => c.sig[ph])).size > 1)
  if (!differing.length) continue
  const what = []
  for (const ph of differing) {
    const outcomes = new Map()
    cells.forEach((c, n) => outcomes.set(c.sig[ph], [...(outcomes.get(c.sig[ph]) || []), n + 1]))
    const [first, second] = [...outcomes.values()].map(ns => cells[ns[0] - 1])
    const [la, lb] = [lockText(first, ph), lockText(second, ph)]
    let detail = la !== lb ? `lock: ${la == null || lb == null ? 'written in one run only' : diff(la, lb).detail.slice(0, 4).join('; ')}` : ''
    if (!detail) {
      const files = new Set([...tree(path.join(first.dir, 'locks', ph)), ...tree(path.join(second.dir, 'locks', ph))])
      const other = [...files].filter(f => read(path.join(first.dir, 'locks', ph, f)) !== read(path.join(second.dir, 'locks', ph, f)))
      detail = other.length ? `another project's lock: ${other.join(', ')}` : `exit ${first.r.exits[ph]} / ${second.r.exits[ph]}, errors ${JSON.stringify((first.r.errors || {})[ph] || [])} / ${JSON.stringify((second.r.errors || {})[ph] || [])}`
    }
    what.push(`${ph}: ${outcomes.size} outcomes over runs ${[...outcomes.values()].map(ns => ns.join(',')).join(' | ')} (${detail})`)
  }
  unstable.push(name)
  lines.push(`  ${name}: reproduces its fixture in runs ${cells.map((c, n) => reproduces(c) ? n + 1 : null).filter(Boolean).join(',') || 'none'}`)
  lines.push(...what.map(w => `      ${w}`))
}
lines.splice(1, 0, `${compared} compared, ${unstable.length} with an outcome that differs between runs`)
console.log(lines.join('\n'))
if (writeTo) fs.writeFileSync(writeTo, [`# scenarios whose outcome differs between ${runs.length} runs of pnpm ${release} (pnpm-repeat.js)`, ...unstable].join('\n') + '\n')

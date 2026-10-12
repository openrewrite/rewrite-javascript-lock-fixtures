// Names the cells that say where an outcome changes between two swept releases with unswept releases between them:
// for every pair of consecutive complete releases A < B and every scenario whose cells differ between A and B (any
// phase: exit, lock bytes, .yarnrc.yml written, failure text, second installs), the scenario's cell in every release
// between A and B. Sweeping those first pins each change to its release; the other cells of the releases between (a
// scenario that A and B treat alike) are swept afterwards, for a change that came and went inside the gap.
// Prints "release scenario" lines for sweep-yarn-berry.js --cells-file, the release nearest the baseline first.
// Usage: node yarn-berry-plan.js <sweep out dir> <pm dir> [--baseline 4.10.3] [--majors 4]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { failureOf } = require('./yarn-berry-failure.js')

const out = path.resolve(process.argv[2])
const pm = path.resolve(process.argv[3])
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const BASE = arg('baseline', '4.10.3')
const MAJORS = arg('majors') ? arg('majors').split(',') : null
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const sha = f => fs.existsSync(f) ? crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '-'
const scenarios = fs.readdirSync(path.join(out, 'control')).filter(s => fs.existsSync(path.join(out, 'control', s, 'result.json'))).sort()
const all = fs.readdirSync(pm).filter(v => /^\d+\.\d+\.\d+$/.test(v) && (!MAJORS || MAJORS.includes(v.split('.')[0]))).sort(cmp)
const complete = v => scenarios.every(s => fs.existsSync(path.join(out, v, s, 'result.json')))
const done = all.filter(complete)

const sigOf = (v, s) => {
  const dir = path.join(out, v, s)
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'))
  if (r.skip) return 'skip'
  const fail = Object.keys(r.exits || {}).filter(ph => r.exits[ph] !== 0).map(ph => {
    const log = path.join(dir, `${ph}.log`)
    return `${ph}:${failureOf(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')}`
  })
  return JSON.stringify([r.exits, r.again, r.crossAgain, fail,
    ['before', 'after', 'after-again', 'cross', 'cross-again', 'yarnrc-before.written', 'yarnrc.written', 'cross.yarnrc.written'].map(f => sha(path.join(dir, f)))])
}
const cells = []
const gaps = []
for (let i = 1; i < done.length; i++) {
  const [a, b] = [done[i - 1], done[i]]
  const between = all.filter(v => cmp(v, a) > 0 && cmp(v, b) < 0)
  if (!between.length) continue
  const differing = scenarios.filter(s => sigOf(a, s) !== sigOf(b, s))
  gaps.push(`${a} .. ${b}: ${between.length} releases between (${between.join(' ')}), ${differing.length} scenarios differ`)
  for (const v of between) for (const s of differing) if (!fs.existsSync(path.join(out, v, s, 'result.json'))) cells.push([v, s])
}
// nearest the baseline first
const distance = v => Math.abs(all.indexOf(v) - all.indexOf(BASE))
cells.sort((x, y) => distance(x[0]) - distance(y[0]) || cmp(x[0], y[0]) || x[1].localeCompare(y[1]))
for (const g of gaps) console.error(g)
console.error(`${cells.length} cells to sweep first`)
console.log(cells.map(c => c.join(' ')).join('\n'))

// Prints the unified diff of the upstream files the port names between two Yarn Berry releases, from the copies
// yarn-berry-source-inventory.js keeps under <inventory>/yarn-berry-source/<version>/.
// Usage: node yarn-berry-source-diff.js <inventory dir> <from version> <to version> [substring of a file path ...] [--context 3]
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const ctxAt = args.indexOf('--context')
const context = ctxAt < 0 ? '3' : args[ctxAt + 1]
const plain = args.filter((a, i) => !a.startsWith('--') && (ctxAt < 0 || i !== ctxAt + 1))
const [inv, from, to, ...filters] = plain
const store = path.join(path.resolve(inv), 'yarn-berry-source')

const filesOf = v => {
  const out = []
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (!e.name.endsWith('.404')) out.push(r)
    }
  }
  walk(path.join(store, v), '')
  return out
}
const all = [...new Set([...filesOf(from), ...filesOf(to)])].sort().filter(f => !filters.length || filters.some(x => f.includes(x)))
for (const f of all) {
  const a = path.join(store, from, f)
  const b = path.join(store, to, f)
  if (!fs.existsSync(a)) {
    console.log(`######## ${f}: not in ${from}, ${fs.readFileSync(b, 'utf8').split('\n').length} lines in ${to}`)
    continue
  }
  if (!fs.existsSync(b)) {
    console.log(`######## ${f}: in ${from}, not in ${to}`)
    continue
  }
  let diff = ''
  try {
    execFileSync('/usr/bin/diff', [`-U${context}`, a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    diff = e.stdout || ''
  }
  if (!diff) continue
  console.log(`######## ${f}  (${from} -> ${to})`)
  console.log(diff.split('\n').slice(2).join('\n'))
}

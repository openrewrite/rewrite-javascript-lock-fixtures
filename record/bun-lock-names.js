// Prints `name@version` for every registry tuple in a scenario's bun locks (before, after, fresh),
// for passing to fetch-http.js, which cannot parse bun.lock (JSONC) itself.
// Usage: node record/bun-lock-names.js <scenario-dir>
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const out = new Set()

const parseJsonc = text => JSON.parse(text.replace(/^\s*\/\/[^\n]*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))

for (const f of ['before', 'after', 'fresh']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  let lock
  try {
    lock = parseJsonc(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`  ${f}: not parseable as bun.lock (${e.message})`)
    continue
  }
  for (const tuple of Object.values(lock.packages || {})) {
    if (!Array.isArray(tuple) || tuple.length !== 4 || typeof tuple[1] !== 'string') continue
    const at = tuple[0].lastIndexOf('@')
    if (at <= 0) continue
    const version = tuple[0].slice(at + 1)
    if (/^[0-9]/.test(version)) out.add(tuple[0])
  }
}
console.log([...out].sort().join('\n'))

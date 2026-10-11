// Drops the people and README fields from recorded registry responses (a scenario's http/ files): no lock is
// written from them. _npmUser keeps only trustedPublisher, which pnpm's trust policy reads.
// Usage: node record/strip-registry-people.js <dir> [--dry]
const fs = require('fs')
const path = require('path')
const [root, flag] = process.argv.slice(2)
const dry = flag === '--dry'
const DROP = ['readme', 'readmeFilename', 'maintainers', 'author', 'contributors', 'users', 'bugs']

const strip = o => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  let changed = false
  for (const k of DROP) if (k in o) { delete o[k]; changed = true }
  if ('_npmUser' in o) {
    const u = o._npmUser
    const kept = u && typeof u === 'object' && 'trustedPublisher' in u ? { trustedPublisher: u.trustedPublisher } : {}
    if (JSON.stringify(kept) !== JSON.stringify(u)) { o._npmUser = kept; changed = true }
  }
  return changed
}

let seen = 0, rewritten = 0, skipped = 0, before = 0, after = 0
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!p.split(path.sep).includes('http')) continue
    const text = fs.readFileSync(p, 'utf8')
    if (text[0] !== '{') continue
    let j
    try { j = JSON.parse(text) } catch { skipped++; continue }
    seen++
    let changed = strip(j)
    if (j.versions && typeof j.versions === 'object') for (const v of Object.values(j.versions)) changed = strip(v) || changed
    if (!changed) continue
    const out = JSON.stringify(j) + (text.endsWith('\n') ? '\n' : '')
    if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(j)) throw new Error('round trip differs: ' + p)
    rewritten++; before += Buffer.byteLength(text); after += Buffer.byteLength(out)
    if (!dry) fs.writeFileSync(p, out)
  }
}
walk(root)
console.log(`${seen} JSON responses, ${rewritten} ${dry ? 'would be ' : ''}rewritten (${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB), ${skipped} not JSON`)

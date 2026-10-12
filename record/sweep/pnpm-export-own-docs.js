// After the pnpm export: removes the copies of pnpm's own registry documents (pnpm, @pnpm/*, @reflink/*, detect-libc)
// it added to the scenarios that pin a pnpm release, about 81 MB, and rewrites the created list without them. Every
// release's replay of every scenario is the same without them: the engine reads no pnpm packument.
// Usage: node pnpm-export-own-docs.js <exported lock/pnpm> <created list>
const fs = require('fs')
const path = require('path')

const [root, created] = process.argv.slice(2)
const OWN = /^lock\/pnpm\/[^/]+\/http\/(pnpm(@full)?|@pnpm\/.+|@reflink\/.+|detect-libc(@full)?)$/
const kept = []
let removed = 0
let bytes = 0
for (const line of fs.readFileSync(created, 'utf8').split('\n')) {
  const p = line.trim()
  if (!p) continue
  if (!OWN.test(p)) {
    kept.push(p)
    continue
  }
  const file = path.join(root, p.slice('lock/pnpm/'.length))
  if (fs.existsSync(file)) {
    bytes += fs.statSync(file).size
    fs.rmSync(file)
    removed++
    // a scope directory the removal emptied (http/@pnpm/) goes too
    for (let dir = path.dirname(file); path.basename(dir) !== 'http' && fs.readdirSync(dir).length === 0;
         dir = path.dirname(dir)) {
      fs.rmdirSync(dir)
    }
  }
}
fs.writeFileSync(created, kept.map(p => p + '\n').join(''))
console.log(`removed ${removed} files (${bytes} bytes); ${kept.length} kept in ${created}`)

// Prints `name@version` for every registry entry of a scenario's yarn v1 locks (`before`, `after`), one per
// line, for fetch-http.js. The real package name comes from the resolved tarball URL, so an alias
// (`foo@npm:bar@^1`) yields `bar@<version>`. With --tarballs, also downloads each resolved tarball into
// <scenario>/http/<name>-<version>.tgz.
// Usage: node record/yarn-lock-names.js <scenario-dir> [--tarballs]
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const tarballs = process.argv.includes('--tarballs')
const REGISTRY = /^https?:\/\/registry\.(?:yarnpkg\.com|npmjs\.org)\/((?:@[^/]+\/)?[^/]+)\/-\/[^#]+$/

const entries = new Map()
for (const f of ['before', 'after']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  let version = null
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\S.*:$/.test(line) && !line.startsWith('#')) {
      version = null
      continue
    }
    const v = line.match(/^ {2}version "?([^"]+)"?$/)
    if (v) version = v[1]
    const r = line.match(/^ {2}resolved "?([^"]+)"?$/)
    if (r && version) {
      const url = r[1].split('#')[0]
      const m = url.match(REGISTRY)
      if (m) entries.set(`${decodeURIComponent(m[1])}@${version}`, url)
    }
  }
}

const main = async () => {
  for (const nv of [...entries.keys()].sort()) console.log(nv)
  if (!tarballs) return
  const http = path.join(dir, 'http')
  fs.mkdirSync(http, { recursive: true })
  for (const [nv, url] of entries) {
    const at = nv.lastIndexOf('@')
    const file = path.join(http, `${nv.slice(0, at)}-${nv.slice(at + 1)}.tgz`)
    if (fs.existsSync(file)) continue
    const res = await fetch(url.replace('registry.yarnpkg.com', 'registry.npmjs.org'))
    if (!res.ok) {
      console.error(`  ${res.status} ${url}`)
      continue
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

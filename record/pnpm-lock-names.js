// Prints `name@version` for every registry package a scenario's pnpm locks (`before`, `after`) name in
// their `packages:` section, one per argument, for fetch-http.js. Keys whose version is not semver
// (git, tarball, directory, link) are skipped.
// Usage: node record/pnpm-lock-names.js <scenario-dir>
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const out = new Set()
for (const f of ['before', 'after']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  let inPackages = false
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:/.test(line)
      continue
    }
    if (!inPackages) continue
    const m = line.match(/^  (?:'([^']+)'|([^\s'][^:]*)):\s*$/)
    if (!m) continue
    // v9 `name@1.0.0`, v6 `/name@1.0.0(peer@1.0.0)`, v5 `/name/1.0.0_peer@1.0.0`
    let key = (m[1] || m[2]).replace(/^\//, '').replace(/\(.*$/, '')
    const v5 = key.match(/^((?:@[^/]+\/)?[^/@]+)\/(\d+\.\d+\.\d+[^_]*)/)
    if (v5) key = v5[1] + '@' + v5[2]
    const at = key.lastIndexOf('@')
    if (at <= 0) continue
    const version = key.slice(at + 1)
    if (/^\d+\.\d+\.\d+/.test(version)) out.add(key)
  }
}
process.stdout.write([...out].sort().join(' '))

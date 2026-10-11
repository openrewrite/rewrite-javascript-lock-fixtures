// Fetches the registry responses a yarn-berry scenario refers to into <scenario>/http/:
//   http/<name>, http/<name>-<version>  through fetch-http.js (full packument, as Yarn asks for it, version manifest)
//   http/<name>-<version>.tgz           the tarball, for every locked registry entry that records a checksum
// Names come from the `resolution:` lines of the scenario's before/after locks (npm: and patch: of npm:),
// plus the manifests (read by fetch-http.js) and an optional whitespace-separated `http-names` file.
// Usage: node record/yarn-berry-http.js <scenario-dir>
const fs = require('fs')
const path = require('path')
const {execFileSync} = require('child_process')

const dir = process.argv[2]
const specs = new Set()
const withChecksum = new Set()

for (const f of ['before', 'after']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  for (const block of fs.readFileSync(p, 'utf8').split(/\n\n+/)) {
    const res = block.match(/^ {2}resolution: "?(.*?)"?$/m)
    if (!res) continue
    let r = res[1]
    const patch = r.match(/^(?:@[^/]+\/)?[^@]+@patch:(.*?)#/)
    if (patch) r = decodeURIComponent(patch[1])
    const m = r.match(/^((?:@[^/]+\/)?[^@]+)@npm:([^:#]+)/)
    if (!m) continue
    const spec = `${m[1]}@${m[2]}`
    specs.add(spec)
    if (/^ {2}checksum: /m.test(block)) withChecksum.add(spec)
  }
}

const extra = path.join(dir, 'http-names')
if (fs.existsSync(extra)) {
  for (const s of fs.readFileSync(extra, 'utf8').split(/\s+/)) if (s) specs.add(s)
}

execFileSync('node', [path.join(__dirname, 'fetch-http.js'), dir, ...[...specs].sort()],
  {stdio: 'inherit', env: {...process.env, FULL_PACKUMENTS: '1'}})

const main = async () => {
  let count = 0
  for (const spec of [...withChecksum].sort()) {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const file = path.join(dir, 'http', `${name}-${version}.tgz`)
    if (fs.existsSync(file)) continue
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'http', `${name}-${version}`), 'utf8'))
    const res = await fetch(manifest.dist.tarball)
    if (!res.ok) {
      console.error(`  ${res.status} ${manifest.dist.tarball}`)
      continue
    }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    count++
  }
  console.log(`  http: ${count} tarballs`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

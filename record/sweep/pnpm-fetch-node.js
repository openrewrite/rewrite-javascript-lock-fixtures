// Downloads official Node.js releases for this machine from nodejs.org/dist and unpacks each into its own directory:
//   <dest>/<version>/bin/node
// The tarball's SHA-256 is checked against the release's SHASUMS256.txt before it is unpacked.
// Usage: node pnpm-fetch-node.js <dest> v24.19.0 [v22.13.0 ...]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const [dest, ...versions] = process.argv.slice(2)
const target = `${process.platform}-${process.arch}`

const fetchOne = async version => {
  const dir = path.join(dest, version)
  if (fs.existsSync(path.join(dir, '.ok'))) return 'cached'
  const base = `https://nodejs.org/dist/${version}`
  const file = `node-${version}-${target}.tar.gz`
  const sums = await fetch(`${base}/SHASUMS256.txt`)
  if (!sums.ok) throw new Error(`${sums.status} ${base}/SHASUMS256.txt`)
  const line = (await sums.text()).split('\n').find(l => l.endsWith(`  ${file}`))
  if (!line) throw new Error(`${file} is not in SHASUMS256.txt`)
  const want = line.split(/\s+/)[0]
  const res = await fetch(`${base}/${file}`)
  if (!res.ok) throw new Error(`${res.status} ${base}/${file}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(buf).digest('hex')
  if (got !== want) throw new Error(`${file}: sha256 ${got}, SHASUMS256.txt says ${want}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, file)
  fs.writeFileSync(tgz, buf)
  execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components', '1'], { stdio: 'ignore' })
  fs.rmSync(tgz)
  fs.writeFileSync(path.join(dir, '.ok'), `${base}/${file} sha256 ${want}\n`)
  return 'fetched'
}

const main = async () => {
  for (const v of versions) {
    try {
      console.log(`${v}: ${await fetchOne(v)}`)
    } catch (e) {
      console.error(`${v}: failed: ${e.message}`)
      process.exitCode = 1
    }
  }
}
main()

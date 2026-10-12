// Fetches official Node.js builds for this machine (nodejs.org/dist), checks each archive against the release's
// SHASUMS256.txt and unpacks it: <dest>/<version>/bin/node. For the Yarn releases that do not run under the Node on
// PATH (sweep-yarn-berry.js --node-for).
// Usage: node yarn-berry-fetch-node.js <dest> <version> [<version> ...]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const [dest, ...versions] = process.argv.slice(2)
const platform = `${process.platform}-${process.arch}`
const main = async () => {
  for (const v of versions) {
    const dir = path.join(path.resolve(dest), v)
    if (fs.existsSync(path.join(dir, '.ok'))) {
      console.log(`${v}: kept (${fs.readFileSync(path.join(dir, '.ok'), 'utf8').trim()})`)
      continue
    }
    const base = `https://nodejs.org/dist/v${v}`
    const name = `node-v${v}-${platform}.tar.gz`
    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
    const line = sums.split('\n').find(l => l.endsWith(`  ${name}`))
    if (!line) throw new Error(`${v}: SHASUMS256.txt has no ${name}`)
    const want = line.split(/\s+/)[0]
    const res = await fetch(`${base}/${name}`)
    if (!res.ok) throw new Error(`${base}/${name}: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got !== want) throw new Error(`${name}: sha256 ${got}, SHASUMS256.txt says ${want}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const tgz = path.join(dir, name)
    fs.writeFileSync(tgz, buf)
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components', '1'], { stdio: 'ignore' })
    fs.rmSync(tgz)
    const says = execFileSync(path.join(dir, 'bin', 'node'), ['--version'], { encoding: 'utf8' }).trim()
    if (says !== `v${v}`) throw new Error(`${dir}/bin/node says ${says}`)
    fs.writeFileSync(path.join(dir, '.ok'), `sha256 ${want} ${base}/${name}\n`)
    console.log(`${v}: ${platform}, sha256 ${want}`)
  }
}
main().catch(e => {
  console.error(e)
  process.exit(1)
})

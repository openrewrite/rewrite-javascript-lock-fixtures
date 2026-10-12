// Downloads releases of a registry package (a package manager's CLI) and unpacks each into its own directory:
//   <dest>/<version>/package/...
// Each tarball is checked against the packument's dist.integrity (or shasum) before it is unpacked.
// Usage: node fetch-pm.js <packument.json> <dest> <version|range-regex> [...]   (a /regex/ selects stable versions)
//        JOBS=8 by default
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const [packumentFile, dest, ...selectors] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(packumentFile, 'utf8'))
const jobs = Number(process.env.JOBS || 8)

const wanted = new Set()
for (const sel of selectors) {
  if (sel.startsWith('/')) {
    const re = new RegExp(sel.slice(1, sel.lastIndexOf('/')))
    for (const v of Object.keys(doc.versions)) if (re.test(v)) wanted.add(v)
  } else if (doc.versions[sel]) {
    wanted.add(sel)
  } else {
    console.error(`no such version: ${sel}`)
    process.exitCode = 1
  }
}

const verify = (buf, dist) => {
  if (dist.integrity) {
    for (const part of dist.integrity.split(/\s+/)) {
      const [algo, b64] = [part.slice(0, part.indexOf('-')), part.slice(part.indexOf('-') + 1)]
      if (crypto.createHash(algo).update(buf).digest('base64') !== b64) return `${algo} mismatch`
    }
    return null
  }
  if (dist.shasum) return crypto.createHash('sha1').update(buf).digest('hex') === dist.shasum ? null : 'sha1 mismatch'
  return 'no integrity'
}

const fetchOne = async version => {
  const dir = path.join(dest, version)
  if (fs.existsSync(path.join(dir, '.ok'))) return 'cached'
  const dist = doc.versions[version].dist
  const res = await fetch(dist.tarball)
  if (!res.ok) throw new Error(`${res.status} ${dist.tarball}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const bad = verify(buf, dist)
  if (bad) throw new Error(`${version}: ${bad}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dir, 'release.tgz')
  fs.writeFileSync(tgz, buf)
  // every registry tarball unpacks under one top-level directory, usually package/
  const pkg = path.join(dir, 'package')
  fs.mkdirSync(pkg)
  execFileSync('tar', ['-xzf', tgz, '-C', pkg, '--strip-components', '1'], { stdio: 'ignore' })
  fs.rmSync(tgz)
  fs.writeFileSync(path.join(dir, '.ok'), `${dist.integrity || dist.shasum}\n`)
  return 'fetched'
}

const main = async () => {
  const queue = [...wanted]
  let done = 0
  const failed = []
  const worker = async () => {
    for (;;) {
      const v = queue.shift()
      if (!v) return
      try {
        await fetchOne(v)
      } catch (e) {
        failed.push(`${v}: ${e.message}`)
      }
      done++
      if (done % 25 === 0) console.log(`  ${done}/${wanted.size}`)
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  console.log(`${wanted.size - failed.length} of ${wanted.size} releases under ${dest}`)
  for (const f of failed) console.error(`  failed ${f}`)
  if (failed.length) process.exitCode = 1
}
main()

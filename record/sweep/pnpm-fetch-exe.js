// pnpm 12 is a native executable: the `pnpm` registry package is a wrapper, and the executable is the platform
// package it names in optionalDependencies (@pnpm/exe.<platform>-<arch>). This downloads that platform package for
// each release already unpacked by fetch-pm.js and unpacks it where npm would install it beside the wrapper:
//   <dest>/<version>/package/                     the wrapper (fetch-pm.js)
//   <dest>/<version>/@pnpm/exe.<target>/pnpm      the executable
// Each tarball is checked against the packument's dist.integrity before it is unpacked. Releases whose wrapper names
// no such optional dependency are left alone.
// Usage: node pnpm-fetch-exe.js <platform packument.json> <dest> [version ...]   (default: every unpacked release)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const [packumentFile, dest, ...only] = process.argv.slice(2)
const doc = JSON.parse(fs.readFileSync(packumentFile, 'utf8'))
const name = doc.name
const jobs = Number(process.env.JOBS || 4)

const verify = (buf, dist) => {
  if (!dist.integrity) return 'no integrity'
  for (const part of dist.integrity.split(/\s+/)) {
    const [algo, b64] = [part.slice(0, part.indexOf('-')), part.slice(part.indexOf('-') + 1)]
    if (crypto.createHash(algo).update(buf).digest('base64') !== b64) return `${algo} mismatch`
  }
  return null
}

const versions = (only.length ? only : fs.readdirSync(dest).filter(v => /^\d+\.\d+\.\d+$/.test(v))).filter(v => {
  const manifest = path.join(dest, v, 'package', 'package.json')
  if (!fs.existsSync(manifest)) return false
  return ((JSON.parse(fs.readFileSync(manifest, 'utf8')).optionalDependencies) || {})[name] === v
})

const fetchOne = async version => {
  const dir = path.join(dest, version, ...name.split('/'))
  const ok = path.join(dest, version, '.exe-ok')
  if (fs.existsSync(ok)) return 'cached'
  const m = doc.versions[version]
  if (!m) throw new Error(`${name}@${version} is not in the packument`)
  const res = await fetch(m.dist.tarball)
  if (!res.ok) throw new Error(`${res.status} ${m.dist.tarball}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const bad = verify(buf, m.dist)
  if (bad) throw new Error(`${version}: ${bad}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tgz = path.join(dest, version, 'exe.tgz')
  fs.writeFileSync(tgz, buf)
  execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components', '1'], { stdio: 'ignore' })
  fs.rmSync(tgz)
  fs.writeFileSync(ok, `${name}@${version} ${m.dist.integrity}\n`)
  return 'fetched'
}

const main = async () => {
  const queue = [...versions]
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
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  console.log(`${versions.length - failed.length} of ${versions.length} ${name} executables under ${dest}`)
  for (const f of failed) console.error(`  failed ${f}`)
  if (failed.length) process.exitCode = 1
}
main()

// Fetches every stable Yarn Berry release (2.x, 3.x, 4.x) into its own directory:
//   <dest>/<version>/package/bin/yarn.js    the release, a single file
//   <dest>/<version>/source.json            where it came from and what it was checked against
// A release has two published forms. Corepack downloads https://repo.yarnpkg.com/<version>/packages/yarnpkg-cli/bin/yarn.js
// (the list of releases is https://repo.yarnpkg.com/tags), which carries no integrity. Most releases are also the npm
// package @yarnpkg/cli-dist, whose tarball the registry signs with dist.integrity; fetch-pm.js unpacks and checks
// those first (run it before this script). This script downloads the repo.yarnpkg.com file of every release and
// compares it byte for byte with the integrity-checked npm one; a release npm does not have is kept from
// repo.yarnpkg.com alone, and source.json says so.
// Usage: node yarn-berry-fetch.js <tags.json> <cli-dist packument.json> <dest>     (JOBS=4 by default)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const [tagsFile, packumentFile, dest] = process.argv.slice(2)
const tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
const doc = JSON.parse(fs.readFileSync(packumentFile, 'utf8'))
const jobs = Number(process.env.JOBS || 4)
const stable = v => /^\d+\.\d+\.\d+$/.test(v)
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const sha512 = buf => crypto.createHash('sha512').update(buf).digest('hex')
const versions = [...new Set([...tags.tags.filter(stable), ...Object.keys(doc.versions).filter(stable)])]
  .filter(v => Number(v.split('.')[0]) >= 2).sort(cmp)

const fetchOne = async version => {
  const dir = path.join(dest, version)
  const bin = path.join(dir, 'package', 'bin', 'yarn.js')
  const sourceFile = path.join(dir, 'source.json')
  if (fs.existsSync(sourceFile) && fs.existsSync(bin)) return JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
  const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`
  const res = await fetch(url)
  const source = { version, repo: { url, status: res.status }, npm: null }
  const repoBody = res.ok ? Buffer.from(await res.arrayBuffer()) : null
  if (repoBody) Object.assign(source.repo, { bytes: repoBody.length, sha512: sha512(repoBody) })
  const dist = doc.versions[version] && doc.versions[version].dist
  const okFile = path.join(dir, '.ok')
  if (dist && fs.existsSync(okFile) && fs.existsSync(bin)) {
    const npmBody = fs.readFileSync(bin)
    source.npm = { tarball: dist.tarball, integrity: dist.integrity, checked: fs.readFileSync(okFile, 'utf8').trim() === dist.integrity,
      bytes: npmBody.length, sha512: sha512(npmBody) }
    source.identical = repoBody ? repoBody.equals(npmBody) : null
    // what corepack runs is the repo.yarnpkg.com file: when the two differ, keep both and run that one
    if (repoBody && !source.identical) {
      fs.renameSync(bin, bin + '.npm')
      fs.writeFileSync(bin, repoBody)
    }
  } else if (repoBody) {
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, repoBody)
    source.identical = null
  } else {
    throw new Error(`${version}: neither on npm nor at ${url} (${res.status})`)
  }
  source.runs = repoBody ? 'repo.yarnpkg.com' : 'npm'
  fs.writeFileSync(sourceFile, JSON.stringify(source, null, 1) + '\n')
  return source
}

const main = async () => {
  const queue = [...versions]
  const done = []
  const failed = []
  const worker = async () => {
    for (;;) {
      const v = queue.shift()
      if (!v) return
      try {
        done.push(await fetchOne(v))
      } catch (e) {
        failed.push(`${v}: ${e.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  done.sort((a, b) => cmp(a.version, b.version))
  const lines = done.map(s => [s.version.padEnd(8), `runs ${s.runs}`.padEnd(22),
    s.npm ? `npm integrity ${s.npm.checked ? 'checked' : 'NOT CHECKED'}` : 'not on npm (no integrity)',
    s.identical === true ? 'identical to repo.yarnpkg.com' : s.identical === false ? 'DIFFERS from repo.yarnpkg.com' : s.repo.sha512 ? '' : `repo.yarnpkg.com ${s.repo.status}`,
    `sha512 ${(s.repo.sha512 || s.npm.sha512).slice(0, 16)}`].join('  '))
  fs.writeFileSync(path.join(dest, 'sources.txt'), lines.join('\n') + '\n')
  console.log(`${done.length} of ${versions.length} releases under ${dest}; ${done.filter(s => s.npm && s.npm.checked).length} checked against npm integrity, ` +
    `${done.filter(s => s.identical === true).length} identical in both forms, ${done.filter(s => s.identical === false).length} differ, ${done.filter(s => !s.npm).length} from repo.yarnpkg.com only`)
  for (const f of failed) console.error(`  failed ${f}`)
  if (failed.length) process.exitCode = 1
}
main()

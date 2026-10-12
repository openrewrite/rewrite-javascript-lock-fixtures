// Writes <pm/yarn-classic>/sources.txt: where each unpacked Yarn classic release came from (the registry tarball and
// the integrity bin/fetch-pm.js checked it against), and what else the directory holds.
// Usage: node yarn-classic-sources.js <pm/yarn-classic>
const fs = require('fs')
const path = require('path')
const dir = path.resolve(process.argv[2])
const j = JSON.parse(fs.readFileSync(path.join(dir, 'packument.json'), 'utf8'))
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const rows = [
  'Yarn classic releases under this directory: every stable 1.x version of the npm package `yarn` on registry.npmjs.org',
  `(packument.json, fetched ${fs.statSync(path.join(dir, 'packument.json')).mtime.toISOString().slice(0, 10)}). Each <version>/package/ is the registry tarball (dist.tarball) unpacked by`,
  'bin/fetch-pm.js after its dist.integrity (sha512) was checked; <version>/.ok holds that integrity. _0x/ holds the 0.x releases',
  'the same way (not swept). tags.txt lists the tags of github.com/yarnpkg/yarn; _src/ holds the trees, blobs and diffs of the',
  'upstream source that bin/yarn-classic-source-inventory.js read. bundle-facts.json: bin/yarn-classic-bundle-facts.js.',
  '',
  'version  published   integrity                                                                                           tarball',
]
for (const v of fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  rows.push(`${v.padEnd(8)} ${j.time[v].slice(0, 10)}  ${fs.readFileSync(path.join(dir, v, '.ok'), 'utf8').trim().padEnd(99)} ${j.versions[v].dist.tarball}`)
}
rows.push('',
  '1.22.12 as the registry has it holds no lib/cli.js bundle (its lib/ is the transpiled source and its dependencies are not',
  'bundled): `bin/yarn.js --version` fails with "Cannot find module". The GitHub release v1.22.12 ships a bundle',
  '(yarn-v1.22.12.tar.gz), signed with GPG and published without a digest; this machine has no gpg, so it is not used.')
fs.writeFileSync(path.join(dir, 'sources.txt'), rows.join('\n') + '\n')
console.log(`${rows.length} lines -> ${path.join(dir, 'sources.txt')}`)

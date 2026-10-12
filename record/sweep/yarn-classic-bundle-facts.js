// What each unpacked Yarn classic release does that decides how the sweep must run it, read from its lib/cli.js:
// the Accept header of a packument request, whether it rewrites registry.npmjs.org to registry.yarnpkg.com, writes
// integrity, reads npm_config_* from the environment and takes a proxy from config, checks packageManager, honours
// yarn-path, and which Node versions it refuses.
// Usage: node yarn-classic-bundle-facts.js <pm/yarn-classic> [--json <file>]
const fs = require('fs')
const path = require('path')
const dir = path.resolve(process.argv[2])
const i = process.argv.indexOf('--json')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const releases = fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const facts = {}
const has = (s, re) => re.test(s)
for (const v of releases) {
  const cli = path.join(dir, v, 'package', 'lib', 'cli.js')
  const bin = path.join(dir, v, 'package', 'bin', 'yarn.js')
  if (!fs.existsSync(cli)) {
    // a publish without the bundle (its lib/ holds the transpiled modules, its dependencies are not bundled)
    facts[v] = { bundle: false, files: fs.readdirSync(path.join(dir, v, 'package', 'lib')).length }
    continue
  }
  const s = fs.readFileSync(cli, 'utf8')
  const b = fs.readFileSync(bin, 'utf8')
  const accept = (s.match(/Accept:\s*(?:\/\/[^\n]*\n\s*)*([^\n]*?application\/[^\n]*)/) || [])[1]
  facts[v] = {
    bundle: true,
    bytes: s.length,
    accept: accept ? accept.trim().replace(/,$/, '') : null,
    cleanRegistry: has(s, /cleanRegistry\(dist\.tarball\)/),
    integrity: has(s, /integrity:\s*dist\.integrity/) || has(s, /dist\.integrity \?/),
    mergeEnvNpmConfig: has(s, /mergeEnv\('npm_config_'\)/) || has(s, /npm_config_/),
    httpsProxyOption: has(s, /getOption\('https-proxy'\)/),
    packageManagerCheck: has(s, /This project's package\.json defines/),
    yarnPath: has(s, /'yarn-path'/),
    ignorePathEnv: has(s, /YARN_IGNORE_PATH/),
    lockfileVersionsOption: has(s, /yarn-enable-lockfile-versions|enableLockfileVersions/),
    nodeCheck: (b.match(/majorVer < (\d+)/) || [])[1] || null,
    nodeRange: (s.match(/"engines":\s*\{[^}]*"node":\s*"([^"]+)"/) || [])[1] || JSON.parse(fs.readFileSync(path.join(dir, v, 'package', 'package.json'), 'utf8')).engines?.node || null,
  }
}
const keys = Object.keys(facts[releases[releases.length - 1]])
// print the releases where a fact changes, oldest first
console.log(`release  ${keys.join('  ')}`)
let last = null
for (const v of releases) {
  if (!facts[v].bundle) {
    console.log(`${v.padEnd(8)} NO BUNDLE: package/lib holds ${facts[v].files} entries and no cli.js (an unbuilt publish)`)
    continue
  }
  const row = keys.map(k => JSON.stringify(facts[v][k]))
  const changed = last == null ? keys : keys.filter((k, j) => k !== 'bytes' && row[j] !== last[j])
  if (last == null || changed.length) console.log(`${v.padEnd(8)} ${changed.filter(k => k !== 'bytes').map(k => `${k}=${JSON.stringify(facts[v][k])}`).join('  ')}`)
  last = row
}
if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(facts, null, 1) + '\n')

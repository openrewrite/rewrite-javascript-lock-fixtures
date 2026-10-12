// For every unpacked npm release: the versions and content hashes of the upstream files the Java port's classes
// name (arborist's modules) and of the libraries it ports, so that releases with identical ported source are known,
// and each change between consecutive releases is named.
//   <out>/npm-source.json    release -> { arborist, files: {file: hash}, libs: {name: {version, hash}} }
//   <out>/npm-source.txt     consecutive releases and what changed between them
// Usage: node npm-source-inventory.js <pm/npm dir> <out dir>
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const [pm, outDir] = process.argv.slice(2)
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const sha = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10)

// the arborist modules the port's classes name
const ARBORIST = ['arborist/build-ideal-tree.js', 'arborist/load-virtual.js', 'arborist/index.js', 'arborist/reify.js',
  'shrinkwrap.js', 'node.js', 'link.js', 'edge.js', 'inventory.js', 'override-set.js', 'override-resolves.js',
  'optional-set.js', 'place-dep.js', 'can-place-dep.js', 'peer-entry-sets.js', 'deepest-nesting-target.js',
  'dep-valid.js', 'calc-dep-flags.js', 'reset-dep-flags.js', 'gather-dep-set.js', 'from-path.js', 'relpath.js',
  'consistent-resolve.js', 'case-insensitive-map.js', 'spec-from-lock.js', 'version-from-tgz.js', 'yarn-lock.js',
  'release-age-exclude.js']
// npm's own files the port names
const NPM = ['lib/utils/explain-eresolve.js', 'lib/utils/explain-dep.js', 'lib/commands/install.js']
// the libraries the port ports, or reads through
const LIBS = ['@npmcli/arborist', 'npm-pick-manifest', 'npm-package-arg', 'pacote', '@npmcli/package-json',
  'npm-install-checks', '@npmcli/map-workspaces', 'json-stringify-nice', 'json-parse-even-better-errors', 'semver',
  'hosted-git-info', 'ssri', 'minimatch', 'validate-npm-package-name', '@npmcli/name-from-folder',
  'npm-normalize-package-bin', '@npmcli/config', 'read-package-json-fast', 'read-package-json', 'normalize-package-data',
  'glob', 'treeverse', 'walk-up-path', 'common-ancestor-path', 'brace-expansion', 'npm-registry-fetch',
  '@npmcli/git', 'promise-all-reject-late', '@isaacs/string-locale-compare']

const hashTree = dir => {
  const h = crypto.createHash('sha1')
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'test' || e.name === 'docs' || e.name === 'man') continue
        walk(p)
      } else if (/\.(js|cjs|mjs|json)$/.test(e.name) && e.name !== 'package.json') {
        h.update(path.relative(dir, p))
        h.update(fs.readFileSync(p))
      }
    }
  }
  walk(dir)
  return h.digest('hex').slice(0, 10)
}

const inventory = {}
for (const v of fs.readdirSync(pm).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  const root = path.join(pm, v, 'package')
  const arb = path.join(root, 'node_modules', '@npmcli', 'arborist')
  const entry = { files: {}, libs: {} }
  if (fs.existsSync(arb)) {
    for (const f of ARBORIST) {
      const p = path.join(arb, 'lib', f)
      entry.files[`arborist/${f}`] = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null
    }
    // every other arborist module, as one hash: a module the port does not name may still reach the lock
    const others = crypto.createHash('sha1')
    const names = []
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.js') && !ARBORIST.includes(path.relative(path.join(arb, 'lib'), p))) {
          names.push(path.relative(path.join(arb, 'lib'), p))
          others.update(path.relative(arb, p))
          others.update(fs.readFileSync(p))
        }
      }
    }
    walk(path.join(arb, 'lib'))
    entry.files['arborist/<other modules>'] = others.digest('hex').slice(0, 10)
    entry.otherModules = names
  }
  for (const f of NPM) {
    const p = path.join(root, f)
    entry.files[`npm/${f}`] = fs.existsSync(p) ? sha(fs.readFileSync(p)) : null
  }
  for (const lib of LIBS) {
    const dir = path.join(root, 'node_modules', lib)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    entry.libs[lib] = { version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, hash: hashTree(dir) }
  }
  inventory[v] = entry
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'npm-source.json'), JSON.stringify(inventory, null, 1) + '\n')

const versions = Object.keys(inventory)
const lines = []
let unchangedRun = []
const flush = () => {
  if (unchangedRun.length) lines.push(`    (ported source identical: ${unchangedRun.join(', ')})`)
  unchangedRun = []
}
const ported = new Set(['@npmcli/arborist', 'npm-pick-manifest', 'npm-package-arg', 'pacote', '@npmcli/package-json',
  'npm-install-checks', '@npmcli/map-workspaces', 'json-stringify-nice', 'json-parse-even-better-errors', 'semver',
  'hosted-git-info', 'ssri', 'minimatch', 'validate-npm-package-name', '@npmcli/name-from-folder',
  'npm-normalize-package-bin', '@npmcli/config', 'read-package-json-fast', 'read-package-json', 'normalize-package-data'])
let classes = 1
for (let i = 1; i < versions.length; i++) {
  const [a, b] = [inventory[versions[i - 1]], inventory[versions[i]]]
  const changes = []
  for (const f of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (a.files[f] !== b.files[f]) changes.push(a.files[f] == null ? `+${f}` : b.files[f] == null ? `-${f}` : f)
  }
  for (const lib of new Set([...Object.keys(a.libs), ...Object.keys(b.libs)])) {
    if (lib === '@npmcli/arborist' || !ported.has(lib)) continue
    const [x, y] = [a.libs[lib], b.libs[lib]]
    if (!x) changes.push(`+${lib}@${y.version}`)
    else if (!y) changes.push(`-${lib}`)
    else if (x.hash !== y.hash) changes.push(`${lib} ${x.version}->${y.version}`)
  }
  if (!changes.length) {
    unchangedRun.push(versions[i])
    continue
  }
  flush()
  classes++
  const arbA = a.libs['@npmcli/arborist'] ? a.libs['@npmcli/arborist'].version : '?'
  const arbB = b.libs['@npmcli/arborist'] ? b.libs['@npmcli/arborist'].version : '?'
  lines.push(`${versions[i - 1]} -> ${versions[i]}  (arborist ${arbA} -> ${arbB})`)
  lines.push(`    ${changes.join(', ')}`)
}
flush()
lines.unshift(`${versions.length} releases, ${classes} distinct states of the ported source`, '')
fs.writeFileSync(path.join(outDir, 'npm-source.txt'), lines.join('\n') + '\n')
console.log(lines[0])

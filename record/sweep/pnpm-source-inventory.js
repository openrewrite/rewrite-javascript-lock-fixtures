// For every unpacked pnpm release that ships a bundle (pnpm 9, 10, 11): the content hashes of the modules of
// pnpm's own that the bundle holds, and of the libraries it bundles, so that releases with identical ported source
// are known and each change between consecutive releases is named. The modules the Java port's classes name are
// read from their Javadoc ("Port of @pnpm/lockfile.fs src/write.ts (pnpm 11.2.2)") and marked.
//   <out>/pnpm-source.json   release -> { bundle, own: {module: hash}, libs: {name: {versions, hash}} }
//   <out>/pnpm-source.txt    consecutive releases and what changed between them
// A module's text is hashed with the numbers esbuild appends to colliding names removed (opts2, require_lib57), so a
// module does not count as changed because another one was added before it. pnpm 12 is a native executable and
// holds no such source: its line says so.
// --survey <tsv>: the upstream commits classified by reading (from-9151/pnpm-peers/diffs/survey-lock-workspace.tsv,
// v11.5.1 .. v11.28.5); a pair's line then lists the pull requests of the later release that can change the lock or
// the workspace manifest.
// Usage: node pnpm-source-inventory.js <pm/pnpm dir> <out dir> <java port dir> [--min-major 9] [--survey <tsv>]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { modulesOf, bundleOf } = require('./pnpm-bundle-modules.js')

const [pm, outDir, portDir] = process.argv.slice(2)
const opt = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? null : process.argv[i + 1]
}
const MIN_MAJOR = Number(opt('min-major') || 0)
const survey = new Map()
if (opt('survey')) {
  for (const line of fs.readFileSync(opt('survey'), 'utf8').split('\n')) {
    const [, , version, pr, kind, , , what] = line.split('\t')
    if (!version || !/^v\d/.test(version)) continue
    const v = version.slice(1)
    if (!survey.has(v)) survey.set(v, [])
    survey.get(v).push(`${pr} ${kind}: ${String(what).split(/(?<=\.)\s/)[0].slice(0, 160)}`)
  }
}
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const sha = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)
const normalize = text => text.replace(/\b([A-Za-z_$][A-Za-z0-9_$]*?)\d+\b/g, '$1')

// ---- what the port names: packages of pnpm's monorepo (as pnpm 11 lays them out) and the files in them
const ported = { packages: new Set(), files: new Set(), libs: new Set() }
const dirOf = name => name === 'error' ? 'core/error' : name.split('.').join('/')
for (const f of fs.readdirSync(portDir).filter(f => f.endsWith('.java'))) {
  const text = fs.readFileSync(path.join(portDir, f), 'utf8')
  for (const doc of text.match(/\/\*\*[\s\S]*?\*\//g) || []) {
    const flat = doc.replace(/^\s*\/?\*+\/?/gm, ' ').replace(/\s+/g, ' ')
    if (!/Port of/.test(flat)) continue
    // each @pnpm/<package> with the src/ files named after it, up to the next package
    const parts = flat.split(/(?=@pnpm\/[a-z])/)
    for (const part of parts) {
      const m = part.match(/^@pnpm\/([a-z0-9.-]+[a-z0-9])/)
      if (!m) continue
      const dir = dirOf(m[1])
      ported.packages.add(dir)
      for (const file of part.match(/\bsrc\/[A-Za-z0-9_./-]+\.ts\b/g) || []) ported.files.add(`${dir}/lib/${file.slice(4, -3)}.js`)
    }
    const cli = flat.match(/pnpm\/src ((?:[A-Za-z0-9_]+\.ts(?:,? and |, )?)+)/)
    if (cli) {
      ported.packages.add('pnpm')
      for (const file of cli[1].match(/[A-Za-z0-9_]+\.ts/g)) ported.files.add(`pnpm/lib/${file.slice(0, -3)}.js`)
    }
    for (const lib of flat.match(/\b(json5|tinyglobby|graph-cycles|semver-range-intersect|object-hash|sort-keys|get-npm-tarball-url) \d+\.\d+\.\d+/g) || []) ported.libs.add(lib.split(' ')[0])
  }
}
// the libraries the shared lock package ports for pnpm (internal/lock/CLAUDE.md and ADR 0013)
for (const lib of ['semver', '@zkochan/js-yaml', 'js-yaml', 'yaml', 'picomatch', 'ssri', 'ini', 'strip-bom', 'validate-npm-package-name',
  '@pnpm/npm-package-arg', 'hosted-git-info', '@pnpm/hosted-git-info', 'micromatch', 'braces', 'fill-range', 'fdir', 'normalize-path', 'is-glob', 'glob-parent']) ported.libs.add(lib)

// where pnpm 9 and 10 keep the packages pnpm 11 renamed
const BEFORE_11 = {
  'installing/deps-resolver': 'pkg-manager/resolve-dependencies', 'installing/deps-installer': 'pkg-manager/core',
  'installing/commands': 'pkg-manager/plugin-commands-installation', 'installing/package-requester': 'pkg-manager/package-requester',
  'installing/env-installer': 'config/deps-installer', 'installing/context': 'pkg-manager/get-context',
  'config/reader': 'config/config', 'core/error': 'packages/error', 'deps/path': 'packages/dependency-path',
  'deps/peer-range': 'semver/peer-range', 'cli/utils': 'cli/cli-utils', 'pkg-manifest/utils': 'pkg-manifest/manifest-utils',
  'workspace/project-manifest-reader': 'pkg-manifest/read-project-manifest', 'workspace/projects-graph': 'workspace/pkgs-graph',
  'workspace/projects-reader': 'workspace/find-packages', 'workspace/root-finder': 'workspace/find-workspace-dir',
  'workspace/workspace-manifest-reader': 'workspace/read-manifest', 'workspace/workspace-manifest-writer': 'workspace/manifest-writer',
  'workspace/projects-sorter': 'workspace/sort-packages', 'engine/runtime/node-resolver': 'env/node.resolver',
  'engine/runtime/bun-resolver': 'resolving/bun-resolver', 'engine/runtime/deno-resolver': 'resolving/deno-resolver',
  'store/connection-manager': 'store/store-connection-manager', 'resolving/parse-wanted-dependency': 'packages/parse-wanted-dependency',
}
const oldToNew = Object.fromEntries(Object.entries(BEFORE_11).map(([k, v]) => [v, k]))
const packageOf = module => module.replace(/\/lib\/.*$/, '')
// a module's package under its pnpm 11 name, and whether the port names the package or the file
const mark = module => {
  const pkg = packageOf(module)
  const now = oldToNew[pkg] || pkg
  const file = `${now}${module.slice(pkg.length)}`
  return ported.files.has(file) ? '*' : ported.packages.has(now) ? '+' : ''
}

const inventory = {}
const versions = fs.readdirSync(pm).filter(v => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) >= MIN_MAJOR).sort(cmp)
for (const v of versions) {
  const bundle = bundleOf(pm, v)
  if (!bundle || fs.existsSync(path.join(pm, v, '@pnpm'))) {
    inventory[v] = { native: true }
    continue
  }
  const { own, libs } = modulesOf(bundle)
  const entry = { bundle: path.basename(bundle), bytes: fs.statSync(bundle).size, own: {}, libs: {} }
  for (const [p, text] of own) entry.own[p] = sha(normalize(text))
  for (const [name, lib] of libs) {
    const h = crypto.createHash('sha1')
    for (const [file, text] of [...lib.files].sort()) h.update(file).update(normalize(text))
    entry.libs[name] = { versions: [...lib.versions].sort(), hash: h.digest('hex').slice(0, 10) }
  }
  inventory[v] = entry
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'pnpm-source.json'), JSON.stringify(inventory, null, 1) + '\n')

const lines = []
let identical = []
const flush = () => {
  if (identical.length) lines.push(`    (ported source identical: ${identical.join(', ')})`)
  identical = []
}
let states = 1
let namedPairs = 0
for (let i = 1; i < versions.length; i++) {
  const [va, vb] = [versions[i - 1], versions[i]]
  const [a, b] = [inventory[va], inventory[vb]]
  if (a.native || b.native) {
    flush()
    lines.push(`${va} -> ${vb}`)
    lines.push(a.native && b.native
      ? '    both are native executables (@pnpm/exe.<platform>): no source in the release; diff the upstream tags'
      : '    a JavaScript bundle on one side and a native executable on the other: no common source in the releases')
    continue
  }
  const named = []
  const inPackage = []
  const other = []
  for (const m of new Set([...Object.keys(a.own), ...Object.keys(b.own)])) {
    if (a.own[m] === b.own[m]) continue
    const label = `${a.own[m] == null ? '+' : b.own[m] == null ? '-' : ''}${m}`
    const k = mark(m)
    if (k === '*') named.push(label)
    else if (k === '+') inPackage.push(label)
    else if (!/^cli\/(cli-)?meta\//.test(m)) other.push(label)
  }
  // a library is compared by the versions bundled: a published version never changes, and the bundled text of one
  // version differs between bundles by esbuild's renaming (a pnpm __patches__ patch would hide here; none of the
  // ported libraries is patched at the tags checked)
  const libs = []
  for (const name of new Set([...Object.keys(a.libs), ...Object.keys(b.libs)])) {
    if (!ported.libs.has(name)) continue
    const [x, y] = [a.libs[name], b.libs[name]]
    if (!x) libs.push(`+${name}@${y.versions.join('+')}`)
    else if (!y) libs.push(`-${name}`)
    else if (x.versions.join('+') !== y.versions.join('+')) libs.push(`${name} ${x.versions.join('+')}->${y.versions.join('+')}`)
  }
  let otherLibs = 0
  const versionsOf = l => l ? l.versions.join('+') : '-'
  for (const name of new Set([...Object.keys(a.libs), ...Object.keys(b.libs)])) {
    if (!ported.libs.has(name) && versionsOf(a.libs[name]) !== versionsOf(b.libs[name])) otherLibs++
  }
  const surveyed = survey.get(vb) || []
  if (named.length) namedPairs++
  if (!named.length && !inPackage.length && !libs.length) {
    identical.push(`${vb}${other.length || otherLibs ? ` (${other.length} other modules, ${otherLibs} other libraries changed)` : ''}`)
    if (surveyed.length) {
      flush()
      lines.push(`${va} -> ${vb}  (no ported module changed; the survey still lists for ${vb}:)`)
      lines.push(...surveyed.map(s => `      ${s}`))
    }
    continue
  }
  flush()
  states++
  lines.push(`${va} -> ${vb}`)
  if (named.length) lines.push(`    modules a port class names: ${named.sort().join(', ')}`)
  if (inPackage.length) lines.push(`    other modules of ported packages: ${inPackage.sort().join(', ')}`)
  if (libs.length) lines.push(`    ported libraries: ${libs.sort().join(', ')}`)
  if (other.length || otherLibs) lines.push(`    not ported: ${other.length} modules${other.length ? ` (${other.sort().slice(0, 8).join(', ')}${other.length > 8 ? ', ...' : ''})` : ''}, ${otherLibs} libraries`)
  if (surveyed.length) {
    lines.push(`    surveyed upstream changes of ${vb} that can change the lock or pnpm-workspace.yaml (from-9151 survey):`)
    lines.push(...surveyed.map(s => `      ${s}`))
  }
}
flush()

// --source-diff <file>: an upstream diff between two tags (from-9151/pnpm-peers/diffs/v11.2.2-v11.5.0.diff, its
// packages headed `######## <package>`, its paths relative to the package): which files the port names, set against
// what the bundles say changed over the same releases, so the bundle comparison is checked against the source
const sourceDiff = opt('source-diff')
if (sourceDiff) {
  const [, from, to] = path.basename(sourceDiff).match(/v(\d+\.\d+\.\d+)-v(\d+\.\d+\.\d+)/) || []
  const files = []
  const changedLines = {}
  let pkg = null
  let current = null
  for (const line of fs.readFileSync(sourceDiff, 'utf8').split('\n')) {
    const head = line.match(/^######## (\S+)/)
    if (head) pkg = head[1]
    const d = line.match(/^diff --git a\/(\S+) b\//)
    if (d && pkg) {
      // a package whose diff was taken one directory up names its files from there (core/types: types/src/index.ts)
      const last = pkg.split('/').pop()
      current = d[1].startsWith(`${last}/`) ? `${pkg.split('/').slice(0, -1).join('/')}/${d[1]}` : `${pkg}/${d[1]}`
      files.push(current)
      changedLines[current] = []
    } else if (current && /^[-+](?![-+]{2} )/.test(line)) {
      changedLines[current].push(line.replace(/\s+/g, ' ').slice(0, 100))
    }
  }
  const moduleOf = f => {
    const m = f.match(/^(.*?)\/src\/(.+)\.ts$/)
    return m ? `${m[1] === 'pnpm' ? 'pnpm' : m[1]}/lib/${m[2]}.js` : null
  }
  const named = files.filter(f => moduleOf(f) && ported.files.has(moduleOf(f)))
  const inPackage = files.filter(f => !named.includes(f) && ported.packages.has(f.replace(/\/(src|test|cmd)\/.*$|\/[^/]+$/, '')))
  const rest = files.filter(f => !named.includes(f) && !inPackage.includes(f))
  // what the bundles say changed among the modules the port names, over the same releases
  const span = versions.filter(v => cmp(v, from) >= 0 && cmp(v, to) <= 0)
  const bundleNamed = new Set()
  for (let i = 1; i < span.length; i++) {
    const [a, b] = [inventory[span[i - 1]], inventory[span[i]]]
    for (const m of new Set([...Object.keys(a.own), ...Object.keys(b.own)])) if (a.own[m] !== b.own[m] && mark(m) === '*') bundleNamed.add(m)
  }
  const fromDiff = new Set(named.map(moduleOf))
  lines.push('', `upstream source ${path.basename(sourceDiff)} (v${from} .. v${to}): ${files.length} files in ${new Set(files.map(f => f.replace(/\/(src|cmd)\/.*$|\/[^/]+$/, ''))).size} packages`,
    `    files a port class names (${named.length}): ${named.join(', ')}`,
    `    other files of ported packages (${inPackage.length}): ${inPackage.join(', ')}`,
    `    files of packages the port does not name (${rest.length}): ${rest.join(', ')}`,
    `    the bundles of ${span.join(', ')} change ${bundleNamed.size} modules a port class names; the source diff ${fromDiff.size}`,
    `    named by the bundles only: ${[...bundleNamed].filter(m => !fromDiff.has(m)).sort().join(', ') || 'none'}`,
    `    named by the source diff only: ${[...fromDiff].filter(m => !bundleNamed.has(m)).sort().join(', ') || 'none'}`)
  // what those files' hunks change: a change the bundle does not show is one that compiles to the same JavaScript
  for (const f of named.filter(f => !bundleNamed.has(moduleOf(f)))) {
    lines.push(`      ${f}: ${changedLines[f].slice(0, 4).join(' ; ')}${changedLines[f].length > 4 ? ` ; ... ${changedLines[f].length - 4} more` : ''}`)
  }
}
const bundled = versions.filter(v => !inventory[v].native)
lines.unshift(
  `${versions.length} releases; ${bundled.length} ship a bundle, ${versions.length - bundled.length} are native executables; ${states} distinct states of the ported source among the bundles;`,
  `${namedPairs} of ${versions.length - 1} pairs of consecutive releases change a module a port class names`,
  'where the source is: github.com/pnpm/pnpm at tag v<release>; the manifests name the CLI\'s directory there: pnpm (9.12.3 to',
  '11.8.0), pnpm11/pnpm (11.9.0 on, the TypeScript packages under pnpm11/), pnpm/npm/pnpm (12.x, whose resolver is Rust crates',
  'under pnpm/crates); the from-9151 survey classifies the commits of v11.5.1..v11.28.5 one by one',
  `the port names ${ported.files.size} modules in ${ported.packages.size} packages of pnpm's monorepo and ${ported.libs.size} libraries`,
  'a module path is the bundle\'s (lockfile/fs/lib/write.js is lockfile/fs/src/write.ts upstream); pnpm 9 and 10 keep some packages',
  'under older names (pkg-manager/resolve-dependencies is installing/deps-resolver), which the marks follow',
  '')
fs.writeFileSync(path.join(outDir, 'pnpm-source.txt'), lines.join('\n') + '\n')
console.log(lines[0])
console.log(lines[1])

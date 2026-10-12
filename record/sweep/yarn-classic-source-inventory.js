// For each pair of consecutive Yarn classic releases, which upstream files that the Java port's classes name changed.
// Yarn 1 ships as one bundled lib/cli.js, so the source of a release is github.com/yarnpkg/yarn at its tag v<release>;
// 1.22.6 - 1.22.9 have no tag and no GitHub release: their source is the 1.22-stable commit that sets package.json's
// version (found by reading package.json along the branch). The files the port names are those of the Javadoc of
// rewrite-javascript/.../internal/lock/yarnclassic/*.java and its package-info (a directory names every file under it);
// the libraries the port names are read from the repository's yarn.lock at each release (what its build bundled).
// Trees and blobs come through `gh api` and are kept under <pm>/_src/ (by commit and by blob sha); the unified diffs of
// the named files for each pair are written to <pm>/_src/diffs/<from>..<to>.diff.
// Usage: node yarn-classic-source-inventory.js <pm/yarn-classic> <out.txt> [--json <file>]
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const [pm, outFile] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const jsonI = process.argv.indexOf('--json')
const SRC = path.join(path.resolve(pm), '_src')
fs.mkdirSync(path.join(SRC, 'trees'), { recursive: true })
fs.mkdirSync(path.join(SRC, 'blobs'), { recursive: true })
fs.mkdirSync(path.join(SRC, 'diffs'), { recursive: true })
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const releases = fs.readdirSync(pm).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const tags = Object.fromEntries(fs.readFileSync(path.join(pm, 'tags.txt'), 'utf8').trim().split('\n').map(l => l.split(' ')))
// no tag, no GitHub release: the commit on 1.22-stable whose package.json says the version
const UNTAGGED = {
  '1.22.6': '53be70489c6fda77d362f491c160ca5010b07cd3',
  '1.22.7': 'b4f5243a0cf43a06c26ebc9fdf7a2b77e9e03c91',
  '1.22.8': 'f8803d1d4a584c6cc99c40614897b11c0b9a01f3',
  '1.22.9': 'f7a900bfc8fef2db0df4827857e9d0d39229f575',
}
// what the port's classes name (their Javadoc and package-info): files, and directories standing for every file in them
const NAMED = [
  'src/cli/index.js', 'src/cli/commands/install.js', 'src/config.js', 'src/rc.js', 'src/util/rc.js', 'src/registries/',
  'src/types.js', 'src/errors.js', 'src/lockfile/', 'src/package-resolver.js', 'src/package-request.js',
  'src/package-reference.js', 'src/package-fetcher.js', 'src/package-compatibility.js', 'src/package-constraint-resolver.js',
  'src/resolution-map.js', 'src/util/parse-package-path.js', 'src/workspace-layout.js', 'src/fetchers/', 'src/resolvers/',
  'src/util/normalize-manifest/', 'src/util/normalize-pattern.js', 'src/util/fs.js', 'src/util/misc.js',
  'src/util/request-manager.js', 'src/reporters/base-reporter.js', 'src/reporters/lang/en.js',
]
const named = p => NAMED.some(n => n.endsWith('/') ? p.startsWith(n) : p === n)
// the libraries the port names, as yarn bundles them
const LIBS = ['semver', 'micromatch', 'arr-diff', 'expand-brackets', 'is-posix-bracket', 'extglob', 'parse-glob', 'glob-base',
  'is-dotfile', 'glob-parent', 'minimatch', 'deep-equal', 'gunzip-maybe', 'is-gzip', 'is-deflate', 'object-path', 'tar-fs',
  'tar-stream', 'ssri', 'ini', 'strip-bom', 'js-yaml', 'normalize-url', 'validate-npm-package-license', 'request']

const gh = args => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const refOf = r => UNTAGGED[r] || tags[`v${r}`]
const treeOf = sha => {
  const f = path.join(SRC, 'trees', `${sha}.json`)
  if (!fs.existsSync(f)) {
    const t = JSON.parse(gh([`repos/yarnpkg/yarn/git/trees/${sha}?recursive=1`]))
    if (t.truncated) throw new Error(`tree ${sha} truncated`)
    fs.writeFileSync(f, JSON.stringify(Object.fromEntries(t.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]))))
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}
const blob = sha => {
  const f = path.join(SRC, 'blobs', sha)
  if (!fs.existsSync(f)) {
    const b = JSON.parse(gh([`repos/yarnpkg/yarn/git/blobs/${sha}`]))
    fs.writeFileSync(f, Buffer.from(b.content, 'base64'))
  }
  return fs.readFileSync(f)
}
// a yarn.lock v1's entries: pattern -> version
const lockVersions = text => {
  const out = {}
  let patterns = null
  for (const line of text.split('\n')) {
    if (/^\S.*:$/.test(line) && !line.startsWith('#')) patterns = line.slice(0, -1).split(/,\s*/).map(p => p.replace(/^"|"$/g, ''))
    const m = line.match(/^ {2}version "?([^"]+)"?$/)
    if (m && patterns) for (const p of patterns) out[p] = m[1]
  }
  return out
}
const libsOf = tree => {
  const pkg = tree['package.json'] ? JSON.parse(blob(tree['package.json']).toString('utf8')) : {}
  const locked = tree['yarn.lock'] ? lockVersions(blob(tree['yarn.lock']).toString('utf8')) : {}
  const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const out = {}
  for (const lib of LIBS) {
    const versions = [...new Set(Object.entries(locked).filter(([p]) => p.slice(0, p.lastIndexOf('@')) === lib).map(([, v]) => v))].sort(cmp)
    const own = direct[lib] ? locked[`${lib}@${direct[lib]}`] : null
    if (versions.length) out[lib] = own ? `${own}${versions.length > 1 ? ` (also ${versions.filter(v => v !== own).join(', ')})` : ''}` : versions.join(', ')
  }
  return out
}
const diffCount = (a, b, label) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ycsi-'))
  fs.writeFileSync(path.join(tmp, 'a'), a || '')
  fs.writeFileSync(path.join(tmp, 'b'), b || '')
  let text = ''
  try {
    text = execFileSync('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, path.join(tmp, 'a'), path.join(tmp, 'b')], { encoding: 'utf8' })
  } catch (e) {
    text = e.stdout || ''
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  const lines = text.split('\n')
  return { text, plus: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length, minus: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length }
}

const rows = []
const json = { source: {}, pairs: [], libs: {} }
let prev = null
for (const r of releases) {
  const ref = refOf(r)
  if (!ref) {
    rows.push(`${r}: no source found`)
    continue
  }
  const tree = treeOf(ref)
  json.source[r] = { ref, how: UNTAGGED[r] ? '1.22-stable commit setting the version (no tag, no GitHub release)' : `tag v${r}` }
  json.libs[r] = libsOf(tree)
  if (prev) {
    const [pr, pt] = prev
    const files = [...new Set([...Object.keys(pt), ...Object.keys(tree)])].filter(named).sort()
    const changed = []
    const diffs = []
    for (const f of files) {
      if (pt[f] === tree[f]) continue
      const d = diffCount(pt[f] ? blob(pt[f]).toString('utf8') : '', tree[f] ? blob(tree[f]).toString('utf8') : '', f)
      changed.push({ file: f, status: !pt[f] ? 'added' : !tree[f] ? 'removed' : 'changed', plus: d.plus, minus: d.minus })
      diffs.push(d.text)
    }
    const libChanges = []
    for (const lib of new Set([...Object.keys(json.libs[pr]), ...Object.keys(json.libs[r])])) {
      if (json.libs[pr][lib] !== json.libs[r][lib]) libChanges.push(`${lib} ${json.libs[pr][lib] || '-'} -> ${json.libs[r][lib] || '-'}`)
    }
    if (diffs.length) fs.writeFileSync(path.join(SRC, 'diffs', `${pr}..${r}.diff`), diffs.join(''))
    json.pairs.push({ from: pr, to: r, files: changed, libs: libChanges })
  }
  prev = [r, tree]
}

const text = [
  'Yarn classic (1.x): the upstream files the Java port names, changed between consecutive releases',
  '',
  'Yarn 1 is published as one bundled file (lib/cli.js), from which no source file can be read back. The source of a',
  'release is github.com/yarnpkg/yarn at its tag v<release>; 1.22.6 - 1.22.9 have no tag and no GitHub release, and their',
  'source is the 1.22-stable commit that sets package.json\'s version (each such commit is listed below). The registry\'s',
  '1.22.12 is a publish without the bundle (its lib/ holds the transpiled modules, its dependencies are not bundled); its',
  'tag is the source of the bundle the GitHub release v1.22.12 ships.',
  '',
  'The port (rewrite-javascript/src/main/java/org/openrewrite/javascript/internal/lock/yarnclassic, Javadoc and',
  'package-info, all "yarn 1.22.22") names these upstream files; a directory stands for every file in it:',
  ...NAMED.map(n => `  ${n}`),
  'and these libraries as yarn bundles them (read from the repository\'s yarn.lock at each release; the version of yarn\'s',
  'own dependency first, "also" the other versions its yarn.lock holds):',
  `  ${LIBS.join(', ')}`,
  '',
  `Unified diffs of the named files for each pair: ${path.relative(path.dirname(path.resolve(outFile)), path.join(SRC, 'diffs'))}/<from>..<to>.diff`,
  '',
  'Sources:',
  ...releases.map(r => `  ${r.padEnd(8)} ${json.source[r] ? `${json.source[r].ref}  ${json.source[r].how}` : 'none'}`),
  '',
  'Bundled libraries at 1.22.22:',
  ...Object.entries(json.libs['1.22.22'] || {}).map(([k, v]) => `  ${k} ${v}`),
  '',
  'Per pair (oldest first): files the port names that changed (+added -removed lines), and bundled library changes',
]
for (const p of json.pairs) {
  text.push('', `${p.from} -> ${p.to}: ${p.files.length ? `${p.files.length} named file(s) changed` : 'no named file changed'}${p.libs.length ? `; libraries: ${p.libs.join('; ')}` : ''}`)
  for (const f of p.files) text.push(`    ${f.status.padEnd(8)} ${f.file} (+${f.plus} -${f.minus})`)
}
fs.writeFileSync(outFile, text.join('\n') + '\n')
if (jsonI > 0) fs.writeFileSync(process.argv[jsonI + 1], JSON.stringify(json, null, 1) + '\n')
console.log(`${releases.length} releases, ${json.pairs.length} pairs -> ${outFile}`)

// The source inventory of the Bun sweep: for each pair of consecutive releases, which upstream files that the Bun
// port's classes name in their Javadoc changed (bun-source-files.js lists them by their bun-v1.3.10 path). Bun is a
// native executable built from github.com/oven-sh/bun at the tag bun-v<version>; the release itself holds no source,
// so the source is read from a clone of that repository (a blobless clone does: git fetches what it diffs).
// Files moved over the releases, so each named file is looked up at each tag by where its code lived:
//   - before 1.2.15 the lockfile modules (bun.lock.zig, Tree, Package, Meta, Scripts, WorkspaceMap, CatalogMap,
//     OverrideMap) were src/install/bun.lock.zig and parts of src/install/lockfile.zig
//   - before 1.2.16 / 1.2.18 the PackageManager modules were parts of src/install/install.zig
//   - before 1.2.3 src/semver/* was src/install/semver.zig, and glob's matcher src/glob/ascii.zig
//   - before 1.2.20 src/interchange/json.zig was src/json_parser.zig, src/string/immutable.zig src/string_immutable.zig,
//     and the TOML parser src/toml/
//   - from 1.3.14 several moved into directories (src/glob/glob.zig, src/glob/matcher.zig, src/ini/ini.zig,
//     src/dotenv/env_loader.zig, src/js_printer/js_printer.zig, src/wyhash/wyhash.zig, src/cli/bunfig.zig)
//   - from 1.4.0 bun is Rust: each .zig file's .rs twin, or the crate file that holds its code
// A location marked "(within)" is a larger file that held the named module's code: a change there may be elsewhere.
// Also: the oven-sh/zig commit each release builds with (cmake/tools/SetupZig.cmake), since the port follows Zig's
// std.hash.Wyhash and HashMapUnmanaged (the order bun.lock writes trusted and patched dependencies in).
// Usage: node bun-source-inventory.js <bare clone of oven-sh/bun> --releases-file <file> [--out <txt>] [--json <json>]
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { FILES } = require('./bun-source-files.js')

const GIT = path.resolve(process.argv[2])
const arg = name => process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : null
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const git = (...args) => {
  const r = spawnSync('git', ['--git-dir', GIT, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
  return r.status === 0 ? r.stdout : null
}
const releases = fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean).sort(cmp)

// where a named file's code is, in order of preference: [path, within?]
const W = true
const candidates = f => {
  const rs = f.replace(/\.zig$/, '.rs')
  const own = [[f], [rs]]
  const pm = ['install_with_manager', 'PackageManagerOptions', 'PackageManagerEnqueue', 'runTasks', 'processDependencyList', 'PackageManagerResolution']
  if (pm.some(n => f.endsWith(`/PackageManager/${n}.zig`))) return [...own, ['src/install/install.zig', W]]
  if (f === 'src/install/lockfile/bun.lock.zig') return [...own, ['src/install/bun.lock.zig']]
  if (/^src\/install\/lockfile\//.test(f)) return [...own, ['src/install/lockfile.zig', W]]
  if (/^src\/semver\//.test(f)) return [...own, ['src/install/semver.zig', W]]
  if (f === 'src/install/versioned_url.zig') return [...own, ['src/install/lib.rs', W]]
  if (f === 'src/install/install.zig') return [...own, ['src/install_types/resolver_hooks.rs', W]]
  if (f === 'src/glob.zig') return [...own, ['src/glob/glob.zig'], ['src/glob/lib.rs']]
  if (f === 'src/glob/match.zig') return [...own, ['src/glob/matcher.zig'], ['src/glob/matcher.rs'], ['src/glob/ascii.zig'], ['src/glob_ascii.zig']]
  if (f === 'src/ini.zig') return [...own, ['src/ini/ini.zig'], ['src/ini/lib.rs']]
  if (f === 'src/env_loader.zig') return [...own, ['src/dotenv/env_loader.zig'], ['src/dotenv/env_loader.rs']]
  if (f === 'src/interchange/json.zig') return [...own, ['src/json_parser.zig'], ['src/parsers/json.rs']]
  if (f === 'src/string/immutable.zig') return [...own, ['src/string_immutable.zig'], ['src/bun_core/string/immutable.rs']]
  if (f === 'src/js_printer.zig') return [...own, ['src/js_printer/js_printer.zig'], ['src/js_printer/lib.rs']]
  if (f === 'src/wyhash.zig') return [...own, ['src/wyhash/wyhash.zig'], ['src/wyhash/lib.rs']]
  if (f === 'src/bunfig.zig') return [...own, ['src/cli/bunfig.zig'], ['src/bunfig/bunfig.rs']]
  if (f === 'src/toml/') return [['src/toml/'], ['src/interchange/toml.zig+src/interchange/toml/lexer.zig'], ['src/parsers/toml.rs']]
  return own
}
const trees = {}
const tree = v => {
  if (!trees[v]) {
    const out = git('ls-tree', '-r', `bun-v${v}`, '--', 'src') || ''
    trees[v] = new Map(out.split('\n').filter(Boolean).map(l => {
      const [meta, p] = l.split('\t')
      return [p, meta.split(' ')[2]]
    }))
  }
  return trees[v]
}
// the files (and their blob ids) a candidate is at a tag, or null
const filesAt = (v, cand) => {
  const t = tree(v)
  const out = {}
  for (const part of cand.split('+')) {
    if (part.endsWith('/')) for (const [p, id] of t) if (p.startsWith(part)) out[p] = id
    if (!part.endsWith('/') && t.has(part)) out[part] = t.get(part)
  }
  return Object.keys(out).length ? out : null
}
const locate = (v, f) => {
  for (const [cand, within] of candidates(f)) {
    const files = filesAt(v, cand)
    if (files) return { cand, within: !!within, files }
  }
  return null
}
// cmake/tools/SetupZig.cmake until 1.3.11, scripts/build/zig.ts from 1.3.12
const zigCommit = v => {
  const text = (git('show', `bun-v${v}:cmake/tools/SetupZig.cmake`) || '') + (git('show', `bun-v${v}:scripts/build/zig.ts`) || '')
  const m = text.match(/ZIG_COMMIT[^\n]*?([0-9a-f]{40})/)
  if (m) return m[1].slice(0, 10)
  const t = tree(v)
  return [...t.keys()].some(p => p.endsWith('.rs') && p.startsWith('src/install/')) ? '(rust)' : '?'
}

const pairs = []
for (let i = 1; i < releases.length; i++) {
  const [a, b] = [releases[i - 1], releases[i]]
  const changed = []
  for (const f of FILES) {
    const la = locate(a, f)
    const lb = locate(b, f)
    if (!la && !lb) continue
    if (!la) {
      changed.push({ file: f, what: `appears as ${lb.cand}${lb.within ? ' (within)' : ''}` })
      continue
    }
    if (!lb) {
      changed.push({ file: f, what: `gone (was ${la.cand})` })
      continue
    }
    if (la.cand !== lb.cand) {
      const same = JSON.stringify(Object.values(la.files)) === JSON.stringify(Object.values(lb.files))
      changed.push({ file: f, what: `${same ? 'moved' : 'moved and changed'}: ${la.cand}${la.within ? ' (within)' : ''} -> ${lb.cand}${lb.within ? ' (within)' : ''}` })
      continue
    }
    const ids = JSON.stringify(Object.entries(la.files)) === JSON.stringify(Object.entries(lb.files))
    if (ids) continue
    // the size of the change
    const paths = [...new Set([...Object.keys(la.files), ...Object.keys(lb.files)])]
    const num = git('diff', '--numstat', `bun-v${a}`, `bun-v${b}`, '--', ...paths) || ''
    let plus = 0
    let minus = 0
    for (const line of num.split('\n').filter(Boolean)) {
      const [p, m] = line.split('\t')
      plus += Number(p) || 0
      minus += Number(m) || 0
    }
    changed.push({ file: f, what: `changed${la.cand !== f ? ` (as ${la.cand}${la.within ? ', within' : ''})` : ''} +${plus} -${minus}` })
  }
  pairs.push({ from: a, to: b, zig: [zigCommit(a), zigCommit(b)], changed })
  process.stderr.write(`${b} `)
}
process.stderr.write('\n')

const lines = [
  '# Bun: which upstream files the port names changed between consecutive releases',
  '#',
  '# The port (rewrite-javascript internal.lock.bun) follows bun 1.3.10; its classes name these files (bun-v1.3.10 paths):',
  ...FILES.map(f => `#   ${f}`),
  '# and Zig\'s lib/std/hash/wyhash.zig and lib/std/hash_map.zig at the oven-sh/zig commit bun builds with.',
  '#',
  '# Bun ships as one native executable per platform: a release holds no source. Each release\'s source is the git tag',
  '# bun-v<version> of https://github.com/oven-sh/bun (126 tags bun-v1.0.0 - bun-v1.4.3). Diff a file between two',
  '# releases with: git diff bun-v<a> bun-v<b> -- <path at each side>.',
  '# Files moved between releases; each is looked up where its code lived (bun-source-inventory.js names the history).',
  '# "(within)" marks a larger file that held the module: its change may lie outside the module.',
  '# Bun 1.4.0 is a translation of the Zig sources to Rust, file for file (bun.lock.zig is bun.lock.rs).',
  '#',
  '# zig: the oven-sh/zig commit the build pins (cmake/tools/SetupZig.cmake, from 1.3.12 scripts/build/zig.ts), (rust)',
  '# from 1.4.0. Only a change of it is shown.',
  '',
]
for (const p of pairs.slice().reverse()) {
  lines.push(`${p.from} -> ${p.to}: ${p.changed.length} named files changed${p.zig[0] !== p.zig[1] ? `; zig ${p.zig[0]} -> ${p.zig[1]}` : ''}`)
  for (const c of p.changed) lines.push(`    ${c.file.padEnd(54)} ${c.what}`)
}
const text = lines.join('\n') + '\n'
if (arg('out')) fs.writeFileSync(arg('out'), text)
if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(pairs, null, 1) + '\n')
console.log(text)

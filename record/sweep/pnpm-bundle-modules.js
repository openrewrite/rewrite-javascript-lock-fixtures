// pnpm 9, 10 and 11 ship as one esbuild bundle (dist/pnpm.cjs, dist/pnpm.mjs) that keeps a `// <path>` line before
// each module it bundles. This lists a release's modules: pnpm's own (paths into its monorepo) and the libraries
// it bundles with their versions, as the bundle's paths name them.
// As a module: { modulesOf(bundleFile) } -> { own: Map(path -> text), libs: Map(name -> { version, files: Map }) }
// Usage: node pnpm-bundle-modules.js <pm/pnpm dir> <version> [--packages | --libs | --all]
const fs = require('fs')
const path = require('path')

// `// ../lockfile/fs/lib/write.js` for a package of the monorepo, `// lib/main.js` for the pnpm package itself
const BOUNDARY = /^\/\/ ((?:(?:\.\.\/)+|lib\/)[^\s]+\.(?:js|cjs|mjs|json))$/

const bundleOf = (pm, version) => {
  for (const f of ['pnpm.mjs', 'pnpm.cjs', 'pnpm.js']) {
    const p = path.join(pm, version, 'package', 'dist', f)
    if (fs.existsSync(p)) return p
  }
  return null
}

// a library's name and version from a path into pnpm's store or node_modules
const libOf = p => {
  // .../store/v11/links/@/<name>/<version>/<hash>/node_modules/<name>/<file>   (pnpm 11's global virtual store)
  let m = p.match(/\/links\/(?:@\/)?((?:@[^/]+\/)?[^/@]+)\/([^/]+)\/[0-9a-f]{16,}\/node_modules\/(?:@[^/]+\/)?[^/]+\/(.*)$/)
  if (m) return { name: m[1], version: m[2], file: m[3] }
  // .../node_modules/.pnpm/<name>@<version>[_peers]/node_modules/<name>/<file>
  m = p.match(/\/node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_(]+)[^/]*\/node_modules\/(?:@[^/]+\/)?[^/]+\/(.*)$/)
  if (m) return { name: m[1].replace('+', '/'), version: m[2], file: m[3] }
  m = p.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/)
  if (m) return { name: m[1], version: '?', file: m[2] }
  return null
}

const modulesOf = bundleFile => {
  const own = new Map()
  const libs = new Map()
  const lines = fs.readFileSync(bundleFile, 'utf8').split('\n')
  let current = null
  let buf = []
  const flush = () => {
    if (current == null) return
    const text = buf.join('\n')
    const lib = current.includes('node_modules') || current.includes('/links/') ? libOf(current) : null
    if (lib) {
      const key = lib.name
      if (!libs.has(key)) libs.set(key, { versions: new Set(), files: new Map() })
      libs.get(key).versions.add(lib.version)
      libs.get(key).files.set(`${lib.version}/${lib.file}`, text)
    } else {
      own.set(current.startsWith('lib/') ? `pnpm/${current}` : current.replace(/^(\.\.\/)+/, ''), text)
    }
  }
  for (const line of lines) {
    const m = line.match(BOUNDARY)
    if (m) {
      flush()
      current = m[1]
      buf = []
    } else if (current != null) {
      buf.push(line)
    }
  }
  flush()
  return { own, libs }
}

module.exports = { modulesOf, bundleOf }

if (require.main === module && process.argv[2] === '--diff') {
  // node pnpm-bundle-modules.js --diff <pm dir> <version a> <version b> <module path>: the module's lines that differ
  // between the two bundles, after the numbers esbuild appends to colliding names are removed
  const [, pm, a, b, mod] = process.argv.slice(2)
  const norm = t => (t || '').replace(/\b([A-Za-z_$][A-Za-z0-9_$]*?)\d+\b/g, '$1').split('\n').map(l => l.trim()).filter(Boolean)
  const [ta, tb] = [a, b].map(v => norm(modulesOf(bundleOf(pm, v)).own.get(mod)))
  const [sa, sb] = [new Set(ta), new Set(tb)]
  console.log(`${mod}: ${ta.length} lines in ${a}, ${tb.length} in ${b}`)
  for (const l of ta.filter(l => !sb.has(l)).slice(0, 40)) console.log(`- ${l.slice(0, 200)}`)
  for (const l of tb.filter(l => !sa.has(l)).slice(0, 40)) console.log(`+ ${l.slice(0, 200)}`)
  process.exit(0)
}

if (require.main === module) {
  const [pm, version, mode = '--packages'] = process.argv.slice(2)
  const bundle = bundleOf(pm, version)
  if (!bundle) {
    console.log(`pnpm ${version}: no dist/pnpm.(mjs|cjs) bundle (a native executable)`)
    process.exit(0)
  }
  const { own, libs } = modulesOf(bundle)
  console.log(`pnpm ${version}: ${path.basename(bundle)}, ${own.size} modules of its own, ${libs.size} libraries`)
  if (mode === '--all') for (const p of own.keys()) console.log(`  ${p}`)
  if (mode === '--packages') {
    const dirs = new Map()
    for (const p of own.keys()) {
      const dir = p.replace(/\/(lib|dist|src)\/.*$/, '')
      dirs.set(dir, (dirs.get(dir) || 0) + 1)
    }
    console.log([...dirs].map(([d, n]) => `${d}(${n})`).join(' '))
  }
  if (mode === '--libs') console.log([...libs].sort().map(([n, l]) => `${n}@${[...l.versions].join('+')}(${l.files.size})`).join(' '))
}

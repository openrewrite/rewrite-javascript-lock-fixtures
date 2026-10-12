// For each pair of consecutive Yarn Berry releases, which upstream files that the Java port's classes name changed.
// A release is one bundled, minified file, so nothing can be read off the release itself: the sources are the
// yarnpkg/berry repository at the tag @yarnpkg/cli/<version>, read file by file from raw.githubusercontent.com
// (no clone, no git).
//   - the files: every `@yarnpkg/<package> ... <file>.ts|.pegjs` the class Javadocs of the port name
//     (rewrite-javascript/src/main/java/org/openrewrite/javascript/internal/lock/berry/), plus what the port's release
//     data is read from (src/test/resources/yarn-berry/generate/releases.js);
//   - <inventory>/yarn-berry-source/<version>/<path>   each file at each tag (a file a release does not have: <path>.404)
//   - <inventory>/yarn-berry-source.txt                per pair of consecutive releases, the files that changed, with
//                                                      the lines added and removed
//   - <inventory>/yarn-berry-source.json               the same, and which class names which file
// Usage: node yarn-berry-source-inventory.js <berry port dir> <pm dir> <inventory dir>     (JOBS=4 by default)
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const [portDir, pmDir, invDir] = process.argv.slice(2).map(p => path.resolve(p))
const jobs = Number(process.env.JOBS || 4)
const RAW = 'https://raw.githubusercontent.com/yarnpkg/berry'
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const dirOf = pkg => /^plugin-/.test(pkg) ? `packages/${pkg}` : `packages/yarnpkg-${pkg}`

// ---- the files the port names --------------------------------------------------------------------------------------
const named = new Map() // repo path -> Set(class)
const add = (file, cls) => {
  if (!named.has(file)) named.set(file, new Set())
  named.get(file).add(cls)
}
for (const f of fs.readdirSync(portDir).filter(f => f.endsWith('.java')).sort()) {
  const text = fs.readFileSync(path.join(portDir, f), 'utf8')
  const cls = f.replace(/\.java$/, '')
  // every Javadoc sentence that says "Port of @yarnpkg/<package> ..." up to its release in parentheses
  for (const m of text.matchAll(/Port of ((?:the parts of )?@yarnpkg\/[\s\S]*?)\(Yarn [\d.]+\)/g)) {
    const sentence = m[1].replace(/\n\s*\*\s?/g, ' ')
    let pkg = null
    for (const t of sentence.matchAll(/@yarnpkg\/([\w-]+)|((?:sources\/)?[\w/.-]+\.(?:ts|pegjs))/g)) {
      if (t[1]) pkg = t[1]
      else if (pkg) add(`${dirOf(pkg)}/${t[2].startsWith('sources/') ? t[2] : 'sources/' + t[2]}`, cls)
    }
  }
}
// what the port's data of a release is read from (generate/releases.js), and the lockfile version (YarnRelease)
for (const [file, cls] of [
  ['packages/yarnpkg-extensions/sources/index.ts', 'YarnRelease (packageExtensions)'],
  ['packages/plugin-compat/sources/extensions.ts', 'YarnRelease (packageExtensions, before they moved)'],
  ['packages/plugin-compat/sources/index.ts', 'YarnRelease (patches)'],
  ['packages/plugin-compat/sources/patches/fsevents.patch.ts', 'CompatPatches (the builtin patch)'],
  ['packages/plugin-compat/sources/patches/resolve.patch.ts', 'CompatPatches (the builtin patch)'],
  ['packages/plugin-compat/sources/patches/typescript.patch.ts', 'CompatPatches (the builtin patch)'],
  ['packages/plugin-npm/sources/NpmSemverResolver.ts', 'YarnRelease (nodeGyp)'],
  ['packages/yarnpkg-cli/package.json', 'YarnRelease (plugins)'],
  ['packages/plugin-npm/sources/npmConfigUtils.ts', 'YarnRelease (jsrScope)'],
  ['packages/yarnpkg-core/sources/Project.ts', 'YarnRelease (lockfileVersion, checksumWithoutCacheKey)'],
  ['packages/yarnpkg-core/sources/Configuration.ts', 'YarnRelease (settings, unknownSettingHint)'],
]) add(file, cls)

const releases = fs.readdirSync(pmDir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const files = [...named.keys()].sort()
const store = path.join(invDir, 'yarn-berry-source')

const fetchOne = async (version, file) => {
  const into = path.join(store, version, file)
  if (fs.existsSync(into) || fs.existsSync(into + '.404')) return
  const url = `${RAW}/${encodeURIComponent('@yarnpkg')}/cli/${version}/${file}`
  let res
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url)
      if (res.status < 500 && res.status !== 429) break
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${e.message}`)
    }
    if (attempt >= 4) break
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  fs.mkdirSync(path.dirname(into), { recursive: true })
  if (res.status === 404) return fs.writeFileSync(into + '.404', '')
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  fs.writeFileSync(into, Buffer.from(await res.arrayBuffer()))
}

const main = async () => {
  const queue = []
  for (const v of releases) for (const f of files) queue.push([v, f])
  const failed = []
  let done = 0
  const worker = async () => {
    for (;;) {
      const t = queue.shift()
      if (!t) return
      try {
        await fetchOne(t[0], t[1])
      } catch (e) {
        failed.push(e.message)
      }
      if (++done % 500 === 0) console.error(`  ${done} files`)
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker))
  if (failed.length) {
    console.error(`${failed.length} files could not be fetched:\n  ${failed.slice(0, 10).join('\n  ')}`)
    process.exitCode = 1
  }

  // of the CLI's package.json the port reads only the plugins the standard bundle holds (every release bumps its version)
  const PLUGINS = 'packages/yarnpkg-cli/package.json'
  const pluginsOf = text => {
    try {
      return JSON.parse(text)['@yarnpkg/builder'].bundles.standard
    } catch (e) {
      return null
    }
  }
  const read = (v, f) => {
    const p = path.join(store, v, f)
    if (!fs.existsSync(p)) return null
    const text = fs.readFileSync(p, 'utf8')
    return f === PLUGINS ? JSON.stringify(pluginsOf(text)) : text
  }
  const stat = (a, b, v1, v2, f) => {
    if (a === null) return 'added'
    if (b === null) return 'removed'
    if (f === PLUGINS) {
      const [x, y] = [JSON.parse(a) || [], JSON.parse(b) || []]
      return `plugins ${[...y.filter(p => !x.includes(p)).map(p => '+' + p), ...x.filter(p => !y.includes(p)).map(p => '-' + p)].join(' ') || 'reordered'}`
    }
    let diff = ''
    try {
      execFileSync('/usr/bin/diff', ['-U0', path.join(store, v1, f), path.join(store, v2, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch (e) {
      diff = e.stdout || ''
    }
    const lines = diff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    return `+${lines.filter(l => l[0] === '+').length} -${lines.filter(l => l[0] === '-').length}`
  }
  const pairs = []
  for (let i = 1; i < releases.length; i++) {
    const [v1, v2] = [releases[i - 1], releases[i]]
    const changed = []
    for (const f of files) {
      const a = read(v1, f)
      const b = read(v2, f)
      if (a === b) continue
      changed.push({ file: f, change: stat(a, b, v1, v2, f), classes: [...named.get(f)] })
    }
    pairs.push({ from: v1, to: v2, changed })
  }
  const text = [
    `Upstream files the Yarn Berry port names, by pair of consecutive releases (${releases[0]} to ${releases[releases.length - 1]}, ${releases.length} releases).`,
    'Source: github.com/yarnpkg/berry at the tag @yarnpkg/cli/<version>, each file read from raw.githubusercontent.com;',
    'a release itself is one bundled file. "+a -r" counts the lines a unified diff adds and removes.',
    '',
    `${files.length} files named by the port's classes (class Javadocs, and the sources of its release data):`,
    ...files.map(f => `  ${f}   <- ${[...named.get(f)].join(', ')}`),
    '',
  ]
  for (const p of [...pairs].reverse()) {
    text.push(`=== ${p.from} -> ${p.to}: ${p.changed.length ? `${p.changed.length} of the named files changed` : 'none of the named files changed'}`)
    for (const c of p.changed) text.push(`  ${c.change.padEnd(12)} ${c.file}   (${c.classes.join(', ')})`)
  }
  fs.writeFileSync(path.join(invDir, 'yarn-berry-source.txt'), text.join('\n') + '\n')
  fs.writeFileSync(path.join(invDir, 'yarn-berry-source.json'), JSON.stringify({ files: Object.fromEntries(files.map(f => [f, [...named.get(f)]])), pairs }, null, 1) + '\n')
  console.log(`${files.length} files x ${releases.length} releases; ${pairs.filter(p => p.changed.length).length} of ${pairs.length} pairs change a named file -> ${path.join(invDir, 'yarn-berry-source.txt')}`)
}
main().catch(e => {
  console.error(e)
  process.exit(1)
})

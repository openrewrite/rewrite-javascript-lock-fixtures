// Fetches the registry responses a scenario refers to into <scenario>/http/, verbatim:
//   http/<name>            abbreviated packument (Accept: application/vnd.npm.install-v1+json); with FULL_PACKUMENTS=1
//                          the full one, which Yarn Berry asks for (its age gate reads the publish times)
//   http/<name>-<version>  single-version manifest
// Names come from the scenario's locks and manifests. Pass extra `name` or `name@version`
// arguments for anything else a replay needs (e.g. a version the resolver examines and rejects).
// Usage: node record/fetch-http.js <scenario-dir> [name|name@version ...]
const fs = require('fs')
const path = require('path')

const REG = 'https://registry.npmjs.org/'
const dir = process.argv[2]
const names = new Set()
const versions = new Set()

const addSpec = (name, spec) => {
  if (typeof spec !== 'string') return
  const alias = spec.match(/^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/)
  if (alias) names.add(alias[1])
  else if (!/^(file:|link:|workspace:|git|https?:|github:|catalog:)/.test(spec) && !/^[^@]+\/[^@]+$/.test(spec)) names.add(name)
}

for (const f of ['pkg-before', 'pkg']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  for (const scope of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[scope] || {})) addSpec(name, spec)
  }
}

for (const f of ['before', 'after']) {
  const p = path.join(dir, f)
  if (!fs.existsSync(p)) continue
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    continue // not an npm lock; pass names explicitly for other package managers
  }
  for (const [loc, e] of Object.entries(lock.packages || {})) {
    const at = loc.lastIndexOf('node_modules/')
    if (at < 0 || e.link || !e.resolved || !e.resolved.startsWith(REG)) continue
    const name = e.name || loc.slice(at + 'node_modules/'.length)
    names.add(name)
    versions.add(name + '@' + e.version)
  }
}

for (const arg of process.argv.slice(3)) {
  const at = arg.lastIndexOf('@')
  if (at > 0) {
    names.add(arg.slice(0, at))
    versions.add(arg)
  } else {
    names.add(arg)
  }
}

const encode = name => name.replace('/', '%2f')

const save = async (url, file, headers) => {
  if (fs.existsSync(file)) return
  const res = await fetch(url, { headers })
  if (!res.ok) {
    console.error(`  ${res.status} ${url}`)
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

const main = async () => {
  const http = path.join(dir, 'http')
  for (const name of [...names].sort()) {
    await save(REG + encode(name), path.join(http, name),
      process.env.FULL_PACKUMENTS ? {} : { accept: 'application/vnd.npm.install-v1+json' })
  }
  for (const nv of [...versions].sort()) {
    const at = nv.lastIndexOf('@')
    const name = nv.slice(0, at)
    const version = nv.slice(at + 1)
    await save(`${REG}${encode(name)}/${version}`, path.join(http, `${name}-${version}`), {})
  }
  console.log(`  http: ${names.size} packuments, ${versions.size} manifests`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
process.on('exit', () => require('child_process').execFileSync('node', [require('path').join(__dirname, 'redact-paths.js'), require('path').join(dir, 'http')], {stdio: 'inherit'}))

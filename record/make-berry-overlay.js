// Writes a scenario's hand-made registry documents from <dir>/overlay.json into <dir>/registry/ (served by
// yarn-berry-registry.js) and into <dir>/http/ (the replay layout: packument <name>, manifest <name>-<version>,
// tarball <name>-<version>.tgz; REGISTRY/ becomes https://registry.npmjs.org/ there).
//
// overlay.json: {"only": bool, "packages": [{
//   "name", "version",
//   "manifest": {...}        fields of package.json, also copied into the packument's version entry
//   "packument": {...}       extra fields for the packument's version entry only (e.g. deprecated)
//   "files": {"path": "text"} extra files under package/ (default: index.js)
//   "tar": [{"type": "file|dir|symlink|link|pax|gpax|gnulong|fifo|contiguous", "path", "content", "mode", "linkpath",
//            "records": {...}, "headerName"}]  the whole tar entry list instead of package.json + files; headerName
//            is written in the ustar name field instead of path (for pax / GNU long names)
//   "tarball": "url"         dist.tarball instead of REGISTRY/<name>/-/<name>-<version>.tgz
//   "noDist": true           no dist object at all
//   "publishedHoursAgo": n   the version's entry in the packument's time, n hours before the overlay is made (a replay
//                            runs at the start of the recording's day, so n must keep each version on the same side
//                            of an age gate from there too)
// }], "distTags": {"<name>": {"latest": "<version>"}}}
// Usage: node record/make-berry-overlay.js <scenario-dir>
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')

const dir = process.argv[2]
const spec = JSON.parse(fs.readFileSync(path.join(dir, 'overlay.json'), 'utf8'))
const reg = path.join(dir, 'registry')
const http = path.join(dir, 'http')
fs.mkdirSync(reg, {recursive: true})
fs.mkdirSync(http, {recursive: true})
if (spec.only) fs.writeFileSync(path.join(reg, '.only'), '')

const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'

const header = ({name, mode = 0o644, size = 0, type = '0', linkpath = '', mtime = 456789000}) => {
  const h = Buffer.alloc(512)
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
  }
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write(octal(mode, 8), 100)
  h.write(octal(0, 8), 108)
  h.write(octal(0, 8), 116)
  h.write(octal(size, 12), 124)
  h.write(octal(mtime, 12), 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write(linkpath.slice(0, 100), 157)
  h.write('ustar\0', 257)
  h.write('00', 263)
  h.write(prefix.slice(0, 155), 345)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}

const block = data => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])

const paxBody = records => Buffer.from(Object.entries(records).map(([k, v]) => {
  const rest = ` ${k}=${v}\n`
  let len = Buffer.byteLength(rest) + 1
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest)
  return `${len}${rest}`
}).join(''))

const tar = entries => {
  const out = []
  for (const e of entries) {
    const mode = e.mode ? parseInt(e.mode, 8) : undefined
    const body = e.content !== undefined ? Buffer.from(e.content) : Buffer.alloc(0)
    switch (e.type || 'file') {
      case 'file':
      case 'contiguous':
        out.push(header({name: e.headerName || e.path, mode, size: body.length, type: e.type === 'contiguous' ? '7' : '0'}), block(body))
        break
      case 'dir':
        out.push(header({name: e.path, mode: mode || 0o755, type: '5'}))
        break
      case 'symlink':
        out.push(header({name: e.path, mode: mode || 0o777, type: '2', linkpath: e.linkpath}))
        break
      case 'link':
        out.push(header({name: e.path, mode, type: '1', linkpath: e.linkpath}))
        break
      case 'fifo':
        out.push(header({name: e.path, mode, type: '6'}))
        break
      case 'pax':
      case 'gpax': {
        const pax = paxBody(e.records)
        out.push(header({name: e.type === 'pax' ? 'PaxHeader/x' : 'GlobalHead.0.0', size: pax.length, type: e.type === 'pax' ? 'x' : 'g'}), block(pax))
        break
      }
      case 'gnulong': {
        const long = Buffer.from(e.content + '\0')
        out.push(header({name: '././@LongLink', size: long.length, type: 'L'}), block(long))
        break
      }
      default:
        throw new Error('unknown tar entry type ' + e.type)
    }
  }
  out.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(out), {level: 9})
}

const packuments = new Map()
for (const p of spec.packages) {
  const manifest = {name: p.name, version: p.version, ...(p.manifest || {})}
  const entries = p.tar || [
    {path: 'package/package.json', content: JSON.stringify(manifest, null, 2) + '\n'},
    ...Object.entries(p.files || {'index.js': `module.exports = ${JSON.stringify(p.name + '@' + p.version)}\n`})
      .map(([f, c]) => ({path: `package/${f}`, content: c})),
  ]
  const tgz = tar(entries)
  const base = p.name.replace(/^@[^/]+\//, '')
  const versionEntry = {...manifest, ...(p.packument || {})}
  if (!p.noDist) {
    versionEntry.dist = {
      shasum: crypto.createHash('sha1').update(tgz).digest('hex'),
      integrity: 'sha512-' + crypto.createHash('sha512').update(tgz).digest('base64'),
      tarball: p.tarball || `REGISTRY/${p.name}/-/${base}-${p.version}.tgz`,
    }
  }
  fs.mkdirSync(path.dirname(path.join(reg, p.name)), {recursive: true})
  fs.writeFileSync(path.join(reg, `${p.name}-${p.version}.tgz`), tgz)
  if (!packuments.has(p.name)) packuments.set(p.name, {name: p.name, 'dist-tags': {}, versions: {}})
  const doc = packuments.get(p.name)
  doc.versions[p.version] = versionEntry
  doc['dist-tags'].latest = p.version
  if (p.publishedHoursAgo !== undefined) {
    const published = new Date(Date.now() - p.publishedHoursAgo * 3600 * 1000).toISOString()
    doc.time = {...(doc.time || {created: published}), modified: published, [p.version]: published}
  }
}
for (const [name, tags] of Object.entries(spec.distTags || {})) packuments.get(name)['dist-tags'] = tags

const toHttp = s => s.split('REGISTRY/').join('https://registry.npmjs.org/')
for (const [name, doc] of packuments) {
  const text = JSON.stringify(doc, null, 2) + '\n'
  fs.writeFileSync(path.join(reg, name), text)
  fs.mkdirSync(path.dirname(path.join(http, name)), {recursive: true})
  fs.writeFileSync(path.join(http, name), toHttp(text))
  for (const [version, entry] of Object.entries(doc.versions)) {
    fs.writeFileSync(path.join(http, `${name}-${version}`), toHttp(JSON.stringify(entry, null, 2) + '\n'))
    fs.copyFileSync(path.join(reg, `${name}-${version}.tgz`), path.join(http, `${name}-${version}.tgz`))
  }
}
console.log(`  overlay: ${packuments.size} packuments, ${spec.packages.length} tarballs`)

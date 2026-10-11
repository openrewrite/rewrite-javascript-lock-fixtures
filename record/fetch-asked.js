// Saves, verbatim, every registry document a recorded install asked for: npm's `npm http fetch GET <status> <url>`
// lines (--loglevel=http) or bun's requests-after.log (`GET <url> accept=<...>`). A document from
// registry.npmjs.org goes to http/, one from registry.<label>.<tld> to http-<label>/, named as the scenario
// replays name them: <name> (abbreviated), <name>@full, <name>-<version> (a version document).
// Usage: node record/fetch-asked.js npm|bun <scenario-dir> <log>
const fs = require('fs')
const path = require('path')
const [pm, dir, log] = process.argv.slice(2)
const CORGI = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
const lines = fs.readFileSync(log, 'utf8').split('\n')
const asked = []
for (const line of lines) {
  let m
  if (pm === 'npm' && (m = line.match(/^npm http fetch GET (\d+) (\S+)/))) {
    asked.push({url: m[2], accept: CORGI, status: m[1]})
  } else if (pm === 'bun' && (m = line.match(/^GET (\S+) accept=(.*)$/))) {
    asked.push({url: m[1], accept: m[2] === '-' ? '*/*' : m[2]})
  }
}
const target = url => {
  const u = new URL(url)
  const labels = u.hostname.split('.')
  const dirName = u.hostname === 'registry.npmjs.org' ? 'http' : 'http-' + labels[1]
  let p = decodeURIComponent(u.pathname.slice(1)).replace(/%40/g, '@')
  const parts = p.split('/')
  const n = parts[0].startsWith('@') ? 2 : 1
  const name = parts.slice(0, n).join('/')
  if (parts.length > n && parts[n] === '-') return {dirName, file: null, name}
  const file = parts.length > n ? name + '-' + parts[n] : name
  return {dirName, file, name}
}
// npm's port reads the full document as the abbreviated one plus the version document of each version it picks: the
// versions the after lock holds of a name asked from a registry are fetched from that registry, as fetch-http.js does
if (pm === 'npm' && fs.existsSync(path.join(dir, 'after'))) {
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'after'), 'utf8'))
  const origins = new Map(asked.map(a => [target(a.url).name, a.url.slice(0, a.url.length - new URL(a.url).pathname.length + 1)]))
  for (const [loc, e] of Object.entries(lock.packages || {})) {
    const at = loc.lastIndexOf('node_modules/')
    if (at < 0 || e.link || !e.version) continue
    const name = e.name || loc.slice(at + 'node_modules/'.length)
    if (origins.has(name)) asked.push({url: origins.get(name) + name.replace('/', '%2f') + '/' + e.version, accept: '*/*'})
  }
}
;(async () => {
  for (const a of asked) {
    const t = target(a.url)
    if (t.file == null) {
      console.log(`  ${path.basename(dir)}: tarball ${a.url} (not saved)`)
      continue
    }
    const out = path.join(dir, t.dirName, t.file)
    if (fs.existsSync(out)) continue
    const res = await fetch(a.url, {headers: {accept: a.accept}})
    if (!res.ok) {
      console.log(`  ${path.basename(dir)}: ${res.status} ${a.url}`)
      continue
    }
    fs.mkdirSync(path.dirname(out), {recursive: true})
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()))
    console.log(`  ${path.basename(dir)}: ${t.dirName}/${t.file}`)
  }
})()

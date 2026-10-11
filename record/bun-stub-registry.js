// A registry for recording Bun against hand-made packuments: GET /<name> answers <scenario>/registry/<name>
// (scoped names as @scope%2fname; the file is the abbreviated packument), every other request is proxied to
// registry.npmjs.org with the same Accept header. Packument bodies have their https://registry.npmjs.org/
// tarball URLs rewritten to this registry (as a proxying registry does), unless the scenario holds a file
// `stub-keep-tarball-urls`. Every body served is saved as served to <scenario>/http/<name>, every request is
// appended to <scenario>/stub-requests.log (`GET <path> <served|proxied> <status>`).
// Usage: node record/bun-stub-registry.js <scenario-dir> <port>   (prints "listening" when ready)
const fs = require('fs')
const http = require('http')
const path = require('path')

const dir = path.resolve(process.argv[2])
const port = Number(process.argv[3])
fs.mkdirSync(path.join(dir, 'http'), { recursive: true })
const log = line => fs.appendFileSync(path.join(dir, 'stub-requests.log'), line + '\n')
const keep = fs.existsSync(path.join(dir, 'stub-keep-tarball-urls'))
const rewrite = body => keep ? body :
  Buffer.from(body.toString('utf8').split('"https://registry.npmjs.org/').join(`"http://127.0.0.1:${port}/`))

const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0])
  const file = path.join(dir, 'registry', name.replace('/', '%2f'))
  const save = body => fs.writeFileSync(path.join(dir, 'http', name.replace('/', '%2f')), body)
  if (fs.existsSync(file)) {
    const body = rewrite(fs.readFileSync(file))
    save(body)
    log(`${req.method} ${req.url} served 200`)
    res.writeHead(200, { 'content-type': 'application/vnd.npm.install-v1+json' })
    res.end(body)
    return
  }
  try {
    const up = await fetch('https://registry.npmjs.org' + req.url, { headers: { accept: req.headers.accept || '*/*' } })
    const raw = Buffer.from(await up.arrayBuffer())
    const body = name.includes('/-/') ? raw : rewrite(raw)
    if (up.status === 200 && !name.includes('/-/')) save(body)
    log(`${req.method} ${req.url} proxied ${up.status}`)
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' })
    res.end(body)
  } catch (e) {
    log(`${req.method} ${req.url} proxy-error ${e.message}`)
    res.writeHead(502)
    res.end()
  }
})
server.listen(port, '127.0.0.1', () => console.log('listening'))

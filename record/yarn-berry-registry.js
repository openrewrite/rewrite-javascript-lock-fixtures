// Logging npm registry for Yarn Berry recordings. Serves a scenario's hand-made documents from <overlay>/ (the http/
// layout: <name> is a packument, <name>-<version>.tgz a tarball; "REGISTRY/" in a packument is replaced by this server's
// URL) and proxies everything else to registry.npmjs.org, rewriting tarball URLs of the form
// https://registry.npmjs.org/<path> to this server so Yarn sees them as conventional. Appends one line per request to
// <log-file>: `GET <path> accept=<accept header> <status> <overlay|upstream>`.
// Usage: node yarn-berry-registry.js <port, 0 for any> <log-file> [overlay-dir]
// Prints "listening <port>" once ready, or "failed <code>" and exits 1 (a busy port must not be someone else's server).
const fs = require('fs')
const http = require('http')
const path = require('path')

const port = Number(process.argv[2])
const logFile = process.argv[3]
const overlay = process.argv[4] && fs.existsSync(process.argv[4]) ? process.argv[4] : null
const UP = 'https://registry.npmjs.org/'
let self = null

const log = line => fs.appendFileSync(logFile, line + '\n')

const overlayFile = rel => {
  if (!overlay) return null
  const f = path.join(overlay, rel)
  return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null
}

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
  const accept = req.headers.accept || ''
  const tgz = url.match(/^((?:@[^/]+\/)?[^/]+)\/-\/(?:@[^/]+\/)?[^/]*?-(\d[^/]*)\.tgz$/)
  const rel = tgz ? `${tgz[1]}-${tgz[2]}.tgz` : url
  const local = overlayFile(rel)
  if (local) {
    let body = fs.readFileSync(local)
    if (!tgz) body = Buffer.from(body.toString('utf8').split('REGISTRY/').join(self))
    res.writeHead(200, {'content-type': tgz ? 'application/octet-stream' : 'application/json'})
    res.end(body)
    log(`GET /${url} accept=${accept} 200 overlay`)
    return
  }
  if (overlay && !tgz && fs.existsSync(path.join(overlay, '.only'))) {
    res.writeHead(404, {'content-type': 'application/json'})
    res.end('{"error":"not found"}')
    log(`GET /${url} accept=${accept} 404 overlay`)
    return
  }
  try {
    const upstream = await fetch(UP + req.url.replace(/^\/+/, ''), {headers: accept ? {accept} : {}})
    let body = Buffer.from(await upstream.arrayBuffer())
    const type = upstream.headers.get('content-type') || ''
    if (!tgz && type.includes('json')) body = Buffer.from(body.toString('utf8').split(UP).join(self))
    res.writeHead(upstream.status, {'content-type': type})
    res.end(body)
    log(`GET /${url} accept=${accept} ${upstream.status} upstream`)
  } catch (e) {
    res.writeHead(502)
    res.end()
    log(`GET /${url} accept=${accept} 502 upstream ${e.message}`)
  }
})

server.on('error', e => {
  console.log(`failed ${e.code}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  self = `http://127.0.0.1:${server.address().port}/`
  console.log(`listening ${server.address().port}`)
})

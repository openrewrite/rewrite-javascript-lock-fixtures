// Runs npm in <cwd> against a local proxy of registry.npmjs.org and logs every request npm makes, with the
// document kind its Accept header asks for (abbreviated = application/vnd.npm.install-v1+json, full =
// application/json). npm gets a fresh --cache, so nothing is served from the cache.
//   <log>       one line per request: GET <path> <abbreviated|full|accept=...> <status>
//   <save-dir>  '-' or a directory; responses are saved there as fetch-http.js names them, except that a full
//               packument is saved as <name>@full (no npm package name contains a non-leading '@')
// NODE_BIN / NPM_CLI select the node binary and npm cli (default: this node and the npm installed beside it).
// Usage: node record/npm-proxied.js <cwd> <log> <save-dir|-> <npm args...>
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const [cwd, logFile, saveDir, ...npmArgs] = process.argv.slice(2)
const UP = 'https://registry.npmjs.org'
const NODE = process.env.NODE_BIN || process.execPath
const CLI = process.env.NPM_CLI || path.join(path.dirname(NODE), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const lines = []

const kind = accept => accept.startsWith('application/vnd.npm.install-v1+json') ? 'abbreviated'
  : accept === 'application/json' ? 'full' : `accept=${accept}`

const save = (url, k, body) => {
  if (saveDir === '-') return
  const parts = url.split('?')[0].slice(1).split('/').map(decodeURIComponent)
  if (parts[0] === '-' || parts.includes('-')) return
  let name, version
  if (parts[0].startsWith('@')) {
    const scoped = parts[0].includes('/') ? parts[0].split('/') : [parts[0], parts[1]]
    name = scoped.join('/')
    version = parts[0].includes('/') ? parts[1] : parts[2]
  } else {
    name = parts[0]
    version = parts[1]
  }
  const file = version ? `${name}-${version}` : k === 'full' ? `${name}@full` : name
  const out = path.join(saveDir, file)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  if (!fs.existsSync(out)) fs.writeFileSync(out, body)
}

const server = http.createServer(async (req, res) => {
  const accept = req.headers.accept || ''
  try {
    const up = await fetch(UP + req.url, { headers: { accept } })
    const body = Buffer.from(await up.arrayBuffer())
    lines.push(`${req.method} ${req.url} ${kind(accept)} ${up.status}`)
    if (up.ok) save(req.url, kind(accept), body)
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'content-length': body.length })
    res.end(body)
  } catch (e) {
    lines.push(`${req.method} ${req.url} ${kind(accept)} proxy-error ${e.message}`)
    res.writeHead(502)
    res.end(String(e))
  }
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-proxied-cache-'))
  const child = spawn(NODE, [CLI, ...npmArgs, '--registry', `http://127.0.0.1:${port}/`, '--cache', cache], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}` },
  })
  child.on('exit', code => {
    fs.writeFileSync(logFile, lines.join('\n') + '\n')
    fs.rmSync(cache, { recursive: true, force: true })
    server.close()
    process.exit(code == null ? 1 : code)
  })
})

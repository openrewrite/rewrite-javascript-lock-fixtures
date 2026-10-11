// An HTTP proxy that tunnels CONNECT and forwards plain requests, logging each target (host:port, or the url).
// Usage: node record/connect-proxy.js <port> <log file>
const http = require('http')
const net = require('net')
const fs = require('fs')

const port = Number(process.argv[2])
const log = process.argv[3]
const note = line => fs.appendFileSync(log, line + '\n')

const server = http.createServer((req, res) => {
  note('GET ' + req.url)
  const target = new URL(req.url)
  const upstream = http.request({host: target.hostname, port: target.port || 80, path: target.pathname + target.search,
    method: req.method, headers: req.headers}, up => {
    res.writeHead(up.statusCode, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => res.destroy())
  req.pipe(upstream)
})
server.on('connect', (req, socket, head) => {
  note('CONNECT ' + req.url)
  const [host, p] = req.url.split(':')
  const upstream = net.connect(Number(p || 443), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
server.listen(port, '127.0.0.1')

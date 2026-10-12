// The frozen registry of the pnpm sweep: an HTTP proxy that answers every request pnpm makes, for any host, from a
// scenario's own recording, so each release sees the network as the recording did. pnpm is pointed at it with
// HTTPS_PROXY / HTTP_PROXY and trusts it through NODE_EXTRA_CA_CERTS, so pnpm's own settings (registry, scopes, named
// registries, tarball URLs) stay the recording's and the lock names the real hosts.
//
//   CONNECT host:443  the tunnel is terminated here with a certificate for that host, signed by the sweep's own CA
//   GET http://host/  answered here as well (a registry on plain http)
//
// What answers a request, and how the answer is marked in requests.log and result.json:
//   recorded        the scenario's http/<name> (abbreviated), http/<name>@full, http/<name>-<version>, or
//                   http-url/<host><path>[.gz] for a document outside a registry
//   recorded-404    a packument the recording's own pnpm log reports as 404
//   recorded-full   an abbreviated packument was asked and the recording kept only the full one
//   as-of           a full packument was asked and the recording kept the abbreviated one: today's document cut back
//                   to the versions, tags and deprecations the recording saw
//   live (...)      nothing recorded: today's registry cut back to the recording's time; newer than the recording
//   tarball         a tarball, fetched once and kept (a published tarball never changes)
//   pm-refused      the tarball of a pnpm release: refused, so that no other pnpm than the one swept ever runs
//   attestation     /-/npm/v1/attestations/..., fetched once and kept (fixed when the version was published)
//   live-url        any other URL, fetched from its host today; newer than the recording
//   unserved        nothing recorded and no upstream to ask
const fs = require('fs')
const path = require('path')
const http = require('http')
const tls = require('tls')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const FULL = 'application/json'
const CORGI = 'application/vnd.npm.install-v1+json'
const OPENSSL = process.env.SWEEP_OPENSSL || 'openssl'

const read = f => fs.existsSync(f) ? fs.readFileSync(f) : null
const writeAtomic = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

// ---- the sweep's certificate authority ------------------------------------------------------------------------

const openssl = (args, cwd) => {
  const r = spawnSync(OPENSSL, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`openssl ${args.join(' ')}: ${r.stderr || r.error}`)
}

// A CA made once per sweep directory. Certificates are valid from before any recording: a release run under the
// recording's clock checks them against that clock.
const ensureCa = dir => {
  if (!fs.existsSync(path.join(dir, 'ca.pem'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const tmp = `${dir}.${process.pid}.tmp`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-subj', '/CN=lockwork pnpm sweep CA', '-not_before', '20260101000000Z', '-not_after', '20360101000000Z',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], tmp)
    fs.mkdirSync(path.join(tmp, 'hosts'))
    try {
      fs.renameSync(tmp, dir)
    } catch (e) {
      // another sweep made it first
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  const caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8')
  const contexts = new Map()
  const contextFor = host => {
    if (!contexts.has(host)) {
      const safe = host.replace(/[^A-Za-z0-9.-]/g, '_')
      const key = path.join(dir, 'hosts', `${safe}.key`)
      const pem = path.join(dir, 'hosts', `${safe}.pem`)
      if (!fs.existsSync(pem)) {
        const tmp = fs.mkdtempSync(path.join(dir, 'hosts', `.${safe}-`))
        const isIp = /^[0-9.]+$/.test(host) || host.includes(':')
        fs.writeFileSync(path.join(tmp, 'ext.cnf'), [`subjectAltName=${isIp ? 'IP' : 'DNS'}:${host}`,
          'extendedKeyUsage=serverAuth', 'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment'].join('\n') + '\n')
        openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'host.key', '-out', 'host.csr', '-subj', `/CN=${host.slice(0, 60)}`], tmp)
        // within the 825 days Apple's trust evaluation allows a server certificate
        openssl(['x509', '-req', '-in', 'host.csr', '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'),
          '-set_serial', `0x${crypto.randomBytes(8).toString('hex')}`, '-out', 'host.pem',
          '-not_before', '20260101000000Z', '-not_after', '20280101000000Z', '-extfile', 'ext.cnf'], tmp)
        fs.renameSync(path.join(tmp, 'host.key'), `${key}.${process.pid}`)
        fs.renameSync(`${key}.${process.pid}`, key)
        // the key is in place before the certificate that says the pair is ready
        fs.renameSync(path.join(tmp, 'host.pem'), pem)
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      let ctx
      try {
        ctx = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(pem, 'utf8') + caPem })
      } catch (e) {
        // two sweeps wrote the pair at once and the halves do not match: make it again
        fs.rmSync(pem, { force: true })
        fs.rmSync(key, { force: true })
        return contextFor(host)
      }
      contexts.set(host, ctx)
    }
    return contexts.get(host)
  }
  return { dir, caFile: path.join(dir, 'ca.pem'), caPem, contextFor }
}

// ---- what a request asks for --------------------------------------------------------------------------------

// the directory pnpm's metadata cache keeps a registry's documents in, which the scenarios' registry-hosts files use
const hostKey = (host, port, scheme) => !port || port === (scheme === 'https' ? 443 : 80) ? host : `${host}+${port}`

const registryRoute = url => {
  let parts
  try {
    parts = url.split('?')[0].slice(1).split('/').map(decodeURIComponent).join('/').split('/')
  } catch (e) {
    return null
  }
  if (!parts[0]) return null
  if (parts[0] === '-') {
    const m = url.split('?')[0].match(/^\/-\/npm\/v1\/attestations\/(.+)$/)
    return m ? { kind: 'attestation', file: decodeURIComponent(m[1]) } : { kind: 'api' }
  }
  const nameParts = parts[0].startsWith('@') ? 2 : 1
  if (parts.length < nameParts) return null
  const name = parts.slice(0, nameParts).join('/')
  const rest = parts.slice(nameParts)
  if (rest.length === 0) return { kind: 'packument', name }
  if (rest[0] === '-' && rest.length === 2 && /\.tgz$/.test(rest[1])) return { kind: 'tarball', name, file: `${name}/-/${rest[1]}` }
  if (rest.length === 1 && rest[0] !== '-') return { kind: 'manifest', name, version: rest[0], file: `${name}-${rest[0]}` }
  return null
}

// the packages pnpm installs to run another release of itself
const isPnpmItself = name => name === 'pnpm' || name === '@pnpm/exe' || /^@pnpm\/exe\./.test(name) ||
  /^@pnpm\/(macos|linux|linuxstatic|win|win32|darwin|freebsd|android)-[a-z0-9-]+$/.test(name)

// URLs whose content is fixed once published: a Node.js release's files, a commit's archive, a release asset
const fixedUrl = (key, urlPath) =>
  /^(unofficial-builds\.)?nodejs\.org$/.test(key) && /^\/(dist|download\/release)\/v\d+\.\d+\.\d+\//.test(urlPath) ||
  key === 'codeload.github.com' && /\/tar\.gz\/[0-9a-f]{40}$/.test(urlPath) ||
  key === 'github.com' && /^\/[^/]+\/[^/]+\/releases\/download\//.test(urlPath)

const isLoopback = host => host === 'localhost' || /^127\./.test(host) || host === '::1' || host === '[::1]' ||
  /^10\./.test(host) || /^192\.168\./.test(host)

// ---- today's registry, fetched once per sweep and kept ---------------------------------------------------------

const inflight = new Map()
const fetchOnce = (url, accept, into) => {
  if (!inflight.has(into)) {
    inflight.set(into, (async () => {
      if (fs.existsSync(into)) return fs.readFileSync(into)
      if (fs.existsSync(into + '.status')) return null
      let res
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(url, { headers: accept ? { accept } : {}, redirect: 'follow' })
          if (res.status < 500 || attempt >= 3) break
        } catch (e) {
          if (attempt >= 3) throw e
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
      }
      if (!res.ok) {
        // a server error is not the registry's answer and is asked again by the next sweep
        if (res.status < 500) writeAtomic(into + '.status', String(res.status))
        return null
      }
      const body = Buffer.from(await res.arrayBuffer())
      writeAtomic(into, body)
      return body
    })())
  }
  return inflight.get(into)
}

const encode = name => name.replace('/', '%2f')
const flat = p => p.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 150) + '-' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 10)

// ---- one scenario's registry ---------------------------------------------------------------------------------

// opts: scenarioDir, scenario (its name), shared (a directory for what every release reuses), at (the recording's
// time), ca, log ({ requests: [], overlay: Set, live: Set, pmMetadata: Set, pmRefused: Set })
const startRegistry = opts => new Promise(resolve => {
  const { scenarioDir, scenario, shared, at, ca, log } = opts
  const own = path.join(scenarioDir, 'http')
  const OVERLAY = path.join(shared, '_overlay', scenario)
  const TARBALLS = path.join(shared, '_tarballs')
  const LIVE = path.join(shared, '_live')
  const hosts = new Set(['registry.npmjs.org'])
  for (const h of (read(path.join(scenarioDir, 'registry-hosts')) || '').toString('utf8').split(/\s+/)) if (h) hosts.add(h)
  const logs = fs.readdirSync(scenarioDir).filter(f => /^pnpm-.*\.log$/.test(f)).map(f => fs.readFileSync(path.join(scenarioDir, f), 'utf8')).join('\n')
  const recorded404 = (origin, name) => {
    const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
    return logs.includes(`GET ${origin}/${enc}: Not Found - 404`) || logs.includes(`GET ${origin}/${name}: Not Found - 404`)
  }

  const liveDoc = async (origin, key, name, accept, suffix) => {
    const body = await fetchOnce(`${origin}/${encode(name)}`, accept, path.join(LIVE, key, `${name}${suffix}`))
    return body && JSON.parse(body.toString('utf8'))
  }

  // The packument a release asks for, as the registry stood when the scenario was recorded. Returns [body, how].
  const asOf = new Map()
  const packument = (origin, key, name, kind) => {
    const k = `${key}\0${name}\0${kind}`
    if (!asOf.has(k)) {
      asOf.set(k, (async () => {
        const recorded = hosts.has(key)
        const abbrFile = path.join(own, name)
        const fullFile = abbrFile + '@full'
        if (recorded) {
          if (kind === 'full' && fs.existsSync(fullFile)) return [fs.readFileSync(fullFile), 'recorded']
          if (kind === 'abbreviated' && fs.existsSync(abbrFile)) return [fs.readFileSync(abbrFile), 'recorded']
          if (kind === 'abbreviated' && fs.existsSync(fullFile)) return [fs.readFileSync(fullFile), 'recorded-full']
          if (!fs.existsSync(abbrFile) && recorded404(origin, name)) return [null, 'recorded-404']
        }
        const kept = path.join(OVERLAY, key, kind === 'full' ? `${name}@full` : name)
        if (fs.existsSync(kept + '.how')) {
          const how = fs.readFileSync(kept + '.how', 'utf8')
          return [fs.existsSync(kept) ? fs.readFileSync(kept) : null, how]
        }
        let body = null
        let how
        if (isLoopback(key.split('+')[0])) {
          how = 'unserved (a registry of the recording machine, with no recording of this package)'
        } else if (recorded && kind === 'full' && fs.existsSync(abbrFile)) {
          const abbr = JSON.parse(fs.readFileSync(abbrFile, 'utf8'))
          const live = await liveDoc(origin, key, name, FULL, '@full')
          if (!live) {
            how = 'absent (recorded abbreviated, gone from the registry since)'
          } else {
            const doc = { ...live, 'dist-tags': abbr['dist-tags'], versions: {}, time: {} }
            if (live.time && live.time.created) doc.time.created = live.time.created
            if (abbr.modified) doc.time.modified = abbr.modified
            const gone = []
            for (const [v, short] of Object.entries(abbr.versions || {})) {
              const m = live.versions && live.versions[v] ? { ...live.versions[v] } : null
              if (!m) {
                gone.push(v)
                doc.versions[v] = short
                continue
              }
              if (short.deprecated === undefined) delete m.deprecated
              else m.deprecated = short.deprecated
              doc.versions[v] = m
              if (live.time && live.time[v]) doc.time[v] = live.time[v]
            }
            body = Buffer.from(JSON.stringify(doc))
            how = gone.length ? `as-of (unpublished since: ${gone.join(' ')})` : 'as-of'
          }
        } else {
          // no recording of this package: today's registry, cut back to the recording's time where it is known
          const live = await liveDoc(origin, key, name, FULL, '@full')
          if (!live) {
            how = 'absent'
          } else {
            const cut = at ? Date.parse(at) : NaN
            const keep = v => Number.isNaN(cut) || !live.time || !live.time[v] || Date.parse(live.time[v]) <= cut
            const from = kind === 'full' ? live : await liveDoc(origin, key, name, `${CORGI}; q=1.0, ${FULL}; q=0.8, */*`, '')
            const doc = { ...from, versions: {} }
            for (const [v, m] of Object.entries((from && from.versions) || {})) if (keep(v)) doc.versions[v] = m
            const dropped = Object.keys((from && from.versions) || {}).length - Object.keys(doc.versions).length
            const tags = {}
            for (const [tag, v] of Object.entries(live['dist-tags'] || {})) if (doc.versions[v]) tags[tag] = v
            doc['dist-tags'] = tags
            let newest = null
            for (const v of Object.keys(doc.versions)) {
              const t = live.time && live.time[v]
              if (t && (!newest || Date.parse(t) > Date.parse(newest))) newest = t
            }
            if (kind === 'full') {
              doc.time = {}
              for (const [k2, t] of Object.entries(live.time || {})) if (k2 === 'created' || keep(k2) && doc.versions[k2]) doc.time[k2] = t
              if (newest) doc.time.modified = dropped ? newest : (live.time || {}).modified || newest
            } else if (dropped && newest) {
              doc.modified = newest
            }
            body = Buffer.from(JSON.stringify(doc))
            how = `live (${Number.isNaN(cut) ? 'uncut' : `cut at ${at}, ${dropped} later versions dropped`}${tags.latest === (live['dist-tags'] || {}).latest ? '' : ', latest tag lost'})`
          }
        }
        fs.mkdirSync(path.dirname(kept), { recursive: true })
        if (body) writeAtomic(kept, body)
        writeAtomic(kept + '.how', how)
        return [body, how]
      })())
    }
    return asOf.get(k)
  }

  const handler = async (req, res) => {
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    }
    let label = `${req.method} ${req.url}`
    try {
      // a tunnelled request names its origin on the tunnel; a proxied plain request names it in the request line
      let scheme, host, port, url
      const tunnel = req.socket.sweepTarget
      if (tunnel) {
        ({ scheme, host, port } = tunnel)
        url = req.url
      } else if (/^http:\/\//.test(req.url)) {
        const u = new URL(req.url)
        scheme = 'http'
        host = u.hostname
        port = Number(u.port || 80)
        url = u.pathname + u.search
      } else {
        log.requests.push(`${label} unserved (not a proxy request)`)
        return send(400, Buffer.from('not a proxy request'), 'text/plain')
      }
      const key = hostKey(host, port, scheme)
      const origin = `${scheme}://${host}${port === (scheme === 'https' ? 443 : 80) ? '' : `:${port}`}`
      label = `${req.method} ${origin}${url}`
      const accept = req.headers.accept || ''
      const note = (kind, how) => log.requests.push(`${label} ${kind} ${how}`)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        note('other', 'unserved (method)')
        log.overlay.add(`${key}${url}: unserved ${req.method}`)
        return send(404, Buffer.from('{"error":"not found"}'), FULL)
      }

      // a document outside a registry that the recording kept
      const urlPath = url.split('?')[0]
      const outside = path.join(scenarioDir, 'http-url', key + urlPath)
      if (!urlPath.includes('..') && urlPath !== '/') {
        if (fs.existsSync(outside) && fs.statSync(outside).isFile()) {
          note('url', 'recorded')
          return send(200, fs.readFileSync(outside), 'application/octet-stream')
        }
        if (fs.existsSync(outside + '.gz')) {
          note('url', 'recorded')
          return send(200, zlib.gunzipSync(fs.readFileSync(outside + '.gz')), /\.json$/.test(urlPath) ? FULL : 'application/octet-stream')
        }
      }

      const route = registryRoute(url)
      // a registry the recording asked, or any host asked the way a registry is asked
      const npmLike = hosts.has(key) || (route && (route.kind === 'tarball' || route.kind === 'packument' && /vnd\.npm\.install/.test(accept)))
      if (route && npmLike && route.kind === 'packument') {
        const kind = accept.includes(CORGI) ? 'abbreviated' : 'full'
        const [body, how] = await packument(origin, key, route.name, kind)
        if (isPnpmItself(route.name)) log.pmMetadata.add(route.name)
        if (!/^recorded(-404)?$/.test(how) && how !== 'as-of') log.overlay.add(`${key === 'registry.npmjs.org' ? '' : key + '/'}${route.name}${kind === 'full' ? '@full' : ''}: ${how}`)
        note(kind, how)
        if (!body) return send(404, Buffer.from('{"error":"Not found"}'), FULL)
        return send(200, body, kind === 'abbreviated' && how !== 'recorded-full' ? CORGI : FULL)
      }
      if (route && npmLike && route.kind === 'tarball') {
        if (isPnpmItself(route.name)) {
          log.pmRefused.add(route.file)
          note('tarball', 'pm-refused')
          return send(403, Buffer.from('{"error":"the sweep runs one pnpm release and serves no other"}'), FULL)
        }
        let body = read(path.join(own, route.file))
        let how = 'recorded'
        if (!body) {
          body = isLoopback(host) ? null : await fetchOnce(origin + url, '', path.join(TARBALLS, key, route.file))
          how = body ? 'tarball' : 'absent'
          if (!body) log.overlay.add(`${route.file}: absent`)
        }
        note('tarball', how)
        return body ? send(200, body, 'application/octet-stream') : send(404, Buffer.from('{"error":"Not found"}'), FULL)
      }
      if (route && npmLike && route.kind === 'manifest') {
        let body = hosts.has(key) ? read(path.join(own, route.file)) : null
        let how = 'recorded'
        if (!body) {
          body = isLoopback(host) ? null : await fetchOnce(origin + url, accept, path.join(LIVE, key, route.file))
          how = body ? 'live-manifest' : 'absent'
          log.overlay.add(`${route.file}: ${how}`)
        }
        note('manifest', how)
        return body ? send(200, body, FULL) : send(404, Buffer.from('{"error":"Not found"}'), FULL)
      }
      if (route && npmLike && route.kind === 'attestation') {
        const body = isLoopback(host) ? null : await fetchOnce(origin + url, accept, path.join(LIVE, key, '-attestations', flat(route.file)))
        note('attestation', body ? 'attestation' : 'attestation-404')
        return body ? send(200, body, FULL) : send(404, Buffer.from('{"error":"Not found"}'), FULL)
      }

      // anything else: its host's answer today
      if (isLoopback(host)) {
        note('url', 'unserved')
        log.overlay.add(`${key}${urlPath}: unserved`)
        return send(404, Buffer.from('not found'), 'text/plain')
      }
      const body = await fetchOnce(origin + url, accept, path.join(LIVE, key, '-url', flat(url)))
      // a release file or a commit's archive is the same today as when the scenario was recorded
      const fixed = fixedUrl(key, urlPath)
      if (!fixed) log.live.add(`${key}${urlPath}`)
      note('url', body ? (fixed ? 'fixed-url' : 'live-url') : (fixed ? 'fixed-url-absent' : 'live-url-absent'))
      return body ? send(200, body, 'application/octet-stream') : send(404, Buffer.from('not found'), 'text/plain')
    } catch (e) {
      log.requests.push(`${label} stub-error ${e && e.message}`)
      log.overlay.add(`stub-error: ${e && e.message}`)
      try {
        send(502, Buffer.from(String(e)), 'text/plain')
      } catch (e2) {
        res.destroy()
      }
    }
  }

  // decrypted and plain tunnelled connections are served here; it never listens
  const inner = http.createServer(handler)
  const proxy = http.createServer(handler)
  const sockets = new Set()
  proxy.on('connection', s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  proxy.on('connect', (req, socket, head) => {
    const at2 = req.url.lastIndexOf(':')
    const host = req.url.slice(0, at2).replace(/^\[|\]$/g, '')
    const port = Number(req.url.slice(at2 + 1))
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const start = first => {
      // the first bytes say whether the client speaks TLS through the tunnel; they are put back for whoever reads next
      socket.pause()
      socket.unshift(first)
      if (first[0] === 0x16) {
        let secure
        try {
          // the TLS socket takes what the socket has buffered (the client hello) when it starts reading
          secure = new tls.TLSSocket(socket, { isServer: true, secureContext: ca.contextFor(host) })
        } catch (e) {
          log.requests.push(`CONNECT ${req.url} stub-error ${e.message}`)
          log.overlay.add(`stub-error: ${e.message}`)
          return socket.destroy()
        }
        secure.sweepTarget = { scheme: 'https', host, port }
        secure.on('error', e => log.requests.push(`CONNECT ${req.url} tls-error ${e.code || e.message}`))
        inner.emit('connection', secure)
      } else {
        socket.sweepTarget = { scheme: 'http', host, port }
        inner.emit('connection', socket)
        socket.resume()
      }
    }
    if (head && head.length) start(head)
    else socket.once('data', start)
  })
  proxy.listen(0, '127.0.0.1', () => resolve({
    port: proxy.address().port,
    close: () => {
      proxy.close()
      for (const s of sockets) s.destroy()
    },
  }))
})

module.exports = { ensureCa, startRegistry, isPnpmItself, registryRoute }

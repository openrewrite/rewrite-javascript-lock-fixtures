// The frozen registry of the Bun sweep: an HTTP proxy that answers every request bun makes, for any host, from a
// scenario's own recording, so each release sees the network as the recording did. Adapted from pnpm-registry.js.
// bun is pointed at it with HTTPS_PROXY / HTTP_PROXY and trusts it through NODE_EXTRA_CA_CERTS, so bun's own settings
// (registry, scopes, .env, bunfig, user .npmrc) stay the recording's and the lock names the real hosts. That matters
// for bun.lock: a package tuple's registry field is "" exactly when the tarball URL starts with
// https://registry.npmjs.org, and a "" read back is expanded to the *configured* registry, so a stub configured as the
// registry would rewrite every carried entry.
//
//   CONNECT host:443  the tunnel is terminated here with a certificate for that host, signed by the sweep's own CA
//   GET http://host/  answered here as well (a registry on plain http: the recordings' loopback stubs)
//
// Where a host's recording is, as the recorders keep it (record/fetch-asked.js, record/bun-stub-registry.js):
//   registry.npmjs.org           http/
//   registry.<label>.<tld>       http-<label>/
//   127.0.0.1:<port>             http/, when the scenario's config names http://127.0.0.1:<port>/ (the recording's
//                                bun-stub-registry.js, whose bodies http/ holds as it served them); a package it holds
//                                no body of is npmjs's, with https://registry.npmjs.org/ tarball URLs rewritten to the
//                                stub's origin, as that stub proxied it
// A scenario's stub-delays (`<name> <ms>` lines) holds back that package's packument as the recording's stub did.
//
// What answers a request, and how the answer is marked in requests.log and result.json:
//   recorded        the scenario's own document for that host
//   recorded-full   an abbreviated packument was asked and the recording kept only the full one
//   as-of           a full packument was asked and the recording kept the abbreviated one: today's document cut back
//                   to the versions, tags and deprecations the recording saw
//   live (...)      nothing recorded: today's registry cut back to the recording's time; newer than the recording
//   stub-proxied (...) a loopback stub's answer for a package it kept no body of: npmjs's as above, URLs rewritten
//   tarball         a tarball, fetched once and kept (a published tarball never changes)
//   live-url        any other URL (a GitHub tarball), fetched from its host once per sweep and kept; newer than the
//                   recording
//   unserved        nothing recorded and no upstream to ask
const fs = require('fs')
const path = require('path')
const http = require('http')
const tls = require('tls')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const FULL = 'application/json'
const CORGI = 'application/vnd.npm.install-v1+json'
const NPMJS = 'https://registry.npmjs.org'
const OPENSSL = process.env.SWEEP_OPENSSL || 'openssl'

const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null
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

// A CA made once per sweep directory, valid from before any recording.
const ensureCa = dir => {
  if (!fs.existsSync(path.join(dir, 'ca.pem'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const tmp = `${dir}.${process.pid}.tmp`
    fs.rmSync(tmp, { recursive: true, force: true })
    fs.mkdirSync(tmp, { recursive: true })
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-subj', '/CN=lockwork bun sweep CA', '-not_before', '20230101000000Z', '-not_after', '20360101000000Z',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], tmp)
    fs.mkdirSync(path.join(tmp, 'hosts'))
    try {
      fs.renameSync(tmp, dir)
    } catch (e) {
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
          '-not_before', '20250801000000Z', '-not_after', '20271101000000Z', '-extfile', 'ext.cnf'], tmp)
        fs.renameSync(path.join(tmp, 'host.key'), `${key}.${process.pid}`)
        fs.renameSync(`${key}.${process.pid}`, key)
        fs.renameSync(path.join(tmp, 'host.pem'), pem)
        fs.rmSync(tmp, { recursive: true, force: true })
      }
      let ctx
      try {
        ctx = tls.createSecureContext({ key: fs.readFileSync(key), cert: fs.readFileSync(pem, 'utf8') + caPem })
      } catch (e) {
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

const hostKey = (host, port, scheme) => !port || port === (scheme === 'https' ? 443 : 80) ? host : `${host}+${port}`

const registryRoute = url => {
  let parts
  try {
    parts = url.split('?')[0].slice(1).split('/').map(decodeURIComponent).join('/').split('/')
  } catch (e) {
    return null
  }
  if (!parts[0]) return null
  if (parts[0] === '-') return { kind: 'api' }
  const nameParts = parts[0].startsWith('@') ? 2 : 1
  if (parts.length < nameParts) return null
  const name = parts.slice(0, nameParts).join('/')
  const rest = parts.slice(nameParts)
  if (rest.length === 0) return { kind: 'packument', name }
  if (rest[0] === '-' && rest.length === 2 && /\.tgz$/.test(rest[1])) return { kind: 'tarball', name, file: `${name}/-/${rest[1]}` }
  if (rest.length === 1 && rest[0] !== '-') return { kind: 'manifest', name, version: rest[0], file: `${name}-${rest[0]}` }
  return null
}

const isLoopback = host => host === 'localhost' || /^127\./.test(host) || host === '::1' || host === '[::1]'

// URLs whose content is fixed once published: a commit's archive, a release asset
const fixedUrl = (key, urlPath) =>
  key === 'codeload.github.com' && /\/tar\.gz\/[0-9a-f]{40}$/.test(urlPath) ||
  key === 'github.com' && /^\/[^/]+\/[^/]+\/releases\/download\//.test(urlPath)

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
        // a 4xx is the host's answer and is kept; a server error is asked again by the next run
        if (res.status < 500 && res.status !== 429 && res.status !== 403) writeAtomic(into + '.status', String(res.status))
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

// The loopback registries a scenario's config names (the recording's bun-stub-registry.js): { 'host+port': origin }
const loopbackRegistries = scenarioDir => {
  const out = {}
  const texts = []
  for (const f of ['npmrc', 'npmrc-before', 'bunfig', 'bunfig-before', 'user-npmrc', 'user-npmrc-before']) {
    const t = read(path.join(scenarioDir, f))
    if (t) texts.push(t.toString('utf8'))
  }
  for (const t of texts) {
    for (const m of t.matchAll(/http:\/\/(127\.0\.0\.1|localhost):(\d+)\/?/g)) out[`${m[1]}+${m[2]}`] = `http://${m[1]}:${m[2]}`
  }
  return out
}

// ---- one scenario's registry ---------------------------------------------------------------------------------

// opts: scenarioDir, scenario (a key for the as-of documents), shared (what every release reuses), at (the recording's
// time, or null), atDay (true when only the recording's day is known), ca, log ({ requests: [], overlay: Set, live: Set })
const startRegistry = opts => new Promise(resolve => {
  const { scenarioDir, scenario, shared, at, ca, log } = opts
  const OVERLAY = path.join(shared, '_overlay', scenario)
  const TARBALLS = path.join(shared, '_tarballs')
  const LIVE = path.join(shared, '_live')
  const loopbacks = loopbackRegistries(scenarioDir)
  // the directory holding a host's recording, or null
  const ownDir = key => {
    if (key === 'registry.npmjs.org' || loopbacks[key]) return path.join(scenarioDir, 'http')
    const labels = key.split('+')[0].split('.')
    if (labels.length >= 3 && labels[0] === 'registry') {
      const d = path.join(scenarioDir, `http-${labels[1]}`)
      if (fs.existsSync(d)) return d
    }
    return null
  }
  const delays = {}
  for (const line of String(read(path.join(scenarioDir, 'stub-delays')) || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\d+)$/)
    if (m) delays[m[1]] = Number(m[2])
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
        const own = ownDir(key)
        const abbrFile = own && path.join(own, name.replace('/', '%2f'))
        const abbrFile2 = own && path.join(own, name)
        const abbr = own ? (read(abbrFile) ? abbrFile : read(abbrFile2) ? abbrFile2 : null) : null
        const fullFile = abbr ? abbr + '@full' : own && path.join(own, name + '@full')
        if (own) {
          if (kind === 'full' && read(fullFile)) return [read(fullFile), 'recorded']
          if (kind === 'abbreviated' && abbr) return [read(abbr), 'recorded']
          if (kind === 'abbreviated' && read(fullFile)) return [read(fullFile), 'recorded-full']
        }
        const kept = path.join(OVERLAY, key, kind === 'full' ? `${name}@full` : name)
        if (fs.existsSync(kept + '.how')) {
          const how = fs.readFileSync(kept + '.how', 'utf8')
          return [fs.existsSync(kept) ? fs.readFileSync(kept) : null, how]
        }
        let body = null
        let how
        if (loopbacks[key]) {
          // the recording's stub proxied what it held no body of to registry.npmjs.org, rewriting tarball URLs
          const [up, upHow] = await packument(NPMJS, 'registry.npmjs.org', name, kind)
          body = up && Buffer.from(up.toString('utf8').split(`"${NPMJS}/`).join(`"${loopbacks[key]}/`))
          how = up ? `stub-proxied (${upHow})` : 'absent'
        } else if (isLoopback(key.split('+')[0])) {
          how = 'unserved (a loopback registry no config of the scenario names)'
        } else if (own && kind === 'full' && abbr) {
          const short = JSON.parse(read(abbr).toString('utf8'))
          const live = await liveDoc(origin, key, name, FULL, '@full')
          if (!live) {
            how = 'absent (recorded abbreviated, gone from the registry since)'
          } else {
            const doc = { ...live, 'dist-tags': short['dist-tags'], versions: {}, time: {} }
            if (live.time && live.time.created) doc.time.created = live.time.created
            if (short.modified) doc.time.modified = short.modified
            const gone = []
            for (const [v, s] of Object.entries(short.versions || {})) {
              const m = live.versions && live.versions[v] ? { ...live.versions[v] } : null
              if (!m) {
                gone.push(v)
                doc.versions[v] = s
                continue
              }
              if (s.deprecated === undefined) delete m.deprecated
              else m.deprecated = s.deprecated
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
            // where only the recording's day is known, a version published that day may or may not have been there
            const sameDay = opts.atDay && at ? Object.keys((from && from.versions) || {}).filter(v => live.time && live.time[v] &&
              live.time[v].slice(0, 10) === at.slice(0, 10)) : []
            body = Buffer.from(JSON.stringify(doc))
            how = `live (${Number.isNaN(cut) ? 'uncut: the recording\'s time is unknown' : `cut at ${at}, ${dropped} later versions dropped`}` +
              `${tags.latest === (live['dist-tags'] || {}).latest ? '' : ', latest tag lost'}` +
              `${sameDay.length ? `, published on the recording's day: ${sameDay.join(' ')}` : ''})`
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

  // requests being answered right now (a run waiting on one is not stalled)
  const state = { inflight: 0 }
  const handler = async (req, res) => {
    state.inflight++
    res.on('close', () => { state.inflight-- })
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    }
    let label = `${req.method} ${req.url}`
    try {
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
      } else if (opts.directFor) {
        // a request made to the loopback stub's own port (bun bypassing the proxy for it)
        ({ scheme, host, port } = opts.directFor(req.socket.localPort))
        url = req.url
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
      const route = registryRoute(url)
      const npmLike = ownDir(key) != null || (route && (route.kind === 'tarball' || route.kind === 'packument' && /vnd\.npm\.install/.test(accept)))
      if (route && npmLike && route.kind === 'packument') {
        const kind = accept.includes(CORGI) ? 'abbreviated' : 'full'
        const [body, how] = await packument(origin, key, route.name, kind)
        if (!/^recorded/.test(how) && how !== 'as-of') log.overlay.add(`${key === 'registry.npmjs.org' ? '' : key + '/'}${route.name}${kind === 'full' ? '@full' : ''}: ${how}`)
        if (delays[route.name]) await new Promise(r => setTimeout(r, delays[route.name]))
        note(kind, how + (delays[route.name] ? ` (held ${delays[route.name]} ms)` : ''))
        if (!body) return send(404, Buffer.from('{"error":"Not found"}'), FULL)
        return send(200, body, kind === 'abbreviated' && how !== 'recorded-full' ? CORGI : FULL)
      }
      if (route && npmLike && route.kind === 'tarball') {
        const own = ownDir(key)
        let body = own ? read(path.join(own, route.file)) : null
        let how = 'recorded'
        if (!body) {
          // a loopback stub proxied tarballs to registry.npmjs.org unchanged
          const upOrigin = loopbacks[key] ? NPMJS : origin
          const upKey = loopbacks[key] ? 'registry.npmjs.org' : key
          body = isLoopback(host) && !loopbacks[key] ? null : await fetchOnce(upOrigin + url, '', path.join(TARBALLS, upKey, route.file))
          how = body ? 'tarball' : 'absent'
          if (!body) log.overlay.add(`${route.file}: absent`)
        }
        note('tarball', how)
        return body ? send(200, body, 'application/octet-stream') : send(404, Buffer.from('{"error":"Not found"}'), FULL)
      }
      if (route && npmLike && route.kind === 'manifest') {
        const own = ownDir(key)
        let body = own ? read(path.join(own, route.file)) : null
        let how = 'recorded'
        if (!body) {
          body = isLoopback(host) ? null : await fetchOnce(origin + url, accept, path.join(LIVE, key, route.file))
          how = body ? 'live-manifest' : 'absent'
          log.overlay.add(`${route.file}: ${how}`)
        }
        note('manifest', how)
        return body ? send(200, body, FULL) : send(404, Buffer.from('{"error":"Not found"}'), FULL)
      }
      // anything else: its host's answer, fetched once per sweep and kept
      const urlPath = url.split('?')[0]
      if (isLoopback(host)) {
        note('url', 'unserved')
        log.overlay.add(`${key}${urlPath}: unserved`)
        return send(404, Buffer.from('not found'), 'text/plain')
      }
      const body = await fetchOnce(origin + url, accept, path.join(LIVE, key, '-url', flat(url)))
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
      socket.pause()
      socket.unshift(first)
      if (first[0] === 0x16) {
        let secure
        try {
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
    handler,
    loopbacks,
    inflight: () => state.inflight,
    close: () => {
      proxy.close()
      for (const s of sockets) s.destroy()
    },
  }))
})

module.exports = { ensureCa, startRegistry, registryRoute, loopbackRegistries }

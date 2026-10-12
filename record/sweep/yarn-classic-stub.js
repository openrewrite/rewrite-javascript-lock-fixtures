// A frozen registry for one Yarn classic scenario, reached as an HTTP proxy (yarn's `proxy` and `https-proxy`
// settings, given as npm_config_proxy / npm_config_https_proxy, as record/record-yarn-classic-user.sh gives them), so
// yarn keeps asking the hosts the recording asked and no setting of the scenario changes. CONNECT to port 443 is
// answered with a certificate for that host signed by the sweep's own authority (NODE_EXTRA_CA_CERTS in the yarn
// process); a request in proxy form (http://127.0.0.1:<port>/...) is answered directly. Nothing goes to the network
// but the documents and tarballs fetched once for the whole sweep and kept.
//
// Hosts and what stands for them:
//   registry.yarnpkg.com, registry.npmjs.org     <scenario>/http/
//   registry.npmmirror.com, cdn.npmmirror.com    <scenario>/http-npmmirror/
//   127.0.0.1:<port>, localhost:<port>           the recorder's own registry: <scenario>/http/, with the scenario's
//                                                registry-config applied as that registry applied it (`patch` merged
//                                                into a version's manifest, `notFound` paths answered 404, `rewrite`:
//                                                it proxied registry.npmjs.org and named itself in every url)
//   github.com, codeload.github.com, raw.githubusercontent.com, api.github.com
//                                                fetched once and kept (a GitHub spec resolves over HTTP)
// Answers:
//   packument   the recording's own document where the release asks for the kind it kept (every Yarn 1 release asks
//               for the abbreviated one when it installs); a full one rebuilt from today's, cut back to the versions,
//               dist-tags and deprecations the recording kept ("as-of"); a package the recording did not keep is
//               today's, cut at the recording's time ("live"). Anything not the recording's own is named in `overlay`.
//   tarball     <scenario>/<dir>/<name>-<version>.tgz, else the registry's own, fetched once (a tarball never changes).
//   other       404, named in `unserved`.
const fs = require('fs')
const path = require('path')
const http = require('http')
const tls = require('tls')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const NPM = 'https://registry.npmjs.org'
const CORGI = 'application/vnd.npm.install-v1+json'
const JSON_TYPE = 'application/json'
const GITHUB = ['github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'api.github.com']

const familyOf = (host, port, scheme) => {
  if (host === '127.0.0.1' || host === 'localhost') return { name: `local-${port}`, dir: 'http', upstream: NPM, local: `${scheme}://${host}:${port}/`, recorder: true }
  if (host === 'registry.yarnpkg.com' || host === 'registry.npmjs.org') return { name: 'npm', dir: 'http', upstream: NPM }
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return { name: 'npmmirror', dir: 'http-npmmirror', upstream: 'https://registry.npmmirror.com' }
  if (GITHUB.includes(host)) return { name: 'github', live: `https://${host}` }
  return null
}

// ---- the sweep's certificate authority -------------------------------------------------------------------------
const openssl = args => execFileSync('/usr/bin/openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
const once = (file, make) => {
  if (fs.existsSync(file)) return
  const tmp = `${file}.${process.pid}.tmp`
  make(tmp)
  fs.renameSync(tmp, file)
}
const ensureCa = dir => {
  fs.mkdirSync(path.join(dir, 'hosts'), { recursive: true })
  const caKey = path.join(dir, 'ca-key.pem')
  const caCert = path.join(dir, 'ca.pem')
  const leafKey = path.join(dir, 'leaf-key.pem')
  once(caKey, tmp => openssl(['genrsa', '-out', tmp, '2048']))
  once(caCert, tmp => {
    const conf = `${tmp}.cnf`
    fs.writeFileSync(conf, '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=yarn-classic sweep CA\n' +
      '[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
    openssl(['req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '825', '-config', conf, '-out', tmp])
    fs.rmSync(conf, { force: true })
  })
  once(leafKey, tmp => openssl(['genrsa', '-out', tmp, '2048']))
  const contexts = new Map()
  const contextFor = host => {
    if (!contexts.has(host)) {
      const cert = path.join(dir, 'hosts', `${host.replace(/[^A-Za-z0-9.-]/g, '_')}.pem`)
      once(cert, tmp => {
        const isIp = /^[\d.]+$/.test(host)
        fs.writeFileSync(`${tmp}.ext`, `subjectAltName=${isIp ? 'IP' : 'DNS'}:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`)
        openssl(['req', '-new', '-key', leafKey, '-subj', `/CN=${host}`, '-out', `${tmp}.csr`])
        openssl(['x509', '-req', '-in', `${tmp}.csr`, '-CA', caCert, '-CAkey', caKey, '-set_serial', String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
          '-sha256', '-days', '825', '-extfile', `${tmp}.ext`, '-out', tmp])
        fs.rmSync(`${tmp}.csr`, { force: true })
        fs.rmSync(`${tmp}.ext`, { force: true })
      })
      contexts.set(host, tls.createSecureContext({ key: fs.readFileSync(leafKey), cert: fs.readFileSync(cert) }))
    }
    return contexts.get(host)
  }
  return { caCert, contextFor }
}

// ---- what the network really has, fetched once for the whole sweep and kept (a 404 too) ---------------------------
const makeShared = outRoot => {
  const LIVE = path.join(outRoot, '_live')
  const TARBALLS = path.join(outRoot, '_tarballs')
  const ASOF = path.join(outRoot, '_asof')
  const inflight = new Map()
  // -> { status, type, body } | null for a 404
  const fetchOnce = (url, accept, into) => {
    if (!inflight.has(into)) {
      inflight.set(into, (async () => {
        if (fs.existsSync(into + '.meta')) {
          const meta = JSON.parse(fs.readFileSync(into + '.meta', 'utf8'))
          return { ...meta, body: meta.status < 300 ? fs.readFileSync(into) : Buffer.alloc(0) }
        }
        let res
        for (let attempt = 0; ; attempt++) {
          try {
            res = await fetch(url, { headers: accept ? { accept } : {}, redirect: 'follow' })
            if (res.status < 500 || attempt >= 3) break
          } catch (e) {
            if (attempt >= 3) throw new Error(`fetch ${url}: ${e.message}`)
          }
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        }
        if (res.status >= 500) throw new Error(`fetch ${url}: ${res.status}`)
        const body = Buffer.from(await res.arrayBuffer())
        const meta = { status: res.status, type: res.headers.get('content-type') || 'application/octet-stream', url }
        fs.mkdirSync(path.dirname(into), { recursive: true })
        if (res.status < 300) {
          fs.writeFileSync(`${into}.${process.pid}.tmp`, body)
          fs.renameSync(`${into}.${process.pid}.tmp`, into)
        }
        fs.writeFileSync(`${into}.meta.${process.pid}.tmp`, JSON.stringify(meta))
        fs.renameSync(`${into}.meta.${process.pid}.tmp`, into + '.meta')
        return { ...meta, body: res.status < 300 ? body : Buffer.alloc(0) }
      })())
      inflight.get(into).catch(() => inflight.delete(into))
    }
    return inflight.get(into)
  }
  const encode = name => name.replace('/', '%2f')
  const liveDoc = async (upstream, family, name, full) => {
    const r = await fetchOnce(`${upstream}/${encode(name)}`, full ? JSON_TYPE : CORGI, path.join(LIVE, family, full ? `${name}@full` : name))
    if (!r || r.status !== 200) return null
    try {
      const doc = JSON.parse(r.body.toString('utf8'))
      return doc && typeof doc === 'object' && doc.versions ? doc : null
    } catch (e) {
      return null
    }
  }
  return { LIVE, TARBALLS, ASOF, fetchOnce, liveDoc, asOf: new Map() }
}

const kindOfDoc = j => {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.versions || typeof j.versions !== 'object') return 'other'
  if (j.time || j._id || j._rev) return 'full'
  if (j.modified) return 'abbreviated'
  // the first downloaded fixtures keep the version numbers and dist-tags only
  const entries = Object.values(j.versions)
  if (entries.length && entries.every(e => e && typeof e === 'object' && !Array.isArray(e) && !Object.keys(e).length)) return 'pruned'
  return 'handmade'
}

// The packument the release asks for, as the registry stood when the scenario was recorded: [body | null, how].
const packument = (shared, scenario, scenarioDir, family, name, wantFull, at) => {
  const key = `${scenario}\0${family.name}\0${name}\0${wantFull ? 'full' : 'abbreviated'}`
  if (!shared.asOf.has(key)) {
    shared.asOf.set(key, (async () => {
      const own = path.join(scenarioDir, family.dir, name)
      const recorded = fs.existsSync(own) && fs.statSync(own).isFile() ? fs.readFileSync(own) : null
      let j = null
      let kind = 'none'
      if (recorded) {
        try {
          j = JSON.parse(recorded.toString('utf8'))
          kind = kindOfDoc(j)
        } catch (e) {
          return [recorded, 'recorded']
        }
        // what the recording kept is what the registry answered, whatever the release asks for, where it cannot be
        // rebuilt (a hand-made document) or is the kind asked for
        if (kind !== 'abbreviated' && kind !== 'full' && kind !== 'pruned') return [recorded, 'recorded']
        if (kind !== 'pruned' && (kind === 'full') === wantFull) return [recorded, 'recorded']
      }
      const famKey = family.recorder ? 'npm' : family.name
      const kept = path.join(shared.ASOF, scenario, family.name, wantFull ? `${name}@full` : name)
      if (fs.existsSync(kept)) return [fs.readFileSync(kept), fs.readFileSync(kept + '.how', 'utf8')]
      let doc
      let how
      const live = await shared.liveDoc(family.upstream, famKey, name, true)
      if (recorded && kind === 'pruned') {
        // version numbers and dist-tags as the recording kept them; each version's entry from the registry's own
        // document of the kind asked for (a published version never changes but for its deprecation), else the
        // version's manifest the recording kept
        const from = wantFull ? live : await shared.liveDoc(family.upstream, famKey, name, false)
        doc = from ? { ...from, 'dist-tags': j['dist-tags'], versions: {} } : { name: j.name, 'dist-tags': j['dist-tags'], versions: {} }
        if (wantFull) doc.time = {}
        const gone = []
        for (const v of Object.keys(j.versions)) {
          let m = from && from.versions && from.versions[v]
          if (!m) {
            const f = path.join(scenarioDir, family.dir, `${name}-${v}`)
            try {
              m = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
            } catch (e) {
              m = null
            }
            gone.push(v)
          }
          doc.versions[v] = m || {}
          if (wantFull && live && live.time && live.time[v]) doc.time[v] = live.time[v]
        }
        how = `as-of a pruned document (version numbers and dist-tags recorded; deprecations as of today${gone.length ? `; not on the registry today: ${gone.join(' ')}` : ''})`
      } else if (recorded) {
        // versions, tags and deprecations as the recording kept them; everything else of a published version never changes
        if (kind === 'full') {
          // asked abbreviated, recorded full: the registry's own abbreviated document, cut to the recorded versions
          const abbr = await shared.liveDoc(family.upstream, famKey, name, false)
          doc = abbr ? { ...abbr, 'dist-tags': j['dist-tags'], versions: {} } : { name: j.name, 'dist-tags': j['dist-tags'], versions: {} }
          for (const v of Object.keys(j.versions)) doc.versions[v] = (abbr && abbr.versions[v]) || j.versions[v]
          if (j.time && j.time.modified) doc.modified = j.time.modified
          how = abbr ? 'as-of (abbreviated from the registry, versions as the recorded full document)' : 'recorded full document (the registry no longer has the package)'
        } else {
          doc = live ? { ...live } : { name: j.name }
          doc['dist-tags'] = j['dist-tags']
          doc.versions = {}
          doc.time = {}
          if (live && live.time && live.time.created) doc.time.created = live.time.created
          const gone = []
          for (const [v, short] of Object.entries(j.versions)) {
            let m = live && live.versions && live.versions[v] ? { ...live.versions[v] } : null
            if (!m) {
              gone.push(v)
              m = short
            } else if (short.deprecated === undefined) {
              delete m.deprecated
            } else {
              m.deprecated = short.deprecated
            }
            doc.versions[v] = m
            if (live && live.time && live.time[v]) doc.time[v] = live.time[v]
          }
          if (j.modified) doc.time.modified = j.modified
          how = !live ? 'recorded versions only (the registry no longer has the package)' : `as-of${gone.length ? ` (not on the registry today: ${gone.join(' ')})` : ''}`
        }
      } else {
        if (!live) return [null, 'absent']
        const cut = at ? Date.parse(at) : NaN
        const keep = v => Number.isNaN(cut) || !live.time || !live.time[v] || Date.parse(live.time[v]) <= cut
        const from = wantFull ? live : await shared.liveDoc(family.upstream, famKey, name, false)
        if (!from) return [null, 'absent']
        doc = { ...from, versions: {} }
        if (wantFull) {
          doc.time = {}
          for (const [k, t] of Object.entries(live.time || {})) if (k === 'created' || k === 'modified' || keep(k)) doc.time[k] = t
        }
        for (const [v, m] of Object.entries(from.versions || {})) if (keep(v)) doc.versions[v] = m
        const dropped = Object.keys(from.versions || {}).length - Object.keys(doc.versions).length
        const tags = {}
        for (const [tag, v] of Object.entries(from['dist-tags'] || {})) if (doc.versions[v]) tags[tag] = v
        doc['dist-tags'] = tags
        how = `live (${Number.isNaN(cut) ? 'uncut: the recording has no date' : `cut at ${at}, ${dropped} later versions dropped`}${tags.latest === (from['dist-tags'] || {}).latest ? '' : ', latest tag lost'})`
      }
      const body = Buffer.from(JSON.stringify(doc))
      fs.mkdirSync(path.dirname(kept), { recursive: true })
      fs.writeFileSync(kept, body)
      fs.writeFileSync(kept + '.how', how)
      return [body, how]
    })())
    shared.asOf.get(key).catch(() => shared.asOf.delete(key))
  }
  return shared.asOf.get(key)
}

// <name>/-/<anything>-<version>.tgz is <name>-<version>.tgz, as the recorders' http/ names it
const TARBALL = /^((?:@[^/]+\/)?[^/]+)\/-\/(?:@[^/]+\/)?[^/]*?-(\d[^/]*)\.tgz$/

// start({ shared, ca, scenario, scenarioDir, at, log }) -> { port, close() }; log = { requests: [], overlay: Set, unserved: [] }
const start = ({ shared, ca, scenario, scenarioDir, at, log }) => new Promise((resolve, reject) => {
  const configFile = path.join(scenarioDir, 'registry-config')
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
  const authority = new WeakMap()
  const sockets = new Set()
  const indexes = new Map() // family dir -> Map(tarball url -> file): a tarball a document names by another url
  const indexOf = family => {
    if (!indexes.has(family.dir)) {
      const index = new Map()
      const dir = path.join(scenarioDir, family.dir)
      const walk = (d, rel) => {
        if (!fs.existsSync(d)) return
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(path.join(d, e.name), r)
          else if (!/\.tgz$/.test(e.name)) {
            try {
              const j = JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8'))
              for (const [v, m] of Object.entries((j && j.versions) || {})) {
                if (m && m.dist && typeof m.dist.tarball === 'string') index.set(m.dist.tarball, `${j.name || r}-${v}.tgz`)
              }
            } catch (err) {
              // not a packument
            }
          }
        }
      }
      walk(dir, '')
      indexes.set(family.dir, index)
    }
    return indexes.get(family.dir)
  }
  // the recorder's registry: its url in every document it proxied, and the manifest patches it applied
  const localize = (family, body) => family.recorder && config.rewrite ? Buffer.from(body.toString('utf8').split(`${NPM}/`).join(family.local)) : body
  const patched = (family, name, body) => {
    const p = family.recorder && config.patch && config.patch[name]
    if (!p) return [body, false]
    const doc = JSON.parse(body.toString('utf8'))
    for (const [v, fields] of Object.entries(p)) if (doc.versions && doc.versions[v]) Object.assign(doc.versions[v], fields)
    return [Buffer.from(JSON.stringify(doc)), true]
  }

  const handle = async (req, res) => {
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    let where = authority.get(req.socket)
    let target = req.url
    if (/^https?:\/\//.test(target)) {
      const u = new URL(target)
      where = { scheme: u.protocol.slice(0, -1), host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) }
      target = u.pathname + u.search
    }
    if (!where) {
      const [h, p] = String(req.headers.host || '').split(':')
      where = { scheme: 'http', host: h, port: Number(p) || 80 }
    }
    const origin = `${where.scheme}://${where.host}${(where.scheme === 'https' && where.port === 443) || (where.scheme === 'http' && where.port === 80) ? '' : ':' + where.port}`
    const accept = req.headers.accept || ''
    const line = `${req.method} ${origin}${target} accept=${accept || '-'}${req.headers.authorization ? ' authorization' : ''}`
    try {
      const family = familyOf(where.host, where.port, where.scheme)
      if (!family || !['GET', 'HEAD'].includes(req.method)) {
        log.requests.push(`${line} -> 404 unserved`)
        log.unserved.push(`${req.method} ${origin}${target}`)
        return send(404, Buffer.from('{"error":"not served by the sweep"}'), JSON_TYPE)
      }
      if (family.live) {
        const r = await shared.fetchOnce(`${family.live}${target}`, accept, path.join(shared.LIVE, 'github', where.host, crypto.createHash('sha1').update(`${target}\0${accept}`).digest('hex')))
        log.overlay.add(`${where.host}${target.split('?')[0]}: fetched once from ${where.host}`)
        log.requests.push(`${line} -> ${r.status} live`)
        return send(r.status, r.body, r.type)
      }
      const rel = decodeURIComponent(target.split('?')[0]).replace(/^\/+/, '')
      if (family.recorder && (config.notFound || []).includes(target.split('?')[0])) {
        log.requests.push(`${line} -> 404 registry-config notFound`)
        return send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
      }
      if (/\.tgz$/.test(rel)) {
        const m = rel.match(TARBALL)
        const dir = path.join(scenarioDir, family.dir)
        let file = m ? `${m[1]}-${m[2]}.tgz` : null
        if (!file || !fs.existsSync(path.join(dir, file))) {
          const asked = `${origin}${target}`
          const index = indexOf(family)
          const named = index.get(asked) || index.get(asked.replace(/^https:\/\/registry\.yarnpkg\.com\//, `${NPM}/`))
          if (named && fs.existsSync(path.join(dir, named))) file = named
        }
        if (file && fs.existsSync(path.join(dir, file))) {
          log.requests.push(`${line} -> 200 tarball recorded`)
          return send(200, fs.readFileSync(path.join(dir, file)), 'application/octet-stream')
        }
        if (family.recorder && !config.rewrite) {
          // a registry of hand-made packages only
          log.requests.push(`${line} -> 404 unserved`)
          log.unserved.push(`${req.method} ${origin}${target}`)
          return send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
        }
        const r = await shared.fetchOnce(`${family.upstream}/${rel}`, '', path.join(shared.TARBALLS, family.recorder ? 'npm' : family.name, rel))
        log.requests.push(`${line} -> ${r.status === 200 ? '200 tarball fetched' : `${r.status} tarball absent`}`)
        return r.status === 200 ? send(200, r.body, 'application/octet-stream') : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
      }
      const parts = rel.split('/')
      const nameParts = parts[0] && parts[0].startsWith('@') ? 2 : 1
      const name = parts.slice(0, nameParts).join('/')
      const rest = parts.slice(nameParts)
      if (!name || parts[0] === '-' || rest.length > 1) {
        log.requests.push(`${line} -> 404 unserved`)
        log.unserved.push(`${req.method} ${origin}${target}`)
        return send(404, Buffer.from('{"error":"not served by the sweep"}'), JSON_TYPE)
      }
      if (rest.length === 1) {
        // one published version's manifest
        const own = path.join(scenarioDir, family.dir, `${name}-${rest[0]}`)
        let body = fs.existsSync(own) ? fs.readFileSync(own) : null
        let how = 'recorded'
        if (!body && !(family.recorder && !config.rewrite)) {
          const r = await shared.fetchOnce(`${family.upstream}/${rel}`, accept, path.join(shared.LIVE, family.recorder ? 'npm' : family.name, `${name}-${rest[0]}`))
          body = r.status === 200 ? localize(family, r.body) : null
          how = body ? 'live' : 'absent'
          log.overlay.add(`${family.name}:${name}-${rest[0]}: ${how}`)
        }
        if (body && family.recorder && config.patch && config.patch[name] && config.patch[name][rest[0]]) {
          body = Buffer.from(JSON.stringify(Object.assign(JSON.parse(body.toString('utf8')), config.patch[name][rest[0]])))
          how += ' + registry-config patch'
        }
        log.requests.push(`${line} -> ${body ? 200 : 404} manifest ${how}`)
        return body ? send(200, body, JSON_TYPE) : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
      }
      const wantFull = !accept.startsWith(CORGI)
      if (family.recorder && !config.rewrite && !fs.existsSync(path.join(scenarioDir, family.dir, name))) {
        // a registry of hand-made packages only
        log.requests.push(`${line} -> 404 unserved`)
        log.unserved.push(`${req.method} ${origin}${target}`)
        return send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
      }
      let [body, how] = await packument(shared, scenario, scenarioDir, family, name, wantFull, at)
      if (how !== 'recorded' && how !== 'as-of') log.overlay.add(`${family.name}:${name}: ${how}`)
      if (body) {
        // the recording keeps the recorder's registry's documents as it served them; an answer of today's is localized
        if (how !== 'recorded') body = localize(family, body)
        const [p, did] = patched(family, name, body)
        body = p
        if (did) how += ' + registry-config patch'
      }
      log.requests.push(`${line} -> ${body ? 200 : 404} ${wantFull ? 'full' : 'abbreviated'} ${how}`)
      return body ? send(200, body, wantFull ? JSON_TYPE : CORGI) : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
    } catch (e) {
      log.requests.push(`${line} -> 502 stub-error ${e.message}`)
      log.unserved.push(`stub-error ${origin}${target}: ${e.message}`)
      try {
        send(502, Buffer.from(String(e.message)), 'text/plain')
      } catch (err) {
        res.destroy()
      }
    }
  }

  // requests arriving inside a tunnel: the same handler, the tunnel's target as the authority
  const inner = http.createServer(handle)
  const outer = http.createServer(handle)
  const track = s => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
  }
  outer.on('connection', track)
  outer.on('connect', (req, socket) => {
    const at2 = req.url.lastIndexOf(':')
    const host = req.url.slice(0, at2)
    const port = Number(req.url.slice(at2 + 1))
    socket.on('error', () => {})
    log.requests.push(`CONNECT ${req.url}`)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (port === 443) {
      let secure
      try {
        secure = new tls.TLSSocket(socket, { isServer: true, secureContext: ca.contextFor(host) })
      } catch (e) {
        log.unserved.push(`CONNECT ${req.url}: ${e.message}`)
        return socket.destroy()
      }
      secure.on('error', e => log.requests.push(`# tls ${host}: ${e.message}`))
      track(secure)
      authority.set(secure, { scheme: 'https', host, port })
      inner.emit('connection', secure)
    } else {
      authority.set(socket, { scheme: 'http', host, port })
      inner.emit('connection', socket)
    }
  })
  outer.on('error', reject)
  outer.listen(0, '127.0.0.1', () => resolve({
    port: outer.address().port,
    close: () => {
      outer.close()
      inner.close()
      for (const s of sockets) s.destroy()
    },
  }))
})

module.exports = { ensureCa, makeShared, start, familyOf, kindOfDoc }

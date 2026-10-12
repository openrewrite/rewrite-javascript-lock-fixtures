// A frozen registry for one scenario, reached as an HTTP proxy (Yarn's httpProxy / httpsProxy settings), so that Yarn
// keeps asking the hosts the recording asked (registry.yarnpkg.com, npm.jsr.io, a mirror, the recorder's own
// 127.0.0.1:<port> registry) and no setting of the scenario has to change. CONNECT to port 443 is answered with a
// certificate for that host signed by the sweep's own authority (NODE_EXTRA_CA_CERTS in the Yarn process); nothing
// is forwarded to the network by the proxy itself.
//
// Answers, in this order:
//   packument   <scenario>/<http dir>/<name> as the recording kept it. A hand-made document (record/make-berry-overlay.js)
//               and a full packument are served as they are. Where the recording kept the abbreviated packument and
//               the release asks for the full one (every Yarn Berry release does), the answer is today's full
//               packument cut back to the versions, dist-tags and deprecations the recording kept ("as-of"). A package
//               the recording did not keep is today's, cut at the recording's day ("live"), and is named in `overlay`.
//   tarball     <scenario>/<http dir>/<name>-<version>.tgz, else the registry's own, fetched once and kept (a tarball
//               never changes); a tarball the registry does not have is a 404, as it was for the recording.
// The recorder's registry (record/yarn-berry-registry.js) replaced https://registry.npmjs.org/ by its own URL in every
// document it served; a request to 127.0.0.1 gets the same replacement.
const fs = require('fs')
const path = require('path')
const http = require('http')
const tls = require('tls')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const NPM = 'https://registry.npmjs.org'
const CORGI = 'application/vnd.npm.install-v1+json'
const JSON_TYPE = 'application/json'

// host -> where the recording keeps its responses and where the registry really is
const familyOf = (host, port, scheme) => {
  if (host === '127.0.0.1' || host === 'localhost') return { dir: 'http', upstream: NPM, local: `${scheme}://${host}:${port}/`, name: 'recorder' }
  if (host === 'registry.yarnpkg.com' || host === 'registry.npmjs.org') return { dir: 'http', upstream: NPM, name: 'npm' }
  if (host === 'npm.jsr.io') return { dir: 'http', upstream: 'https://npm.jsr.io', name: 'jsr' }
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return { dir: 'http-npmmirror', upstream: 'https://registry.npmmirror.com', name: 'npmmirror' }
  // Yarn downloads a github: dependency's commit as an archive before it falls back to git
  if (host === 'github.com' || host === 'codeload.github.com') return { dir: 'http', upstream: `https://${host}`, name: 'github', archives: /^\/[^/]+\/[^/]+\/(?:archive|tar\.gz)\/[0-9a-f]{40}(?:\.tar\.gz)?$/ }
  return null
}

// ---- the sweep's certificate authority -------------------------------------------------------------------------
const openssl = (args, opts = {}) => execFileSync('/usr/bin/openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const atomically = (file, make) => {
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
  if (!fs.existsSync(caCert)) {
    const conf = path.join(dir, `ca.${process.pid}.cnf`)
    fs.writeFileSync(conf, '[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n[dn]\nCN=yarn-berry sweep CA\n' +
      '[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n')
    atomically(caKey, tmp => openssl(['genrsa', '-out', tmp, '2048']))
    atomically(caCert, tmp => openssl(['req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '825', '-config', conf, '-out', tmp]))
    fs.rmSync(conf, { force: true })
  }
  atomically(leafKey, tmp => openssl(['genrsa', '-out', tmp, '2048']))
  const contexts = new Map()
  const contextFor = host => {
    if (!contexts.has(host)) {
      const cert = path.join(dir, 'hosts', `${host.replace(/[^A-Za-z0-9.-]/g, '_')}.pem`)
      atomically(cert, tmp => {
        const csr = `${tmp}.csr`
        const ext = `${tmp}.ext`
        const isIp = /^[\d.]+$/.test(host)
        fs.writeFileSync(ext, `subjectAltName=${isIp ? 'IP' : 'DNS'}:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`)
        openssl(['req', '-new', '-key', leafKey, '-subj', `/CN=${host}`, '-out', csr])
        openssl(['x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-set_serial', String(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
          '-sha256', '-days', '825', '-extfile', ext, '-out', tmp])
        fs.rmSync(csr, { force: true })
        fs.rmSync(ext, { force: true })
      })
      contexts.set(host, tls.createSecureContext({ key: fs.readFileSync(leafKey), cert: fs.readFileSync(cert) }))
    }
    return contexts.get(host)
  }
  return { caCert, contextFor }
}

// ---- what the registry really has, fetched once for the whole sweep and kept, a 404 too --------------------------
const makeShared = outRoot => {
  const LIVE = path.join(outRoot, '_live')
  const TARBALLS = path.join(outRoot, '_tarballs')
  const ASOF = path.join(outRoot, '_asof')
  const inflight = new Map()
  const fetchOnce = (url, accept, into) => {
    if (!inflight.has(into)) {
      inflight.set(into, (async () => {
        if (fs.existsSync(into)) return fs.readFileSync(into)
        if (fs.existsSync(into + '.404')) return null
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
        fs.mkdirSync(path.dirname(into), { recursive: true })
        if (res.status === 404 || res.status === 405 || res.status === 400) {
          fs.writeFileSync(into + '.404', String(res.status))
          return null
        }
        if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
        const body = Buffer.from(await res.arrayBuffer())
        const tmp = `${into}.${process.pid}.tmp`
        fs.writeFileSync(tmp, body)
        fs.renameSync(tmp, into)
        return body
      })())
      // a failed fetch is not remembered: the next request tries again
      inflight.get(into).catch(() => inflight.delete(into))
    }
    return inflight.get(into)
  }
  const encode = name => name.replace('/', '%2f')
  const liveFull = async (family, name) => {
    const body = await fetchOnce(`${family.upstream}/${encode(name)}`, JSON_TYPE, path.join(LIVE, family.name === 'recorder' ? 'npm' : family.name, `${name}@full`))
    if (!body) return null
    try {
      const doc = JSON.parse(body.toString('utf8'))
      return doc && typeof doc === 'object' && doc.versions ? doc : null
    } catch (e) {
      return null
    }
  }
  // Hand-made packages the recordings do not keep. A scenario's http/ holds what its edit asked the recorder's
  // registry for; the hand-made package its first phase installed (lwb-leaf, lwc-base, lws-b) is in the lock with its
  // checksum only, and one scenario keeps a document without its tarball (lwt-dist). <out>/_handmade/ holds them made
  // again by record/make-berry-overlay.js from {name, version}, its defaults. That they are the recording's is
  // checked, not assumed: the control must then write the fixture's `before`, checksum included, and a tarball whose
  // document the recording kept is served only when its bytes match that document's dist.integrity.
  const HANDMADE_DIR = path.join(outRoot, '_handmade', 'http')
  const handmadePackument = name => {
    const f = path.join(HANDMADE_DIR, name)
    return fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f) : null
  }
  const handmadeTarball = (scenarioDir, name, version) => {
    const f = path.join(HANDMADE_DIR, `${name}-${version}.tgz`)
    if (!fs.existsSync(f)) return null
    const body = fs.readFileSync(f)
    const own = path.join(scenarioDir, 'http', name)
    if (!fs.existsSync(own)) return { body, how: HANDMADE }
    try {
      const dist = JSON.parse(fs.readFileSync(own, 'utf8')).versions[version].dist
      const integrity = `sha512-${crypto.createHash('sha512').update(body).digest('base64')}`
      return dist.integrity === integrity ? { body, how: 'made again (its bytes match the dist.integrity the recording kept)' } : null
    } catch (e) {
      return null
    }
  }
  return { LIVE, TARBALLS, ASOF, fetchOnce, liveFull, asOf: new Map(), handmadePackument, handmadeTarball }
}
const HANDMADE = 'made again (a hand-made package the recording does not keep; record/make-berry-overlay.js from its name and version)'

const kindOfDoc = j => {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !j.versions || typeof j.versions !== 'object') return 'other'
  if (j.time || j._id || j._rev) return 'full'
  if (j.modified) return 'abbreviated'
  const entries = Object.values(j.versions)
  if (entries.length && entries.every(e => e && typeof e === 'object' && !Object.keys(e).length)) return 'pruned'
  return 'handmade'
}

const CORGI_FIELDS = ['name', 'version', 'dependencies', 'optionalDependencies', 'devDependencies', 'bundleDependencies', 'bundledDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'acceptDependencies', 'bin', 'directories', 'dist', 'engines', 'os', 'cpu', 'libc', 'deprecated',
  'hasInstallScript', 'funding', '_hasShrinkwrap']
const abbreviate = doc => {
  const out = { name: doc.name, 'dist-tags': doc['dist-tags'], versions: {}, modified: doc.time && doc.time.modified }
  for (const [v, m] of Object.entries(doc.versions || {})) {
    out.versions[v] = {}
    for (const f of CORGI_FIELDS) if (m && m[f] !== undefined) out.versions[v][f] = m[f]
    if (m && m.scripts && ['preinstall', 'install', 'postinstall'].some(s => m.scripts[s])) out.versions[v].hasInstallScript = true
  }
  return out
}

// ---- the packument a release asks for, as the registry stood when the scenario was recorded ----------------------
// Returns [body | null, how]. `how` is 'recorded' when the answer is the recording's own bytes, 'as-of' when it is
// rebuilt from today's registry within what the recording kept, and anything else is named in the result's overlay.
const packument = (shared, scenario, scenarioDir, family, name, wantFull, at) => {
  const famKey = family.name === 'recorder' ? 'npm' : family.name
  const key = `${scenario}\0${famKey}\0${name}\0${wantFull ? 'full' : 'abbreviated'}`
  if (!shared.asOf.has(key)) {
    shared.asOf.set(key, (async () => {
      const own = path.join(scenarioDir, family.dir, name)
      const kept = path.join(shared.ASOF, scenario, famKey, wantFull ? `${name}@full` : name)
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
        if (kind === 'handmade' || kind === 'other') return [recorded, 'recorded']
        if (kind === 'full' && wantFull) return [recorded, 'recorded']
        if (kind === 'abbreviated' && !wantFull) return [recorded, 'recorded']
      }
      // a hand-made package of the recorder's registry that the recording does not keep, made again
      const again = !recorded && family.name === 'recorder' ? shared.handmadePackument(name) : null
      if (again) return [again, HANDMADE]
      if (fs.existsSync(kept)) return [fs.readFileSync(kept), fs.readFileSync(kept + '.how', 'utf8')]
      let doc
      let how
      if (kind === 'full') {
        doc = abbreviate(j)
        how = 'recorded (abbreviated from the recorded full packument)'
      } else {
        const live = await shared.liveFull(family, name)
        if (recorded) {
          // versions, tags and deprecations as the recording kept them; everything else of a published version never changes
          const manifestOf = v => {
            const f = path.join(scenarioDir, family.dir, `${name}-${v}`)
            try {
              return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
            } catch (e) {
              return null
            }
          }
          doc = live ? { ...live } : { name: j.name }
          doc['dist-tags'] = j['dist-tags']
          doc.versions = {}
          doc.time = {}
          if (live && live.time && live.time.created) doc.time.created = live.time.created
          const gone = []
          let latest = 0
          for (const [v, short] of Object.entries(j.versions)) {
            let m = live && live.versions && live.versions[v] ? { ...live.versions[v] } : null
            if (!m) {
              gone.push(v)
              m = manifestOf(v) || short
            } else if (kind === 'abbreviated') {
              if (short.deprecated === undefined) delete m.deprecated
              else m.deprecated = short.deprecated
            }
            doc.versions[v] = m
            if (live && live.time && live.time[v]) {
              doc.time[v] = live.time[v]
              latest = Math.max(latest, Date.parse(live.time[v]))
            }
          }
          doc.time.modified = j.modified || (latest ? new Date(latest).toISOString() : undefined)
          how = !live ? 'recorded versions only (the registry no longer has the package)'
            : `as-of${kind === 'pruned' ? ' (deprecations as of today: the recording kept version numbers only)' : ''}${gone.length ? ` (not on the registry today: ${gone.join(' ')})` : ''}`
        } else {
          if (!live) return [null, 'absent']
          const cut = at ? Date.parse(at) : NaN
          const keep = v => Number.isNaN(cut) || !live.time || !live.time[v] || Date.parse(live.time[v]) <= cut
          doc = { ...live, versions: {}, time: {} }
          for (const [k, t] of Object.entries(live.time || {})) if (k === 'created' || k === 'modified' || keep(k)) doc.time[k] = t
          for (const [v, m] of Object.entries(live.versions || {})) if (keep(v)) doc.versions[v] = m
          const dropped = Object.keys(live.versions || {}).length - Object.keys(doc.versions).length
          const tags = {}
          for (const [tag, v] of Object.entries(live['dist-tags'] || {})) if (doc.versions[v]) tags[tag] = v
          doc['dist-tags'] = tags
          how = `live (${Number.isNaN(cut) ? 'uncut: the recording has no date' : `cut at ${at}, ${dropped} later versions dropped`}${tags.latest === (live['dist-tags'] || {}).latest ? '' : ', latest tag lost'})`
        }
        if (!wantFull) doc = abbreviate(doc)
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

// the routing of record/yarn-berry-registry.js for a tarball: <name>/-/<anything>-<version>.tgz is <name>-<version>.tgz
const TARBALL = /^((?:@[^/]+\/)?[^/]+)\/-\/(?:@[^/]+\/)?[^/]*?-(\d[^/]*)\.tgz$/

// ---- the proxy ---------------------------------------------------------------------------------------------------
// start({ shared, ca, scenario, scenarioDir, at, log }) -> { port, close() }; log = { requests: [], overlay: Set, unserved: [] }
const start = ({ shared, ca, scenario, scenarioDir, at, log }) => new Promise((resolve, reject) => {
  const authority = new WeakMap()
  const sockets = new Set()
  const tarballIndex = new Map() // family dir -> Map(tarball url -> file)
  const indexOf = family => {
    if (!tarballIndex.has(family.dir)) {
      const index = new Map()
      const walk = (dir, rel) => {
        if (!fs.existsSync(dir)) return
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(path.join(dir, e.name), r)
          else if (!/\.tgz$/.test(e.name)) {
            try {
              const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'))
              for (const [v, m] of Object.entries((j && j.versions) || {})) {
                if (m && m.dist && typeof m.dist.tarball === 'string') index.set(m.dist.tarball, `${j.name || r}-${v}.tgz`)
              }
            } catch (err) {
              // not a packument
            }
          }
        }
      }
      walk(path.join(scenarioDir, family.dir), '')
      tarballIndex.set(family.dir, index)
    }
    return tarballIndex.get(family.dir)
  }

  const handle = async (req, res) => {
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length })
      res.end(body)
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
    const line = `${req.method} ${origin}${target} accept=${accept || '-'}${req.headers['if-none-match'] ? ' if-none-match' : ''}`
    try {
      const family = familyOf(where.host, where.port, where.scheme)
      if (!family || req.method !== 'GET') {
        log.requests.push(`${line} -> 404 unserved`)
        log.unserved.push(`${req.method} ${origin}${target}`)
        return send(404, Buffer.from('{"error":"not served by the sweep"}'), JSON_TYPE)
      }
      const rel = decodeURIComponent(target.split('?')[0]).replace(/^\/+/, '')
      const localize = body => family.local ? Buffer.from(body.toString('utf8').split(`${NPM}/`).join(family.local)) : body
      if (family.archives) {
        // a commit's archive never changes in content; fetched once and kept
        const body = family.archives.test(target.split('?')[0]) ? await shared.fetchOnce(`${family.upstream}${target}`, '', path.join(shared.TARBALLS, family.name, rel)) : null
        log.requests.push(`${line} -> ${body ? '200 archive fetched' : '404 unserved'}`)
        if (!body) log.unserved.push(`${req.method} ${origin}${target}`)
        return body ? send(200, body, 'application/x-gzip') : send(404, Buffer.from('Not Found'), 'text/plain')
      }
      if (/\.tgz$/.test(rel)) {
        const m = rel.match(TARBALL)
        const dir = path.join(scenarioDir, family.dir)
        let file = m ? `${m[1]}-${m[2]}.tgz` : null
        if (!file || !fs.existsSync(path.join(dir, file))) {
          // a tarball the document names by another url (jsr's, a renamed one)
          const asked = `${origin}${target}`
          const index = indexOf(family)
          const named = index.get(asked) || index.get(asked.replace(family.local || '\0', `${NPM}/`)) ||
            index.get(asked.replace(/^https:\/\/registry\.yarnpkg\.com\//, `${NPM}/`))
          if (named && fs.existsSync(path.join(dir, named))) file = named
        }
        if (file && fs.existsSync(path.join(dir, file))) {
          log.requests.push(`${line} -> 200 tarball recorded`)
          return send(200, fs.readFileSync(path.join(dir, file)), 'application/octet-stream')
        }
        // a hand-made package the recording does not keep, made again (see makeShared)
        const again = m && family.local ? shared.handmadeTarball(scenarioDir, m[1], m[2]) : null
        if (again) {
          log.overlay.add(`${family.name}:${m[1]}-${m[2]}.tgz: ${again.how}`)
          log.requests.push(`${line} -> 200 tarball ${again.how}`)
          return send(200, again.body, 'application/octet-stream')
        }
        const body = await shared.fetchOnce(`${family.upstream}${target}`, '', path.join(shared.TARBALLS, family.name === 'recorder' ? 'npm' : family.name, rel))
        log.requests.push(`${line} -> ${body ? '200 tarball fetched' : '404 tarball absent'}`)
        return body ? send(200, body, 'application/octet-stream') : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
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
        if (!body) {
          body = await shared.fetchOnce(`${family.upstream}${target}`, accept, path.join(shared.LIVE, family.name === 'recorder' ? 'npm' : family.name, `${name}-${rest[0]}`))
          how = body ? 'live' : 'absent'
          log.overlay.add(`${family.name}:${name}-${rest[0]}: ${how}`)
        }
        log.requests.push(`${line} -> ${body ? 200 : 404} manifest ${how}`)
        return body ? send(200, localize(body), JSON_TYPE) : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
      }
      const wantFull = !accept.startsWith(CORGI)
      const [body, how] = await packument(shared, scenario, scenarioDir, family, name, wantFull, at)
      if (how !== 'recorded' && how !== 'as-of') log.overlay.add(`${family.name}:${name}: ${how}`)
      log.requests.push(`${line} -> ${body ? 200 : 404} ${wantFull ? 'full' : 'abbreviated'} ${how}`)
      return body ? send(200, localize(body), wantFull ? JSON_TYPE : CORGI) : send(404, Buffer.from('{"error":"Not found"}'), JSON_TYPE)
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

module.exports = { ensureCa, makeShared, start, kindOfDoc, familyOf }

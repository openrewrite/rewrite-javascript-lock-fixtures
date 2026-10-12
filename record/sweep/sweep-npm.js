// Replays recorded npm scenarios with other npm releases against a frozen registry: each scenario's own http/,
// so every release sees the registry the recording saw. For each release and scenario it runs the recorder's phases
// (record/record-npm-open.sh) and one more:
//   before   pkg-before installed from scratch            (skipped with before-input or without pkg-before)
//   after    pkg installed in the same directory over that lock
//   again    the edit's command again over `after`        (after-again when the lock changed)
//   cross    pkg installed over the fixture's own start lock, the one the recording release wrote
// Output: <out>/<release>/<scenario>/{before,after,after-again,cross,<phase>.log,result.json}
// A full packument the recording kept only abbreviated is today's, cut back to the versions, tags and deprecations
// the recording saw (<out>/_overlay/<scenario>/, reused by every release). A package the recording never asked for
// is today's registry, and result.json's `overlay` names it: that answer is newer than the recording.
//
// Usage: node sweep-npm.js --scenarios <lock/npm> --pm <dir of unpacked releases> --out <dir>
//          --releases 11.17.0,10.9.9 | --releases-file <file>   [--only <regex>] [--jobs 14] [--node <binary>] [--force]
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const flag = name => process.argv.includes(`--${name}`)

const SCENARIOS = path.resolve(arg('scenarios'))
const PM = path.resolve(arg('pm'))
const OUT = path.resolve(arg('out'))
const JOBS = Number(arg('jobs', 14))
const NODE = arg('node', process.execPath)
const ONLY = arg('only') ? new RegExp(arg('only')) : null
const FORCE = flag('force')
const RELEASES = arg('releases-file')
  ? fs.readFileSync(arg('releases-file'), 'utf8').split(/\s+/).filter(Boolean)
  : arg('releases').split(',')
const UP = 'https://registry.npmjs.org'
const OVERLAY = path.join(OUT, '_overlay')
const TARBALLS = path.join(OUT, '_tarballs')
const LIVE = path.join(OUT, '_live')
const CLOCK_RUNNER = path.join(__dirname, 'run-with-clock.js')
const TOP_UP = flag('top-up')
const BASE_ARGS = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier',
  '--loglevel=warn', '--userconfig', '/dev/null']

const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
const isDir = f => fs.existsSync(f) && fs.statSync(f).isDirectory()

const isScenario = dir => fs.readdirSync(dir, { withFileTypes: true })
  .some(e => e.isFile() && /^(before|after|fresh)(-.+)?$/.test(e.name) && !/^(before|after|fresh)-(yarn|npm|npmrc)$/.test(e.name))

const discover = () => {
  const found = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'http' || e.name.startsWith('tree') || e.name.startsWith('http-')) continue
      const p = path.join(dir, e.name)
      // nothing inside a scenario is a scenario: its release/<first>/ directories hold other releases' outcomes
      if (isScenario(p)) found.push(path.relative(SCENARIOS, p))
      else walk(p)
    }
  }
  walk(SCENARIOS)
  return found.sort()
}

// what the recorder was given for the scenario, or why the sweep leaves it out
const shape = name => {
  const d = path.join(SCENARIOS, name)
  const has = f => fs.existsSync(path.join(d, f))
  const pkg = has('pkg') ? 'pkg' : has('pkg-after') ? 'pkg-after' : null
  if (!pkg) return { skip: 'no edited manifest' }
  if (has('user-npmrc') || has('user-npmrc-before')) return { skip: 'user config' }
  if (fs.readdirSync(d).some(f => f.startsWith('http-'))) return { skip: 'another registry' }
  const start = has('before-input') ? 'before-input' : has('before') ? 'before' : null
  const words = f => (read(path.join(d, f)) || '').trim().split(/\s+/).filter(Boolean)
  const bargs = words('args-before')
  const aargs = words('args-after')
  // record-npm.sh <dir> 2: the lockfile version was an argument, kept nowhere but in the lock the before phase
  // wrote; the edit keeps the version of the lock it finds, so only the before phase is given it
  let version = null
  let dirName = 'project'
  const startText = start && read(path.join(d, start))
  if (startText) {
    try {
      const lock = JSON.parse(startText)
      if (start === 'before' && !has('args-before') && (lock.lockfileVersion === 1 || lock.lockfileVersion === 2)) {
        version = lock.lockfileVersion
      }
    } catch (e) {
      // a start lock that does not parse says nothing
    }
  }
  // a root without a name is named after the directory npm ran in, which the lock it wrote kept
  for (const [lockFile, manifest] of [['before', 'pkg-before'], ['after', pkg]]) {
    try {
      if (has(lockFile) && has(manifest) && JSON.parse(read(path.join(d, manifest))).name === undefined) {
        const named = JSON.parse(read(path.join(d, lockFile))).name
        if (typeof named === 'string' && /^[A-Za-z0-9._-]+$/.test(named)) dirName = named
      }
    } catch (e) {
      // a manifest or lock that does not parse names nothing
    }
  }
  const recorded = read(path.join(d, 'recorded-with')) || ''
  const at = phase => {
    const m = recorded.match(new RegExp(`${phase} exit=-?\\d+ at ([^,\\s]+)`))
    if (m) return m[1]
    const day = recorded.match(/, (\d{4}-\d{2}-\d{2})\s/)
    return day ? `${day[1]}T12:00:00Z` : null
  }
  return {
    dir: d, pkg, start, bargs, aargs, version, dirName,
    scratch: has('pkg-before') && !has('before-input'),
    pkgBefore: has('pkg-before'),
    beforeAt: at('before') || at('after'),
    afterAt: at('after'),
  }
}

const fileFor = (url, accept) => {
  const parts = url.split('?')[0].slice(1).split('/').map(decodeURIComponent).join('/').split('/')
  const nameParts = parts[0].startsWith('@') ? 2 : 1
  const name = parts.slice(0, nameParts).join('/')
  const rest = parts.slice(nameParts)
  if (!name || parts[0] === '-') return null
  if (rest.length === 0) {
    const full = !accept.startsWith('application/vnd.npm.install-v1+json')
    return { kind: full ? 'full' : 'abbreviated', file: full ? `${name}@full` : name }
  }
  if (rest[0] === '-' && rest.length === 2 && rest[1].endsWith('.tgz')) return { kind: 'tarball', file: `${name}/-/${rest[1]}` }
  if (rest.length === 1 && rest[0] !== '-') return { kind: 'manifest', file: `${name}-${rest[0]}` }
  return null
}

// one registry fetch per file for the whole sweep, kept on disk; a 404 is kept too
const upstream = new Map()
const fetchOnce = (url, accept, into) => {
  if (!upstream.has(into)) {
    upstream.set(into, (async () => {
      if (fs.existsSync(into)) return fs.readFileSync(into)
      if (fs.existsSync(into + '.404')) return null
      const res = await fetch(UP + url, { headers: accept ? { accept } : {} })
      fs.mkdirSync(path.dirname(into), { recursive: true })
      if (!res.ok) {
        fs.writeFileSync(into + '.404', String(res.status))
        return null
      }
      const body = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(into, body)
      return body
    })())
  }
  return upstream.get(into)
}

const FULL = 'application/json'
const CORGI = 'application/vnd.npm.install-v1+json'
const encode = name => name.replace('/', '%2f')
// a version an older recording kept bare: an empty object, or its name and version without the dist every published
// version has
const isEmpty = v => v != null && typeof v === 'object' && !Array.isArray(v) && v.dist === undefined
// an abbreviated packument whose versions an older recording kept bare
const emptyVersions = file => {
  try {
    return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).versions || {}).some(isEmpty)
  } catch (e) {
    return false
  }
}
const liveFull = async name => {
  const body = await fetchOnce('/' + encode(name), FULL, path.join(LIVE, `${name}@full`))
  return body && JSON.parse(body.toString('utf8'))
}

// The packument a release asks for, as the registry stood when the scenario was recorded. The recording keeps the
// abbreviated packument: its versions, dist-tags and deprecations are the registry's state then. Everything else of
// a published version never changes, so a full packument is today's with exactly those versions, tags and
// deprecations. Returns [body, how]; how says what the answer rests on.
const asOf = new Map()
const packument = (scenario, name, kind, at) => {
  const key = `${scenario}\0${name}\0${kind}`
  if (!asOf.has(key)) {
    asOf.set(key, (async () => {
      const own = path.join(SCENARIOS, scenario, 'http', name)
      if (kind === 'full' && fs.existsSync(own + '@full')) return [fs.readFileSync(own + '@full'), 'recorded']
      if (kind === 'abbreviated' && fs.existsSync(own) && !emptyVersions(own)) return [fs.readFileSync(own), 'recorded']
      const kept = path.join(OVERLAY, scenario, kind === 'full' ? `${name}@full` : name)
      if (fs.existsSync(kept)) return [fs.readFileSync(kept), fs.readFileSync(kept + '.how', 'utf8')]
      let body
      let how
      if (kind === 'abbreviated' && fs.existsSync(own)) {
        // an older recording kept only the versions, each bare (an empty object, or its name and version), beside a
        // manifest per version it installed: each is the registry's abbreviated version today (a published version
        // never changes), without a deprecation the recording did not keep, as a full packument rebuilt from it has none
        const abbr = JSON.parse(fs.readFileSync(own, 'utf8'))
        const res = await fetchOnce('/' + encode(name), CORGI, path.join(LIVE, name))
        if (!res) return [fs.readFileSync(own), 'recorded (no abbreviated packument today)']
        const live = JSON.parse(res.toString('utf8'))
        const doc = { ...abbr, versions: {} }
        const gone = []
        for (const [v, short] of Object.entries(abbr.versions || {})) {
          const m = isEmpty(short) && live.versions && live.versions[v] ? { ...live.versions[v] } : null
          if (!m) {
            if (isEmpty(short)) gone.push(v)
            doc.versions[v] = short
            continue
          }
          delete m.deprecated
          doc.versions[v] = m
        }
        body = Buffer.from(JSON.stringify(doc))
        how = gone.length ? `as-of-abbreviated (unpublished since: ${gone.join(' ')})` : 'as-of-abbreviated'
      } else if (kind === 'abbreviated' && fs.existsSync(own + '@full')) {
        // the registry's abbreviated form of the recorded full packument is not derivable; the full one answers
        body = fs.readFileSync(own + '@full')
        how = 'recorded-full'
      } else if (kind === 'full' && fs.existsSync(own)) {
        const abbr = JSON.parse(fs.readFileSync(own, 'utf8'))
        const live = await liveFull(name)
        if (!live) return [null, 'absent']
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
      } else {
        // no recording of this package at all: today's registry, cut back to the recording's time where it is known
        const live = await liveFull(name)
        if (!live) return [null, 'absent']
        const cut = at ? Date.parse(at) : NaN
        const keep = v => Number.isNaN(cut) || !live.time || !live.time[v] || Date.parse(live.time[v]) <= cut
        let doc
        if (kind === 'full') {
          doc = { ...live, versions: {}, time: {} }
          for (const [k, t] of Object.entries(live.time || {})) if (k === 'created' || k === 'modified' || keep(k)) doc.time[k] = t
        } else {
          const res = await fetchOnce('/' + encode(name), CORGI, path.join(LIVE, name))
          doc = { ...JSON.parse(res.toString('utf8')), versions: {} }
        }
        const from = kind === 'full' ? live : JSON.parse((await fetchOnce('/' + encode(name), CORGI, path.join(LIVE, name))).toString('utf8'))
        for (const [v, m] of Object.entries(from.versions || {})) if (keep(v)) doc.versions[v] = m
        const dropped = Object.keys(from.versions || {}).length - Object.keys(doc.versions).length
        const tags = {}
        for (const [tag, v] of Object.entries(live['dist-tags'] || {})) if (doc.versions[v]) tags[tag] = v
        doc['dist-tags'] = tags
        body = Buffer.from(JSON.stringify(doc))
        how = `live (${Number.isNaN(cut) ? 'uncut' : `cut at ${at}, ${dropped} later versions dropped`}${tags.latest === (live['dist-tags'] || {}).latest ? '' : ', latest tag lost'})`
      }
      fs.mkdirSync(path.dirname(kept), { recursive: true })
      fs.writeFileSync(kept, body)
      fs.writeFileSync(kept + '.how', how)
      return [body, how]
    })())
  }
  return asOf.get(key)
}

// a registry answering as it stood when the scenario was recorded
const registry = (scenario, log, at) => new Promise(resolve => {
  const own = path.join(SCENARIOS, scenario, 'http')
  const server = http.createServer(async (req, res) => {
    const accept = req.headers.accept || ''
    const send = (status, body, type) => {
      res.writeHead(status, { 'content-type': type, 'content-length': body.length })
      res.end(body)
    }
    try {
      const f = fileFor(req.url, accept)
      if (!f) {
        log.requests.push(`${req.method} ${req.url} unserved`)
        return send(404, Buffer.from('{"error":"not found"}'), FULL)
      }
      let body
      let how
      if (f.kind === 'full' || f.kind === 'abbreviated') {
        const name = f.kind === 'full' ? f.file.slice(0, -'@full'.length) : f.file
        ;[body, how] = await packument(scenario, name, f.kind, at)
        if (how !== 'recorded' && how !== 'as-of' && how !== 'as-of-abbreviated') log.overlay.add(`${f.file}: ${how}`)
      } else if (fs.existsSync(path.join(own, f.file))) {
        body = fs.readFileSync(path.join(own, f.file))
        how = 'recorded'
      } else if (f.kind === 'tarball') {
        body = await fetchOnce(req.url, '', path.join(TARBALLS, f.file))
        how = body ? 'tarball' : 'absent'
      } else {
        // one published version's manifest never changes but for its deprecation
        body = await fetchOnce(req.url, accept, path.join(LIVE, f.file))
        how = body ? 'live-manifest' : 'absent'
        log.overlay.add(`${f.file}: ${how}`)
      }
      log.requests.push(`${req.method} ${req.url} ${f.kind} ${how}`)
      const type = f.kind === 'tarball' ? 'application/octet-stream' : f.kind === 'abbreviated' && how !== 'recorded-full' ? CORGI : FULL
      return body ? send(200, body, type) : send(404, Buffer.from('{"error":"Not found"}'), FULL)
    } catch (e) {
      log.requests.push(`${req.method} ${req.url} stub-error ${e.message}`)
      send(502, Buffer.from(String(e)), 'text/plain')
    }
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

const run = (cli, cwd, args, port, home, now) => new Promise(resolve => {
  const cache = fs.mkdtempSync(path.join(home, 'cache-'))
  const env = { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: home, TMPDIR: home }
  // the clock through a wrapper, not a preload: Node resolves a preload from the working directory and fails on a
  // malformed package.json there before npm runs
  const entry = now ? [CLOCK_RUNNER, cli] : [cli]
  if (now) env.SWEEP_NOW = now
  const child = spawn(NODE, [...entry, ...args, '--registry', `http://127.0.0.1:${port}/`, '--cache', cache], { cwd, env })
  const out = []
  child.stdout.on('data', c => out.push(c))
  child.stderr.on('data', c => out.push(c))
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    fs.rmSync(cache, { recursive: true, force: true })
    resolve({ code: code == null ? `signal:${signal}` : code, log: Buffer.concat(out).toString('utf8') })
  })
})

const lockfileVersionConfig = release => {
  const [major, minor] = release.split('.').map(Number)
  return major > 8 || major === 8 && minor >= 1
}
// the values of --lockfile-version in an argument list, as `--lockfile-version 2` or `--lockfile-version=2`
const flagValues = args => {
  const out = []
  args.forEach((a, i) => {
    if (a === '--lockfile-version' && i + 1 < args.length) out.push(args[i + 1])
    else if (a.startsWith('--lockfile-version=')) out.push(a.slice('--lockfile-version='.length))
  })
  return out
}
const withoutFlag = args => args.filter((a, i) => a !== '--lockfile-version' && !a.startsWith('--lockfile-version=') && args[i - 1] !== '--lockfile-version')

const copyTree = (from, to) => {
  if (isDir(from)) fs.cpSync(from, to, { recursive: true })
}

const sweepOne = async (release, name) => {
  const outDir = path.join(OUT, release, name)
  const done = !FORCE && fs.existsSync(path.join(outDir, 'result.json'))
  // --top-up: a cell swept before the second install over `cross` existed gets the cross phases again, alone
  let topUp = null
  // a cell not swept yet is the sweep's own to do
  if (TOP_UP && !done) return 'cached'
  if (done) {
    if (!TOP_UP) return 'cached'
    topUp = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'))
    const cross = read(path.join(outDir, 'cross'))
    if (topUp.skip || topUp.crossAgain !== undefined || cross == null || cross === read(path.join(outDir, 'after'))) return 'cached'
  }
  const s = shape(name)
  if (!topUp) {
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
  }
  const result = topUp || { release, scenario: name, node: NODE === process.execPath ? process.version : NODE, exits: {}, same: {} }
  // lockfile-version is a config from npm 8.1.0 (lib/utils/config/definitions.js). An older release takes the flag
  // for a boolean and its value for a package to install, so it is left out where it asks for that release's own
  // default, 2, and the scenario is left out where it asks for another version.
  if (!s.skip && !lockfileVersionConfig(release)) {
    const asked = [...(s.version ? [String(s.version)] : []), ...flagValues(s.bargs), ...flagValues(s.aargs)]
    if (asked.some(v => v !== '2')) {
      s.skip = `lockfile-version ${asked.find(v => v !== '2')} asked of a release without that config`
    } else {
      s.version = null
      s.bargs = withoutFlag(s.bargs)
      s.aargs = withoutFlag(s.aargs)
    }
  }
  if (s.skip) {
    result.skip = s.skip
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1) + '\n')
    return 'skipped'
  }
  const cli = path.join(PM, release, 'package', 'bin', 'npm-cli.js')
  // the real path: under a symlinked cache directory arborist loses the bundled dependencies it unpacks there
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sweep-'))
  const log = { requests: [], overlay: new Set() }
  const server = await registry(name, log, s.afterAt)
  const port = server.address().port
  const redact = text => text.split(home).join('<scratch>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
  const versionArgs = s.version ? ['--lockfile-version', String(s.version)] : []
  const phase = async (label, cwd, extra, now) => {
    log.requests.push(`# ${label}`)
    const r = await run(cli, cwd, [...BASE_ARGS, ...(label === 'before' ? versionArgs : []), ...extra], port, home, now)
    result.exits[label] = r.code
    fs.writeFileSync(path.join(outDir, `${label}.log`), redact(r.log))
    return r.code
  }
  // replace-registry-host points a registry tarball URL given as a spec at the stub; the recordings ran on npmjs
  const lockOf = cwd => {
    const text = read(path.join(cwd, 'package-lock.json'))
    return text == null ? null : text.split(`http://127.0.0.1:${port}/`).join('https://registry.npmjs.org/')
  }
  const keep = (label, text) => fs.writeFileSync(path.join(outDir, label), text)
  const fixture = f => read(path.join(s.dir, f))
  try {
    const w = path.join(home, 'scratch', s.dirName)
    fs.mkdirSync(w, { recursive: true })
    const npmrc = (dir, file) => {
      fs.rmSync(path.join(dir, '.npmrc'), { force: true })
      if (fixture(file) != null) fs.copyFileSync(path.join(s.dir, file), path.join(dir, '.npmrc'))
    }
    if (!topUp && (s.scratch || s.start === 'before-input')) {
      npmrc(w, fixture('npmrc-before') != null ? 'npmrc-before' : 'npmrc')
      copyTree(path.join(s.dir, 'tree-before'), w)
      if (s.pkgBefore) fs.copyFileSync(path.join(s.dir, 'pkg-before'), path.join(w, 'package.json'))
      if (s.start === 'before-input') {
        fs.copyFileSync(path.join(s.dir, 'before-input'), path.join(w, 'package-lock.json'))
      } else {
        const b = await phase('before', w, s.bargs, s.beforeAt)
        const lock = lockOf(w)
        if (b === 0 && lock != null) {
          keep('before', lock)
          if (fixture('before') != null) result.same.before = lock === fixture('before')
        }
      }
      npmrc(w, 'npmrc')
      copyTree(path.join(s.dir, 'tree'), w)
      fs.copyFileSync(path.join(s.dir, s.pkg), path.join(w, 'package.json'))
      const a = await phase('after', w, s.aargs, s.afterAt)
      const after = lockOf(w)
      if (a === 0 && after != null) {
        keep('after', after)
        if (fixture('after') != null) result.same.after = after === fixture('after')
        const g = await phase('again', w, s.aargs, s.afterAt)
        const again = lockOf(w)
        result.again = g !== 0 ? 'no lock written' : again === after ? 'lock unchanged' : 'lock changed'
        if (g === 0 && again != null && again !== after) keep('after-again', again)
      }
      result.fixtureHasAfter = fixture('after') != null
    }
    if (s.start === 'before') {
      const x = path.join(home, 'cross', s.dirName)
      fs.mkdirSync(x, { recursive: true })
      npmrc(x, 'npmrc')
      copyTree(path.join(s.dir, 'tree-before'), x)
      copyTree(path.join(s.dir, 'tree'), x)
      fs.copyFileSync(path.join(s.dir, s.pkg), path.join(x, 'package.json'))
      fs.copyFileSync(path.join(s.dir, 'before'), path.join(x, 'package-lock.json'))
      const c = await phase('cross', x, s.aargs, s.afterAt)
      const cross = lockOf(x)
      if (c === 0 && cross != null) {
        keep('cross', cross)
        if (fixture('after') != null) result.same.cross = cross === fixture('after')
        // the same lock as `after` gets the same second install; another lock gets its own
        if (cross === read(path.join(outDir, 'after'))) {
          result.crossAgain = result.again || null
        } else {
          const g = await phase('cross-again', x, s.aargs, s.afterAt)
          const again = lockOf(x)
          result.crossAgain = g !== 0 ? 'no lock written' : again === cross ? 'lock unchanged' : 'lock changed'
          if (g === 0 && again != null && again !== cross) keep('cross-again', again)
        }
      }
      result.fixtureHasAfter = fixture('after') != null
    }
  } catch (e) {
    result.error = String(e && e.stack || e)
  } finally {
    server.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  result.overlay = [...new Set([...(topUp ? topUp.overlay || [] : []), ...log.overlay])].sort()
  fs.writeFileSync(path.join(outDir, 'requests.log'), (topUp ? read(path.join(outDir, 'requests.log')) || '' : '') + log.requests.join('\n') + '\n')
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1) + '\n')
  return 'ran'
}

const main = async () => {
  const scenarios = discover().filter(n => !ONLY || ONLY.test(n))
  const tasks = []
  for (const release of RELEASES) {
    if (!fs.existsSync(path.join(PM, release, 'package', 'bin', 'npm-cli.js'))) {
      console.error(`no npm ${release} under ${PM}`)
      process.exitCode = 1
      continue
    }
    for (const name of scenarios) tasks.push([release, name])
  }
  const total = tasks.length
  const started = Date.now()
  const tally = { ran: 0, cached: 0, skipped: 0 }
  let done = 0
  const worker = async () => {
    for (;;) {
      const t = tasks.shift()
      if (!t) return
      const outcome = await sweepOne(t[0], t[1])
      tally[outcome]++
      done++
      if (done % 200 === 0 || done === total) {
        const secs = Math.round((Date.now() - started) / 1000)
        console.log(`${done}/${total} in ${secs}s  (ran ${tally.ran}, cached ${tally.cached}, skipped ${tally.skipped})`)
      }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker))
}
main()

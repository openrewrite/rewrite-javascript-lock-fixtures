// Writes a sweep's findings into the fixtures: for every scenario, which releases write the recorded outcome, and
// each other outcome some releases write.
//   <scenario>/releases                 the releases that write the scenario's own before/after (ranges, one a line)
//   <scenario>/release/<first>/         an outcome other releases write, named by its first release:
//       releases                        the releases that write it
//       recorded-with                   the release, Node and clock of the replay
//       before, after, after-again      what the release wrote from scratch and for the edit (absent when it failed)
//       cross                           what it wrote for the edit over the scenario's own `before`
//       expect, expect-cross            the outcome when it is not byte-exact
//       npm-<phase>.log                 npm's output for a phase that failed, and npm-again.log
//   <scenario>/http/<name>-<version>    the manifest of every version an outcome locks, where it was missing
// A range joins releases only when every stable release between them was swept and wrote the same outcome.
// Only scenarios the baseline release reproduces from the fixture are exported.
// Usage: node sweep-export.js --sweep <sweep out> --fixtures <lock/npm> --packument <npm packument.json>
//          [--created-list <file>] [--report <file, default <sweep out>/_report/export.txt>]
//          [--baseline 11.17.0] [--min-major 7] [--dry]
const fs = require('fs')
const path = require('path')
const { FILES, read, sha, codeOf, loadCell, cmp } = require('./npm-cell')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
// the working directory: the one above bin/ as this script was started (bin/ links to record/sweep, and __dirname is
// the link's target)
const ROOT = path.resolve(path.dirname(process.argv[1]), '..')
const SWEEP = path.resolve(arg('sweep'))
const FIXTURES = path.resolve(arg('fixtures'))
const BASE = arg('baseline', '11.17.0')
const MIN_MAJOR = Number(arg('min-major', 7))
const DRY = process.argv.includes('--dry')
const REPORT = path.resolve(arg('report', path.join(SWEEP, '_report', 'export.txt')))
// the registry files this export creates, by path in the fixtures repository, so the next export removes only those
const CREATED_LIST = arg('created-list')
const created = []
const createdHttp = f => created.push(path.join('lock', 'npm', path.relative(FIXTURES, f)))
const REG = 'https://registry.npmjs.org/'
const LIVE = path.join(SWEEP, '_live')

const write = (f, text) => {
  if (DRY) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
}

const master = Object.keys(JSON.parse(fs.readFileSync(arg('packument'), 'utf8')).versions)
  .filter(v => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) >= MIN_MAJOR).sort(cmp)
const swept = fs.readdirSync(SWEEP).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)

const scenarios = []
const walk = (dir, rel) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const p = path.join(dir, e.name)
    const name = rel ? `${rel}/${e.name}` : e.name
    if (fs.existsSync(path.join(p, 'result.json'))) {
      if (!scenarios.includes(name)) scenarios.push(name)
    }
    else walk(p, name)
  }
}
for (const r of swept) walk(path.join(SWEEP, r), '')
// the release that recorded a scenario is its baseline: recorded-with names it, and the oldest fixtures predate that
const recordedBy = scenario => {
  const m = (read(path.join(FIXTURES, scenario, 'recorded-with')) || '').match(/npm (\d+\.\d+\.\d+)/)
  return m ? m[1] : BASE
}

// A scenario's releases-expect, written by a person with the reason in '#' lines, states what the engine should do
// where a release's outcome followed something the sweep cannot show (a filesystem error npm swallowed): one line
// per rule, "<node-semver range>\t<after|cross|*>\t<expect line>". It wins over the classification below.
const semver = require(path.join(ROOT, 'pm', 'npm', '11.17.0', 'package', 'node_modules', 'semver'))
const rulesOf = scenario => (read(path.join(FIXTURES, scenario, 'releases-expect')) || '').split('\n')
  .filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [range, phase, ...rest] = l.split('\t')
    return { range, phase, expect: rest.join('\t').trim() }
  })
const ruled = (rules, release, phase) => {
  for (const r of rules) if ((r.phase === phase || r.phase === '*') && semver.satisfies(release, r.range)) return r.expect
  return null
}
const FILESYSTEM = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EEXIST', 'ENOTEMPTY'])

// npm's output without what differs from run to run
const stable = log => (log || '').split('\n')
  .filter(l => !/A complete log of this run can be found in|_logs\/|^npm (ERR!|error)\s*$/.test(l)).join('\n').trim() + '\n'

const load = (release, scenario) => loadCell(path.join(SWEEP, release, scenario))

const ranges = releases => {
  const set = new Set(releases)
  const out = []
  let run = null
  for (const v of master) {
    if (set.has(v)) {
      if (run) run[1] = v
      else run = [v, v]
    } else if (run) {
      out.push(run)
      run = null
    }
  }
  if (run) out.push(run)
  return out.map(([a, b]) => a === b ? a : `${a} - ${b}`)
}

// the outcome of an edit when it is not the lock byte for byte; base is how the recording release ended the phase,
// log what npm printed in it
const classify = (exit, code, again, rootExpect, base, log) => {
  const kind = (rootExpect || 'exact').split(/\s+/)[0]
  if (exit !== 0) {
    // npm ends as the recording release does: the recording's own line says what that is for the engine
    if (rootExpect && base && base.exit !== 0 && base.exit !== undefined && base.code === code) return rootExpect
    // what npm found on the disk it ran on is not the engine's to know
    if (FILESYSTEM.has(code)) return `cannot-know the filesystem npm ran on (${code})`
    return code ? `npm-rejects ${code}` : 'pm-fails'
  }
  if (kind === 'not-reproduced') return rootExpect
  // a malformed input npm gets past and writes a lock for (a lock it discards) is malformed under any release that
  // gets past it too; a release that writes a lock where the recording release failed did not read it as malformed
  if (kind === 'malformed' && base && base.exit === 0) return rootExpect
  // npm wrote a lock past a filesystem error it swallowed (an optional dependency's): the lock where the engine
  // writes one, else the disk the engine cannot see
  const swallowed = (log || '').match(new RegExp(`\\b(${[...FILESYSTEM].join('|')})\\b`))
  if (swallowed && again === 'lock unchanged') return `exact-or cannot-know the filesystem npm ran on (${swallowed[1]})`
  // what the engine cannot know under the recording release it may know under this one (a release that fetches
  // nothing for a git dependency, say): the lock byte for byte when it does, the recording's own line when not
  if (kind === 'cannot-know') return again === 'lock unchanged' ? `exact-or ${rootExpect}` : rootExpect
  if (again === 'no lock written') return kind === 'peer-conflict' ? rootExpect : 'unstable'
  if (again === 'lock changed') return 'unstable'
  return 'exact'
}

const DROP = ['readme', 'readmeFilename', 'maintainers', 'author', 'contributors', 'users', 'bugs']
const strip = o => {
  for (const k of DROP) delete o[k]
  if ('_npmUser' in o) {
    const u = o._npmUser
    o._npmUser = u && typeof u === 'object' && 'trustedPublisher' in u ? { trustedPublisher: u.trustedPublisher } : {}
  }
  return o
}
const locked = text => {
  const found = []
  let lock
  try {
    lock = JSON.parse(text)
  } catch (e) {
    return found
  }
  for (const [loc, e] of Object.entries(lock.packages || {})) {
    const at = loc.lastIndexOf('node_modules/')
    if (at < 0 || !e || e.link || typeof e.resolved !== 'string' || !e.resolved.startsWith(REG) || !e.version) continue
    found.push([e.name || loc.slice(at + 'node_modules/'.length), e.version])
  }
  const deps = d => {
    for (const [name, e] of Object.entries(d || {})) {
      if (e && typeof e.resolved === 'string' && e.resolved.startsWith(REG) && typeof e.version === 'string') {
        // an alias is locked as npm:<name>@<version>
        const alias = e.version.match(/^npm:(.+)@([^@]+)$/)
        found.push(alias ? [alias[1], alias[2]] : [name, e.version])
      }
      if (e) deps(e.dependencies)
    }
  }
  deps(lock.dependencies)
  return found
}
const liveCache = new Map()
const live = name => {
  if (!liveCache.has(name)) liveCache.set(name, (() => {
    const f = path.join(LIVE, `${name}@full`)
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
  })())
  return liveCache.get(name)
}

const main = async () => {
  const report = []
  const perRelease = Object.fromEntries(swept.map(r => [r, { root: 0, other: 0, missing: 0 }]))
  let exported = 0
  let groupsWritten = 0
  let manifestsAdded = 0
  let packumentsAdded = 0
  let unknownCrossAgain = 0
  const review = []
  for (const scenario of scenarios.sort()) {
    const base = load(recordedBy(scenario), scenario)
    if (!base || base.skip) continue
    const checks = Object.values(base.same || {})
    // a recording in which npm failed is reproduced when its release fails the same way: no lock, npm's same code
    const failsAlike = !checks.length && !fs.existsSync(path.join(FIXTURES, scenario, 'after')) &&
      base.exits.after !== undefined && base.exits.after !== 0 && base.code.after != null &&
      base.code.after === codeOf(read(path.join(FIXTURES, scenario, 'npm-after.log')))
    if (!failsAlike && (!checks.length || !checks.every(Boolean))) continue
    const dir = path.join(FIXTURES, scenario)
    const rootExpect = (read(path.join(dir, 'expect')) || '').trim() || null
    // releases group by what they wrote and by the rule, if any, that says what the engine should do there
    const rules = rulesOf(scenario)
    const keyOf = (r, o) => `${o.sig}|${ruled(rules, r, 'after') || ''}|${ruled(rules, r, 'cross') || ''}`
    const baseKey = keyOf(recordedBy(scenario), base)
    const groups = new Map()
    for (const r of swept) {
      const o = load(r, scenario)
      if (!o || o.skip) {
        perRelease[r].missing++
        continue
      }
      const key = keyOf(r, o)
      if (!groups.has(key)) {
        groups.set(key, { outcome: o, releases: [], ruledAfter: ruled(rules, r, 'after'), ruledCross: ruled(rules, r, 'cross') })
      }
      groups.get(key).releases.push(r)
      perRelease[r][key === baseKey ? 'root' : 'other']++
    }
    if (!DRY) {
      fs.rmSync(path.join(dir, 'release'), { recursive: true, force: true })
      fs.rmSync(path.join(dir, 'releases'), { force: true })
    }
    write(path.join(dir, 'releases'), ranges(groups.get(baseKey).releases).join('\n') + '\n')
    exported++
    const recorded = read(path.join(dir, 'recorded-with')) || ''
    const at = phase => {
      const m = recorded.match(new RegExp(`${phase} exit=-?\\d+ at ([^,\\s]+)`))
      if (m) return m[1]
      const day = recorded.match(/, (\d{4}-\d{2}-\d{2})\s/)
      return day ? `${day[1]}T12:00:00Z` : null
    }
    const need = new Map()
    for (const [key, g] of groups) {
      if (key === baseKey) continue
      const o = g.outcome
      const label = g.releases[0]
      const gdir = path.join(dir, 'release', label)
      const spans = ranges(g.releases)
      write(path.join(gdir, 'releases'), spans.join('\n') + '\n')
      const stamp = (phase, exit) => `${phase} exit=${exit === undefined ? '-' : exit}${at(phase === 'before' ? 'before' : 'after') ? ` at ${at(phase === 'before' ? 'before' : 'after')}` : ''}`
      write(path.join(gdir, 'recorded-with'),
        `npm ${label}, node ${process.version}, replayed against http/\n` +
        `${stamp('before', o.exits.before)}, ${stamp('after', o.exits.after)}, again exit=${o.exits.again === undefined ? '-' : o.exits.again}, cross exit=${o.exits.cross === undefined ? '-' : o.exits.cross}\n` +
        `platform os=${process.platform} cpu=${process.arch} libc=\n`)
      for (const f of FILES) if (o.text[f] != null) write(path.join(gdir, f), o.text[f])
      const expect = g.ruledAfter || o.exits.after === undefined ? g.ruledAfter : classify(o.exits.after, o.code.after, o.again, rootExpect,
        { exit: base.exits.after, code: base.code.after }, o.log.after)
      if (expect && expect !== 'exact') write(path.join(gdir, 'expect'), expect + '\n')
      // a cell swept before the second install over `cross` existed is taken as stable until it is topped up
      const expectCross = g.ruledCross || o.exits.cross === undefined ? g.ruledCross : classify(o.exits.cross, o.code.cross,
        o.crossAgain === 'unknown' ? 'lock unchanged' : o.crossAgain, rootExpect, { exit: base.exits.cross, code: base.code.cross },
        o.log.cross)
      if (expectCross && expectCross !== 'exact') write(path.join(gdir, 'expect-cross'), expectCross + '\n')
      if (o.crossAgain === 'unknown') unknownCrossAgain++
      for (const ph of ['before', 'after', 'cross']) if (o.exits[ph]) write(path.join(gdir, `npm-${ph}.log`), stable(o.log[ph]))
      if (o.exits.again !== undefined) write(path.join(gdir, 'npm-again.log'), `${stable(o.log.again)}exit=${o.exits.again}\n${o.again}\n`)
      for (const f of FILES) if (o.text[f] != null) for (const [n, v] of locked(o.text[f])) need.set(`${n}@${v}`, [n, v])
      groupsWritten++
      // today's registry stands for the recording's where nothing was published since and the tags are the same
      const tainted = o.overlay.filter(x => !/: as-of$/.test(x) && !/: live \(cut at [^,]+, 0 later versions dropped\)$/.test(x) && !/: live-manifest$/.test(x) && !/: absent$/.test(x))
      report.push(`${scenario}  release/${label}  [${spans.join(', ')}]  after: ${expect || '-'}  cross: ${expectCross || '-'}${tainted.length ? `  REGISTRY NEWER THAN RECORDING: ${tainted.join('; ')}` : ''}`)
      if (tainted.length) review.push(`${scenario} release/${label}: ${tainted.join('; ')}`)
    }
    for (const [n, v] of need.values()) {
      const f = path.join(dir, 'http', `${n}-${v}`)
      if (fs.existsSync(f)) continue
      let doc = live(n) && live(n).versions && live(n).versions[v]
      if (!doc) {
        const res = await fetch(`${REG}${n.replace('/', '%2f')}/${v}`)
        doc = res.ok ? await res.json() : null
      }
      if (!doc) {
        review.push(`${scenario}: no manifest for ${n}@${v}`)
        continue
      }
      write(f, JSON.stringify(strip({ ...doc })))
      createdHttp(f)
      manifestsAdded++
    }
    // every packument a current replay was served from outside the recording, by the cells' own request logs (a
    // document only a spoiled or superseded run asked for stays out): the abbreviated one, as the stub's answer
    // stood (a full one's versions and tags, in the registry's abbreviated form)
    const overlay = path.join(SWEEP, '_overlay', scenario)
    const served = new Set()
    const filled = new Set()
    for (const r of swept) {
      const requests = read(path.join(SWEEP, r, scenario, 'requests.log'))
      if (requests == null) continue
      for (const line of requests.split('\n')) {
        const m = line.match(/^GET (\S+) (full|abbreviated) (.*)$/)
        if (!m || m[3].startsWith('recorded') || m[3] === 'absent') continue
        const name = decodeURIComponent(m[1].split('?')[0].slice(1))
        if (!name || name.startsWith('-/')) continue
        if (m[2] === 'abbreviated' && m[3].startsWith('as-of-abbreviated')) filled.add(name)
        else served.add(name)
      }
    }
    // an abbreviated packument whose versions the recording kept as empty objects, as the stub filled them, beside it
    for (const n of filled) {
      const doc = path.join(overlay, n)
      if (!fs.existsSync(doc)) {
        review.push(`${scenario}: filled ${n} but the overlay no longer holds it`)
        continue
      }
      const f = path.join(dir, 'http', `${n}@abbreviated`)
      if (fs.existsSync(f)) continue
      const parsed = JSON.parse(fs.readFileSync(doc, 'utf8'))
      for (const v of Object.values(parsed.versions || {})) strip(v)
      write(f, JSON.stringify(strip(parsed)))
      createdHttp(f)
      packumentsAdded++
    }
    for (const n of served) {
      if (!fs.existsSync(path.join(overlay, n)) && !fs.existsSync(path.join(overlay, `${n}@full`))) {
        review.push(`${scenario}: served ${n} but the overlay no longer holds it`)
        continue
      }
      const own = path.join(dir, 'http', n)
      if (fs.existsSync(own) || fs.existsSync(own + '@full')) continue
      let doc
      if (fs.existsSync(path.join(overlay, n))) {
        doc = JSON.parse(fs.readFileSync(path.join(overlay, n), 'utf8'))
      } else {
        const full = JSON.parse(fs.readFileSync(path.join(overlay, `${n}@full`), 'utf8'))
        const cached = path.join(LIVE, n)
        if (!fs.existsSync(cached)) {
          const res = await fetch(`${REG}${n.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } })
          if (!res.ok) {
            review.push(`${scenario}: no abbreviated packument for ${n} (${res.status})`)
            continue
          }
          fs.mkdirSync(path.dirname(cached), { recursive: true })
          fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()))
        }
        const abbr = JSON.parse(fs.readFileSync(cached, 'utf8'))
        doc = { ...abbr, 'dist-tags': full['dist-tags'], versions: {} }
        for (const v of Object.keys(full.versions || {})) if (abbr.versions && abbr.versions[v]) doc.versions[v] = abbr.versions[v]
      }
      for (const v of Object.values(doc.versions || {})) strip(v)
      write(own, JSON.stringify(strip(doc)))
      createdHttp(own)
      packumentsAdded++
    }
  }
  const lines = [`each scenario's baseline is the release that recorded it (npm ${BASE} where the fixture does not say); ${exported} scenarios exported; ${groupsWritten} other outcomes (${unknownCrossAgain} with the second install over cross not yet run); ${manifestsAdded} manifests and ${packumentsAdded} packuments added to http/`, '',
    'release      writes-the-recorded-outcome  writes-another  not-swept']
  for (const r of swept) lines.push(`${r.padEnd(12)} ${String(perRelease[r].root).padEnd(28)} ${String(perRelease[r].other).padEnd(15)} ${perRelease[r].missing}`)
  lines.push('', 'outcomes other releases write:', ...report.map(l => '  ' + l))
  if (review.length) lines.push('', 'to review:', ...review.map(l => '  ' + l))
  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  if (CREATED_LIST && !DRY) fs.writeFileSync(CREATED_LIST, created.sort().join('\n') + (created.length ? '\n' : ''))
  console.log(lines[0])
  console.log(`${review.length} to review -> ${REPORT}`)
}
main()

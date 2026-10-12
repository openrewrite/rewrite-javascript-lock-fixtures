// Writes the Yarn Berry sweep's findings into the fixtures, as sweep-export.js does npm's: for every scenario, which
// releases write the recorded outcome, and each other outcome some releases write.
//   <scenario>/releases                 the releases that write the scenario's own outcome (ranges, one a line)
//   <scenario>/release/<first>/         an outcome other releases write, named by its first release:
//       releases                        the releases that write it
//       recorded-with                   the release, Node, machine and clock the sweep ran it with
//       before, after, after-again      what the release wrote from the scenario's start and for the edit (absent when
//                                       it failed)
//       cross, cross-again              what it wrote for the edit over the scenario's own `before`
//       yarnrc-before.written, yarnrc.written, cross.yarnrc.written
//                                       the .yarnrc.yml the release wrote in that phase: the settings its lockfile
//                                       migration rules add, which the regeneration writes too
//       expect-before, expect, expect-cross   the outcome when it is not byte-exact
//       yarn-<phase>.log                Yarn's output for a phase that failed
//   <scenario>/http/...                 the registry documents and tarballs a replay needs that the recording did not
//                                       keep, as the sweep's stub served them: a full packument as <name>@full (Yarn
//                                       Berry asks for the full one, whose `time` the age gate reads)
// An outcome is the locks, the .yarnrc.yml written, the exits, the failures and the second installs of a cell; the
// package.json Yarn reformats is no outcome, since the regeneration writes no manifest. A range joins releases only
// when every stable release between them was swept and wrote the same outcome. Only scenarios whose every phase the
// sweep's control reproduces are exported, and only releases from --min-major. The export removes what it created
// before (release/, releases, the files --created-list names) and never touches a recorded file.
//
// Expect lines, for a phase that is not byte-exact:
//   - a failure the recording release also ended the phase with: the scenario's own expect line;
//   - Yarn's reason otherwise: `pm-fails YN0001 <message>` for an exception, `pm-rejects YN<code> <message>` for
//     another report, `pm-rejects Usage Error: ...`, `pm-fails Internal Error: ...`, `pm-fails <crash>`; a message is
//     cut where it names a scratch path, a home or a port, which differ on every machine;
//   - a lock written where the recording's line says the engine cannot know it: `exact-or <line>` (sweep-export.js);
//     the recording's `malformed` or `not-reproduced` line stands as it is;
//   - a lock the second install rewrites or rejects: `second-install-rejects`;
//   - a lock holding a builtin compat patch entry (`#optional!builtin<compat/...>::...&hash=`) its start lock does not
//     hold, the release's own patch applied to the source's archive: `exact-or cannot-know builtin compat patch
//     changed (<resolution>)`, as the scenarios recorded over such an entry say (compat-patch-typescript-bump).
//
// Usage: node sweep-export-yarn-berry.js --sweep <sweep>/yarn-berry --fixtures <fixtures>/lock/yarn-berry
//          --created-list <file> --report <file> [--min-major 4] [--dry]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const SWEEP = path.resolve(arg('sweep'))
const FIXTURES = path.resolve(arg('fixtures'))
const MIN_MAJOR = Number(arg('min-major', 4))
const DRY = process.argv.includes('--dry')
const CREATED_LIST = arg('created-list')
const REPORT = arg('report')
const ASOF = path.join(SWEEP, '_asof')
const LIVE = path.join(SWEEP, '_live')
const TARBALLS = path.join(SWEEP, '_tarballs')
const HANDMADE = path.join(SWEEP, '_handmade', 'http')

const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)
const write = (f, data) => {
  if (DRY) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, data)
}

// the files an earlier export created, by path in the fixtures repository; removed first, so that an export writes
// only what this sweep says
const repoRoot = path.resolve(FIXTURES, '..', '..')
const created = []
const createdFile = f => created.push(path.relative(repoRoot, f))
if (CREATED_LIST && fs.existsSync(CREATED_LIST) && !DRY) {
  for (const rel of fs.readFileSync(CREATED_LIST, 'utf8').split('\n').filter(Boolean)) {
    fs.rmSync(path.join(repoRoot, rel), { force: true })
  }
}

const control = JSON.parse(fs.readFileSync(path.join(SWEEP, '_report', 'control.json'), 'utf8'))
const swept = fs.readdirSync(SWEEP).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const master = swept.filter(v => Number(v.split('.')[0]) >= MIN_MAJOR)

const LOCKS = ['before', 'after', 'after-again', 'cross', 'cross-again']
const RC = { before: 'yarnrc-before.written', after: 'yarnrc.written', cross: 'cross.yarnrc.written' }
const PHASES = ['before', 'after', 'again', 'cross', 'cross-again']

const load = (release, scenario) => {
  const dir = path.join(SWEEP, release, scenario)
  const rj = read(path.join(dir, 'result.json'))
  if (!rj) return null
  const r = JSON.parse(rj)
  if (r.skip || r.error) return { skip: r.skip || r.error }
  const o = {
    release, dir, exits: r.exits || {}, fail: r.fail || {}, again: r.again || null, crossAgain: r.crossAgain || null,
    node: r.node || {}, text: {}, rc: {}, log: {}
  }
  for (const f of LOCKS) o.text[f] = read(path.join(dir, f))
  for (const [phase, f] of Object.entries(RC)) o.rc[phase] = read(path.join(dir, f))
  for (const ph of PHASES) o.log[ph] = read(path.join(dir, `${ph}.log`))
  o.sig = sha(JSON.stringify([LOCKS.map(f => sha(o.text[f])), Object.keys(RC).map(ph => sha(o.rc[ph])),
    PHASES.map(ph => [o.exits[ph], o.fail[ph] || null]), o.again, o.crossAgain]))
  return o
}

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

// Yarn's reason, cut where it names what differs from machine to machine
const cut = message => {
  const at = message.search(/<(tmp|home|path|port|time|pid)>/)
  if (at < 0) return message.trim()
  return message.slice(0, at).replace(/(\s*\(in|\s+in|,?\s+open\s+'|\s+'|\s*\(|\s*'|%3A|:)\s*$/, '').trim()
}
const failureExpect = fail => {
  const first = String(fail || '').split('\n')[0]
  // a TypeError names the receiver by its name in the minified bundle: the method is the stable part
  let m = first.match(/\b[A-Za-z_$][\w$]{0,2}\.([\w$]+ is not a function.*)$/)
  if (m) return `pm-fails ${cut(m[1])}`
  m = first.match(/^➤ (YN\d{4}): │ (.*)$/)
  if (m) return `${m[1] === 'YN0001' ? 'pm-fails' : 'pm-rejects'} ${m[1]} ${cut(m[2])}`
  if (/^Usage Error: /.test(first)) return `pm-rejects ${cut(first)}`
  if (/^Internal Error: /.test(first)) return `pm-fails ${cut(first)}`
  if (/JavaScript heap out of memory/.test(first)) return 'pm-fails JavaScript heap out of memory'
  if (/unexpected empty event loop/.test(first)) return 'pm-fails unexpected empty event loop'
  m = first.match(/^(\w*Error|YAMLException)\b(.*)$/)
  if (m) return `pm-fails ${cut(first)}`
  return `pm-fails ${cut(first)}`
}

// the builtin compat patch resolutions of a lock
const builtinPatches = text => {
  const out = new Set()
  for (const m of String(text || '').matchAll(/^ {2}resolution: "([^"\n]*#optional!builtin<compat\/[^"\n]*hash=[0-9a-f]+[^"\n]*)"$/gm)) {
    out.add(m[1])
  }
  return out
}
const newBuiltinPatch = (start, written) => {
  const before = builtinPatches(start)
  for (const r of builtinPatches(written)) if (!before.has(r)) return r
  return null
}

// the outcome of one phase of a cell when it is not the lock byte for byte
const classify = ({ o, phase, base, basePhase, rootExpect, start, againOf }) => {
  const exit = o.exits[phase]
  if (exit === undefined) return null
  const kind = (rootExpect || 'exact').split(/\s+/)[0]
  if (exit !== 0) {
    if (rootExpect && base && base.exits[basePhase] !== 0 && base.exits[basePhase] !== undefined &&
      base.fail[basePhase] === o.fail[phase]) return rootExpect
    return failureExpect(o.fail[phase])
  }
  if (kind === 'not-reproduced' || kind === 'malformed') return rootExpect
  // what the engine cannot know under the recording release it may know under this one: the lock byte for byte when
  // it writes one, the recording's own line when not
  if (kind === 'cannot-know') return againOf === 'lock unchanged' || againOf == null ? `exact-or ${rootExpect}` : rootExpect
  if (againOf === 'lock changed' || againOf === 'no lock written') return 'second-install-rejects'
  const written = o.text[phase]
  const patch = written != null && start != null ? newBuiltinPatch(start, written) : null
  if (patch) {
    const m = patch.match(/^((?:@[^/@]+\/)?[^@]+)@patch:.*::version=([^&]+)&/)
    return `exact-or cannot-know builtin compat patch changed (${m ? `${m[1]} ${m[2]}` : patch})`
  }
  return 'exact'
}

// Yarn's output for a failed phase, without what differs from run to run
const stable = log => String(log || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  .filter(l => !/^\s+at /.test(l))
  .map(l => l.replace(/\/[^\s'"]*\/(project|cache|home)\b/g, '<tmp>/$1').replace(/\b\d+s \d+ms\b|\b\d+ms\b/g, '<time>'))
  .join('\n').trim() + '\n'

// ---- the registry documents and tarballs a replay of the exported releases asks for that the recording lacks -------
const FAMILY = host => {
  if (host === '127.0.0.1' || host === 'localhost' || host === 'registry.yarnpkg.com' || host === 'registry.npmjs.org')
    return { dir: 'http', key: 'npm' }
  if (host === 'npm.jsr.io') return { dir: 'http', key: 'jsr' }
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return { dir: 'http-npmmirror', key: 'npmmirror' }
  return null
}
// what of a packument reaches a lock: the tags, the publish times the age gate reads, and of each version the fields
// npmHttpUtils caches (CACHED_FIELDS) with its version
const VERSION_FIELDS = ['name', 'version', 'bin', 'scripts', 'os', 'cpu', 'libc', 'dependencies', 'dependenciesMeta',
  'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'deprecated']
const strip = doc => {
  const out = { name: doc.name, 'dist-tags': doc['dist-tags'], versions: {} }
  for (const [v, m] of Object.entries(doc.versions || {})) {
    if (!m || typeof m !== 'object') {
      out.versions[v] = m
      continue
    }
    const kept = {}
    for (const k of VERSION_FIELDS) if (k in m) kept[k] = m[k]
    if (m.dist && typeof m.dist === 'object' && 'tarball' in m.dist) kept.dist = { tarball: m.dist.tarball }
    out.versions[v] = kept
  }
  if ('time' in doc) out.time = doc.time
  return out
}
const TARBALL = /^((?:@[^/]+\/)?[^/]+)\/-\/(?:@[^/]+\/)?[^/]*?-(\d[^/]*)\.tgz$|^~\/\d+\/(@jsr\/[^/]+)\/(\d[^/]*)\.tgz$/
// the name and version of a tarball path, the registry's (<name>/-/<file>-<version>.tgz) or npm.jsr.io's
const tarballOf = rel => {
  const t = rel.match(TARBALL)
  return !t ? null : t[1] ? [t[1], t[2]] : [t[3], t[4]]
}

const addHttp = (scenario, cells, phasesOf, tarballPhasesOf, review, added) => {
  const dir = path.join(FIXTURES, scenario)
  for (const o of cells) {
    const log = read(path.join(o.dir, 'requests.log'))
    if (log == null) continue
    let phase = null
    for (const line of log.split('\n')) {
      const header = line.match(/^# (\S+): /)
      if (header) {
        phase = header[1]
        continue
      }
      if (!phasesOf(o).has(phase)) continue
      const m = line.match(/^GET (https?):\/\/([^/:\s]+)(?::\d+)?(\/\S*) accept=\S*(?: if-none-match)? -> 200 (full|abbreviated|tarball|manifest) (.*)$/)
      if (!m) continue
      const family = FAMILY(m[2])
      if (!family) continue
      const rel = decodeURIComponent(m[3].split('?')[0]).replace(/^\/+/, '')
      const how = m[5]
      if (how.startsWith('made again')) {
        // a hand-made package of the recorder's registry the recording does not keep, made again: its documents and
        // tarball as the stub served them
        const t = tarballOf(rel)
        const name = t ? t[0] : rel
        const files = t ? [`${t[0]}-${t[1]}.tgz`] : fs.readdirSync(HANDMADE).filter(f => f === name ||
          (f.startsWith(`${name}-`) && /^\d/.test(f.slice(name.length + 1)) && !f.endsWith('.tgz')))
        for (const f of files) {
          const own = path.join(dir, family.dir, f)
          if (fs.existsSync(own) || added.has(own) || !fs.existsSync(path.join(HANDMADE, f))) continue
          write(own, fs.readFileSync(path.join(HANDMADE, f)))
          added.set(own, t ? 'tarball' : 'packument')
        }
        continue
      }
      if (m[4] === 'full' || m[4] === 'abbreviated') {
        if (how.startsWith('recorded') || m[4] !== 'full') continue
        const name = rel
        const own = path.join(dir, family.dir, `${name}@full`)
        if (fs.existsSync(own) || added.has(own)) continue
        const kept = path.join(ASOF, scenario, family.key, `${name}@full`)
        if (!fs.existsSync(kept)) {
          review.push(`${scenario}: ${o.release} ${phase} was served ${name} (${how}) but the sweep keeps no copy`)
          continue
        }
        write(own, JSON.stringify(strip(JSON.parse(fs.readFileSync(kept, 'utf8')))))
        added.set(own, 'packument')
      } else if (m[4] === 'tarball') {
        // a tarball reaches the lock only where the replay writes one
        if (!/fetched/.test(how) || !tarballPhasesOf(o).has(phase)) continue
        const t = tarballOf(rel)
        if (!t) continue
        const own = path.join(dir, family.dir, `${t[0]}-${t[1]}.tgz`)
        if (fs.existsSync(own) || added.has(own)) continue
        const kept = path.join(TARBALLS, family.key, rel)
        if (!fs.existsSync(kept)) {
          review.push(`${scenario}: ${o.release} ${phase} fetched ${rel} but the sweep keeps no copy`)
          continue
        }
        write(own, fs.readFileSync(kept))
        added.set(own, 'tarball')
      } else if (m[4] === 'manifest') {
        if (!/live/.test(how)) continue
        const parts = rel.split('/')
        const n = parts[0].startsWith('@') ? 2 : 1
        const name = parts.slice(0, n).join('/')
        const own = path.join(dir, family.dir, `${name}-${parts[n]}`)
        if (fs.existsSync(own) || added.has(own)) continue
        const kept = path.join(LIVE, family.key, `${name}-${parts[n]}`)
        if (!fs.existsSync(kept)) continue
        write(own, JSON.stringify(strip(JSON.parse(fs.readFileSync(kept, 'utf8')))))
        added.set(own, 'manifest')
      }
    }
  }
}

const main = () => {
  const report = []
  const review = []
  const perRelease = Object.fromEntries(master.map(r => [r, { root: 0, other: 0, missing: 0 }]))
  let exported = 0
  let groupsWritten = 0
  const added = new Map()
  for (const scenario of Object.keys(control).sort()) {
    const c = control[scenario]
    const dir = path.join(FIXTURES, scenario)
    if (!fs.existsSync(dir)) continue
    if (!DRY) {
      fs.rmSync(path.join(dir, 'release'), { recursive: true, force: true })
      fs.rmSync(path.join(dir, 'releases'), { force: true })
    }
    if (c.skip) continue
    const checks = Object.entries(c).filter(([k, v]) => typeof v === 'boolean')
    if (!checks.length || !checks.every(([, v]) => v)) {
      report.push(`${scenario}  not exported: the control does not reproduce ${checks.filter(([, v]) => !v).map(([k]) => k).join(', ')}`)
      continue
    }
    const releases = c.releases || {}
    const baseline = /^\d/.test(releases.after || '') ? releases.after : releases.before
    if (!baseline || Number(baseline.split('.')[0]) < MIN_MAJOR) {
      report.push(`${scenario}  not exported: recorded with ${baseline}`)
      continue
    }
    const base = load(baseline, scenario)
    if (!base || base.skip) {
      report.push(`${scenario}  not exported: no cell of its recording release ${baseline}`)
      continue
    }
    const rootExpect = (read(path.join(dir, 'expect')) || '').trim() || null
    const recordedBefore = read(path.join(dir, 'before'))
    const seed = read(path.join(dir, 'lock-seed'))
    const groups = new Map()
    const cells = []
    for (const r of master) {
      const o = load(r, scenario)
      if (!o || o.skip) {
        perRelease[r].missing++
        continue
      }
      cells.push(o)
      if (!groups.has(o.sig)) groups.set(o.sig, { outcome: o, releases: [] })
      groups.get(o.sig).releases.push(r)
      perRelease[r][o.sig === base.sig ? 'root' : 'other']++
    }
    if (!groups.has(base.sig)) {
      report.push(`${scenario}  not exported: the baseline ${baseline} is not among the releases swept`)
      continue
    }
    write(path.join(dir, 'releases'), ranges(groups.get(base.sig).releases).join('\n') + '\n')
    exported++
    // the phases each cell's replay holds to a lock byte for byte
    const exactPhases = new Map()
    const rootExact = !rootExpect || rootExpect === 'exact'
    for (const o of cells) if (o.sig === base.sig) exactPhases.set(o, new Set(rootExact ? ['before', 'after', 'cross'] : ['before']))
    const recorded = read(path.join(dir, 'recorded-with')) || ''
    const head = recorded.split('\n')[0]
    const day = (head.match(/(\d{4}-\d{2}-\d{2})\s*$/) || [])[1]
    const machine = (head.match(/, ([^,]*\(node [^)]+\)),/) || [])[1] || 'Darwin x86_64 (node darwin-arm64)'
    for (const [sig, g] of groups) {
      if (sig === base.sig) continue
      const o = g.outcome
      const label = g.releases[0]
      const gdir = path.join(dir, 'release', label)
      const spans = ranges(g.releases)
      write(path.join(gdir, 'releases'), spans.join('\n') + '\n')
      const node = o.node.after || o.node.before || o.node.cross || '-'
      const exit = ph => o.exits[ph] === undefined ? '-' : o.exits[ph]
      write(path.join(gdir, 'recorded-with'),
        `yarn ${label} then ${label} (sweep), node ${node}, ${machine}, ${day || '-'}\n` +
        `before exit=${exit('before')}, after exit=${exit('after')}, again exit=${exit('again')}, cross exit=${exit('cross')}, ` +
        `cross-again exit=${exit('cross-again')}\n` +
        (day ? `clock ${day}T12:00:00Z\n` : ''))
      for (const f of LOCKS) if (o.text[f] != null) write(path.join(gdir, f), o.text[f])
      for (const [phase, f] of Object.entries(RC)) if (o.rc[phase] != null) write(path.join(gdir, f), o.rc[phase])
      const expectBefore = seed == null ? null : classify({ o, phase: 'before', base, basePhase: 'before', rootExpect: null, start: seed })
      const expect = classify({ o, phase: 'after', base, basePhase: 'after', rootExpect, start: o.text.before, againOf: o.again })
      const expectCross = classify({ o, phase: 'cross', base, basePhase: 'after', rootExpect, start: recordedBefore, againOf: o.crossAgain })
      const exact = new Set()
      if (expectBefore === 'exact') exact.add('before')
      if (expect === 'exact') exact.add('after')
      if (expectCross === 'exact') exact.add('cross')
      for (const c of cells) if (c.sig === sig) exactPhases.set(c, exact)
      if (expectBefore && expectBefore !== 'exact') write(path.join(gdir, 'expect-before'), expectBefore + '\n')
      if (expect && expect !== 'exact') write(path.join(gdir, 'expect'), expect + '\n')
      if (expectCross && expectCross !== 'exact') write(path.join(gdir, 'expect-cross'), expectCross + '\n')
      for (const ph of PHASES) if (o.exits[ph]) write(path.join(gdir, `yarn-${ph}.log`), stable(o.log[ph]))
      groupsWritten++
      report.push(`${scenario}  release/${label}  [${spans.join(', ')}]  before: ${expectBefore || '-'}  after: ${expect || '-'}  cross: ${expectCross || '-'}`)
    }
    // what a replay of the after, cross and seeded before phases asks the registry for
    addHttp(scenario, cells, o => new Set(['after', 'cross', ...(seed != null ? ['before'] : [])]),
      o => exactPhases.get(o) || new Set(), review, added)
  }
  for (const f of added.keys()) createdFile(f)
  let bytes = 0
  const kinds = {}
  for (const [f, kind] of added) {
    kinds[kind] = (kinds[kind] || 0) + 1
    if (!DRY) bytes += fs.statSync(f).size
  }
  const lines = [`${exported} scenarios exported, ${groupsWritten} other outcomes; added to http/: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}s`).join(', ') || 'nothing'} (${Math.round(bytes / 1024)} KiB)`, '',
    'release      writes-the-recorded-outcome  writes-another  not-swept']
  for (const r of master) lines.push(`${r.padEnd(12)} ${String(perRelease[r].root).padEnd(28)} ${String(perRelease[r].other).padEnd(15)} ${perRelease[r].missing}`)
  lines.push('', 'outcomes:', ...report.map(l => '  ' + l))
  if (review.length) lines.push('', 'to review:', ...review.map(l => '  ' + l))
  if (REPORT) fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  if (CREATED_LIST && !DRY) fs.writeFileSync(CREATED_LIST, created.sort().join('\n') + (created.length ? '\n' : ''))
  console.log(lines[0])
  console.log(`${review.length} to review${REPORT ? ` -> ${REPORT}` : ''}`)
}
main()

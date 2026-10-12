// Writes the Yarn classic sweep's findings into the fixtures, as sweep-export-yarn-berry.js does Yarn Berry's: for every
// scenario, which releases write the recorded outcome, and each other outcome some releases write.
//   <scenario>/releases                 the releases that write the scenario's own outcome (ranges, one a line)
//   <scenario>/release/<first>/         an outcome other releases write, named by its first release:
//       releases                        the releases that write it
//       recorded-with                   the release, Node and day the sweep ran it with, and its exits
//       before                          the lock the release wrote from pkg-before (absent where it failed, or where the
//                                       recording was given its start lock)
//       after                           what it wrote for the edit over its own before (over the given lock where the
//                                       recording was given one)
//       cross                           what it wrote for the edit over the scenario's own `before`
//       after-fixpoint, after-again, cross-fixpoint, cross-again
//                                       what a second install over after or cross rewrote it to
//       expect, expect-cross            the outcome of after and cross when it is not byte-exact
//       yarn-<phase>.log                Yarn's output for a phase that failed
//   <scenario>/http/... (http-npmmirror/...)
//                                       the registry documents and tarballs a replay of the after and cross phases needs
//                                       that the recording did not keep, as the sweep's stub served them: a packument the
//                                       recording did not keep at all (the registry's, cut at the recording's time); for
//                                       one it kept pruned (version numbers and dist-tags only), the manifest of each
//                                       version an outcome locks as <name>-<version>; a tarball as <name>-<version>.tgz
// An outcome is the locks a cell wrote, the exits and failures of before, after and cross, and the second installs over
// after and cross (the fixpoint and again installs; the --frozen-lockfile install is no regeneration's, and the member
// and repository locks the cwd and layout recorders keep are none of the lock's directory, which alone the regeneration
// writes). A range joins releases only when every stable release between them was swept and wrote the same outcome. Only
// scenarios whose every phase the sweep's control reproduces are exported. The export removes what it created before
// (release/, releases, the files --created-list names) and never touches a recorded file.
//
// A failure is the error that ended the phase: the last `error` line after yarn's last step (an error yarn reports
// before it, an optional package's, ends nothing), none where yarn printed none there, else a crash's line naming an
// Error.
//
// Expect lines, for a phase that is not byte-exact:
//   - a failure the recording release also ended the phase with: the scenario's own expect line; where only the wording
//     differs, the same kind with this release's words, and the recording's line where it says the engine cannot know
//     the outcome or the input is malformed;
//   - Yarn's own failure otherwise: `pm-rejects <message>` for the message of an error Yarn reports as its own
//     (`error <message>`) and for a registry's `Not found` however Yarn reports it, `pm-fails <message>` for an
//     unexpected one (`An unexpected error occurred: ...`, an Error's stack, a crash), the kind alone where the release
//     prints no error; a message is cut
//     where it names a scratch path, a home or the stub, which differ on every machine, or the workspace aggregator's
//     random name;
//   - a lock written where the recording's line says the engine cannot know it, or that the input is malformed (a
//     Berry lock 1.19.0 sets aside, which 1.17.0 to 1.18.0 read as theirs): `exact-or <line>` (sweep-export.js); the
//     recording's `not-reproduced` line stands as it is;
//   - where the recording's line says nothing the engine cannot know, what the recorders give the engine to not know,
//     as the line of the cannot-know above: a run in a member directory no workspaces list that writes the member's
//     lock (`after-member-lock`) where the recording release writes none (the line of open-cwd-unlisted-member's
//     recording, the scenario's `cwd` in it), and a lock that names yarn's cache folder (the line of
//     open-fetch-tarball-file-dependency's recording, the dependency and its package as the lock names them);
//   - a lock a second install (fixpoint or again) rewrites or rejects: `second-install-rejects`.
//
// Usage: node sweep-export-yarn-classic.js --sweep <sweep>/yarn-classic --fixtures <fixtures>/lock/yarn-classic
//          --packument <pm>/yarn-classic/packument.json --created-list <file> --report <file> [--dry]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const SWEEP = path.resolve(arg('sweep'))
const FIXTURES = path.resolve(arg('fixtures'))
const DRY = process.argv.includes('--dry')
const CREATED_LIST = arg('created-list')
const REPORT = arg('report')
const BASELINE = '1.22.22'
const ASOF = path.join(SWEEP, '_asof')
const TARBALLS = path.join(SWEEP, '_tarballs')

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
if (CREATED_LIST && fs.existsSync(CREATED_LIST) && !DRY) {
  for (const rel of fs.readFileSync(CREATED_LIST, 'utf8').split('\n').filter(Boolean)) {
    fs.rmSync(path.join(repoRoot, rel), { force: true })
  }
}

// every stable Yarn 1 release the registry has; a release the sweep could not run breaks a range
const master = Object.keys(JSON.parse(fs.readFileSync(arg('packument'), 'utf8')).versions)
  .filter(v => /^1\.\d+\.\d+$/.test(v)).sort(cmp)
const swept = fs.readdirSync(SWEEP).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const control = JSON.parse(fs.readFileSync(path.join(SWEEP, '_report', 'control.json'), 'utf8'))

const LOCKS = ['before', 'after', 'cross', 'after-fixpoint', 'after-again', 'cross-fixpoint', 'cross-again']
const PHASES = ['before', 'after', 'cross']

// what a second install over a lock did, as the regeneration's own second install would see it
const secondOf = s => s ? { over: s.over, fixpoint: s.fixpoint, again: s.again, againExit: s.againExit } : null
const rejects = s => !!s && s.over !== 'before' &&
  (s.fixpoint !== undefined && s.fixpoint !== 'same' || s.again !== undefined && s.again !== 'lock unchanged')

// Yarn's output for a failed phase, without what differs from run to run
const stable = log => String(log || '').split('\n')
  .filter(l => !/^\s+at /.test(l) && !/^\(node:\d+\) /.test(l) && !/^\(Use `node --trace-/.test(l))
  .map(l => l.replace(/workspace-aggregator-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'workspace-aggregator-<uuid>'))
  .join('\n').trim() + '\n'

// The `error` lines of a phase's log, in the order yarn printed them (all go to stderr, whose order the log keeps; the
// steps go to stdout, which interleaves with it from run to run), and the line of a crash naming an Error where there is
// none.
const errorLinesOf = log => stable(log).split('\n').filter(l => /^error /.test(l)).map(l => l.trim())
const crashOf = log => {
  const crash = stable(log).split('\n').find(l => /\b[A-Za-z]*Error\b/.test(l))
  return crash ? crash.trim() : null
}
const isStrictPrefix = (a, b) => a.length < b.length && a.every((l, i) => l === b[i])

// The error that ended a phase: the last `error` line; none where the release printed only what the release before it
// printed ahead of its last one (1.22.20 reports no error that is no MessageError, while an optional package's error
// yarn reports earlier ends nothing); a crash's line where yarn printed no `error` line.
const settle = (o, previous) => {
  for (const ph of PHASES) {
    if (o.exits[ph] === undefined || o.exits[ph] === 0) continue
    const lines = o.errorLines[ph]
    const before = previous && previous.errorLines[ph]
    if (!lines.length) o.fail[ph] = crashOf(o.log[ph])
    else if (before && isStrictPrefix(lines, before)) o.fail[ph] = null
    else o.fail[ph] = lines[lines.length - 1]
  }
  o.sig = sha(JSON.stringify([LOCKS.map(f => sha(o.text[f])), PHASES.map(ph => [o.exits[ph], o.fail[ph] || null]),
    o.second.after, o.second.cross]))
}

const load = (release, scenario) => {
  const dir = path.join(SWEEP, release, scenario)
  const rj = read(path.join(dir, 'result.json'))
  if (!rj) return null
  const r = JSON.parse(rj)
  if (r.skip || r.error || r.inconclusive) return { skip: r.skip || r.error || r.inconclusive }
  const o = {
    release, dir, exits: r.exits || {}, fail: {}, node: r.node, text: {}, log: {},
    second: { after: secondOf((r.second || {}).after), cross: secondOf((r.second || {}).cross) },
    memberLock: sha(read(path.join(dir, 'after-member-lock'))), repoLock: sha(read(path.join(dir, 'after-repo-lock'))),
  }
  for (const f of LOCKS) o.text[f] = read(path.join(dir, f))
  o.errorLines = {}
  for (const ph of PHASES) {
    o.log[ph] = read(path.join(dir, `${ph}.log`))
    o.errorLines[ph] = errorLinesOf(o.log[ph])
  }
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

// Yarn's words, cut where they name what differs from machine to machine
const cut = message => {
  const at = message.search(/<(tmp|home|stub|root|work|yarn|node|corepack|uuid)>/)
  if (at < 0) return message.trim()
  return message.slice(0, at).replace(/(\s*\(in|\s+in|,?\s+open\s+'|\s+'|\s*\(|\s*'|\s*"|%3A|:)+\s*$/, '').trim()
}
// the first line of a failure as Yarn printed it: an error Yarn reports as its own (`error <message>`, the registry's
// `Not found`) is the package manager rejecting the edit, an unexpected one (`An unexpected error occurred`, an Error's
// stack, a crash) the package manager failing
const kindOf = first => {
  if (first == null) return 'pm-fails'
  const message = first.replace(/^error /, '')
  // the registry's verdict however yarn reports it: before 1.5.0 a nested request's 404 is an unexpected error, as a
  // root request's is in every release before 1.22.20
  if (/: Not found$/.test(core(first))) return 'pm-rejects'
  if (!/^error /.test(first) || /^An unexpected error occurred: /.test(message)) return 'pm-fails'
  if (/: Not found$/.test(message)) return 'pm-rejects'
  return /^(?:[A-Z]\w*)?Error\b[^:]*: /.test(message) ? 'pm-fails' : 'pm-rejects'
}
// the error a failure's first line names, without the words a release wraps it in: `error `, `An unexpected error
// occurred: "..."`, an Error's name
const core = first => {
  if (first == null) return null
  let message = first.replace(/^error /, '')
  const unexpected = message.match(/^An unexpected error occurred: "([\s\S]*)"\.$/)
  if (unexpected) message = unexpected[1].replace(/\\"/g, '"')
  return message.replace(/^(?:[A-Z]\w*)?Error(?: \[\w+\])?: /, '').replace(/\.$/, '').trim()
}
const firstLine = fail => fail == null ? null : String(fail).split('\n')[0]

// the outcome of after or cross when it is not the lock byte for byte; base is the recording release's cell, previous
// the release swept before this one (whose error a release that prints none, 1.22.20, ended with)
const classify = ({ o, phase, base, previous, rootExpect, second, cwd }) => {
  const exit = o.exits[phase]
  if (exit === undefined) return null
  const kind = (rootExpect || 'exact').split(/\s+/)[0]
  if (exit !== 0) {
    const baseFailed = base.exits.after !== undefined && base.exits.after !== 0
    const first = firstLine(o.fail[phase])
    if (baseFailed && rootExpect && (base.fail.after === o.fail[phase] ||
                                     ['cannot-know', 'malformed', 'not-reproduced'].includes(kind))) {
      return rootExpect
    }
    // the error this release ended with: its own line, else (no error line) the one the release before printed
    const named = first != null ? first :
      previous && previous.exits[phase] !== 0 && previous.exits[phase] !== undefined ? firstLine(previous.fail[phase]) : null
    const sameError = baseFailed && rootExpect && named != null && core(named) === core(firstLine(base.fail.after))
    const message = first == null ? '' : cut(first.replace(/^error /, ''))
    return `${sameError ? kind : kindOf(named)}${message ? ` ${message}` : ''}`
  }
  if (kind === 'not-reproduced') return rootExpect
  // what the engine cannot know under the recording release it may know under this one, and what that release
  // discards as malformed this one may read: the lock byte for byte when the engine writes one, the recording's own
  // line when not
  if (kind === 'cannot-know' || kind === 'malformed') return rejects(second) ? rootExpect : `exact-or ${rootExpect}`
  // what the recorders say the engine cannot know, where this release writes it and the recording release does not:
  // run in a member directory no workspaces list (yarn before 1.7.0 drops a .yarnrc's --focus), it writes the member's
  // lock, not this one; a lock that names yarn's cache folder, which differs from machine to machine
  const unknowable = o.memberLock !== '-' && base.memberLock === '-' && cwd ?
    `cannot-know the lock yarn writes: run in ${cwd}, which no workspaces list, it writes ${cwd}/yarn.lock (member ` +
    'lock written), not this lock' : cacheEntryOf(o.text[phase])
  if (unknowable) return rejects(second) ? unknowable : `exact-or ${unknowable}`
  if (rejects(second)) return 'second-install-rejects'
  return 'exact'
}

// the cannot-know of a lock entry's dependency written relative to yarn's cache folder (the sweep's <tmp>/cache), in
// the words the recorders give it, as far as the lock says them
const cacheEntryOf = text => {
  let entry = null
  let type = null
  for (const line of String(text || '').split('\n')) {
    if (/^\S.*:$/.test(line)) entry = line.slice(0, -1).split(', ')[0].replace(/^"|"$/g, '').replace(/(.)@[^@]*$/, '$1')
    else if (/^ {2}\S.*:$/.test(line)) type = line.trim().slice(0, -1)
    else if (/^ {4}\S/.test(line) && line.includes('<tmp>/cache/') && entry && type) {
      const name = line.trim().split(' ')[0].replace(/^"|"$/g, '')
      return `cannot-know where yarn's cache sits, which the ${type} entry ${name} of ${entry} is written relative to`
    }
  }
  return null
}

// ---- the registry documents and tarballs a replay asks for that the recording lacks ---------------------------------
const FAMILY = (host, port) => {
  if (host === 'registry.yarnpkg.com' || host === 'registry.npmjs.org') return { dir: 'http', key: 'npm' }
  if (host === '127.0.0.1' || host === 'localhost') return { dir: 'http', key: `local-${port}`, tarballs: 'npm' }
  if (host === 'registry.npmmirror.com' || host === 'cdn.npmmirror.com') return { dir: 'http-npmmirror', key: 'npmmirror' }
  return null
}
const TARBALL = /^((?:@[^/]+\/)?[^/]+)\/-\/(?:@[^/]+\/)?[^/]*?-(\d[^/]*)\.tgz$/
const isPruned = text => {
  try {
    const j = JSON.parse(text)
    const entries = Object.values((j && j.versions) || {})
    return entries.length > 0 && entries.every(e => e && typeof e === 'object' && !Array.isArray(e) && !Object.keys(e).length)
  } catch (e) {
    return false
  }
}
// the registry versions a lock holds: [name, version] of each entry resolved to a registry tarball
const lockedVersions = text => {
  const out = []
  let version = null
  for (const line of String(text || '').split('\n')) {
    const v = line.match(/^ {2}version "([^"]+)"$/)
    if (v) version = v[1]
    const r = line.match(/^ {2}resolved "https?:\/\/[^/"]+\/((?:@[^/"]+\/)?[^/"]+)\/-\/[^"#]*?\.tgz(?:#[^"]*)?"$/)
    if (r && version) out.push([decodeURIComponent(r[1]), version])
    if (/^\S/.test(line)) version = null
  }
  return out
}

const addHttp = (scenario, cells, replayed, outcomeLocks, review, added) => {
  const dir = path.join(FIXTURES, scenario)
  const fixtureTarballs = path.join(FIXTURES, 'fixture-tarballs')
  const unrecorded = !fs.existsSync(path.join(dir, 'recorded-with'))
  const has = f => fs.existsSync(f) || added.has(f)
  const asOf = new Map()
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
      if (!replayed(o).has(phase)) continue
      const m = line.match(/^GET (https?):\/\/([^/:\s]+)(?::(\d+))?(\/\S*) accept=\S*.*? -> 200 (abbreviated|full|tarball|manifest) ?(.*)$/)
      if (!m) continue
      const family = FAMILY(m[2], m[3])
      if (!family) continue
      const rel = decodeURIComponent(m[4].split('?')[0]).replace(/^\/+/, '')
      const how = m[6]
      if (m[5] === 'tarball') {
        if (!/^fetched/.test(how)) continue
        const t = rel.match(TARBALL)
        if (!t) {
          review.push(`${scenario}: ${o.release} ${phase} fetched ${rel}, which names no package and version`)
          continue
        }
        const file = `${t[1]}-${t[2]}.tgz`
        const own = path.join(dir, family.dir, file)
        if (has(own) || unrecorded && family.dir === 'http' && fs.existsSync(path.join(fixtureTarballs, file))) continue
        const kept = path.join(TARBALLS, family.tarballs || family.key, rel)
        if (!fs.existsSync(kept)) {
          review.push(`${scenario}: ${o.release} ${phase} fetched ${rel} but the sweep keeps no copy`)
          continue
        }
        write(own, fs.readFileSync(kept))
        added.set(own, 'tarball')
      } else if (m[5] === 'abbreviated' || m[5] === 'full') {
        if (/^recorded/.test(how)) continue
        const name = rel
        const kept = path.join(ASOF, scenario, family.key, m[5] === 'full' ? `${name}@full` : name)
        if (!fs.existsSync(kept)) {
          review.push(`${scenario}: ${o.release} ${phase} was served ${name} (${how}) but the sweep keeps no copy`)
          continue
        }
        if (/^live/.test(how)) {
          const own = path.join(dir, family.dir, name)
          if (has(own)) continue
          if (m[5] === 'full') {
            review.push(`${scenario}: ${o.release} ${phase} asked for the full packument of ${name}`)
            continue
          }
          write(own, fs.readFileSync(kept))
          added.set(own, 'packument')
        } else if (/^as-of a pruned document/.test(how)) {
          asOf.set(`${family.dir}\0${name}`, kept)
        } else {
          review.push(`${scenario}: ${o.release} ${phase} was served ${name} as "${how}"`)
        }
      }
    }
  }
  // the manifest of each version an outcome locks, where the recording kept the document pruned and not the version
  for (const [key, kept] of asOf) {
    const [familyDir, name] = key.split('\0')
    const recorded = read(path.join(dir, familyDir, name))
    if (recorded == null || !isPruned(recorded)) continue
    const doc = JSON.parse(fs.readFileSync(kept, 'utf8'))
    for (const text of outcomeLocks) {
      for (const [n, v] of lockedVersions(text)) {
        if (n !== name) continue
        const own = path.join(dir, familyDir, `${name}-${v}`)
        if (has(own)) continue
        const manifest = doc.versions && doc.versions[v]
        if (!manifest || !Object.keys(manifest).length) {
          review.push(`${scenario}: an outcome locks ${name}@${v}, which the stub's document of it does not hold`)
          continue
        }
        write(own, JSON.stringify(manifest))
        added.set(own, 'manifest')
      }
    }
  }
}

const main = () => {
  const report = []
  const review = []
  const perRelease = Object.fromEntries(swept.map(r => [r, { root: 0, other: 0, missing: 0 }]))
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
    if (!c.counts || c.not.length) {
      report.push(`${scenario}  not exported: the control does not reproduce ${c.not.join(', ') || 'it'}`)
      continue
    }
    const recorded = read(path.join(dir, 'recorded-with')) || ''
    const recordedBy = (recorded.match(/^yarn (\S+),/) || [])[1] || BASELINE
    if (recordedBy !== BASELINE) {
      report.push(`${scenario}  not exported: recorded with ${recordedBy}`)
      continue
    }
    const cells = []
    let previous = null
    for (const r of swept) {
      const o = load(r, scenario)
      if (!o || o.skip) {
        perRelease[r].missing++
        if (o && o.skip) review.push(`${scenario}: ${r} not exported (${o.skip})`)
        previous = null
        continue
      }
      settle(o, previous)
      previous = o
      cells.push(o)
    }
    const base = cells.find(o => o.release === BASELINE)
    if (!base) {
      report.push(`${scenario}  not exported: no cell of its recording release ${BASELINE}`)
      continue
    }
    const rootExpect = (read(path.join(dir, 'expect')) || '').trim() || null
    const given = fs.existsSync(path.join(dir, 'before-given')) || /^before exit=given/m.test(recorded)
    const cwd = (read(path.join(dir, 'cwd')) || '').trim()
    const groups = new Map()
    for (const o of cells) {
      const r = o.release
      if (!groups.has(o.sig)) groups.set(o.sig, { outcome: o, releases: [], cells: [] })
      groups.get(o.sig).releases.push(r)
      groups.get(o.sig).cells.push(o)
      perRelease[r][o.sig === base.sig ? 'root' : 'other']++
    }
    write(path.join(dir, 'releases'), ranges(groups.get(base.sig).releases).join('\n') + '\n')
    exported++
    const day = (recorded.split('\n')[0].match(/(\d{4}-\d{2}-\d{2})\s*$/) || [])[1] || '-'
    const outcomeLocks = []
    for (const [sig, g] of groups) {
      const o = g.outcome
      for (const f of LOCKS) if (o.text[f] != null) outcomeLocks.push(o.text[f])
      // a lock the cwd and layout recorders keep beside the project's is no outcome; one that differs is noted
      const others = new Set(g.cells.map(x => `${x.memberLock}/${x.repoLock}`))
      if (others.size > 1) review.push(`${scenario}: the releases ${ranges(g.releases).join(', ')} write the same outcome but another member or repository lock`)
      if (sig === base.sig) continue
      const label = g.releases[0]
      const gdir = path.join(dir, 'release', label)
      const spans = ranges(g.releases)
      write(path.join(gdir, 'releases'), spans.join('\n') + '\n')
      const exit = ph => o.exits[ph] === undefined ? '-' : o.exits[ph]
      write(path.join(gdir, 'recorded-with'),
        `yarn ${label} (sweep), node ${o.node || '-'}, ${day}\n` +
        `before exit=${exit('before')}, after exit=${exit('after')}, cross exit=${exit('cross')}\n`)
      for (const f of LOCKS) if (o.text[f] != null) write(path.join(gdir, f), o.text[f])
      const previous = cells.find(x => x.release === swept[swept.indexOf(label) - 1]) || null
      const expect = classify({ o, phase: 'after', base, previous, rootExpect, second: o.second.after, cwd })
      const expectCross = given ? null :
        classify({ o, phase: 'cross', base, previous, rootExpect, second: o.second.cross, cwd })
      if (expect && expect !== 'exact') write(path.join(gdir, 'expect'), expect + '\n')
      if (expectCross && expectCross !== 'exact') write(path.join(gdir, 'expect-cross'), expectCross + '\n')
      for (const ph of PHASES) if (o.exits[ph]) write(path.join(gdir, `yarn-${ph}.log`), stable(o.log[ph]))
      groupsWritten++
      report.push(`${scenario}  release/${label}  [${spans.join(', ')}]  after: ${expect || '-'}  cross: ${expectCross || '-'}`)
    }
    // what a replay of after (where the release wrote its own start, or was given one) and cross asks the registry for
    addHttp(scenario, cells,
      o => new Set([...(given || o.text.before != null ? ['after'] : []), ...(given ? [] : ['cross'])]),
      outcomeLocks, review, added)
  }
  for (const f of [...added.keys()].sort()) created.push(path.relative(repoRoot, f))
  let bytes = 0
  const kinds = {}
  for (const [f, kind] of added) {
    kinds[kind] = (kinds[kind] || 0) + 1
    if (!DRY) bytes += fs.statSync(f).size
  }
  const lines = [`${exported} scenarios exported, ${groupsWritten} other outcomes; added to http/: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}s`).join(', ') || 'nothing'} (${Math.round(bytes / 1024)} KiB)`, '',
    'release      writes-the-recorded-outcome  writes-another  not-swept']
  for (const r of swept) lines.push(`${r.padEnd(12)} ${String(perRelease[r].root).padEnd(28)} ${String(perRelease[r].other).padEnd(15)} ${perRelease[r].missing}`)
  lines.push('', 'outcomes:', ...report.map(l => '  ' + l))
  if (review.length) lines.push('', 'to review:', ...review.map(l => '  ' + l))
  if (REPORT) fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  if (CREATED_LIST && !DRY) fs.writeFileSync(CREATED_LIST, created.join('\n') + (created.length ? '\n' : ''))
  console.log(lines[0])
  console.log(`${review.length} to review${REPORT ? ` -> ${REPORT}` : ''}`)
}
main()

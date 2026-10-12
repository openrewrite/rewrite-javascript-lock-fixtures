// Writes the Bun sweep's findings into the fixtures, as sweep-export.js does npm's and sweep-export-yarn-berry.js Yarn
// Berry's: for every scenario, which releases write the recorded outcome, and each other outcome some releases write.
//   <scenario>/releases                 the releases that write the scenario's own outcome (ranges, one a line)
//   <scenario>/release/<first>/         an outcome other releases write, named by its first release:
//       releases                        the releases that write it
//       recorded-with                   the release, how the sweep ran it, the clock, and each phase's exit
//       before                          what the release wrote from the scenario's start (pkg-before from scratch, or
//                                       the seeded lock-before); absent where that failed or never finished
//       after, after-again              what it wrote for the edit over that before, and what a second install over
//                                       after rewrote it to; absent where the edit failed, and where there was no
//                                       before to edit over (the edit then installed from scratch, which no
//                                       regeneration does)
//       cross, cross-again              what it wrote for the edit over the scenario's own `before`, and the second
//                                       install's rewrite of it
//       expect, expect-cross            the outcome of the edit and of cross when it is not byte-exact
//       bun-<phase>.log                 bun's output for a phase that failed
//   <scenario>/http/...                 the registry documents a replay of the after, cross or second-install phases
//                                       asked for that the recording did not keep, as the sweep's frozen registry
//                                       served them (http/ for registry.npmjs.org and the recording's loopback stub,
//                                       http-<label>/ for registry.<label>.<tld>)
// An outcome is what the regeneration writes too: the lock where the scenario keeps it (lock-dir's for a lockdir
// scenario) for the edit over the release's own before and for cross, with each phase's exit and error lines, the
// second install over each, the before it edits over, and for a lockdir or rundir scenario which locks the edit
// created or changed (where bun installed). A range joins releases only when every release between them was swept and
// wrote the same outcome. Only scenarios the control counts (bun-control.js: every check the fixture allows passes, the
// outcome the same in every run) are exported, and only releases from --min. A cell with an undecided replayed phase
// (harness error, a run killed in a phase the replays read, a phase whose outcome varied between the passes of that
// release, or a request the frozen registry had no answer for that the baseline's cell never made) is not exported:
// that release is not replayed over the scenario. A before that never finished (killed at the timeout alone and against
// the real registry, _hung/) is an outcome: the replays never install from scratch, and its cross stands.
// The export removes what it created before (release/, releases, the files --created-list names) and never touches a
// recorded file.
//
// Expect lines, for a phase that is not byte-exact:
//   - a failure the baseline release also ended the phase with, with the same error lines: the scenario's own line;
//   - a `"git clone" for "<name>" failed`: `cannot-know git ref of <name>@`, since what git reaches over the network is
//     not the engine's to know (as sweep-export.js takes the filesystem npm ran on);
//   - bun's reason otherwise: `pm-rejects <the first error line>`, its scratch directory cut (`<tmp>/proj/`); a run
//     killed in the phase: `pm-fails it never finishes`;
//   - the lock of a lockdir scenario left as it was while the edit created or changed another one above it: `cannot-know
//     the lock bun writes: it installs at the workspace root <up>, whose workspaces list this project`, as the
//     recorder's own lines say;
//   - a lock written where the recording's line says the engine cannot know it: `exact-or <line>` when the second
//     install leaves it, the line itself otherwise; the recording's `malformed` or `not-reproduced` line stands;
//   - a lock the second install rewrites or rejects: `second-install-rejects`.
//
// Usage: node sweep-export-bun.js --sweep <sweep>/bun --fixtures <fixtures>/lock/bun --created-list <file>
//          --report <file> [--min 1.2.0] [--baseline 1.3.10] [--dry]
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { loadCell, read } = require('./bun-cell.js')

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? dflt : process.argv[i + 1]
}
const SWEEP = path.resolve(arg('sweep'))
const FIXTURES = path.resolve(arg('fixtures'))
const MIN = arg('min', '1.2.0')
const BASE = arg('baseline', '1.3.10')
const DRY = process.argv.includes('--dry')
const CREATED_LIST = arg('created-list')
const REPORT = arg('report')
const PASSES = ['_pass-2', '_pass-3'].map(p => path.join(SWEEP, p))

const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
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

const control = JSON.parse(fs.readFileSync(path.join(SWEEP, '_report', 'control.json'), 'utf8'))
const master = fs.readdirSync(SWEEP).filter(v => /^\d+\.\d+\.\d+$/.test(v) && cmp(v, MIN) >= 0).sort(cmp)
const NAMESPACE = fs.readdirSync(path.join(SWEEP, '_overlay'))[0]

// the phases a replay reads, their logs, and the phases each builds on
const LOGS = { before: 'before', after: 'after', again: 'again', cross: 'cross', crossAgain: 'cross-again' }
const BUILDS_ON = { after: ['before'], again: ['before', 'after'], crossAgain: ['cross'] }

// the requests a phase made that the frozen registry had no answer for (requests.log, under `# <phase>`)
const noAnswers = dir => {
  const by = {}
  let phase = null
  for (const line of String(read(path.join(dir, 'requests.log')) || '').split('\n')) {
    const h = line.match(/^# (\S+)/)
    if (h) {
      phase = h[1]
      continue
    }
    const m = line.match(/^(?:GET|HEAD) (\S+) \S+ (absent|unserved|stub-error|live-url-absent|fixed-url-absent)/)
    if (m && phase) (by[phase] = by[phase] || new Set()).add(m[1])
  }
  return by
}

// what an outcome is made of, per phase; null where the phase did not run or is not replayed
const outcomeOf = c => {
  const p = c.phase
  const hung = c.r.hung || {}
  const part = ph => {
    const x = p[ph]
    if (!x.ran) return null
    return { exit: x.exit, status: x.status, lock: x.lock, errors: x.errors, extra: x.extra, hung: hung[LOGS[ph]] || null }
  }
  const o = { before: part('before'), cross: part('cross'), crossAgain: part('crossAgain') }
  // the edit is over a lock only where the release wrote its before
  if (o.before && o.before.lock != null) {
    o.after = part('after')
    o.again = part('again')
  }
  return o
}
const sigOf = o => sha(JSON.stringify(['before', 'after', 'again', 'cross', 'crossAgain'].map(ph => {
  const x = o[ph]
  return x ? [x.exit, x.status, sha(x.lock), x.errors, x.extra] : null
})))

// why a phase of a cell's outcome decides nothing, or null; a before that never finished is an outcome
const undecided = (rel, s, c, base) => {
  if (c.r.error) return `harness error: ${c.r.error.split('\n')[0]}`
  const hung = c.r.hung || {}
  const phases = Object.keys(LOGS).filter(ph => c.outcome[ph])
  for (const ph of phases) {
    if (ph !== 'before' && hung[LOGS[ph]]) return `${ph} hung: ${hung[LOGS[ph]]}`
  }
  // the passes of the same release: a phase whose outcome differs follows timing
  for (const pass of PASSES) {
    const dir = path.join(pass, rel, s)
    if (!fs.existsSync(path.join(dir, 'result.json'))) continue
    const other = loadCell(dir)
    if (!other || other.skip || other.r.error) continue
    for (const ph of phases) {
      if (hung[LOGS[ph]] || (other.r.hung || {})[LOGS[ph]]) continue
      if (other.phase[ph].sig !== c.phase[ph].sig) return `${ph} varies between the passes of ${rel}`
    }
  }
  const known = new Set(Object.values(noAnswers(base.dir)).flatMap(x => [...x]))
  const asked = noAnswers(c.dir)
  for (const ph of phases) {
    const mine = [...(asked[LOGS[ph]] || [])].filter(u => !known.has(u))
    if (mine.length) return `the registry has no answer for ${mine.join(', ')} (${ph})`
  }
  return null
}

// bun's first error line, its scratch directory cut, as an expect line's rest
const firstError = errors => {
  const line = (errors || []).find(e => /^error: /.test(e)) || (errors || [])[0] || ''
  return line.replace(/<tmp>\/(?:proj|again|req|fresh)\//g, '')
}

// the lock of a lockdir or rundir scenario the edit left as it was while it created or changed another one
const installedAbove = (x, lockRel) => {
  if (!x || !x.extra) return null
  const lines = x.extra.split('|')
  const mine = lines.find(l => l.startsWith(`${lockRel} `))
  if (mine && !/ unchanged$/.test(mine)) return null
  const other = lines.find(l => !l.startsWith(`${lockRel} `) && / (created|changed)$/.test(l))
  if (!other) return null
  const otherDir = path.posix.dirname(other.replace(/ (created|changed)$/, ''))
  const up = path.posix.relative(path.posix.dirname(lockRel), otherDir === '.' ? '' : otherDir)
  return `cannot-know the lock bun writes: it installs at the workspace root ${up}, whose workspaces list this project`
}

// the outcome of the edit (after) or of cross when it is not the lock byte for byte; base the baseline's outcome
const classify = ({ o, phase, base, rootExpect, lockRel }) => {
  const x = o[phase]
  if (!x) return null
  const second = o[phase === 'after' ? 'again' : 'crossAgain']
  const kind = (rootExpect || 'exact').split(/\s+/)[0]
  const b = base[phase] || base.cross
  if (x.exit !== 0) {
    if (x.hung) return 'pm-fails it never finishes'
    if (rootExpect && kind !== 'exact' && b && b.exit === x.exit &&
      JSON.stringify(b.errors) === JSON.stringify(x.errors)) return rootExpect
    // what git reached over the network the engine cannot know, as npm's export takes the filesystem npm ran on
    const clone = (x.errors || []).map(e => e.match(/^error: "git clone" for "([^"]+)" failed/)).find(Boolean)
    if (clone) return `cannot-know git ref of ${clone[1]}@`
    return `pm-rejects ${firstError(x.errors)}`
  }
  const above = lockRel !== 'bun.lock' ? installedAbove(x, lockRel) : null
  if (above) return above
  if (kind === 'not-reproduced' || kind === 'malformed') return rootExpect
  // bun deletes a lockfile with no packages: the test holds the regeneration to that
  if (x.lock == null && lockRel === 'bun.lock') return 'exact'
  const again = second ? second.status : null
  if (kind === 'cannot-know') return again === 'lock unchanged' || again == null ? `exact-or ${rootExpect}` : rootExpect
  if (again === 'lock changed' || again === 'no lock written') return 'second-install-rejects'
  return 'exact'
}

// bun's output for a failed phase, without what differs from run to run
const stable = log => String(log || '').split('\n')
  .map(l => l.replace(/\s+\[[\d.]+m?s\]$/, '').replace(/\[[\d.]+m?s\]/g, '[<time>]'))
  .join('\n').trim() + '\n'

// ---- the registry documents a replay asks for that the recording lacks -------------------------------------------
// where the scenario keeps a host's documents, as BunScenarioTest's registry reads them
const homeOf = (scenarioDir, key) => {
  const host = key.split('+')[0]
  if (host === 'registry.npmjs.org' || host === '127.0.0.1' || host === 'localhost') return 'http'
  const labels = host.split('.')
  if (labels.length >= 3 && labels[0] === 'registry') return `http-${labels[1]}`
  return null
}
// the engine resolves, and so asks the registry, only where its replay is to write the lock
const RESOLVES = /^(exact|exact-or|second-install-rejects)\b/
const addHttp = (scenario, cells, review, added) => {
  const dir = path.join(FIXTURES, scenario)
  for (const c of cells) {
    let phase = null
    for (const line of String(read(path.join(c.dir, 'requests.log')) || '').split('\n')) {
      const h = line.match(/^# (\S+)/)
      if (h) {
        phase = h[1]
        continue
      }
      if (!['after', 'again', 'cross', 'cross-again'].includes(phase)) continue
      if (phase === 'after' || phase === 'again') {
        // the edit over the release's own before only: without one it installed from scratch
        if (!c.outcome.after || !RESOLVES.test(c.expect.after || 'exact')) continue
      } else if (!RESOLVES.test(c.expect.cross || 'exact')) {
        continue
      }
      const m = line.match(/^GET (https?):\/\/([^/\s]+)(\/\S*) (abbreviated|full) (.*)$/)
      if (!m) continue
      const how = m[5]
      if (/^recorded/.test(how) || how === 'absent') continue
      if (how === 'as-of') {
        review.push(`${scenario}: ${c.release} ${phase} was served the full packument of ${m[3]} (as-of)`)
        continue
      }
      const key = m[2].replace(/:(\d+)$/, '+$1')
      const home = homeOf(dir, key)
      const name = decodeURIComponent(m[3].split('?')[0].slice(1))
      if (!home) {
        review.push(`${scenario}: ${c.release} ${phase} asked ${m[2]} for ${name}, which no http directory holds`)
        continue
      }
      const file = m[4] === 'full' ? `${name}@full` : name
      const own = path.join(dir, home, file)
      // the replay's registry reads a mirror's own directory where the scenario has one, and http/ after it
      const recorded = [own, path.join(dir, 'http', file)]
      if (home !== 'http') recorded.push(path.join(dir, home, file.replace('/', '%2f')))
      if (recorded.some(f => fs.existsSync(f)) || added.has(own)) continue
      const kept = path.join(SWEEP, '_overlay', NAMESPACE, scenario, key, file)
      if (!fs.existsSync(kept)) {
        review.push(`${scenario}: ${c.release} ${phase} was served ${file} (${how}) but the sweep keeps no copy`)
        continue
      }
      write(own, fs.readFileSync(kept))
      added.set(own, `${m[4]} packument (${how.replace(/ \(.*$/, '')}), first asked by ${c.release} ${phase}`)
    }
  }
}

const main = () => {
  const report = []
  const review = []
  const perRelease = Object.fromEntries(master.map(r => [r, { root: 0, other: 0, undecided: 0, missing: 0 }]))
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
    if (!c.count) {
      report.push(`${scenario}  not exported: the control does not count it (${c.verdict || '-'}${(c.varies || []).length ? `; varies in ${c.varies.join(', ')}` : ''})`)
      continue
    }
    const recorded = read(path.join(dir, 'recorded-with')) || ''
    const recordedBy = (recorded.match(/^bun (\d+\.\d+\.\d+)/) || [])[1]
    if (recordedBy !== BASE) {
      report.push(`${scenario}  not exported: recorded with ${recordedBy || '-'}, not ${BASE}`)
      continue
    }
    const baseCell = loadCell(path.join(SWEEP, BASE, scenario))
    if (!baseCell || baseCell.skip) {
      report.push(`${scenario}  not exported: no cell of ${BASE}`)
      continue
    }
    baseCell.release = BASE
    baseCell.outcome = outcomeOf(baseCell)
    const base = baseCell.outcome
    const baseSig = sigOf(base)
    const rootExpect = (read(path.join(dir, 'expect')) || '').trim() || null
    const lockDir = (read(path.join(dir, 'lock-dir')) || '').trim()
    const lockRel = lockDir ? `${lockDir}/bun.lock` : 'bun.lock'
    const groups = new Map()
    const cells = []
    for (const r of master) {
      const cellDir = path.join(SWEEP, r, scenario)
      const cell = fs.existsSync(path.join(cellDir, 'result.json')) ? loadCell(cellDir) : null
      if (!cell || cell.skip) {
        perRelease[r].missing++
        continue
      }
      cell.release = r
      cell.outcome = outcomeOf(cell)
      const why = undecided(r, scenario, cell, baseCell)
      if (why) {
        perRelease[r].undecided++
        report.push(`${scenario}  ${r} not exported: ${why}`)
        continue
      }
      cells.push(cell)
      const sig = sigOf(cell.outcome)
      if (!groups.has(sig)) groups.set(sig, { cell, releases: [] })
      groups.get(sig).releases.push(r)
      perRelease[r][sig === baseSig ? 'root' : 'other']++
    }
    if (!groups.has(baseSig)) {
      report.push(`${scenario}  not exported: the baseline ${BASE} is not among the releases swept`)
      continue
    }
    // a range joins releases only when every release between them was exported and wrote the same outcome
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
    write(path.join(dir, 'releases'), ranges(groups.get(baseSig).releases).join('\n') + '\n')
    exported++
    const day = (recorded.split('\n')[0].match(/, (\d{4}-\d{2}-\d{2})\s*$/) || [])[1]
    for (const [sig, g] of groups) {
      const expects = sig === baseSig ? { after: rootExpect, cross: rootExpect } : {
        after: classify({ o: g.cell.outcome, phase: 'after', base, rootExpect, lockRel }),
        cross: classify({ o: g.cell.outcome, phase: 'cross', base, rootExpect, lockRel }),
      }
      for (const cell of cells) if (sigOf(cell.outcome) === sig) cell.expect = expects
    }
    for (const [sig, g] of groups) {
      if (sig === baseSig) continue
      const o = g.cell.outcome
      const label = g.releases[0]
      const gdir = path.join(dir, 'release', label)
      const spans = ranges(g.releases)
      write(path.join(gdir, 'releases'), spans.join('\n') + '\n')
      const r = g.cell.r
      const exit = ph => r.exits[ph] === undefined ? '-' : r.exits[ph]
      const hung = r.hung || {}
      const at = r.recordedAt || (day ? `${day}T23:59:59Z` : null)
      write(path.join(gdir, 'recorded-with'),
        `bun ${label} (sweep), ${r.command.join(' ')}, frozen registry, ${day || '-'}\n` +
        `before exit=${exit('before')}${hung.before ? ' (never finishes)' : ''}, after exit=${exit('after')}${o.after ? '' : ' (no before: from scratch)'}, ` +
        `again exit=${exit('again')}, cross exit=${exit('cross')}, cross-again exit=${exit('cross-again')}\n` +
        (at ? `edit started ${at}\n` : '') +
        'platform os=darwin cpu=arm64 libc=\n')
      if (o.before && o.before.lock != null) write(path.join(gdir, 'before'), o.before.lock)
      if (o.after && o.after.lock != null) write(path.join(gdir, 'after'), o.after.lock)
      if (o.again && o.again.status === 'lock changed' && o.again.lock != null) write(path.join(gdir, 'after-again'), o.again.lock)
      if (o.cross && o.cross.lock != null) write(path.join(gdir, 'cross'), o.cross.lock)
      if (o.crossAgain && o.crossAgain.status === 'lock changed' && o.crossAgain.lock != null) {
        write(path.join(gdir, 'cross-again'), o.crossAgain.lock)
      }
      const expect = g.cell.expect.after
      const expectCross = g.cell.expect.cross
      if (expect && expect !== 'exact') write(path.join(gdir, 'expect'), expect + '\n')
      if (expectCross && expectCross !== 'exact') write(path.join(gdir, 'expect-cross'), expectCross + '\n')
      for (const ph of ['before', 'after', 'cross']) {
        if (o[ph] && o[ph].exit !== 0) write(path.join(gdir, `bun-${ph}.log`), stable(read(path.join(g.cell.dir, `${ph}.log`))))
      }
      groupsWritten++
      report.push(`${scenario}  release/${label}  [${spans.join(', ')}]  after: ${expect || '-'}  cross: ${expectCross || '-'}`)
    }
    addHttp(scenario, cells, review, added)
  }
  for (const f of added.keys()) created.push(path.relative(repoRoot, f))
  const kinds = {}
  let bytes = 0
  for (const [f, kind] of added) {
    const k = kind.replace(/, first asked by .*$/, '')
    kinds[k] = (kinds[k] || 0) + 1
    if (!DRY) bytes += fs.statSync(f).size
  }
  const lines = [`${exported} scenarios exported, ${groupsWritten} other outcomes; added to http/: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'} (${Math.round(bytes / 1024)} KiB)`, '',
    'release      writes-the-recorded-outcome  writes-another  undecided  not-swept']
  for (const r of master) {
    const p = perRelease[r]
    lines.push(`${r.padEnd(12)} ${String(p.root).padEnd(28)} ${String(p.other).padEnd(15)} ${String(p.undecided).padEnd(10)} ${p.missing}`)
  }
  lines.push('', 'outcomes:', ...report.map(l => '  ' + l))
  if (added.size) lines.push('', 'added to http/:', ...[...added].map(([f, k]) => `  ${path.relative(FIXTURES, f)}  ${k}`))
  if (review.length) lines.push('', 'to review:', ...review.map(l => '  ' + l))
  if (REPORT) fs.writeFileSync(REPORT, lines.join('\n') + '\n')
  if (CREATED_LIST && !DRY) fs.writeFileSync(CREATED_LIST, created.sort().join('\n') + (created.length ? '\n' : ''))
  console.log(lines[0])
  console.log(`${review.length} to review${REPORT ? ` -> ${REPORT}` : ''}`)
}
main()

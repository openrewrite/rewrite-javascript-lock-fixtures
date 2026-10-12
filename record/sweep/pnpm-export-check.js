// Checks an export of the pnpm sweep (sweep-export-pnpm.js) against the fixtures it was made from:
//   - nothing but releases, release/, and the files the created list names differs from the original fixtures;
//   - every releases file names swept releases as node-semver ranges, and no release is in two outcomes of a scenario;
//   - each release/<first>/ is named by the first release of its ranges, holds recorded-with, and its edits say what
//     they end with: the lock (after, cross) or an expect line of a kind the scenario tests know.
// Usage: node pnpm-export-check.js <exported lock/pnpm> <original lock/pnpm> <created list> <sweep dir>
const fs = require('fs')
const path = require('path')

const [exported, original, createdList, sweep] = process.argv.slice(2)
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const swept = fs.readdirSync(sweep).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)
const KINDS = new Set(['exact', 'exact-or', 'not-reproduced', 'pm-fails', 'pm-rejects', 'cannot-know', 'malformed', 'second-install-rejects'])
const problems = []
const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
const walk = (dir, rel = '') => {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r))
    else out.push(r)
  }
  return out
}

// what the export may have written
const created = new Set((read(createdList) || '').split('\n').filter(Boolean).map(l => l.replace(/^lock\/pnpm\//, '')))
for (const f of created) if (!fs.existsSync(path.join(exported, f))) problems.push(`created list names ${f}, which is not there`)
const after = new Set(walk(exported))
const before = new Set(walk(original))
for (const f of before) {
  if (!after.has(f)) problems.push(`removed: ${f}`)
  else if (!fs.readFileSync(path.join(exported, f)).equals(fs.readFileSync(path.join(original, f)))) problems.push(`changed: ${f}`)
}
let outcomeFiles = 0
for (const f of after) {
  if (before.has(f)) continue
  const parts = f.split('/')
  if (parts[1] === 'releases' && parts.length === 2) continue
  if (parts[1] === 'release') {
    outcomeFiles++
    continue
  }
  if (!created.has(f)) problems.push(`added but not in the created list: ${f}`)
}

// the releases files
const rangeReleases = text => {
  const out = []
  for (const line of String(text || '').split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+\.\d+\.\d+)(?: - (\d+\.\d+\.\d+))?$/)
    if (!m) {
      out.push({ bad: line })
      continue
    }
    const [a, b] = [m[1], m[2] || m[1]]
    if (!swept.includes(a) || !swept.includes(b)) out.push({ bad: `${line} (not a swept release)` })
    for (const v of swept) if (cmp(v, a) >= 0 && cmp(v, b) <= 0) out.push({ v })
  }
  return out
}
let scenarios = 0
let groups = 0
const tally = {}
for (const s of fs.readdirSync(exported).filter(n => fs.existsSync(path.join(exported, n, 'releases')))) {
  scenarios++
  const seen = new Map()
  const note = (v, where) => {
    if (seen.has(v)) problems.push(`${s}: ${v} is in ${seen.get(v)} and ${where}`)
    seen.set(v, where)
  }
  for (const x of rangeReleases(read(path.join(exported, s, 'releases')))) {
    if (x.bad) problems.push(`${s}/releases: ${x.bad}`)
    else note(x.v, 'releases')
  }
  const rel = path.join(exported, s, 'release')
  for (const label of fs.existsSync(rel) ? fs.readdirSync(rel) : []) {
    groups++
    const g = path.join(rel, label)
    const list = rangeReleases(read(path.join(g, 'releases')))
    for (const x of list) {
      if (x.bad) problems.push(`${s}/release/${label}/releases: ${x.bad}`)
      else note(x.v, `release/${label}`)
    }
    const first = list.find(x => x.v)
    if (!first || first.v !== label) problems.push(`${s}/release/${label}: named otherwise than its first release (${first && first.v})`)
    if (!fs.existsSync(path.join(g, 'recorded-with'))) problems.push(`${s}/release/${label}: no recorded-with`)
    for (const [lock, expectFile] of [['after', 'expect'], ['cross', 'expect-cross']]) {
      const e = read(path.join(g, expectFile))
      if (e != null) {
        const kind = e.trim().split(/\s+/)[0]
        tally[kind] = (tally[kind] || 0) + 1
        if (!KINDS.has(kind)) problems.push(`${s}/release/${label}/${expectFile}: unknown kind ${kind}`)
        if (kind === 'exact-or' && !KINDS.has(e.trim().split(/\s+/)[1])) problems.push(`${s}/release/${label}/${expectFile}: exact-or ${e.trim().split(/\s+/)[1]}`)
      } else if (!fs.existsSync(path.join(g, lock)) && (lock === 'cross' || fs.existsSync(path.join(g, 'before')))) {
        problems.push(`${s}/release/${label}: no ${lock} and no ${expectFile}`)
      }
    }
  }
}
console.log(`${scenarios} scenarios with releases, ${groups} other outcomes, ${outcomeFiles} files under release/, ${created.size} files added to http/ and http-url/`)
console.log(`expect kinds: ${JSON.stringify(tally)}`)
console.log(`${problems.length} problems`)
for (const p of problems.slice(0, 40)) console.log(`  ${p}`)
process.exitCode = problems.length ? 1 : 0

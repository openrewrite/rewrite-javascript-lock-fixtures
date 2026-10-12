// One cell of the pnpm sweep (a release's run of a scenario, written by sweep-pnpm.js) and the outcome of each of
// its phases as one comparable value: the exit code, the error codes, the lock the phase wrote, the files pnpm
// rewrote beside it (pnpm-workspace.yaml, package.json, .npmrc), the other locks of the project and, for the second
// install, whether the lock changed. A phase in which the release asked for another pnpm's tarball, which the sweep
// refuses, is "hands over to <release>".
// As a module: { PHASES, LOCK_FILE, loadCell(dir), reproduces(cell), tree(dir), read(file) }
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PHASES = ['before', 'after', 'again', 'cross', 'cross-again']
// the lock a phase wrote is kept as before, after, cross; a second install's only when it changed the lock
const LOCK_FILE = { before: 'before', after: 'after', again: 'after-again', cross: 'cross', 'cross-again': 'cross-again' }
// the status of a second install (lock unchanged, lock changed, no lock written)
const statusOf = (r, ph) => ph === 'again' ? r.again : ph === 'cross-again' ? r.crossAgain : undefined

const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
const tree = dir => {
  const found = []
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name)
      else found.push(rel ? `${rel}/${e.name}` : e.name)
    }
  }
  walk(dir, '')
  return found
}

const REFUSED = /\/(?:pnpm|exe[^/\s]*|[a-z0-9]+-[a-z0-9-]+)-(\d+\.\d+\.\d+[^/\s]*)\.tgz: Forbidden - 403/

// What a run's output says went wrong, as one value along the release line: the error codes it names (ERR_PNPM_...,
// Node's ERR_...), else its first error line without the marker a release prints before it (pnpm 11.0 prints
// ` ERROR  message`, 11.2 `[ERROR] message`, pnpm 12 `Error: message`).
const errorsIn = log => {
  const out = [...new Set(log.match(/ERR_[A-Z0-9_]+/g) || [])].sort()
  if (!out.length) {
    const lines = log.split('\n')
    const line = lines.find(l => /^\s*(\[ERROR\]|ERROR\b|Error:)/.test(l)) || lines.find(l => /\bERROR\b/.test(l))
    if (line) out.push(`ERROR: ${line.trim().replace(/^(\[ERROR\]|ERROR|Error:)\s*/, '').replace(/^[×✗✖]\s*/, '').slice(0, 160)}`)
  }
  return out
}

const loadCell = dir => {
  const rj = path.join(dir, 'result.json')
  if (!fs.existsSync(rj)) return null
  const r = JSON.parse(fs.readFileSync(rj, 'utf8'))
  const refused = ((r.pm || {}).refused || []).map(f => (f.match(/-(\d+\.\d+\.\d+[^/]*)\.tgz$/) || [])[1]).filter(Boolean)
  const cell = { r, dir, sig: {}, wrote: {}, over: refused.length ? [...new Set(refused)].sort().join(',') : null }
  if (r.skip) return cell
  // a cross phase that is the after phase has a second install only where the edit wrote a lock (cells swept
  // before the sweep said so itself carry the after phase's second install even when the edit failed)
  if (r.crossFrom && !fs.existsSync(path.join(dir, 'cross'))) delete r.crossAgain
  // the errors are read from the kept logs, so every cell is read the same way whenever it was swept; a cross phase
  // that is the after phase has after's
  r.errors = {}
  for (const ph of Object.keys(r.exits)) {
    if (r.exits[ph] === 'seeded') continue
    const log = read(path.join(dir, `${ph}.log`))
    const errs = log != null ? errorsIn(log) : ph === 'cross' && r.crossFrom ? r.errors.after || [] : []
    if (errs.length) r.errors[ph] = errs
  }
  // an error that names the release itself ("Your current pnpm is v11.27.1") is one error along the release line
  for (const ph of Object.keys(r.errors)) r.errors[ph] = r.errors[ph].map(e => e.split(`v${r.release}`).join('v<this release>').split(r.release).join('<this release>'))
  // the phase in which the registry refused a pnpm tarball, from what it served (requests.log: `# <phase>` then its requests)
  const refusedIn = {}
  if (refused.length) {
    let phase = null
    for (const line of (read(path.join(dir, 'requests.log')) || '').split('\n')) {
      if (line.startsWith('# ')) phase = line.slice(2).replace(/-own$/, '')
      else if (phase && / pm-refused$/.test(line)) refusedIn[phase] = (line.match(/-(\d+\.\d+\.\d+[^/\s]*)\.tgz /) || [])[1] || '?'
    }
    // a cross phase that is the after phase asked for what the after phase asked for
    if (r.crossFrom && refusedIn.after && !refusedIn.cross) refusedIn.cross = refusedIn.after
  }
  for (const ph of PHASES) {
    const exit = r.exits[ph]
    const errors = (r.errors || {})[ph] || []
    const asked = refusedIn[ph] || errors.map(x => (x.match(REFUSED) || [])[1]).find(Boolean)
    if (asked) {
      cell.sig[ph] = cell.wrote[ph] = `hands over to ${asked}`
      continue
    }
    // the cross lock that is the after lock got after's second install: its outcome is that one's
    if (ph === 'cross-again' && exit === undefined && r.crossAgain != null) {
      cell.sig[ph] = cell.sig.again
      cell.wrote[ph] = cell.wrote.again
      cell.crossAgainIsAgain = true
      continue
    }
    const changed = tree(path.join(dir, 'changed', ph)).map(f => `${f}=${sha(read(path.join(dir, 'changed', ph, f)))}`).join(',')
    const others = tree(path.join(dir, 'locks', ph)).map(f => `${f}=${sha(read(path.join(dir, 'locks', ph, f)))}`).join(',')
    // what the phase wrote and how it exited, whatever its output says: releases word and code one error differently
    cell.wrote[ph] = [exit === undefined ? '-' : exit, sha(read(path.join(dir, LOCK_FILE[ph]))), changed, others, statusOf(r, ph) || (LOCK_FILE[ph] === ph ? '' : '-')].join('|')
    cell.sig[ph] = `${cell.wrote[ph]}|${errors.join(',')}`
  }
  return cell
}

// the lock a phase of a cell wrote, and the phase whose kept files (changed/, locks/) are that phase's
const phaseOf = (cell, ph) => ph === 'cross-again' && cell.crossAgainIsAgain ? 'again' : ph
const lockText = (cell, ph) => read(path.join(cell.dir, LOCK_FILE[phaseOf(cell, ph)]))

// the release writes the fixture's own locks, exits as the recording did and fails with its errors
const reproduces = cell => !!cell && !cell.r.skip && !cell.r.error && !cell.over &&
  Object.keys(cell.r.same).length > 0 && Object.values(cell.r.same).every(Boolean)

module.exports = { PHASES, LOCK_FILE, statusOf, phaseOf, lockText, errorsIn, loadCell, reproduces, tree, read, sha }

// One cell of the Bun sweep (<out>/<release>/<scenario>/) read back: per phase, whether it ran, its exit, the lock it
// wrote (or the status of a second install), the error lines bun printed, and the other locks of the project.
//   phases  before, after, again, frozen, cold, fresh, beforeAgain, cross, crossAgain
// A phase's signature is what makes two cells' outcomes the same: exit, lock bytes, error lines (and for a second
// install its status and the lock it rewrote to; for lockdir/rundir scenarios every bun.lock of the project).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const read = f => fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
const PHASES = ['before', 'after', 'again', 'frozen', 'cold', 'fresh', 'beforeAgain', 'cross', 'crossAgain']
// the log, lock file and status of each phase in a cell directory
const FILES = {
  before: { log: 'before', lock: 'before' },
  after: { log: 'after', lock: 'after' },
  again: { log: 'again', lock: 'after-again', status: 'again' },
  frozen: { log: 'frozen' },
  cold: { log: 'cold', lock: 'cold', status: 'cold' },
  fresh: { log: 'fresh', lock: 'fresh' },
  beforeAgain: { log: 'before-again', lock: 'before-again-lock', status: 'beforeAgain' },
  cross: { log: 'cross', lock: 'cross' },
  crossAgain: { log: 'cross-again', lock: 'cross-again', status: 'crossAgain' },
}

// every file under <dir>/locks/<phase>/ by path, with its text
const locksOf = (dir, phase) => {
  const root = path.join(dir, 'locks', phase)
  const out = {}
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out[r] = fs.readFileSync(path.join(d, e.name), 'utf8')
    }
  }
  walk(root, '')
  return out
}

const loadCell = dir => {
  const r = JSON.parse(read(path.join(dir, 'result.json')) || 'null')
  if (!r) return null
  if (r.skip) return { r, skip: r.skip }
  const cell = { r, dir, phase: {} }
  for (const ph of PHASES) {
    const f = FILES[ph]
    const exit = r.exits[f.log]
    // a second install over the same lock as after's is after's (cross-again)
    const from = ph === 'crossAgain' && r.crossAgainFrom === 'again' ? 'again' : null
    const src = from ? FILES[from] : f
    const ran = (from ? r.exits[src.log] : exit) !== undefined
    const lock = src.lock ? read(path.join(dir, src.lock)) : null
    const status = f.status ? r[f.status] : null
    // (an error that names the running release, as 1.4's "This is Bun v1.4.0, which supports ...", is the same error)
    const errors = ((r.errors || {})[src.log] || []).map(e => e.replace(/\bBun v\d+\.\d+\.\d+\b/g, 'Bun v<release>'))
    const locks = ph === 'before' || ph === 'after' || ph === 'cross' ? locksOf(dir, ph) : {}
    const extra = ph === 'after' ? (r.locksAfter || []).join('|') : ph === 'cross' ? (r.locksCross || []).join('|') : ''
    const p = { ran, exit: from ? r.exits[src.log] : exit, lock, status, errors, locks, extra, from }
    p.sig = !ran ? 'not run' : [p.exit, status == null ? '' : status, sha(lock), sha(JSON.stringify(errors)),
      sha(JSON.stringify(Object.entries(locks).map(([k, v]) => [k, sha(v)]))), extra].join('|')
    cell.phase[ph] = p
  }
  return cell
}

module.exports = { PHASES, FILES, loadCell, read, sha }

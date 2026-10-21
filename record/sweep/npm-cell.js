// One cell of the npm sweep (a release's run of a scenario, written by sweep-npm.js) and its outcome as one
// comparable value, `sig`: the lock each phase wrote, each phase's exit and error code, and the second installs'.
// Two cells with the same sig are the same outcome to the export.
// As a module: { FILES, read, sha, codeOf, loadCell(dir), cmp }
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const FILES = ['before', 'after', 'after-again', 'cross', 'cross-again']

const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
const sha = s => s == null ? '-' : crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)

const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

const codeOf = log => {
  const m = log && log.match(/^npm (?:ERR!|error) code (\S+)/m)
  return m ? m[1] : null
}

const loadCell = dir => {
  const rj = read(path.join(dir, 'result.json'))
  if (!rj) return null
  const r = JSON.parse(rj)
  if (r.skip || r.error) return { skip: r.skip || r.error }
  const o = { exits: r.exits, again: r.again || null, same: r.same, overlay: r.overlay || [], text: {}, code: {}, log: {} }
  for (const f of FILES) o.text[f] = read(path.join(dir, f))
  for (const ph of ['before', 'after', 'again', 'cross', 'cross-again']) {
    o.log[ph] = read(path.join(dir, `${ph}.log`))
    o.code[ph] = o.exits[ph] ? codeOf(o.log[ph]) : null
  }
  // the second install over `cross`: the one over `after` when the two locks are the same, else its own, and
  // unknown for a cell swept before that phase existed
  o.crossAgain = o.text.cross == null ? null : o.text.cross === o.text.after ? o.again : r.crossAgain || 'unknown'
  o.sig = sha(JSON.stringify([FILES.map(f => sha(o.text[f])),
    ['before', 'after', 'again', 'cross'].map(ph => [o.exits[ph], o.code[ph]]), o.again, o.crossAgain]))
  return o
}

module.exports = { FILES, read, sha, codeOf, loadCell, cmp }

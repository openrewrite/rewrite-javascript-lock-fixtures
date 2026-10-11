// Redacts the recording machine's paths in recorded files, in place: the yarn and Node installs (<yarn>, <node>),
// corepack's home (<corepack>), this repository (<root>), the home directory (<home>), a temporary directory with the
// mktemp directory under it (<tmp>), and any other user's home directory (<home>). Every recorder runs it over what it
// wrote; it is idempotent. A .gz file (not a tarball) is read decompressed and rewritten compressed when it changes.
// Usage: node record/redact-paths.js [--logs-only] [--check] <file or dir>...
const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')

const HOME = os.homedir()
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ROOT = path.resolve(__dirname, '..')
const TMP = (process.env.TMPDIR || os.tmpdir()).replace(/\/+$/, '')
const TMP_BASE = TMP.replace(/^\/private/, '')
const SEG = "[^/\\s'\"`:,;)\\]}]+"
const RULES = [
  [new RegExp(esc(HOME) + '/\\.npm-global/lib/node_modules/yarn', 'g'), '<yarn>'],
  [new RegExp(esc(HOME) + '/\\.nvm/versions/node/v[0-9.]+', 'g'), '<node>'],
  [new RegExp(esc(ROOT) + '/\\.cache/corepack', 'g'), '<corepack>'],
  [/\$COREPACK_HOME/g, '<corepack>'],
  [new RegExp(esc(ROOT) + '/\\.cache/' + SEG, 'g'), '<work>'],
  [new RegExp(esc(ROOT), 'g'), '<root>'],
  [new RegExp('(?:/private)?' + esc(TMP_BASE) + '(?:/' + SEG + ')?', 'g'), '<tmp>'],
  [new RegExp('/private/tmp(?:/' + SEG + ')?', 'g'), '<tmp>'],
  [/<tmp>\/home(?=[/\s'"`:,;)\]}]|$)/gm, '<home>'],
  [new RegExp(esc(HOME) + '(?=[/\\s\'"`:,;)\\]}]|$)', 'gm'), '<home>'],
  [/\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]*(?=\/)/g, '<home>'],
]
const BINARY = /\.(tgz|gz|zip|lockb|png|jpg|jar|class)$/

const args = process.argv.slice(2)
const logsOnly = args.includes('--logs-only')
const check = args.includes('--check')
let changed = 0
function redact(text) {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}
function visit(p) {
  const st = fs.lstatSync(p)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) if (e !== 'node_modules') visit(path.join(p, e))
    return
  }
  if (!st.isFile() || (logsOnly && !p.endsWith('.log'))) return
  if (/\.gz$/.test(p) && !/\.tar\.gz$/.test(p)) {
    let text
    try {
      text = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')
    } catch (e) {
      return
    }
    const out = redact(text)
    if (out !== text) {
      changed++
      if (check) console.log(p)
      else fs.writeFileSync(p, zlib.gzipSync(out, {level: 9}))
    }
    return
  }
  if (BINARY.test(p)) return
  const buf = fs.readFileSync(p)
  if (buf.includes(0)) return
  const text = buf.toString('utf8')
  const out = redact(text)
  if (out !== text) {
    changed++
    if (check) console.log(p)
    else fs.writeFileSync(p, out)
  }
}
for (const a of args.filter(a => !a.startsWith('--'))) if (fs.existsSync(a)) visit(a)
if (check || process.env.REDACT_VERBOSE) console.error(`${changed} file(s) ${check ? 'would change' : 'redacted'}`)

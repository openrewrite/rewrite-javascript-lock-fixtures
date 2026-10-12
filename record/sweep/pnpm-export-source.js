// The code a pnpm release's own source gives an error it prints without one: in the release's bundle
// (dist/pnpm.cjs, dist/pnpm.mjs), the construction of the error whose message the printed one is.
//   new PnpmError("CODE", `message ...`)           the code is PnpmError's first argument
//   const msg = `message ...`; ... new PnpmError("CODE", msg)
//   new SomeError("message ...") where SomeError = class extends PnpmError { constructor (m) { super("CODE", m) } }
//   new Error(...), new TypeError(...)              no code
// A candidate is a string or template literal of the bundle that contains a stretch of the printed message's literal
// text (pnpm quotes the values it puts in a message, and the printed one names this run's paths and versions) and
// whose whole text, its ${...} parts read as anything, is the printed message; of those, the ones with the most literal
// text. Candidates under more than one code, or under a code and as a plain Error, give none. pnpm 12 is a native executable: no source to read.
// As a module: { codesOf(pmDir, release, messages) } -> Map(message -> { code, how } | null)
// Usage: node pnpm-export-source.js <pm/pnpm dir> <release> "<message as printed>" [...]
const fs = require('fs')
const path = require('path')

const bundleOf = (pm, release) => ['pnpm.cjs', 'pnpm.mjs'].map(f => path.join(pm, release, 'package', 'dist', f)).find(f => fs.existsSync(f))

// the literal stretches of a printed message: what is outside quotes, paths and versions
const stretches = message => String(message)
  .split(/"[^"]*"|'[^']*'|<tmp>\S*|<home>\S*|\/\S+|\bv?\d+\.\d+\.\d+\S*|<this release>/)
  .map(s => s.replace(/^[\s.,:;]+/, ''))
  .filter(s => s.trim().length >= 10)
  .sort((a, b) => b.length - a.length)

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// the string or template literal of the bundle around position at: [start of its opening quote, end after its closing
// quote, its parts], a part being literal text or null for a ${...}; null when at is in none
const literalAround = (text, at) => {
  for (let s = at - 1; s >= Math.max(0, at - 400); s--) {
    const q = text[s]
    if (q !== '`' && q !== '"' && q !== "'") continue
    // read the literal forward from s; it must reach past at
    const parts = []
    let lit = ''
    let i = s + 1
    let ok = false
    while (i < text.length && i < s + 2000) {
      const ch = text[i]
      if (ch === '\\') {
        lit += text[i + 1]
        i += 2
        continue
      }
      if (ch === q) {
        ok = true
        break
      }
      if (q === '`' && ch === '$' && text[i + 1] === '{') {
        parts.push(lit)
        lit = ''
        let depth = 1
        i += 2
        while (i < text.length && depth > 0) {
          if (text[i] === '{') depth++
          else if (text[i] === '}') depth--
          i++
        }
        parts.push(null)
        continue
      }
      if (q !== '`' && ch === '\n') break
      lit += ch
      i++
    }
    if (!ok || i <= at) continue
    parts.push(lit)
    return [s, i + 1, parts]
  }
  return null
}

const matches = (parts, message) => new RegExp(`^${parts.map(p => p == null ? '[\\s\\S]*?' : escape(p)).join('')}$`).test(message)

// the code the construction around the literal [start, end) gives it
const codeOf = (text, start, end) => {
  const before = text.slice(Math.max(0, start - 200), start)
  let m = before.match(/new\s+[\w$.]*PnpmError\d*\(\s*["'`]([A-Z0-9_]+)["'`]\s*,\s*$/)
  if (m) return { code: m[1], how: 'new PnpmError(code, message)' }
  m = before.match(/new\s+([\w$.]+)\(\s*$/)
  if (m) {
    const cls = m[1].split('.').pop()
    if (/^(Error|TypeError|RangeError|SyntaxError|ReferenceError)$/.test(cls)) return { code: null, how: `new ${cls}(message)` }
    const def = text.match(new RegExp(`(?:class\\s+${escape(cls)}\\b|\\b${escape(cls)}\\s*=\\s*class)\\s+extends\\s+[\\w$.]*PnpmError\\d*\\s*\\{\\s*constructor\\s*\\([^)]*\\)\\s*\\{\\s*super\\(\\s*["'\`]([A-Z0-9_]+)["'\`]`))
    if (def) return { code: def[1], how: `new ${cls}(message), a PnpmError of that code` }
    return undefined
  }
  // a message assigned to a name, thrown under it before the name is assigned again
  m = before.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*$/)
  if (m) {
    const after = text.slice(end, end + 3000)
    const reassigned = after.search(new RegExp(`(?:const|let|var)\\s+${escape(m[1])}\\s*=`))
    const scope = reassigned < 0 ? after : after.slice(0, reassigned)
    const use = scope.match(new RegExp(`new\\s+[\\w$.]*PnpmError\\d*\\(\\s*["'\`]([A-Z0-9_]+)["'\`]\\s*,\\s*${escape(m[1])}\\b`))
    if (use) return { code: use[1], how: 'new PnpmError(code, a message assigned before)' }
    const plain = scope.match(new RegExp(`new\\s+(Error|TypeError|RangeError)\\(\\s*${escape(m[1])}\\b`))
    if (plain) return { code: null, how: `new ${plain[1]}(a message assigned before)` }
  }
  return undefined
}

const codesOf = (pm, release, messages) => {
  const out = new Map()
  const bundle = bundleOf(pm, release)
  const text = bundle ? fs.readFileSync(bundle, 'utf8') : null
  for (const message of messages) {
    if (!text) {
      out.set(message, null)
      continue
    }
    const found = new Map()
    for (const stretch of stretches(message)) {
      // the stretch's start, shorter until it is found: a variable part may follow anywhere in it
      for (const n of [40, 28, 20, 12].filter(k => k <= stretch.length)) {
        const probe = stretch.slice(0, n)
        let at = -1
        let hits = 0
        while ((at = text.indexOf(probe, at + 1)) >= 0 && hits < 50) {
          hits++
          const lit = literalAround(text, at)
          if (!lit || found.has(lit[0]) || !matches(lit[2], message)) continue
          const r = codeOf(text, lit[0], lit[1])
          if (r !== undefined) found.set(lit[0], { ...r, literal: lit[2].filter(p => p != null).join('').length })
        }
        if (hits) break
      }
    }
    // the most literal of the templates that read as the message: `use ${name}` reads as any message that starts so
    const most = Math.max(0, ...[...found.values()].map(r => r.literal))
    const best = [...found.values()].filter(r => r.literal === most)
    const codes = new Set(best.map(r => r.code))
    out.set(message, codes.size === 1 ? best[0]
      : codes.size > 1 ? { code: null, how: `found as ${[...codes].map(c => c || 'a plain Error').join(' and ')}` } : null)
  }
  return out
}

module.exports = { codesOf, bundleOf }

if (require.main === module) {
  const [pm, release, ...messages] = process.argv.slice(2)
  for (const [m, r] of codesOf(pm, release, messages)) console.log(`${release}: "${m}": ${r ? `${r.code ? `ERR_PNPM_${r.code}` : 'no code'} (${r.how})` : 'not found'}`)
}

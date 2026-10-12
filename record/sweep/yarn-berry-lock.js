// Reads a Yarn Berry yarn.lock into its own structure and says what differs between two of them, in the lock's terms:
// the __metadata block (version, cacheKey), then the entries, each identified by its resolution, with the fields
// that differ. A checksum is "<cache key>/<hash>" in a lock of version 8 and later and a bare hash before, where the
// cache key is __metadata.cacheKey; the two parts are compared separately, because the cache key follows the release
// and its compression setting while the hash is the archive's content.
//
//   parse(text)            -> { metadata, entries: Map(resolution -> { key, descriptors, fields }), order, raw } | null
//   diff(aText, bText)     -> { kind, metadata: [...], entries: [...], notes: [...] }   concrete changes
//   signature(diffResult)  -> [strings]   the same changes with package names and versions generalized, for grouping
const unquote = s => {
  s = s.trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s)
    } catch (e) {
      return s.slice(1, -1)
    }
  }
  return s
}

// the block-mapping subset Yarn's syml writes: `key: value`, `key:` with an indented mapping, `? long key` / `:`
const parseSyml = text => {
  const root = {}
  const stack = [{ indent: -1, obj: root }]
  let pendingKey = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    let content = line.trim()
    let key
    let val
    if (content.startsWith('? ')) {
      pendingKey = { indent, key: unquote(content.slice(2)) }
      continue
    }
    if (pendingKey && content[0] === ':') {
      key = pendingKey.key
      val = content.slice(1).trim()
      pendingKey = null
    } else {
      const m = content.match(/^("(?:[^"\\]|\\.)*"|[^:]+):(?:\s+(.*))?$/)
      if (!m) throw new Error(`not a mapping line: ${content.slice(0, 80)}`)
      key = unquote(m[1])
      val = m[2] === undefined ? '' : m[2]
    }
    while (stack[stack.length - 1].indent >= indent) stack.pop()
    const top = stack[stack.length - 1].obj
    if (val === '') {
      const obj = {}
      top[key] = obj
      stack.push({ indent, obj })
    } else {
      top[key] = unquote(val)
    }
  }
  return root
}

const parse = text => {
  if (text == null) return null
  let doc
  try {
    doc = parseSyml(String(text))
  } catch (e) {
    return null
  }
  const metadata = doc.__metadata && typeof doc.__metadata === 'object' ? doc.__metadata : null
  const entries = new Map()
  const order = []
  for (const [key, fields] of Object.entries(doc)) {
    if (key === '__metadata') continue
    if (!fields || typeof fields !== 'object' || typeof fields.resolution !== 'string') return null
    entries.set(fields.resolution, { key, descriptors: key.split(/ *, */), fields })
    order.push(fields.resolution)
  }
  if (!metadata && !entries.size) return null
  return { metadata, entries, order }
}

// "<cache key>/<hash>" or a bare hash under the lock's cacheKey
const checksumParts = (value, metadata) => {
  if (typeof value !== 'string') return { key: null, hash: null }
  const at = value.indexOf('/')
  return at < 0 ? { key: metadata && metadata.cacheKey !== undefined ? String(metadata.cacheKey) : null, hash: value, bare: true }
    : { key: value.slice(0, at), hash: value.slice(at + 1), bare: false }
}

// what kind of package a resolution names, for the generalized signature
const protocolOf = resolution => {
  const at = resolution.indexOf('@', 1)
  const ref = at < 0 ? resolution : resolution.slice(at + 1)
  const m = ref.match(/^([a-z+]+):/)
  if (!m) return 'npm'
  if (/^https?$/.test(m[1])) return /\.git(#|$)/.test(ref) ? 'git' : 'url'
  return m[1]
}
const hasBinding = resolution => /::/.test(resolution) ? `+${[...resolution.split('::')[1].matchAll(/(?:^|&)([^=&]+)=/g)].map(m => m[1]).join('+')}` : ''

const flat = (v, prefix = '') => {
  const out = {}
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) Object.assign(out, flat(x, prefix ? `${prefix}.${k}` : k))
  else out[prefix] = v
  return out
}

const diff = (aText, bText) => {
  if (aText == null && bText == null) return { kind: 'both absent', metadata: [], entries: [], notes: [] }
  if (aText == null) return { kind: 'lock appears', metadata: [], entries: [], notes: [] }
  if (bText == null) return { kind: 'lock disappears', metadata: [], entries: [], notes: [] }
  if (String(aText) === String(bText)) return { kind: 'identical', metadata: [], entries: [], notes: [] }
  const a = parse(aText)
  const b = parse(bText)
  if (!a || !b) return { kind: 'unparseable', metadata: [], entries: [], notes: [!a && !b ? 'neither lock parses' : !a ? 'the first lock does not parse' : 'the second lock does not parse'] }
  const out = { kind: 'changed', metadata: [], entries: [], notes: [] }
  const am = a.metadata || {}
  const bm = b.metadata || {}
  for (const k of new Set([...Object.keys(am), ...Object.keys(bm)])) {
    if (String(am[k]) !== String(bm[k])) out.metadata.push({ field: k, from: am[k] === undefined ? null : String(am[k]), to: bm[k] === undefined ? null : String(bm[k]) })
  }
  for (const res of new Set([...a.order, ...b.order])) {
    const ea = a.entries.get(res)
    const eb = b.entries.get(res)
    if (!ea) {
      out.entries.push({ resolution: res, change: 'added', key: eb.key })
      continue
    }
    if (!eb) {
      out.entries.push({ resolution: res, change: 'removed', key: ea.key })
      continue
    }
    const fields = []
    const da = [...ea.descriptors].sort()
    const db = [...eb.descriptors].sort()
    if (JSON.stringify(da) !== JSON.stringify(db)) {
      fields.push({ field: 'key', gained: db.filter(d => !da.includes(d)), lost: da.filter(d => !db.includes(d)) })
    } else if (ea.key !== eb.key) {
      fields.push({ field: 'key', reordered: true })
    }
    const fa = flat(ea.fields)
    const fb = flat(eb.fields)
    for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (f === 'checksum') {
        const ca = checksumParts(fa[f], a.metadata)
        const cb = checksumParts(fb[f], b.metadata)
        if (fa[f] === undefined) fields.push({ field: 'checksum', from: null, to: fb[f], what: 'appears' })
        else if (fb[f] === undefined) fields.push({ field: 'checksum', from: fa[f], to: null, what: 'disappears' })
        else if (ca.hash !== cb.hash) fields.push({ field: 'checksum', from: fa[f], to: fb[f], what: ca.key === cb.key ? 'hash' : `hash and cache key ${ca.key}->${cb.key}` })
        else if (ca.key !== cb.key) fields.push({ field: 'checksum', from: fa[f], to: fb[f], what: `cache key ${ca.key}->${cb.key}` })
        else if (fa[f] !== fb[f]) fields.push({ field: 'checksum', from: fa[f], to: fb[f], what: ca.bare ? 'cache key prefix written' : 'cache key prefix dropped' })
        continue
      }
      if (fa[f] !== fb[f]) fields.push({ field: f, from: fa[f] === undefined ? null : fa[f], to: fb[f] === undefined ? null : fb[f] })
    }
    if (JSON.stringify(Object.keys(fa).filter(k => k in fb)) !== JSON.stringify(Object.keys(fb).filter(k => k in fa))) fields.push({ field: '(field order)' })
    if (fields.length) out.entries.push({ resolution: res, change: 'changed', fields })
  }
  const common = x => x.order.filter(r => a.entries.has(r) && b.entries.has(r))
  if (JSON.stringify(common(a)) !== JSON.stringify(common(b))) out.notes.push('entry order')
  if (!out.metadata.length && !out.entries.length && !out.notes.length) out.notes.push('formatting only (the parsed lock is the same)')
  return out
}

// only the metadata block differs, or nothing but checksum cache keys follows from it
const scope = d => {
  if (d.kind !== 'changed') return d.kind
  const entryChanges = d.entries.flatMap(e => e.change === 'changed' ? e.fields.map(f => f.field === 'checksum' ? `checksum ${f.what.replace(/\S+->\S+/, '').trim()}` : f.field) : [e.change])
  if (!entryChanges.length && !d.notes.length) return 'metadata only'
  if (!entryChanges.length) return d.metadata.length ? 'metadata and layout' : 'layout only'
  if (entryChanges.every(c => c === 'checksum cache key' || c === 'checksum cache key prefix written' || c === 'checksum cache key prefix dropped')) return d.metadata.length ? 'metadata and checksum cache keys' : 'checksum cache keys'
  return 'entries'
}

const signature = d => {
  if (d.kind !== 'changed') return [d.kind]
  const out = new Set()
  for (const m of d.metadata) out.add(`__metadata.${m.field}: ${m.from}->${m.to}`)
  for (const e of d.entries) {
    const kind = `<${protocolOf(e.resolution)}${hasBinding(e.resolution)}>`
    if (e.change !== 'changed') {
      out.add(`entry ${kind}: ${e.change}`)
      continue
    }
    for (const f of e.fields) {
      if (f.field === 'key') out.add(`entry ${kind} key: ${f.reordered ? 'descriptor order' : `${f.gained.length ? 'gains' : ''}${f.gained.length && f.lost.length ? ' and ' : ''}${f.lost.length ? 'loses' : ''} a descriptor`}`)
      else if (f.field === 'checksum') out.add(`entry ${kind} checksum: ${f.what}`)
      else if (f.field === '(field order)') out.add(`entry ${kind}: field order`)
      else {
        const top = f.field.split('.')[0]
        const nested = f.field.includes('.')
        out.add(`entry ${kind} ${top}${nested ? '.<name>' : ''}: ${f.from === null ? 'appears' : f.to === null ? 'disappears' : 'changed'}`)
      }
    }
  }
  for (const n of d.notes) out.add(n)
  return [...out].sort()
}

// the concrete changes, one line each
const describe = d => {
  if (d.kind !== 'changed') return [d.kind, ...d.notes]
  const out = []
  for (const m of d.metadata) out.push(`__metadata.${m.field}: ${m.from} -> ${m.to}`)
  for (const e of d.entries) {
    if (e.change !== 'changed') {
      out.push(`${e.change}: ${e.resolution}   (key ${e.key})`)
      continue
    }
    for (const f of e.fields) {
      if (f.field === 'key') out.push(`${e.resolution} key: ${f.reordered ? 'descriptor order' : `${f.gained.length ? '+ ' + f.gained.join(', ') : ''}${f.lost.length ? ' - ' + f.lost.join(', ') : ''}`}`)
      else if (f.field === 'checksum') out.push(`${e.resolution} checksum (${f.what}): ${f.from} -> ${f.to}`)
      else if (f.field === '(field order)') out.push(`${e.resolution}: field order`)
      else out.push(`${e.resolution} ${f.field}: ${f.from === null ? '(absent)' : JSON.stringify(f.from)} -> ${f.to === null ? '(absent)' : JSON.stringify(f.to)}`)
    }
  }
  for (const n of d.notes) out.push(n)
  return out
}

module.exports = { parse, diff, signature, describe, scope, checksumParts }

if (require.main === module) {
  const fs = require('fs')
  const [a, b] = process.argv.slice(2)
  const d = diff(fs.readFileSync(a, 'utf8'), b ? fs.readFileSync(b, 'utf8') : null)
  console.log(scope(d))
  console.log(signature(d).join('\n'))
  console.log('--')
  console.log(describe(d).join('\n'))
}

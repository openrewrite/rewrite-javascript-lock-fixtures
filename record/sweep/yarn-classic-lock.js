// Reads a yarn.lock v1 into its own structure, and describes how two locks differ in those terms: header comment
// lines, patterns that appear or disappear, the fields of the entry a pattern resolves to (version, resolved, integrity,
// uid, ...), its dependency maps, how patterns share entries, the order of entries, and formatting. Used by
// sweep-matrix-yarn-classic.js.
const NAME_AT = /^((?:@[^/@]+\/)?[^@]+)@/

const unquote = s => {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t)
    } catch (e) {
      return t.slice(1, -1)
    }
  }
  return t
}

// a key line `"a@^1", b@2:` -> ['a@^1', 'b@2'], splitting on commas outside quotes
const splitKey = key => {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < key.length; i++) {
    const c = key[i]
    if (c === '"' && key[i - 1] !== '\\') quoted = !quoted
    if (c === ',' && !quoted) {
      out.push(unquote(cur))
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(unquote(cur))
  return out
}

// `version "1.0.0"` -> ['version', '1.0.0']; `"@a/b" "^1"` -> ['@a/b', '^1']
const splitField = text => {
  const t = text.trim()
  let key
  let rest
  if (t.startsWith('"')) {
    let j = 1
    while (j < t.length && !(t[j] === '"' && t[j - 1] !== '\\')) j++
    key = unquote(t.slice(0, j + 1))
    rest = t.slice(j + 1)
  } else {
    const sp = t.indexOf(' ')
    key = sp < 0 ? t : t.slice(0, sp)
    rest = sp < 0 ? '' : t.slice(sp + 1)
  }
  return [key, unquote(rest)]
}

const parse = text => {
  if (text == null) return null
  const lines = text.split(/\r?\n/)
  const header = []
  const entries = []
  let cur = null
  let map = null
  for (const line of lines) {
    if (/^#/.test(line)) {
      if (!entries.length) header.push(line)
      continue
    }
    if (!line.trim()) continue
    if (!/^\s/.test(line)) {
      if (!line.endsWith(':')) return null
      cur = { key: line.slice(0, -1), patterns: splitKey(line.slice(0, -1)), fields: {}, maps: {} }
      entries.push(cur)
      map = null
      continue
    }
    if (!cur) return null
    const four = line.match(/^ {4}(\S.*)$/)
    const two = line.match(/^ {2}(\S.*)$/)
    if (four && map) {
      const [k, v] = splitField(four[1])
      map[k] = v
    } else if (two) {
      const t = two[1]
      if (t.endsWith(':')) {
        map = cur.maps[unquote(t.slice(0, -1))] = {}
      } else {
        const [k, v] = splitField(t)
        cur.fields[k] = v
        map = null
      }
    } else {
      return null
    }
  }
  return { header, entries, crlf: /\r\n/.test(text) }
}

const nameOf = pattern => {
  const m = pattern.match(NAME_AT)
  return m ? m[1] : pattern
}

const urlParts = u => {
  const m = String(u || '').match(/^(\w+:\/\/[^/]+)(\/[^#]*)?(?:#(.*))?$/)
  return m ? { origin: m[1], path: m[2] || '', hash: m[3] || '' } : { origin: '', path: String(u || ''), hash: '' }
}

// -> { kinds: [general descriptions], detail: [concrete changes] }
const diff = (aText, bText) => {
  if (aText === bText) return { kinds: [], detail: [] }
  if (aText == null) return { kinds: ['lock now written'], detail: [] }
  if (bText == null) return { kinds: ['lock no longer written'], detail: [] }
  const A = parse(aText)
  const B = parse(bText)
  if (!A || !B) return { kinds: [`${!A ? 'from' : 'to'} lock not in yarn.lock v1 syntax`], detail: [] }
  const kinds = new Set()
  const detail = []
  if (A.header.join('\n') !== B.header.join('\n')) {
    const gone = A.header.filter(l => !B.header.includes(l))
    const added = B.header.filter(l => !A.header.includes(l))
    const gen = l => l.replace(/v?\d+\.\d+\.\d+/g, '<version>')
    const onlyVersions = gone.length === added.length && gone.every((l, i) => gen(l) === gen(added[i]))
    kinds.add(onlyVersions ? `header: ${[...new Set(added.map(gen))].join(' / ')} names another version` : `header: ${gone.length ? `-${gone.map(gen).join(' -')}` : ''}${added.length ? ` +${added.map(gen).join(' +')}` : ''}`.trim())
    for (const l of gone) detail.push(`header - ${l}`)
    for (const l of added) detail.push(`header + ${l}`)
  }
  if (A.crlf !== B.crlf) kinds.add(`line ends ${A.crlf ? 'CRLF' : 'LF'} -> ${B.crlf ? 'CRLF' : 'LF'}`)
  const byPattern = L => {
    const m = new Map()
    for (const e of L.entries) for (const p of e.patterns) m.set(p, e)
    return m
  }
  const pa = byPattern(A)
  const pb = byPattern(B)
  for (const p of pa.keys()) {
    if (!pb.has(p)) {
      kinds.add('pattern no longer locked')
      detail.push(`- ${p} (${pa.get(p).fields.version || '?'})`)
    }
  }
  for (const p of pb.keys()) {
    if (!pa.has(p)) {
      kinds.add('pattern newly locked')
      detail.push(`+ ${p} (${pb.get(p).fields.version || '?'})`)
    }
  }
  const seen = new Set()
  for (const [p, ea] of pa) {
    const eb = pb.get(p)
    if (!eb || seen.has(ea)) continue
    seen.add(ea)
    if (ea.patterns.slice().sort().join('\0') !== eb.patterns.slice().sort().join('\0')) {
      kinds.add('patterns share entries otherwise')
      detail.push(`~ ${ea.key} -> ${eb.key}`)
    } else if (ea.key !== eb.key) {
      kinds.add('entry key spelled otherwise')
      detail.push(`~ key ${ea.key} -> ${eb.key}`)
    }
    for (const f of new Set([...Object.keys(ea.fields), ...Object.keys(eb.fields)])) {
      const [x, y] = [ea.fields[f], eb.fields[f]]
      if (x === y) continue
      if (x === undefined) kinds.add(`${f} added`)
      else if (y === undefined) kinds.add(`${f} removed`)
      else if (f === 'resolved') {
        const [u, v] = [urlParts(x), urlParts(y)]
        if (u.origin !== v.origin) kinds.add(`resolved host ${u.origin.replace(/^\w+:\/\//, '')} -> ${v.origin.replace(/^\w+:\/\//, '')}`)
        if (u.path !== v.path) kinds.add('resolved path changed')
        if (u.hash !== v.hash) kinds.add(!u.hash ? 'resolved #hash added' : !v.hash ? 'resolved #hash removed' : 'resolved #hash changed')
      } else if (f === 'integrity') {
        const algos = s => s.split(/\s+/).map(t => t.split('-')[0]).join('+')
        kinds.add(algos(x) !== algos(y) ? `integrity ${algos(x)} -> ${algos(y)}` : 'integrity changed')
      } else kinds.add(`${f} changed`)
      detail.push(`${ea.key}: ${f} ${x === undefined ? '(none)' : JSON.stringify(x)} -> ${y === undefined ? '(none)' : JSON.stringify(y)}`)
    }
    for (const mname of new Set([...Object.keys(ea.maps), ...Object.keys(eb.maps)])) {
      const [x, y] = [ea.maps[mname] || {}, eb.maps[mname] || {}]
      for (const dep of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (x[dep] === y[dep]) continue
        if (x[dep] === undefined) kinds.add(`${mname}: a dependency added`)
        else if (y[dep] === undefined) kinds.add(`${mname}: a dependency removed`)
        else kinds.add(`${mname}: a range changed`)
        detail.push(`${ea.key}: ${mname}.${dep} ${x[dep] === undefined ? '(none)' : JSON.stringify(x[dep])} -> ${y[dep] === undefined ? '(none)' : JSON.stringify(y[dep])}`)
      }
      if (JSON.stringify(Object.keys(x).filter(k => k in y)) !== JSON.stringify(Object.keys(y).filter(k => k in x))) kinds.add(`${mname}: order`)
    }
  }
  const order = L => L.entries.map(e => e.patterns.slice().sort().join(', '))
  const common = (xs, ys) => xs.filter(k => ys.includes(k))
  if (JSON.stringify(common(order(A), order(B))) !== JSON.stringify(common(order(B), order(A)))) kinds.add('entry order')
  if (!kinds.size) kinds.add('formatting only')
  return { kinds: [...kinds].sort(), detail }
}

module.exports = { parse, diff, nameOf }

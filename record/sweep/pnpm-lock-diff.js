// Reads pnpm's YAML (pnpm-lock.yaml with its optional env document, pnpm-workspace.yaml) as pnpm writes it and says
// what differs between two of them by the file's own structure: which documents, top-level keys, importers,
// packages and snapshots entries appear, disappear or change, and in which fields. Scalars are kept as written.
// As a module: { parse, diff, describe }.  As a command: node pnpm-lock-diff.js <a> <b> [--general]
const fs = require('fs')

// ---- a reader for the YAML pnpm writes: block mappings and sequences, flow collections on one line, block scalars

const splitKey = text => {
  // returns [key, rest] for `key: rest` or `key:`; null when the line is no mapping entry
  if (text[0] === "'" || text[0] === '"') {
    const q = text[0]
    let i = 1
    let key = ''
    for (; i < text.length; i++) {
      if (text[i] === q) {
        if (q === "'" && text[i + 1] === "'") {
          key += "'"
          i++
          continue
        }
        break
      }
      if (q === '"' && text[i] === '\\') {
        key += text[i + 1]
        i++
        continue
      }
      key += text[i]
    }
    const after = text.slice(i + 1)
    if (after === ':') return [key, '']
    if (after.startsWith(': ')) return [key, after.slice(2).trim()]
    return null
  }
  if (text.endsWith(':') && !text.includes(': ')) return [text.slice(0, -1), '']
  const at = text.indexOf(': ')
  if (at < 0) return null
  return [text.slice(0, at), text.slice(at + 2).trim()]
}

// `{a: b, c: 'd, e'}` and `[a, b]` on one line; anything it cannot read stays the string it is
const parseFlow = text => {
  let i = 0
  const ws = () => {
    while (text[i] === ' ') i++
  }
  const scalar = stops => {
    ws()
    if (text[i] === "'" || text[i] === '"') {
      const q = text[i]
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === q) {
          if (q === "'" && text[j + 1] === "'") {
            j++
            continue
          }
          break
        }
        if (q === '"' && text[j] === '\\') j++
      }
      const out = text.slice(i, j + 1)
      i = j + 1
      return out
    }
    let j = i
    while (j < text.length && !stops.includes(text[j]) && !(text[j] === ':' && text[j + 1] === ' ' && stops.includes(':'))) j++
    const out = text.slice(i, j).trim()
    i = j
    return out
  }
  const value = () => {
    ws()
    if (text[i] === '{') {
      i++
      const map = new Map()
      for (;;) {
        ws()
        if (text[i] === '}') {
          i++
          return map
        }
        const key = scalar([':', ',', '}'])
        ws()
        if (text[i] !== ':') throw new Error('flow')
        i++
        map.set(key.replace(/^'(.*)'$/, '$1'), value())
        ws()
        if (text[i] === ',') i++
        else if (text[i] !== '}') throw new Error('flow')
      }
    }
    if (text[i] === '[') {
      i++
      const list = []
      for (;;) {
        ws()
        if (text[i] === ']') {
          i++
          return list
        }
        list.push(value())
        ws()
        if (text[i] === ',') i++
        else if (text[i] !== ']') throw new Error('flow')
      }
    }
    return scalar([',', '}', ']'])
  }
  try {
    const v = value()
    ws()
    return i === text.length ? v : text
  } catch (e) {
    return text
  }
}

const parseDoc = text => {
  const lines = []
  for (const raw of text.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), raw })
  }
  const block = (i, indent) => {
    // a sequence
    if (lines[i].text === '-' || lines[i].text.startsWith('- ')) {
      const list = []
      while (i < lines.length && lines[i].indent === indent && (lines[i].text === '-' || lines[i].text.startsWith('- '))) {
        let item = lines[i].text.slice(1).trim()
        i++
        while (i < lines.length && lines[i].indent > indent) item += '\n' + lines[i++].text
        list.push(item)
      }
      return [list, i]
    }
    const map = new Map()
    while (i < lines.length && lines[i].indent === indent) {
      const kv = splitKey(lines[i].text)
      if (!kv) {
        // not a mapping entry: keep the text under a key of its own, so it still shows in a diff
        map.set(`<line ${lines[i].text}>`, '')
        i++
        continue
      }
      const [key, rest] = kv
      i++
      if (rest === '') {
        if (i < lines.length && (lines[i].indent > indent || lines[i].indent === indent && lines[i].text.startsWith('- '))) {
          const [v, next] = block(i, lines[i].indent)
          map.set(key, v)
          i = next
        } else {
          map.set(key, '')
        }
      } else if (/^[|>][+-]?\d*$/.test(rest)) {
        let scalar = rest
        while (i < lines.length && lines[i].indent > indent) scalar += '\n' + lines[i++].raw
        map.set(key, scalar)
      } else {
        map.set(key, rest[0] === '{' || rest[0] === '[' ? parseFlow(rest) : rest)
      }
    }
    return [map, i]
  }
  if (!lines.length) return new Map()
  const [doc, end] = block(0, lines[0].indent)
  if (end < lines.length && doc instanceof Map) doc.set('<unread>', lines.slice(end).map(l => l.raw).join('\n'))
  return doc
}

// a pnpm-lock.yaml: its env document (package manager and config dependencies) when it has one, and the lock
const parse = text => {
  const docs = text.split(/^---[ \t]*$/m).filter(d => d.trim()).map(parseDoc)
  return docs.length > 1 ? { env: docs[0], lock: docs[docs.length - 1], documents: docs.length } : { env: null, lock: docs[0] || new Map(), documents: docs.length }
}

// ---- what differs

const isMap = v => v instanceof Map
const same = (x, y) => {
  if (isMap(x) && isMap(y)) return x.size === y.size && [...x].every(([k, v], n) => [...y.keys()][n] === k && same(v, y.get(k)))
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, n) => same(v, y[n]))
  return x === y
}
const kind = v => v === undefined ? 'absent' : isMap(v) ? 'mapping' : Array.isArray(v) ? 'list' : 'scalar'

// name@version of a packages or snapshots key, and its peer suffix
const splitDepPath = key => {
  const at = key.indexOf('(')
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at)]
}
const kindOfDepPath = key => {
  const [base, suffix] = splitDepPath(key)
  const version = base.slice(base.lastIndexOf('@') + 1)
  const exotic = /^(https?:|git|file:|link:|github:|runtime:)/.test(version) || base.includes('@file:') || base.includes('@https:') || base.includes('@git')
  return `<pkg${exotic ? '@url' : ''}${suffix ? '(peers)' : ''}>`
}

// every difference as { path: concrete, general: with names replaced, what }
const diffValues = (x, y, path, general, out, section) => {
  if (same(x, y)) return
  if (!isMap(x) || !isMap(y)) {
    let what = kind(x) === kind(y) ? 'changed' : `${kind(x)} -> ${kind(y)}`
    if (typeof x === 'string' && typeof y === 'string') {
      const [bx, sx] = splitDepPath(x)
      const [by, sy] = splitDepPath(y)
      if (bx === by && sx !== sy) what = !sx ? 'gains a peer suffix' : !sy ? 'loses its peer suffix' : 'peer suffix changes'
      else if (/lockfileVersion$/.test(general)) what = `${x} -> ${y}`
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const added = y.filter(v => !x.includes(v)).length
      const removed = x.filter(v => !y.includes(v)).length
      what = added || removed ? `list ${added ? `+${added}` : ''}${removed ? `-${removed}` : ''}` : 'list order'
    }
    out.push({ path, general, what, from: x, to: y })
    return
  }
  const kx = [...x.keys()]
  const ky = [...y.keys()]
  if (JSON.stringify(kx.filter(k => y.has(k))) !== JSON.stringify(ky.filter(k => x.has(k)))) {
    out.push({ path: path || '<top>', general: general || '<top>', what: 'key order' })
  }
  for (const k of new Set([...kx, ...ky])) {
    const g = generalKey(section, path, k)
    const sub = path ? `${path} > ${k}` : k
    const gsub = general ? `${general}.${g}` : g
    if (!x.has(k)) out.push({ path: sub, general: gsub, what: 'added', to: y.get(k) })
    else if (!y.has(k)) out.push({ path: sub, general: gsub, what: 'removed', from: x.get(k) })
    else diffValues(x.get(k), y.get(k), sub, gsub, out, section || k)
  }
}

const DEP_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'packageManagerDependencies', 'configDependencies', 'dependenciesMeta', 'publishDirectory'])
const generalKey = (section, path, k) => {
  const depth = path ? path.split(' > ').length : 0
  const parent = path ? path.split(' > ').pop() : ''
  if (depth === 1 && section === 'importers') return k === '.' ? '<root>' : '<member>'
  if (depth === 1 && (section === 'packages' || section === 'snapshots')) return kindOfDepPath(k)
  if (depth === 1 && section === 'catalogs') return k === 'default' ? 'default' : '<catalog>'
  if (depth === 1 && (section === 'overrides' || section === 'patchedDependencies' || section === 'time')) return '<name>'
  if (depth === 2 && section === 'catalogs') return '<dep>'
  if (DEP_FIELDS.has(parent)) return '<dep>'
  return k
}

// the differences of two files' texts; `general` groups scenarios, `detail` names the entries
const diff = (aText, bText) => {
  if (aText == null && bText == null) return { general: ['both absent'], detail: [] }
  if (aText == null) return { general: ['file appears'], detail: [] }
  if (bText == null) return { general: ['file disappears'], detail: [] }
  const a = parse(aText)
  const b = parse(bText)
  const out = []
  if (!!a.env !== !!b.env) out.push({ path: '<env document>', general: '<env document>', what: a.env ? 'removed' : 'added' })
  else if (a.env && b.env) diffValues(a.env, b.env, '<env document>', '<env>', out, null)
  diffValues(a.lock, b.lock, '', '', out, null)
  // an entry that disappears while one of the same name@version appears is one entry whose peer suffix changed
  const pairs = []
  for (const section of ['snapshots', 'packages']) {
    const removed = out.filter(d => d.what === 'removed' && d.path.startsWith(`${section} > `))
    const added = out.filter(d => d.what === 'added' && d.path.startsWith(`${section} > `))
    for (const r of removed) {
      const [base, suffix] = splitDepPath(r.path.slice(section.length + 3))
      const twin = added.find(d => !d.paired && splitDepPath(d.path.slice(section.length + 3))[0] === base)
      if (!twin) continue
      const twinSuffix = splitDepPath(twin.path.slice(section.length + 3))[1]
      r.paired = twin.paired = true
      pairs.push({
        path: `${section} > ${base}`, general: `${section}.<pkg>`,
        what: !suffix ? 'entry gains a peer suffix' : !twinSuffix ? 'entry loses its peer suffix' : 'entry peer suffix changes',
        from: suffix || '(none)', to: twinSuffix || '(none)',
      })
    }
  }
  const all = [...out.filter(d => !d.paired), ...pairs]
  if (!all.length) return { general: [aText === bText ? 'identical' : 'formatting only (same entries and values)'], detail: [] }
  const show = v => v === undefined ? '' : typeof v === 'string' ? v : isMap(v) ? `{${[...v.keys()].slice(0, 4).join(', ')}${v.size > 4 ? ', ...' : ''}}` : JSON.stringify(v)
  return {
    general: [...new Set(all.map(d => `${d.general}: ${d.what}`))].sort(),
    detail: all.map(d => `${d.path}: ${d.what}${d.from !== undefined && d.to !== undefined && typeof d.from === 'string' && typeof d.to === 'string' ? ` (${show(d.from)} -> ${show(d.to)})` : ''}`),
  }
}

module.exports = { parse, parseDoc, diff, splitDepPath }

if (require.main === module) {
  const [a, b] = process.argv.slice(2)
  const d = diff(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'))
  console.log(d.general.join('\n'))
  if (!process.argv.includes('--general')) console.log('\n' + d.detail.join('\n'))
}

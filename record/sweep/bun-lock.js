// bun.lock, read for comparing what two releases wrote: JSON with trailing commas (bun.lock.zig's writer). A difference
// is described in the lock's own structure:
//   header      lockfileVersion, configVersion (their values)
//   workspaces  by location ("" the root, else the member's path): fields added, removed or changed
//   packages    by key (a hoisted name, or a nested path "parent/name"): entries added or removed, and for an entry the
//               tuple's parts (npm: [id, registry, info, integrity]; workspace: [id] or [id, info]; git and github:
//               [id, info, tag, integrity]; tarball and folder: [id, info, (integrity)]), info by field
//   overrides, catalog, catalogs, trustedDependencies, patchedDependencies   by key
//   text        the same document written otherwise: another order of keys, or another layout
// signature() generalizes names and versions away (what kind of change), describe() keeps them (which change).
const parse = text => {
  if (text == null) return null
  try {
    // bun.lock's writer puts a trailing comma after every member; comments are not written but are read
    return JSON.parse(text.replace(/^\s*\/\/.*$/mg, '').replace(/,(\s*[}\]])/g, '$1'))
  } catch (e) {
    return undefined
  }
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const json = v => JSON.stringify(v)
const short = v => {
  const s = typeof v === 'string' ? v : json(v)
  return s.length > 90 ? `${s.slice(0, 87)}...` : s
}
// the kind of package a tuple is, from its id (name@<resolution>)
const tupleKind = t => {
  if (!Array.isArray(t) || typeof t[0] !== 'string') return 'other'
  const res = t[0].slice(t[0].lastIndexOf('@', t[0].length - 1) > 0 ? t[0].indexOf('@', 1) + 1 : 0)
  if (/^workspace:/.test(res)) return 'workspace'
  if (/^(github:|git\+|git:)/.test(res)) return 'git'
  if (/^(file:|link:)/.test(res)) return 'folder'
  if (/^https?:/.test(res)) return 'tarball'
  if (/^(root:|module:)/.test(res)) return 'other'
  return 'npm'
}
const PART = { npm: ['id', 'registry', 'info', 'integrity'], workspace: ['id', 'info'], git: ['id', 'info', 'tag', 'integrity'], tarball: ['id', 'info', 'integrity'], folder: ['id', 'info'], other: [] }
const keyKind = k => k.includes('/') && !(k.startsWith('@') && k.split('/').length === 2) ? '<nested>' : '<pkg>'

// a list of { where, change, from, to } between two parsed locks
const diff = (aText, bText) => {
  const out = []
  const a = parse(aText)
  const b = parse(bText)
  if (aText == null && bText == null) return out
  if (aText == null) return [{ where: 'lock', change: 'appears' }]
  if (bText == null) return [{ where: 'lock', change: 'disappears' }]
  if (a === undefined || b === undefined) return [{ where: 'lock', change: a === undefined ? (b === undefined ? 'unparseable both' : 'was unparseable') : 'unparseable' }]
  if (aText === bText) return out
  const add = (where, change, from, to) => out.push({ where, change, from, to })
  const fields = (where, x, y) => {
    x = x || {}
    y = y || {}
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in x)) add(`${where}.${k}`, 'added', undefined, y[k])
      else if (!(k in y)) add(`${where}.${k}`, 'removed', x[k], undefined)
      else if (json(x[k]) !== json(y[k])) {
        if (isObj(x[k]) && isObj(y[k]) && /dependencies|Dependencies|bin|optionalPeers|scripts/.test(k)) {
          for (const d of new Set([...Object.keys(x[k]), ...Object.keys(y[k])])) {
            if (!(d in x[k])) add(`${where}.${k}[]`, 'added', undefined, `${d}: ${y[k][d]}`)
            else if (!(d in y[k])) add(`${where}.${k}[]`, 'removed', `${d}: ${x[k][d]}`, undefined)
            else if (json(x[k][d]) !== json(y[k][d])) add(`${where}.${k}[]`, 'changed', `${d}: ${short(x[k][d])}`, `${d}: ${short(y[k][d])}`)
          }
          if (json(Object.keys(x[k]).filter(d => d in y[k])) !== json(Object.keys(y[k]).filter(d => d in x[k]))) add(`${where}.${k}`, 'key order')
        } else {
          add(`${where}.${k}`, 'changed', x[k], y[k])
        }
      } else if (isObj(x[k]) && isObj(y[k]) && json(Object.keys(x[k])) !== json(Object.keys(y[k]))) {
        add(`${where}.${k}`, 'key order')
      }
    }
    if (json(Object.keys(x).filter(k => k in y)) !== json(Object.keys(y).filter(k => k in x))) add(where, 'key order')
  }
  const top = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of top) {
    if (k === 'lockfileVersion' || k === 'configVersion') {
      if (a[k] !== b[k]) add(k, a[k] === undefined ? 'added' : b[k] === undefined ? 'removed' : 'changed', a[k], b[k])
      continue
    }
    if (!(k in a)) {
      add(k, 'added', undefined, b[k])
      continue
    }
    if (!(k in b)) {
      add(k, 'removed', a[k], undefined)
      continue
    }
    if (json(a[k]) === json(b[k])) continue
    if (k === 'workspaces') {
      for (const loc of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
        const w = `workspaces[${loc === '' ? '<root>' : '<member>'}:${loc}]`
        if (!(loc in a[k])) add(w, 'added', undefined, b[k][loc])
        else if (!(loc in b[k])) add(w, 'removed', a[k][loc], undefined)
        else if (json(a[k][loc]) !== json(b[k][loc])) fields(w, a[k][loc], b[k][loc])
      }
    } else if (k === 'packages') {
      for (const key of new Set([...Object.keys(a[k]), ...Object.keys(b[k])])) {
        const x = a[k][key]
        const y = b[k][key]
        const kind = tupleKind(y || x)
        const w = `packages[${keyKind(key)}:${key}](${kind})`
        if (x === undefined) add(w, 'added', undefined, y)
        else if (y === undefined) add(w, 'removed', x, undefined)
        else if (json(x) !== json(y)) {
          if (!Array.isArray(x) || !Array.isArray(y)) {
            add(w, 'changed', x, y)
            continue
          }
          if (x.length !== y.length) add(`${w}.length`, 'changed', x.length, y.length)
          const names = PART[kind] || []
          for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const part = names[i] || `[${i}]`
            if (json(x[i]) === json(y[i])) {
              if (isObj(x[i]) && isObj(y[i]) && json(Object.keys(x[i])) !== json(Object.keys(y[i]))) add(`${w}.${part}`, 'key order')
              continue
            }
            if (isObj(x[i]) && isObj(y[i])) fields(`${w}.${part}`, x[i], y[i])
            else add(`${w}.${part}`, x[i] === undefined ? 'added' : y[i] === undefined ? 'removed' : 'changed', x[i], y[i])
          }
        } else if (Array.isArray(x)) {
          x.forEach((v, i) => {
            if (isObj(v) && json(Object.keys(v)) !== json(Object.keys(y[i]))) add(`${w}.${(PART[kind] || [])[i] || `[${i}]`}`, 'key order')
          })
        }
      }
      if (json(Object.keys(a[k]).filter(key => key in b[k])) !== json(Object.keys(b[k]).filter(key => key in a[k]))) add('packages', 'key order')
    } else if (isObj(a[k]) && isObj(b[k])) {
      fields(k, a[k], b[k])
    } else {
      add(k, 'changed', a[k], b[k])
    }
  }
  if (json(Object.keys(a).filter(k => k in b)) !== json(Object.keys(b).filter(k => k in a))) add('<top>', 'key order')
  if (!out.length) add('text', 'layout only')
  return out
}

// generalized: no names, no versions
const generalize = where => where
  .replace(/workspaces\[<(root|member)>:[^\]]*\]/g, 'workspaces[<$1>]')
  .replace(/packages\[<(pkg|nested)>:[^\]]*\]/g, 'packages[<$1>]')
const valueKind = v => v === undefined ? '' : typeof v === 'number' ? String(v) : ''
const signature = d => [...new Set(d.map(c => {
  const w = generalize(c.where)
  if (/^(lockfileVersion|configVersion)$/.test(c.where)) return `${w} ${c.change}${c.from !== undefined || c.to !== undefined ? ` ${valueKind(c.from) || '-'}->${valueKind(c.to) || '-'}` : ''}`
  // a registry or integrity that became "" or a URL, or appeared
  if (/\.(registry|integrity)$/.test(c.where) && c.change === 'changed') {
    const k = v => v === '' ? '""' : typeof v === 'string' && /^https?:/.test(v) ? '<url>' : typeof v === 'string' ? '<hash>' : typeof v
    return `${w} ${k(c.from)}->${k(c.to)}`
  }
  return `${w} ${c.change}`
}))].sort()

const describe = d => d.map(c => `${c.where} ${c.change}${c.from !== undefined ? ` from ${short(c.from)}` : ''}${c.to !== undefined ? ` to ${short(c.to)}` : ''}`)

// the class of a difference: header (lockfileVersion/configVersion only), text (layout, key order), entries
const scope = d => {
  if (!d.length) return 'same'
  if (d.every(c => /^(lockfileVersion|configVersion)$/.test(c.where))) return 'header'
  if (d.every(c => c.change === 'key order' || c.where === 'text' || /^(lockfileVersion|configVersion)$/.test(c.where))) return 'text'
  return 'entries'
}

module.exports = { parse, diff, signature, describe, scope, tupleKind }

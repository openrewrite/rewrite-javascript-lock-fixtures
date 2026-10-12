// Reads, from the oven-sh/bun source at every bun-v1.x.y tag, the facts that decide which lockfile a release writes
// and how the sweep can run it. Bun 1.4.0 is a Rust translation of the Zig sources, file for file (bun.lock.zig is
// bun.lock.rs there), so both are read.
//   lang      zig | rust (where src/install/lockfile.zig or lockfile.rs is)
//   text      where bun.lock.zig / bun.lock.rs lives (no file: the release reads and writes bun.lockb only)
//   versions  bun.lock's Version enum, and current: the lockfileVersion it writes
//   config    the ConfigVersion enum and its current value, where bun.lock writes "configVersion"
//   flags     the install command's --save-text-lockfile, --lockfile-only, --minimum-release-age, --linker options
//   save      how the save format is chosen (`save_format`), and the save_text_lockfile option's default
// Usage: node bun-format-facts.js <bare clone of oven-sh/bun> [--out <json>]
//   (a blobless clone does: git fetches each blob it is asked for)
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const GIT = path.resolve(process.argv[2])
const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null
const git = (...args) => {
  const r = spawnSync('git', ['--git-dir', GIT, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
  return r.status === 0 ? r.stdout : null
}
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const tags = (git('tag', '-l', 'bun-v1.*') || '').split('\n').filter(t => /^bun-v\d+\.\d+\.\d+$/.test(t))
  .map(t => t.slice('bun-v'.length)).sort(cmp)
const show = (tag, file) => git('show', `bun-v${tag}:${file}`)
const files = tag => (git('ls-tree', '-r', '--name-only', `bun-v${tag}`, '--', 'src/install', 'src/cli', 'src/cli.zig', 'src/cli.rs') || '').split('\n').filter(Boolean)

// an enum's members `name = n` or bare `name,` (numbered on from the last), and its current value
const enumOf = (src, zigName, rustName) => {
  const zig = src.match(new RegExp(`pub const ${zigName} = enum\\(u\\d+\\) \\{([\\s\\S]*?)\\n\\};`))
  const rust = src.match(new RegExp(`pub enum ${rustName} \\{([\\s\\S]*?)\\n\\}`))
  const body = zig ? zig[1] : rust ? rust[1] : null
  if (body == null) return null
  const members = []
  let n = -1
  for (const line of body.split('\n')) {
    const t = line.replace(/\/\/.*$/, '').trim()
    const m = t.match(/^([A-Za-z]\w*)\s*(?:=\s*(\d+))?\s*,?$/)
    if (!m || /^(pub|const|fn|impl)$/.test(m[1])) continue
    n = m[2] != null ? Number(m[2]) : n + 1
    members.push(`${m[1]}=${n}`)
  }
  let current = null
  const zc = (zig ? zig[1] : '').match(/pub const current(?:: \w+)? = \.(\w+)/)
  if (zc) current = zc[1]
  const rc = src.match(new RegExp(`pub const CURRENT: ${rustName} = ${rustName}::(\\w+)`))
  if (rc) current = rc[1]
  return { members, current }
}

const facts = []
for (const v of tags) {
  const all = files(v)
  const lang = all.some(f => /src\/install\/lockfile\.rs$/.test(f)) ? 'rust' : 'zig'
  const lockText = all.find(f => /\/bun\.lock\.(zig|rs)$/.test(f)) || null
  const f = { version: v, lang, text: lockText }
  if (lockText) {
    const src = show(v, lockText) || ''
    const e = enumOf(src, 'Version', 'Version')
    f.versions = e ? e.members : null
    f.current = e ? e.current : null
    f.writesConfigVersion = /"configVersion"|\\"configVersion\\"/.test(src)
    // ConfigVersion lives in its own file or in lockfile.zig
    const cvFile = all.find(x => /config_version\.(zig|rs)$|ConfigVersion\.(zig|rs)$/.test(x))
    const cvSrc = [cvFile && show(v, cvFile), show(v, all.find(x => /src\/install\/lockfile\.(zig|rs)$/.test(x)) || '')].filter(Boolean).join('\n')
    const cv = enumOf(cvSrc, 'ConfigVersion', 'ConfigVersion')
    f.configVersions = cv ? cv.members : null
    f.configCurrent = cv ? cv.current : null
  }
  const optFiles = all.filter(x => /(install\.(zig|rs)|CommandLineArguments\.(zig|rs)|PackageManagerOptions\.(zig|rs)|install_with_manager\.(zig|rs))$/.test(x))
  const opt = optFiles.map(x => show(v, x) || '').join('\n')
  f.flags = ['--save-text-lockfile', '--lockfile-only', '--minimum-release-age', '--linker', '--frozen-lockfile']
    .filter(flag => opt.includes(`"${flag}`) || opt.includes(`${flag} `) || opt.includes(`${flag}=`) || opt.includes(`${flag} <`))
  const save = opt.match(/(?:const|let) save_format[^\n]*\n(?:[^\n]*\n){0,6}/)
  f.saveFormat = save ? save[0].replace(/\s+/g, ' ').trim().slice(0, 200) : null
  f.saveTextOption = (opt.match(/save_text_lockfile: (?:\?)?(?:bool|Option<bool>)(?: = [^,]+)?,/) || [])[0] || null
  facts.push(f)
  process.stderr.write(`${v} `)
}
process.stderr.write('\n')
let last = null
for (const f of facts) {
  const key = JSON.stringify([f.lang, f.text, f.versions, f.current, f.writesConfigVersion, f.configVersions, f.configCurrent, f.flags, f.saveTextOption])
  if (key !== last) {
    console.log(`${f.version.padEnd(8)} ${f.lang} text=${f.text || '-'} lockfileVersion: ${(f.versions || []).join('/') || '-'} writes ${f.current || '-'}; ` +
      `configVersion: ${f.writesConfigVersion ? `${(f.configVersions || []).join('/')} writes ${f.configCurrent}` : 'not written'}; flags=${f.flags.join(' ') || '-'}`)
    console.log(`         save: ${f.saveFormat || '-'} | option: ${f.saveTextOption || '-'}`)
  }
  last = key
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(facts, null, 1) + '\n')

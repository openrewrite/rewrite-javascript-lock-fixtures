// Checks a control run of the pnpm sweep: the recording release replayed against the frozen registry must write the
// fixture's own locks, exit as the recording did and fail with the recording's errors. Lists every scenario where it
// does not, with the checks that fail, the exit codes and what the registry had to add.
// Usage: node pnpm-control.js <sweep out dir> <release> [--verbose] [--write]   (--write: <out>/_report/control-<release>.txt)
const fs = require('fs')
const path = require('path')
const [out, release] = process.argv.slice(2)
const verbose = process.argv.includes('--verbose')
const root = path.join(out, release)
const results = []
for (const e of fs.readdirSync(root, { withFileTypes: true })) {
  const rj = path.join(root, e.name, 'result.json')
  if (e.isDirectory() && fs.existsSync(rj)) results.push(JSON.parse(fs.readFileSync(rj, 'utf8')))
}
const verdictOf = r => {
  if (r.skip) return ['skipped', r.skip]
  if (r.error) return ['harness error', r.error.split('\n')[0]]
  const bad = Object.entries(r.same).filter(([, same]) => !same).map(([check]) => check)
  // the release asked for another pnpm's tarball: what it wrote, if anything, is not this release's install
  if ((r.pm.refused || []).length || (r.pm.ranOther || []).length) return ['hands over', `asked for ${r.pm.refused.join(' ')}${r.pm.ranOther.length ? `, ran ${r.pm.ranOther.join(' ')}` : ''}; differs: ${bad.join(',') || '-'}`]
  if (bad.length) return ['differs', bad.join(',')]
  if (!Object.keys(r.same).length) return ['nothing to compare', '']
  return ['reproduced', '']
}
const tally = {}
const lines = []
for (const r of results.sort((a, b) => a.scenario < b.scenario ? -1 : 1)) {
  const [verdict, why] = verdictOf(r)
  tally[verdict] = (tally[verdict] || 0) + 1
  const extra = `${(r.overlay || []).length ? ` overlay=[${r.overlay.join('; ')}]` : ''}${(r.live || []).length ? ` live=[${r.live.join('; ')}]` : ''}${r.git ? ` git=${JSON.stringify(r.git)}` : ''}${r.pm && r.pm.metadata.length ? ` pm-metadata=[${r.pm.metadata.join(' ')}]` : ''}`
  if (verdict === 'skipped') {
    if (verbose) lines.push(`  skipped     ${r.scenario}: ${why}`)
  } else if (verdict !== 'reproduced') {
    lines.push(`  ${verdict.padEnd(11)} ${r.scenario} (${r.kind}, recorded by ${r.recordedBy || '?'}): ${why}  exits=${JSON.stringify(r.exits)} fixture=${JSON.stringify(r.fixtureExits)} errors=${JSON.stringify(r.errors)} again=${JSON.stringify(r.again)}/${JSON.stringify(r.fixtureAgain)}${extra}`)
  } else if (extra && verbose) {
    lines.push(`  ok, with    ${r.scenario}:${extra}`)
  }
}
const text = [`pnpm ${release}: ${results.length} scenarios`, ...Object.entries(tally).sort().map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`), ...lines].join('\n')
console.log(text)
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.join(out, '_report'), { recursive: true })
  fs.writeFileSync(path.join(out, '_report', `control-${release}.txt`), text + '\n')
}

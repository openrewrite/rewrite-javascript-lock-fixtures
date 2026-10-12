// The control of a scenario directory whose scenarios were recorded with several releases: each scenario must be
// reproduced by the release its own recorded-with names (the fixture's locks, exit codes and errors, as
// pnpm-control.js checks them for one release). Lists every scenario with its recording release and the verdict.
// Usage: node pnpm-control-recorded.js <sweep out dir> <dir of scenarios> [--write <file>]
const fs = require('fs')
const path = require('path')
const { loadCell, reproduces } = require('./pnpm-cell.js')

const args = process.argv.slice(2)
const writeAt = args.indexOf('--write')
const [out, scenarios] = args
const lines = []
const tally = {}
for (const name of fs.readdirSync(scenarios).sort()) {
  const recorded = path.join(scenarios, name, 'recorded-with')
  if (!fs.existsSync(recorded)) continue
  const release = (fs.readFileSync(recorded, 'utf8').match(/^pnpm (\d+\.\d+\.\d+),/) || [])[1]
  let verdict
  let why = ''
  if (!release) {
    verdict = 'no recording release'
    why = 'recorded-with names no pnpm release (pnpm --version failed in the project when it was recorded)'
  } else {
    const cell = loadCell(path.join(out, release, name))
    if (!cell) {
      verdict = 'not swept'
      why = `no cell for pnpm ${release}`
    } else if (cell.r.skip) {
      verdict = 'skipped'
      why = cell.r.skip
    } else if (reproduces(cell)) {
      verdict = 'reproduced'
    } else {
      const bad = Object.entries(cell.r.same).filter(([, same]) => !same).map(([check]) => check)
      verdict = cell.over ? 'hands over' : 'differs'
      why = `${cell.over ? `asked for pnpm ${cell.over}; ` : ''}${bad.join(',')} exits=${JSON.stringify(cell.r.exits)} errors=${JSON.stringify(cell.r.errors)} again=${JSON.stringify(cell.r.again)}/${JSON.stringify(cell.r.fixtureAgain)}${cell.r.error ? ` HARNESS ERROR ${cell.r.error.split('\n')[0]}` : ''}`
    }
  }
  tally[verdict] = (tally[verdict] || 0) + 1
  lines.push(`  ${verdict.padEnd(11)} ${name} (recorded by pnpm ${release || '?'})${why ? `: ${why}` : ''}`)
}
const text = [`${lines.length} recorded scenarios under ${scenarios}, each against the release that recorded it`,
  ...Object.entries(tally).sort().map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`), ...lines].join('\n')
console.log(text)
if (writeAt >= 0) fs.writeFileSync(args[writeAt + 1], text + '\n')

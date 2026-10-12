// Starts a Yarn classic release as its bin/yarn.js starts it, in this process, with two additions:
//   - the clock of fake-clock.js (SWEEP_NOW): the recording's time, for anything that counts from "now";
//   - a witness (SWEEP_WITNESS, a file): one JSON line for the release this process loads and one for every child
//     process the CLI starts (yarn-path hands the install to another script; a git dependency may start git).
// Both variables are removed before the CLI starts, so yarn and its children see the environment the recorders gave.
// Not a preload (NODE_OPTIONS=--require): Node resolves a preload from the working directory and reads the
// package.json there, so a scenario whose manifest is malformed would fail in Node before yarn runs.
//   node yarn-classic-run.js <release>/package/bin/yarn.js <args...>
const fs = require('fs')
require('./fake-clock.js')
const witness = process.env.SWEEP_WITNESS
delete process.env.SWEEP_WITNESS
delete process.env.SWEEP_NOW
const note = entry => {
  if (witness) fs.appendFileSync(witness, JSON.stringify(entry) + '\n')
}
const cp = require('child_process')
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = cp[fn]
  cp[fn] = function (command, args, ...rest) {
    note({ spawn: fn, command: String(command), args: Array.isArray(args) ? args.map(String) : [] })
    return original.call(this, command, args, ...rest)
  }
}
const cli = process.argv[2]
note({ main: cli })
process.argv.splice(1, 2, cli)
require(cli)

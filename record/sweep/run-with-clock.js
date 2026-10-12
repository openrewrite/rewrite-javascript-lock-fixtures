// Runs a package manager's CLI with the clock of fake-clock.js (SWEEP_NOW), as if the CLI itself had been started:
//   node run-with-clock.js <cli.js> <args...>
// A preload (NODE_OPTIONS=--require) would do the same, but Node resolves a preload from the working directory and
// reads the package.json there, so a scenario whose manifest is malformed fails in Node before npm ever runs.
require('./fake-clock.js')
const cli = process.argv[2]
process.argv.splice(1, 2, cli)
require(cli)

// Runs a pnpm CLI with the clock of fake-clock.js (SWEEP_NOW), as if the CLI itself had been started:
//   node pnpm-run-with-clock.js <bin/pnpm.cjs | bin/pnpm.mjs> <args...>
// A preload (NODE_OPTIONS=--require) would set the same clock, but Node resolves a preload from the working
// directory and reads the package.json there, so a scenario whose manifest is malformed fails in Node before pnpm
// runs. Here the CLI becomes the process's main module, as `node <cli>` makes it: pnpm 9 and 10 read their own
// name and version from the package.json beside require.main, and pnpm 11's CLI is an ES module with a top-level
// await, which require() does not load. The clock is this process's only: a worker thread or a child process pnpm
// starts keeps the machine's time (a lock-only install decides nothing there that counts from now).
require('./fake-clock.js')
const cli = process.argv[2]
process.argv.splice(1, 2, cli)
require('module').runMain()

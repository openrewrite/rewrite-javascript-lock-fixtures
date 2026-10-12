// Starts a Yarn release's single-file CLI the way corepack starts it: this process becomes the CLI (the bundle is
// loaded as the main module with argv rewritten, as corepack's runVersion does), after
//   - the clock is set to SWEEP_NOW and runs on from there (fake-clock.js's clock), so what counts from "now"
//     (npmMinimalAgeGate) counts from the recording's day;
//   - a line saying which bundle this process runs is appended to SWEEP_WITNESS, and one line more for every child
//     process the CLI starts (what it runs, its arguments), so the sweep can prove that no other Yarn than the release
//     under test ran.
//   node yarn-berry-run.js <yarn.js> <args...>
// Not a preload: NODE_OPTIONS=--require is resolved from the working directory, where Node reads the package.json
// with its own reader first and stops at a manifest Yarn itself reads (a lone surrogate, a trailing comma) before
// Yarn runs. Nothing is left in the environment either (SWEEP_* are removed), so the CLI and what it starts see the
// environment the sweep gave them and no more.
// Child processes: a child Node process the CLI starts (Yarn starts itself again to pack a git dependency) runs
// without this wrapper, so with the machine's clock; packing reads no dates. Worker threads (Yarn converts archives
// in them) have their own Date too, and write fixed timestamps.
const fs = require('fs')
const Module = require('module')
const childProcess = require('child_process')

const at = Date.parse(process.env.SWEEP_NOW || '')
const witness = process.env.SWEEP_WITNESS
delete process.env.SWEEP_NOW
delete process.env.SWEEP_WITNESS

if (!Number.isNaN(at)) {
  const RealDate = Date
  const offset = at - RealDate.now()
  const FakeDate = function Date (...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString()
    return Reflect.construct(RealDate, args.length ? args : [RealDate.now() + offset], new.target)
  }
  FakeDate.prototype = RealDate.prototype
  Object.setPrototypeOf(FakeDate, RealDate)
  FakeDate.now = () => RealDate.now() + offset
  global.Date = FakeDate
}

const cli = process.argv[2]
const args = process.argv.slice(3)
if (witness) {
  const note = entry => {
    try {
      fs.appendFileSync(witness, JSON.stringify(entry) + '\n')
    } catch (e) {
      // a witness that cannot be written is seen by the sweep as a missing line
    }
  }
  note({ pid: process.pid, main: cli, args, node: process.version })
  // every way of starting a process ends in one of these
  const spawn = childProcess.ChildProcess.prototype.spawn
  childProcess.ChildProcess.prototype.spawn = function (options) {
    note({ pid: process.pid, spawn: options && options.file, args: options && options.args, cwd: options && options.cwd })
    return spawn.apply(this, arguments)
  }
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const original = childProcess[name]
    childProcess[name] = function (file, ...rest) {
      note({ pid: process.pid, spawn: file, args: Array.isArray(rest[0]) ? rest[0] : [], sync: name })
      return original.call(this, file, ...rest)
    }
  }
}

// corepack's runVersion: the binary is loaded into the current process, which is made to look spawned for it
process.argv = [process.execPath, cli, ...args]
process.execArgv = []
process.mainModule = undefined
process.nextTick(Module.runMain, cli)

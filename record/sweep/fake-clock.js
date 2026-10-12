// Preloaded into a package manager's process (NODE_OPTIONS=--require): the clock starts at SWEEP_NOW and runs on
// from there, so anything that counts from "now" (min-release-age, before) counts from the recording's time.
const at = Date.parse(process.env.SWEEP_NOW || '')
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

// What a failed Yarn install said, in a form two runs can be compared by: the lines that give the reason, Yarn's
// report lines but for its progress ones and whatever else is not a stack frame or V8's crash dump, with what differs
// from run to run (paths, ports, timings, colors, the release in the usage banner) taken out.
//   failureOf(log) -> string
// Used on the logs a sweep keeps (their scratch paths already read <tmp> and <home>, as the recorders' logs do) and on
// the fixtures' own logs.
const PROGRESS = new Set(['YN0000', 'YN0085', 'YN0013', 'YN0019', 'YN0073', 'YN0087'])

// With { raw: true } a run that V8 aborted keeps what Yarn reported before; by default it is the abort alone: what
// Yarn had flushed when the heap ran out follows timing (one control run reports a missing patch file first, the next
// run of the same phase does not).
const failureOf = (log, { raw = false } = {}) => {
  const out = []
  if (!raw && /^FATAL ERROR: .*JavaScript heap out of memory/m.test(String(log || ''))) return 'FATAL ERROR: JavaScript heap out of memory'
  for (let line of String(log || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    // the usage banner is ruled off with box characters where the terminal has colors, and names the release
    line = line.replace(/━+/g, '').replace(/\s+$/, '').replace(/^\s+(?=Yarn Package Manager)/, '').replace(/Yarn Package Manager - \S+/, 'Yarn Package Manager - <release>')
    if (!line.trim()) continue
    const yn = line.match(/^➤ (YN\d{4}): /)
    if (yn && PROGRESS.has(yn[1])) continue
    if (/^\s+at /.test(line) || /^\s*\d+: 0x/.test(line) || /^\[\d+:0x/.test(line) || /^<--- /.test(line) || /^----- /.test(line)) continue
    if (/^(exit=|over=|lock unchanged$|lock changed$|no lock written$|package\.json changed$|\.yarnrc\.yml changed$|\+ yarn )/.test(line)) continue
    // V8 words the same exhaustion by where the last allocation failed
    if (/^FATAL ERROR: .*JavaScript heap out of memory/.test(line)) line = 'FATAL ERROR: JavaScript heap out of memory'
    out.push(line
      .replace(/<corepack>\/v1\/yarn\/[\d.]+\/yarn\.js/g, '<yarn>')
      // the release's own file, wherever it is (a require stack names it)
      .replace(/(?:\/[^\s'"`:,;)\]}]+)*\/yarn-berry\/\d+\.\d+\.\d+\/package\/bin\/yarn\.js/g, '<yarn>')
      .replace(/(?:\/private)?\/(?:var|tmp)\/[^\s'"`:,;)\]}]*/g, '<path>')
      .replace(/<(tmp|home|scratch|root|work)>(\/[^\s'"`:,;)\]}]*)?/g, (m, t, rest) => `<${t === 'scratch' ? 'tmp' : t}>${rest || ''}`)
      .replace(/127\.0\.0\.1(:|%3A)\d+/g, '127.0.0.1$1<port>')
      .replace(/\b\d+s \d+ms\b|\b\d+ms\b/g, '<time>')
      .replace(/\bpid \d+\b/g, 'pid <pid>'))
  }
  return out.join('\n')
}

module.exports = { failureOf, PROGRESS }

// Reads each release's single bundled file and reports what the sweep has to know before running it:
//   - which of the settings the recorders and the sweep set the release defines (an unknown YARN_* variable or rc key
//     is a usage error in Yarn Berry): a setting counts as defined when `<name>:{description:` is in the bundle;
//   - whether `install` takes --mode;
//   - what the release does with COREPACK_ROOT and with a manifest's packageManager: every place the bundle names
//     either is classified by the code around it, and a place that fits none of the known uses is printed. A release
//     with none unexplained neither chooses nor checks itself by the project's packageManager, which is what lets
//     the sweep run a release on a project that pins another.
// Static reading of minified bundles; the sweep's control and its log headers confirm it by running them.
// Usage: node yarn-berry-bundle-facts.js <pm dir> [--json <file>]
const fs = require('fs')
const path = require('path')

const dir = path.resolve(process.argv[2])
const jsonAt = process.argv.indexOf('--json')
const cmp = (a, b) => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const SETTINGS = ['enableTelemetry', 'enableGlobalCache', 'enableImmutableInstalls', 'enableProgressBars', 'enableColors',
  'globalFolder', 'cacheFolder', 'httpProxy', 'httpsProxy', 'unsafeHttpWhitelist', 'npmRegistryServer', 'enableStrictSsl',
  'caFilePath', 'httpsCaFilePath', 'enableScripts', 'compressionLevel', 'enableHardenedMode', 'enableOfflineMode',
  'defaultProtocol', 'supportedArchitectures', 'npmMinimalAgeGate', 'npmPreapprovedPackages', 'approvedGitRepositories',
  'catalog', 'catalogs', 'packageExtensions', 'enableNetwork', 'networkConcurrency', 'enableMirror', 'checksumBehavior',
  'enableStrictSettings', 'injectEnvironmentFiles', 'yarnPath', 'ignorePath', 'enableTransparentWorkspaces', 'nodeLinker']

// the uses of `packageManager` and of COREPACK_ROOT a Yarn Berry bundle is known to have, by the code around the word
const USES = {
  packageManager: [
    [/this\.packageManager=null/, 'the Manifest field (loaded, written back)'],
    [/typeof \w+\.packageManager==["`]string["`]\?this\.packageManager=/, 'the Manifest field (loaded, written back)'],
    [/this\.packageManager!==null\?\w+\.packageManager=this\.packageManager:delete \w+\.packageManager/, 'the Manifest field (loaded, written back)'],
    [/packageManagerField|found \$\{JSON\.stringify\(\{packageManager|\.tryFind\(\w+\);if\(\w+(\?\.|!=null&&\w+\.)packageManager\)\{let \w+=\w+\(\w+\.packageManager\)/, 'which package manager packs an external project (a git dependency)'],
    [/\{packageManager:("[A-Za-z ]+"|\w+\.\w+),reason:/, 'which package manager packs an external project (a git dependency)'],
    [/Using \$\{\w+\.packageManager\} for bootstrap|\w+=\w+\.packageManager\):\(\w+\.write\(`No package manager configuration detected/, 'which package manager packs an external project (a git dependency)'],
    [/\.packageManager=`yarn@\$\{|packageManager=\w+&&\w+\.isTaggedYarnVersion/, '`yarn set version` and `yarn init` write it'],
    [/set the `packageManager` field/, 'help text'],
  ],
  COREPACK_ROOT: [
    [/process\.env\.COREPACK_ROOT(&&!\w+)?\?\w+\.join\(process\.env\.COREPACK_ROOT,"dist\/yarn\.js"\):process\.argv\[1\]/, 'the `yarn` a script or an external project is given (corepack\'s shim, else this bundle)'],
    [/!process\.env\.COREPACK_ROOT&&\(\w+\.reportWarning/, '`yarn set version` warns without it'],
  ],
}
const classify = (s, word) => {
  const kinds = {}
  const unexplained = []
  for (let i = s.indexOf(word); i >= 0; i = s.indexOf(word, i + 1)) {
    const around = s.slice(Math.max(0, i - 170), i + 210)
    const use = USES[word].find(([re]) => re.test(around))
    if (use) kinds[use[1]] = (kinds[use[1]] || 0) + 1
    else unexplained.push(s.slice(Math.max(0, i - 80), i + 100))
  }
  return { kinds: Object.keys(kinds).sort(), unexplained }
}

const facts = {}
for (const v of fs.readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort(cmp)) {
  const s = fs.readFileSync(path.join(dir, v, 'package', 'bin', 'yarn.js'), 'utf8')
  const defined = {}
  for (const k of SETTINGS) defined[k] = new RegExp(`[{,\\s]${k}:\\s*\\{\\s*description:`).test(s)
  facts[v] = {
    bytes: s.length,
    defined,
    modeOption: /update-lockfile/.test(s),
    packageManager: classify(s, 'packageManager'),
    corepackRoot: classify(s, 'COREPACK_ROOT'),
  }
}
if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(facts, null, 1) + '\n')

// one block per run of consecutive releases with the same facts
const sigOf = f => JSON.stringify([Object.entries(f.defined).filter(([, d]) => !d).map(([k]) => k), f.modeOption, f.packageManager.kinds, f.corepackRoot.kinds,
  f.packageManager.unexplained.length, f.corepackRoot.unexplained.length])
let run = null
const flush = () => {
  if (!run) return
  const f = facts[run.from]
  console.log(`${run.from}${run.to === run.from ? '' : ' .. ' + run.to} (${run.n})`)
  console.log(`    install --mode: ${f.modeOption ? 'yes' : 'NO'}`)
  console.log(`    packageManager: ${f.packageManager.kinds.join('; ') || 'not named'}${f.packageManager.unexplained.length ? `; UNEXPLAINED: ${f.packageManager.unexplained.length}` : ''}`)
  console.log(`    COREPACK_ROOT: ${f.corepackRoot.kinds.join('; ') || 'not read'}${f.corepackRoot.unexplained.length ? `; UNEXPLAINED: ${f.corepackRoot.unexplained.length}` : ''}`)
  console.log(`    not defined: ${Object.entries(f.defined).filter(([, d]) => !d).map(([k]) => k).join(' ') || '-'}`)
  for (const u of [...f.packageManager.unexplained, ...f.corepackRoot.unexplained].slice(0, 4)) console.log(`      unexplained: ${JSON.stringify(u)}`)
}
for (const [v, f] of Object.entries(facts)) {
  const sig = sigOf(f)
  if (run && run.sig === sig) {
    run.to = v
    run.n++
  } else {
    flush()
    run = { from: v, to: v, n: 1, sig }
  }
}
flush()

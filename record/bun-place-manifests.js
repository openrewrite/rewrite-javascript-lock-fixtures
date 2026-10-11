// Writes a Bun scenario's manifests for one lock's phase into a project directory: package.json from `pkg-before`
// (phase before) or `pkg` / `pkg-after` (phase after), else `pkg-root`; and each workspace member manifest of the
// downloaded fixtures' layout (`pkg-<member>`, `pkg-<member>-before`, `pkg-<member>-after`) at the path the lock's
// workspaces give that member name.
// Usage: node bun-place-manifests.js <scenario-dir> <lock-file> <before|after> <project-dir>
const fs = require('fs');
const path = require('path');
const [dir, lockFile, phase, out] = process.argv.slice(2);
const has = f => fs.existsSync(path.join(dir, f)) && fs.statSync(path.join(dir, f)).isFile();
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const rootFile = phase === 'before'
  ? (has('pkg-before') ? 'pkg-before' : has('pkg-root') ? 'pkg-root' : null)
  : (has('pkg') ? 'pkg' : has('pkg-after') ? 'pkg-after' : has('pkg-root') ? 'pkg-root' : null);
if (!rootFile) process.exit(1);
fs.writeFileSync(path.join(out, 'package.json'), read(rootFile));
let lock;
try {
  lock = JSON.parse(read(lockFile).replace(/^\s*\/\/.*$/mg, '').replace(/,(\s*[}\]])/g, '$1'));
} catch (e) {
  lock = null;
}
const members = {};
for (const f of fs.readdirSync(dir)) {
  const m = /^pkg-(.+?)(?:-(before|after))?$/.exec(f);
  if (!m || ['before', 'after', 'root'].includes(m[1]) || !has(f)) continue;
  if (m[2] && m[2] !== phase) continue;
  if (!m[2] && members[m[1]]) continue;
  members[m[1]] = f;
}
const workspaces = lock && lock.workspaces || {};
for (const [name, f] of Object.entries(members)) {
  const loc = Object.keys(workspaces).find(k => k !== '' && workspaces[k].name === name);
  if (!loc) continue;
  fs.mkdirSync(path.join(out, loc), { recursive: true });
  fs.writeFileSync(path.join(out, loc, 'package.json'), read(f));
}

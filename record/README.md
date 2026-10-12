# Recorders

Each script runs the real package manager on a scenario directory and writes what it produced: the locks, its
logs, `recorded-with` and the registry responses under `http/`. Every script's header lists its inputs and outputs.

| Package manager | Two phases | Plus the second install and request logs | With a user config | Second install only |
|---|---|---|---|---|
| npm 11.17.0 | `record-npm.sh` | `record-npm-open.sh` | `record-npm-user.sh` | `again-npm.sh` |
| Bun 1.3.10 | `record-bun.sh` | `record-bun-open.sh` | `record-bun-user.sh` | `again-bun-lock.sh` |
| Yarn 1.22.22 | `record-yarn-classic.sh` | `record-yarn-classic-open.sh` | `record-yarn-classic-user.sh` | `again-yarn-classic.sh` |
| Yarn 4.10.3 | `record-yarn-berry.sh` | `record-yarn-berry-open.sh` | `record-yarn-berry-user.sh` | `again-yarn-berry.sh` |
| pnpm 11.2.2 | `record-pnpm.sh` | `record-pnpm-open.sh`, `record-pnpm-lockdir.sh` | `record-pnpm-user.sh` | `again-pnpm.sh` |

The two phases install `pkg-before` from scratch (`before`), then `pkg` in the same directory over that lock
(`after`, absent when the package manager fails). The second install runs the edit's command again over `after`:
a lock that changes or is rejected there is a failure for the regenerator too.

`record-npm-repository.sh`, `record-yarn-classic-repository.sh` and `record-pnpm-repository.sh` record a
`lock/repository/<package manager>/<scenario>` the same way, over a whole repository tree laid out as `repo/`: the
package manager runs in the scenario's `lock-dir`, so a workspace root above it, a member beside it and a `file:`
target elsewhere in the repository are all there for it to read.

## Recording a scenario

1. Make `lock/<family>/<scenario>/` with `pkg-before`, `pkg`, a one-line `about`, and any config files the
   recorder's header names (`npmrc`, `yarnrc`, `bunfig`, `workspace`, `tree/`, `user-npmrc`, ...).
2. Run the recorder: `bash record/record-npm-open.sh lock/npm/<scenario>`. It needs the package manager release in
   the table on `PATH` (Yarn 4 through corepack, whose downloads are kept in `.cache/`).
3. Write `expect`: `exact`, or the failure kind and the package manager's reason (`pm-rejects ...`,
   `cannot-know ...`, `pm-fails ...`, `second-install-rejects ...`).
4. Commit and push. Of `probes/`, commit only what the scenario's test reads (pnpm's `<phase>-locks/`,
   `<phase>-root-lock` and `<phase>-changed/`); its metadata caches hold full registry documents and stay out.
   `.cache/` holds downloads and is ignored.

The recordings are hermetic: HOME, the XDG directories, caches and the user config point into a scratch directory,
so no `~/.npmrc` or other user configuration is read and no credential is recorded. A scenario that needs a user
config names it (`user-npmrc`, `user-yarnrc-yml`, ...). Every recorder runs `redact-paths.js` (machine paths) and
`strip-registry-people.js` (maintainer, author, contributor and README fields) over what it wrote.

# The release sweep

`rewrite-javascript` ports one release of each package manager (npm 11.17.0, Yarn 4.10.3, Yarn 1.22.22, Bun 1.3.10,
pnpm 11.2.2) and reproduces other releases beside it. The sweep shows what every other release does: it replays each
real release over every recorded scenario of its family against a frozen registry, and its export writes what each
release wrote into `lock/<family>/<scenario>/releases` and `release/<first>/`, which the scenario tests replay. These
are the scripts that produced the release outcomes in `lock/`. Each script's header says what it reads and writes.

For every family:

- **A frozen registry.** A stub answers from the scenario's own `http/`. A document the recording did not keep is
  rebuilt as of the recording (today's, cut back to the versions, tags and deprecations the recording kept), or, for a
  package the recording never asked for, today's cut at the recording's time; `result.json` names each such answer.
- **Hermetic runs.** HOME, caches and temp in a scratch directory with a real path, a minimal environment, the
  recording's clock (`fake-clock.js`, loaded by a wrapper that then runs the CLI; for a native executable, a library
  inserted with `DYLD_INSERT_LIBRARIES`).
- **The recorder's phases and command line**, plus `cross` (the edit over the fixture's own `before`) and the second
  install over every lock a phase writes.
- **A control.** The release that recorded a scenario, replayed, must reproduce the fixture. Only the scenarios it
  reproduces count, in the reports and in the export.

## Requirements

macOS on Apple silicon (the recordings' platform; the native clocks are built with `/usr/bin/clang`, the Yarn stubs
call `/usr/bin/openssl`, copies are APFS clones, `cp -c`), Node 24 (the sweeps and exports ran under 24.21.0, and
npm's export writes the Node it runs under into every `recorded-with`), git, `gh` (Yarn classic's source inventory),
and the network: what a recording did not keep is fetched once and kept in the sweep's directory.

## The working directory

```
<work>/
  bin -> fixtures/record/sweep            these scripts
  fixtures/                               a clone of this repository
  pm/<family>/<version>/                  each release, unpacked;  pm/node/<version>/  the Node builds
  sweep/<family>/<release>/<scenario>/    the cells;  sweep/<family>/_report/  the reports
  inventory/                              packuments, release orders, the exports' created lists, source inventories
  snap/<n>/lock/                          immutable copies of fixtures/lock for builds (snapshot.sh, refresh.sh)
  scratch/                                pristine scenarios and other working copies
```

```bash
mkdir work && cd work
git clone https://github.com/openrewrite/rewrite-javascript-lock-fixtures.git fixtures
ln -s fixtures/record/sweep bin
mkdir pm sweep inventory snap scratch
```

Run every script from `<work>` as `node bin/<name>.js` or `bash bin/<name>.sh`, never from `fixtures/record/sweep`: a
script takes the working directory to be the one above `bin/` in the path it was started by (Node resolves `__dirname`
through the link, so the Node scripts read that path from `process.argv[1]`).

A sweep reads the scenarios as recorded. A registry document an export added to `http/` would be served as recorded,
and then not exported again, so a sweep reads a pristine copy:

```bash
bash bin/pristine-npm.sh scratch/npm-pristine                # npm: scratch/npm-pristine/npm

F=yarn-berry P=scratch/pristine                              # the other families
mkdir -p $P/lock && rm -rf $P/lock/$F && cp -cR fixtures/lock/$F $P/lock/$F
sed "s|^|$P/|" inventory/export-$F-created.txt | xargs rm -f  # none while lock/<family> holds no export (pnpm)
find $P/lock/$F -mindepth 2 -maxdepth 2 \( -name releases -o -name release \) -exec rm -rf {} +
ln -sfn ../../fixtures/record $P/record     # sweep-yarn-berry.js runs <scenarios>/../../record/make-berry-overlay.js
```

The created lists (`inventory/exported-http.txt` for npm, `inventory/export-<family>-created.txt` for the others) are
written by the exports and name every file one added. They are kept in the working directory that ran the export,
not in this repository; without the list of the export that is in `lock/`, an added file cannot be told from a
recorded one.

## A cell

`sweep/<family>/<release>/<scenario>/` is one release's run of one scenario: the lock each phase wrote, named for the
phase (`before`, `after`, `after-again` where the second install changed it, `cross`, `cross-again`; absent where the
phase wrote none), each phase's output (`<phase>.log`, scratch paths redacted), `requests.log` (every request the stub
answered, under `# <phase>`, with what answered it: `recorded`, `as-of`, `live`, ...) and `result.json` (each phase's
exit, `same`: what equals the fixture, the second installs' outcome, the answers beyond the recording, `skip` or
`error`). A cell with a `result.json` is done: a sweep skips it unless given `--force`.

| Family | Also in a cell |
|---|---|
| Yarn Berry | `pkg*.written`, `yarnrc*.written`: the manifest and `.yarnrc.yml` the release rewrote |
| Yarn classic | `after-fixpoint`, `cross-fixpoint` (the recorders' fixpoint install), `after-member-lock`, `after-repo-lock` |
| Bun | `fresh`, `cold` (the recorders' fresh-directory and empty-cache installs); `locks/<phase>/`, every `bun.lock` |
| pnpm | `changed/<phase>/`: the files pnpm rewrote; `locks/<phase>/`: every project's lock; `git-<phase>.log` |

Beside the cells, `sweep/<family>/` keeps what they share: the documents rebuilt as of a recording (`_overlay/` or
`_asof/`, with a `.how` beside each), today's registry (`_live/`), tarballs (`_tarballs/`), the stub's certificate
authority (`_ca/`) and the interposed clock (`_native/`). Bun and pnpm keep the rebuilt documents under
`_overlay/<scenarios dir name>-<hash of its absolute path>/`: sweep one family from one scenarios path.

## npm

All 217 releases 7.0.0 to 12.2.0, under the Node running the sweep. Each scenario's baseline is the release its
`recorded-with` names (11.17.0, 11.18.0, 12.1.0, 12.2.0; 11.17.0 where it names none).

```bash
curl -sf https://registry.npmjs.org/npm -o inventory/npm-packument.json
node bin/fetch-pm.js inventory/npm-packument.json pm/npm '/^([7-9]|1[0-2])\.\d+\.\d+$/'  # checks dist.integrity
node bin/pm-smoke.js pm/npm bin/npm-cli.js                        # which releases start under this Node
node bin/release-order.js pm/npm 7 > inventory/npm-sweep-order.txt
bash bin/pristine-npm.sh scratch/npm-pristine
S="--scenarios scratch/npm-pristine/npm --pm pm/npm --out sweep/npm --jobs 8"
node bin/sweep-npm.js $S --releases 11.17.0,11.18.0,12.1.0,12.2.0  # the control: the recording releases
node bin/sweep-control.js sweep/npm 11.17.0 --verbose              # what it does not reproduce (per release)
node bin/sweep-npm.js $S --releases-file inventory/npm-sweep-order.txt
node bin/npm-killed-cells.js sweep/npm inventory/killed-cells.txt  # cells the 180 s timeout killed under load
bash bin/npm-resweep-killed.sh 8                                   # each again, alone: what times out again hangs
node bin/sweep-matrix.js sweep/npm                                 # _report/summary.txt, boundaries.txt, .json
bash bin/refresh.sh                                                # the export, committed in fixtures (below)
node bin/npm-source-inventory.js pm/npm inventory                  # npm-source.txt: ported files changed per pair
bash bin/npm-upstream-diff.sh 11.17.0 11.18.0 --stat --libs        # the upstream diff of what the port follows
bash bin/npm-first-release-with.sh node_modules/@npmcli/arborist/lib/link.js overrideMatchesSubtree
```

## Yarn Berry

All 83 releases 2.1.0 to 4.18.1, each the single file corepack downloads, run as corepack runs it: Yarn 4 under the
Node running the sweep, 2.x and 3.1.0 - 3.8.7 under Node 20.19.5, 3.0.x under 16.20.2 (`yarn-berry-node-probe.js`
shows why).

```bash
curl -sf https://registry.npmjs.org/@yarnpkg/cli-dist -o inventory/yarn-berry-cli-dist-packument.json
curl -sf https://repo.yarnpkg.com/tags -o inventory/yarn-berry-tags.json
node bin/fetch-pm.js inventory/yarn-berry-cli-dist-packument.json pm/yarn-berry '/^[2-4]\.\d+\.\d+$/'
node bin/yarn-berry-fetch.js inventory/yarn-berry-tags.json inventory/yarn-berry-cli-dist-packument.json pm/yarn-berry
node bin/yarn-berry-fetch-node.js pm/node 16.20.2 20.19.5
node bin/yarn-berry-bundle-facts.js pm/yarn-berry --json inventory/yarn-berry-bundle-facts.json  # settings, pins
S="--scenarios scratch/pristine/lock/yarn-berry --pm pm/yarn-berry --out sweep/yarn-berry"
node bin/yarn-berry-node-probe.js $S --nodes 16.20.2,20.19.5,current --releases 3.0.2,3.1.1
node bin/sweep-yarn-berry.js $S --control                          # each phase with its recording release
node bin/sweep-yarn-berry.js $S --control --label control-2
node bin/yarn-berry-control.js sweep/yarn-berry --against control-2  # _report/control.txt, control.json
NODES="2=$PWD/pm/node/20.19.5/bin/node,3=$PWD/pm/node/20.19.5/bin/node,3.0=$PWD/pm/node/16.20.2/bin/node"
node bin/sweep-yarn-berry.js $S --releases-file inventory/yarn-berry-sweep-order.txt --jobs 10 --heavy-jobs 2 \
  --node-for $NODES
node bin/sweep-matrix-yarn-berry.js sweep/yarn-berry               # summary, boundaries, boundaries-detail
node bin/yarn-berry-health.js sweep/yarn-berry > sweep/yarn-berry/_report/health.txt
node bin/sweep-export-yarn-berry.js --sweep sweep/yarn-berry --fixtures fixtures/lock/yarn-berry \
  --created-list inventory/export-yarn-berry-created.txt --report inventory/export-yarn-berry-report.txt
PORT=<rewrite>/rewrite-javascript/src/main/java/org/openrewrite/javascript/internal/lock
node bin/yarn-berry-source-inventory.js $PORT/berry pm/yarn-berry inventory
node bin/yarn-berry-source-diff.js inventory 4.13.0 4.14.0
```

`yarn-berry-rest.js` ran the sweep this way over `fixtures/lock/yarn-berry`, before an export was in it: the last patch
of every minor (`inventory/yarn-berry-first-pass.txt`), the cells `yarn-berry-plan.js` names (`--cells-file`), then
every cell.

## Yarn classic

All 61 releases 1.0.0 to 1.22.22 (1.22.12's registry tarball holds no bundle and does not start), under Node 24.19.0,
the recordings' Node.

```bash
curl -sf https://registry.npmjs.org/yarn -o pm/yarn-classic/packument.json
node bin/fetch-pm.js pm/yarn-classic/packument.json pm/yarn-classic '/^1\.\d+\.\d+$/'
node bin/yarn-classic-sources.js pm/yarn-classic                   # sources.txt
node bin/pnpm-fetch-node.js pm/node v24.19.0
NODE=$PWD/pm/node/v24.19.0/bin/node
node bin/pm-smoke.js pm/yarn-classic bin/yarn.js $NODE
node bin/yarn-classic-bundle-facts.js pm/yarn-classic --json pm/yarn-classic/bundle-facts.json
S="--scenarios scratch/pristine/lock/yarn-classic --pm pm/yarn-classic --out sweep/yarn-classic --node $NODE"
node bin/sweep-yarn-classic.js $S --releases 1.22.22               # the control
node bin/sweep-yarn-classic.js $S --releases 1.22.22 --label control-2
mkdir -p sweep/yarn-classic/_report                                # control.json is written there
node bin/yarn-classic-control.js sweep/yarn-classic 1.22.22 control-2 > sweep/yarn-classic/_report/control.txt
node bin/release-order.js pm/yarn-classic > scratch/yarn-classic-order.txt
node bin/sweep-yarn-classic.js $S --releases-file scratch/yarn-classic-order.txt
node bin/yarn-classic-source-inventory.js pm/yarn-classic inventory/yarn-classic-source.txt \
  --json pm/yarn-classic/source-inventory.json                     # needs pm/yarn-classic/tags.txt, gh
node bin/sweep-matrix-yarn-classic.js sweep/yarn-classic           # summary, boundaries (and their source), health
node bin/sweep-export-yarn-classic.js --sweep sweep/yarn-classic --fixtures fixtures/lock/yarn-classic \
  --packument pm/yarn-classic/packument.json --created-list inventory/export-yarn-classic-created.txt \
  --report inventory/export-yarn-classic-report.txt
```

`pm/yarn-classic/tags.txt` lists yarnpkg/yarn's tags, `v<release> <commit>` a line. The cells' files go through the
recorders' `record/redact-paths.js` (`--record` names another `record/`).

## Bun

The 50 releases that can write `bun.lock`, 1.1.39 to 1.4.3, the npm package `@oven/bun-darwin-aarch64`.

```bash
curl -sf https://registry.npmjs.org/@oven/bun-darwin-aarch64 -o pm/bun/_packument.json
node bin/fetch-pm.js pm/bun/_packument.json pm/bun '/^1\.\d+\.\d+$/'
node bin/bun-smoke.js pm/bun --json pm/bun/_smoke.json             # versions, code signatures
git clone --bare --filter=blob:none https://github.com/oven-sh/bun.git scratch/bun.git
node bin/bun-format-facts.js scratch/bun.git --out pm/bun/_format-facts.json   # which releases write bun.lock
node bin/release-order.js pm/bun | grep -vxE '1\.0\.[0-9]+|1\.1\.([0-9]|[12][0-9]|3[0-8])' > sweep/bun/_order.txt
node bin/bun-native-clock.js sweep/bun --check pm/bun/1.3.10/package/bin/bun   # sweep/bun/_native/
S="--scenarios scratch/pristine/lock/bun --pm pm/bun"
node bin/sweep-bun.js $S --out sweep/bun --releases-file sweep/bun/_order.txt --jobs 4
node bin/sweep-bun.js $S --out sweep/bun/_pass-2 --shared sweep/bun --releases-file sweep/bun/_order.txt  # and _pass-3
node bin/sweep-bun.js $S --out sweep/bun/_control/run-2 --shared sweep/bun --releases 1.3.10
node bin/sweep-bun.js $S --out sweep/bun/_control/real-clock --shared sweep/bun --releases 1.3.10 --clock real
node bin/bun-repeat.js $S --out sweep/bun/_repeat/control --shared sweep/bun --releases 1.3.10 --only '<re>' --runs 20
node bin/bun-rerun-hung.js $S --out sweep/bun                      # every cell that hung, again, alone
node bin/bun-control.js sweep/bun --scenarios scratch/pristine/lock/bun --runs sweep/bun/_control/run-2 \
  sweep/bun/_control/real-clock sweep/bun/_pass-2 sweep/bun/_pass-3 --repeat sweep/bun/_repeat/control/tally.json
node bin/sweep-matrix-bun.js sweep/bun --runs sweep/bun/_pass-2 sweep/bun/_pass-3 \
  --repeat sweep/bun/_repeat/control/tally.json sweep/bun/_repeat/boundaries/tally.json
node bin/sweep-export-bun.js --sweep sweep/bun --fixtures fixtures/lock/bun \
  --created-list inventory/export-bun-created.txt --report inventory/export-bun-report.txt
node bin/bun-source-inventory.js scratch/bun.git --releases-file sweep/bun/_order.txt --out inventory/bun-source.txt
```

The export reads the passes at `sweep/bun/_pass-2` and `_pass-3`: a phase whose outcome differs between them is
undecided.

## pnpm

The 205 releases 9.0.0 to 12.12.1: pnpm 9 to 11 under Node 24.19.0, pnpm 12 as its native executable.

```bash
curl -sf https://registry.npmjs.org/pnpm -o inventory/pnpm-packument.json
curl -sf https://registry.npmjs.org/@pnpm/exe.darwin-arm64 -o inventory/pnpm-exe-darwin-arm64-packument.json
node bin/pnpm-releases.js inventory/pnpm-packument.json            # per minor: dates, engines.node, bin
node bin/fetch-pm.js inventory/pnpm-packument.json pm/pnpm '/^(9|1[0-2])\.\d+\.\d+$/'
node bin/pnpm-fetch-exe.js inventory/pnpm-exe-darwin-arm64-packument.json pm/pnpm
node bin/pnpm-fetch-node.js pm/node v24.19.0
NODE=$PWD/pm/node/v24.19.0/bin/node
node bin/pnpm-smoke.js pm/pnpm $NODE 9 12
node bin/pnpm-native-clock.js sweep/pnpm --check pm/pnpm/12.12.1/@pnpm/exe.darwin-arm64/pnpm
for m in 9 10 11 12; do node bin/pnpm-sweep-order.js pm/pnpm $m > inventory/pnpm-sweep-order-$m.txt; done
SC=$PWD/fixtures/lock/pnpm   # pristine while lock/pnpm holds no export; every step names it by this absolute path
S="--scenarios $SC --pm pm/pnpm --node $NODE --jobs 8"
node bin/sweep-pnpm.js $S --out sweep/pnpm --releases 11.2.2 --cross always                   # the control
node bin/sweep-pnpm.js $S --out sweep/pnpm/_repeat/2 --shared sweep/pnpm --releases 11.2.2 --cross always
mkdir -p sweep/pnpm/_report
node bin/pnpm-control.js sweep/pnpm 11.2.2 --write                 # _report/control-11.2.2.txt
node bin/pnpm-repeat.js 11.2.2 sweep/pnpm sweep/pnpm/_repeat/2 --write sweep/pnpm/_report/unstable.txt
for m in 11 12 10 9; do
  node bin/sweep-pnpm.js $S --out sweep/pnpm --releases-file inventory/pnpm-sweep-order-$m.txt
done
node bin/sweep-matrix-pnpm.js sweep/pnpm --unstable sweep/pnpm/_report/unstable.txt  # --min, --max, --report per major
PORT=<rewrite>/rewrite-javascript/src/main/java/org/openrewrite/javascript/internal/lock
node bin/pnpm-source-inventory.js pm/pnpm inventory $PORT/pnpm --min-major 9
```

`pnpm-sweep-all.js <work>` ran the rest of the sweep this way: each major's scenarios that differ between its first
and last release (`pnpm-differing.js`) first, then every cell; its steps 2 and 4 sweep the #9151 session's
optional-peer scenarios from `<work>/from-9151/`, which this repository does not hold. `unstable.txt` began as
`pnpm-repeat.js`'s list; its `<scenario> errors <from>..<to>` line, which the matrix and the export read, is written
by no script here.

Where a release's own `before` was the fixture's, the sweep took the edit's outcome for `cross`. The export runs that
cross phase for real first, into a copy of the sweep's shared documents, and writes into a copy of the scenarios:

```bash
X=scratch/pnpm-export
mkdir -p $X/shared
for d in _ca _live _overlay _tarballs _native; do cp -cR sweep/pnpm/$d $X/shared/$d; done
ls sweep/pnpm | grep -E '^[0-9]' | sort -t. -k1,1n -k2,2n -k3,3n > $X/releases.txt
node bin/pnpm-export-cross.js --from sweep/pnpm --scenarios $SC --pm pm/pnpm --out $X/cross --shared $X/shared \
  --releases-file $X/releases.txt --node $NODE --jobs 8
cp -cR fixtures/lock/pnpm $X/pnpm
node bin/sweep-export-pnpm.js --sweep sweep/pnpm --cross $X/cross --fixtures $X/pnpm --sweep-scenarios $SC \
  --unstable sweep/pnpm/_report/unstable.txt --repeats sweep/pnpm/_repeat/2,sweep/pnpm/_repeat/3,sweep/pnpm/_repeat/4 \
  --created-list inventory/export-pnpm-created.txt --report inventory/export-pnpm-report.txt
node bin/pnpm-export-check.js $X/pnpm fixtures/lock/pnpm inventory/export-pnpm-created.txt sweep/pnpm
```

`sweep/pnpm/_repeat/<n>/` hold second runs (`sweep-pnpm.js --out sweep/pnpm/_repeat/<n> --shared sweep/pnpm`): of
the control (2), and of some scenarios under some 11.0 and 10.28 - 10.33 releases (3, 4). A cell whose second run
ended otherwise is left out of the export.

## The export

Each scenario's baseline is the release that recorded it. A scenario is exported only where the control reproduces
it. Every release's cell has an outcome: what it wrote that the regeneration writes too (the lock of each phase; for
Yarn Berry the `.yarnrc.yml` a lockfile migration writes; for pnpm every project's lock and the files it rewrote; for
Bun the locks a lock-dir or run-dir edit created or changed), each phase's exit and failure, and the second installs.
The releases with the baseline's outcome are written to `<scenario>/releases`; every other outcome to
`<scenario>/release/<its first release>/`:

```
releases                          the releases that write it
recorded-with                     the release, Node, clock and exits of the replay
before, after, after-again,       what the release wrote (absent where it wrote nothing; pnpm names the second
cross, cross-again, ...           install's lock `again`, and keeps other projects' locks under probes/)
expect, expect-cross              the edit's outcome where it is not the lock byte for byte (Yarn Berry: also
                                  expect-before, over a seeded lock)
<pm>-<phase>.log                  the package manager's output of a failed phase (npm, pnpm: of the second install too)
requests.log                      Bun: the requests of the phases the replays read, as the cell's requests.log has them
```

The rules every export follows:

- `releases` holds node-semver ranges, one a line. A range joins two releases only when every release between them
  in the release line was swept and has the same outcome. The release line is the registry's stable releases for npm
  (`--packument`, from `--min-major 7`) and Yarn classic (so 1.22.12, which does not start, splits a range), and the
  swept releases for Yarn Berry (from `--min-major 4`), Bun (from `--min 1.2.0`) and pnpm.
- An expect line is the scenario's own where the release fails as the recording release did; else the package
  manager's own failure (`pm-rejects <code or message>`, `pm-fails <message>`, cut where it names a machine's path);
  `cannot-know ...` for what the engine cannot see (a filesystem error, a git remote, the pnpm a project pins);
  `exact-or <line>` where a release writes a lock where the recording's line says the engine cannot know;
  `second-install-rejects` (npm: `unstable`) where the second install changes or rejects the lock. npm's
  `<scenario>/releases-expect`, a person's rule with its reason, wins over all of these.
- A registry document a replay of an exported release needs that the recording did not keep is added to the scenario's
  `http/` (`http-url/`, `http-npmmirror/`, `http-<label>/`; Bun: wherever that host's own directory lacks it, whatever
  `http/` holds) as the stub served it, and named in the created list. An existing file is never written: a recorded
  file is never touched.
- The export removes what the last one wrote first: every scenario's `releases` and `release/`, and the files the
  created list names (`--created-list` names the last list, and the export writes the new one there; npm's
  `refresh.sh` does both for `sweep-export.js`).
- Left out: Bun's undecided cells (a harness error, a run killed in a phase the replays read, an outcome that differs
  between the passes, a request the stub could not answer) and pnpm's cells whose outcome varied between runs
  (`--unstable`, `--repeats`) or whose cross phase no real run checks; that release is not replayed for the scenario.

The npm export writes the Node it runs under into `recorded-with`: run it under the Node of the outcomes in `lock/`
(v24.21.0) to write them again byte for byte.

## After a re-sweep

A sweep keeps every finished cell; give `--force` with `--releases` and `--only <regex>` to run cells again. Then:

1. Rebuild the control and the reports (the commands above). The export reads the control's
   `sweep/<family>/_report/control.json` (Yarn Berry, Yarn classic, Bun).
2. Export into `fixtures/lock/<family>` with the last created list. npm: `bash bin/refresh.sh [n]` rebuilds the
   reports, removes the last export, exports, commits in `fixtures/` and, with a number, snapshots `fixtures/lock` to
   `snap/<n>/lock`. The others: their export command above, then `git -C fixtures add -A lock/<family>` and a commit.
   pnpm: `pnpm-export-cross.js` for the new cells first, and `pnpm-export-check.js` after.
3. `bash bin/snapshot.sh <n>` copies `fixtures/lock` to `snap/<n>/lock` (and its commit to `snap/<n>/commit`) for a
   build to read.

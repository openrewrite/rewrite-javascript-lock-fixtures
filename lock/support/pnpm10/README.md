# Bounded PNPM 10 recordings

The engine fixtures in `lock/pnpm/pnpm1000-*`, `pnpm10110-*` and `pnpm10349-*` were recorded with real PNPM
10.0.0, 10.11.0 and 10.34.9. The registry's `latest-10` was 10.34.9 when this work began. No other PNPM 10 release
is claimed by this campaign.

There are eight scenarios per release: a registry dependency upgrade, `.npmrc` peer configuration, manifest
`pnpm.overrides`, catalog workspaces, nested transitive peers, workspace configuration precedence, registry aliases, and a seeded lock
with optional-package libc metadata. The seed in the last case is an actual PNPM 10.34.9 lock, accompanied by its
manifest and recording log. Locks were never edited by hand.

Each scenario has its native lock-only recording and unchanged second install. `native-installs.json` and four
`native-*.log` files also record full baseline and edited frozen/ordinary installs: 24 scenarios, 96 successful
commands, with every original input byte unchanged. `record/verify-pnpm-installs.py` reproduces those checks, and
the paired source PR's existing CI checks the pinned fixture replay. A proposed native CI workflow is retained in
the campaign board because the OAuth connection lacks workflow scope. OpenRewrite's PNPM scenario tests compare regenerated locks with `after`
byte for byte.

The engine's PNPM 10 profile covers registry dependencies, linked workspaces and catalog resolution. Patches,
runtime/package-manager dev engines, config dependencies, exotic protocols, unshared workspaces, complex workspace
globs and advanced configuration paths remain explicit cannot-know outcomes. Catalog file editing remains under
its separate existing writer guard for 10.0.0 and 10.11.0. These boundaries preserve unported behavior for future
work; rejected cases are not acceptance.

The directories below retain native oracles for the two pinned real repositories that exposed missing version
coverage. They are outside automatic unit-test discovery because their complete registry responses require much
more memory than the default test heap. `http/*.gz` holds the actual responses captured by `record-pnpm.sh`, with
the recorder's normal removal of registry people/README fields. `http-sha256.json` records both uncompressed and
gzip hashes; gzip changes no response bytes. `pkg-before`, `seed-lock`, `pkg`, `before` and `after` retain the
native two-phase inputs and outputs. The final actual recipe/native acceptance evidence is alongside each oracle.

`upstream-provenance.json` pins the upstream sources and registry releases used in the comparison. Notable source
boundaries were workspace settings/packages validation (10.5.0), current-version preference (10.12.1), configured
libc metadata (10.14.0), workspace-root peer hoisting (10.15.0), optional full metadata (10.28.2), hidden workspace
manifest detection (10.29.0), weighted peer selectors (10.33.0), and PNPM 11's lock-version weighting, age default,
configuration model and compatibility database. The old database was extracted from all three actual bundles;
each contains the identical 147-entry `@yarnpkg/extensions` 2.0.3 JSON.

## Real recipe acceptance and the lock-only boundary

Both pinned repositories passed fresh parsing, the standard RPC dependency-upgrade recipe, patch application,
and baseline/edited frozen and ordinary native installs. Parser runtime versions are checked against the native
executables. `acceptance-summary.json` records eight native commands on two mutated real repositories.

Blazity's generated lock also equals the independent native lock-only oracle byte for byte. LMS's generated lock
is accepted unchanged by full frozen and ordinary PNPM 10.11.0 installs, but differs from the native lock-only
oracle in a cyclic eslint peer suffix. It is **native acceptance only**, not a byte-exact lock-only claim. Both
outputs are retained. LMS compilation and type checking succeeded; page-data collection needs an unavailable API
token, so its complete consumer build/check could not be verified. Blazity's compile and check passed.

Earlier local LMS attempts that parsed with PNPM 11.10.0 are excluded. The retained acceptance uses PNPM 10.11.0
for parsing, native installs and resolved project build commands, and enforces `NATIVE_LOCKGROUPS` in the helper.

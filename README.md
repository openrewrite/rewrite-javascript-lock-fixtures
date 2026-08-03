# rewrite-javascript lock fixtures

Recorded package-manager output used by the lock regeneration tests in
[openrewrite/rewrite](https://github.com/openrewrite/rewrite) (`rewrite-javascript`). The tests hold the
native lock engine to byte-identity with what the real package managers write, so these fixtures are the
contract: golden lock files, the manifests that produced them, and the registry HTTP responses needed to
replay each scenario offline.

The `rewrite-javascript` build downloads the latest `main` of this repository at build time and puts
`lock/` on the test classpath. There is no published artifact and no version pinning: fixture changes here
are expected to track the engine's tests in lockstep, and older revisions of rewrite are not kept building
against newer fixtures.

## Layout

```
lock/<package-manager>/<scenario>/
  pkg-before   package.json before the edit (whole-closure scenarios)
  pkg          package.json after the edit
  before       lock produced by installing pkg-before from scratch
  after        lock produced by installing pkg incrementally in the same directory
  http/        recorded registry responses: abbreviated packument per name, one verbatim
               single-version manifest per name-version, and (yarn-berry) package tarballs
               (*.tgz) for checksum reproduction
```

Some older per-dependency scenarios use only `before`/`after` with inline manifests in the tests.

## Provenance and re-recording

Goldens were recorded against registry.npmjs.org with npm 11.6.2, pnpm 11.2.2, yarn 1.22.22,
yarn 4.5.3 (via corepack), and bun 1.3.10. Each `<Pm>ResolveAndPatchLockRegenTest` in rewrite-javascript
carries a disabled live helper that re-derives and verifies its goldens two-phase: install `pkg-before`
from scratch and compare with `before`, then install `pkg` in the same directory and compare with `after`.

When adding fixtures:

- Record with the real package manager; never hand-edit a golden.
- Capture the registry responses the scenario needs under `http/` (packument with
  `Accept: application/vnd.npm.install-v1+json`, manifests verbatim).
- Tarballs are binary (`.gitattributes` enforces this); after committing, verify
  `git cat-file blob` output matches the on-disk shasum — line-ending normalization has corrupted
  a tarball before.

## License

The test scenarios and their organization are licensed under the Apache License 2.0 (see LICENSE).
The recorded registry responses and package tarballs are published open-source packages and metadata
belonging to their respective authors under their own licenses, included unmodified as test data.

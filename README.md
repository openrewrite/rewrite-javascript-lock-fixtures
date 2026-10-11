# rewrite-javascript lock fixtures

Recorded package-manager output used by the lock regeneration tests in
[openrewrite/rewrite](https://github.com/openrewrite/rewrite) (`rewrite-javascript`). Each scenario is replayed
offline, and the regenerator must reproduce the package manager's lock byte for byte, or the failure the scenario
records.

The `rewrite-javascript` build downloads the latest `main` of this repository and puts `lock/` on the test
classpath. There is no published artifact and no version pinning: fixture changes here track the tests in lockstep,
and older revisions of rewrite are not kept building against newer fixtures.

## Layout

```
lock/<family>/<scenario>/
  pkg-before   package.json before the edit
  before       the lock before the edit
  pkg          package.json after the edit
  after        the lock the package manager wrote (absent when it failed)
  expect       the outcome when it is not byte-exact (cannot-know, pm-rejects, ...)
  http/        the registry responses the scenario needs, and tarballs where a checksum needs them
```

Scenarios may also hold the package manager's config files, workspace members, and the logs of the recording.

## Recording

Recorded against registry.npmjs.org with npm 11.17.0, Bun 1.3.10, Yarn 1.22.22, Yarn 4.10.3 and pnpm 11.2.2, the
releases rewrite-javascript ports, by the scripts in [`record/`](record/README.md). Record with the real package
manager and never hand-edit a lock. Tarballs are binary (`.gitattributes`); after committing one, check that
`git cat-file blob` matches the file's shasum.

## License

The test scenarios and their organization are licensed under the Apache License 2.0 (see LICENSE). The recorded
registry responses and package tarballs are published open-source packages and metadata belonging to their
respective authors under their own licenses, included as test data with the maintainer, author, contributor and
README fields removed.

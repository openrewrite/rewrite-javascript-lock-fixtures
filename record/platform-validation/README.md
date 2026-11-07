# Linux native lock validation

Five pinned public checkouts cover npm (including a linked child project), pnpm,
Yarn Classic, modern Yarn and Bun. `cases.json` fixes the Git commits, recipes,
Node 24.22.2 and package manager versions. These tests validate dependency
installation; they do not claim that project builds or tests passed.

`generate` checks the published Java and SDK 8.100.3 distribution hashes, performs
baseline frozen and normal installs, runs the actual standard RPC recipe, and
verifies that the parser detected the same Node and package manager versions as
the native commands. It then checks and applies the patch, performs patched
frozen and normal installs, and requires a zero-patch repeat. Dependency input
hashes must stay unchanged during installs.

`consume` downloads the same real checkout, overlays the recorded baseline and
patched dependency inputs, verifies their hashes, and performs both native install
modes on each. It needs no CodeGenome credentials. Recorded files were generated
and validated on Linux ARM64 with published 8.100.3.

Run with a fresh absolute work directory:

```
node record/platform-validation/run.mjs consume unjs-pathe-pnpm /absolute/work
```

For generation, set `REWRITE_JAVASCRIPT_CLASSPATH` to the published Java classpath
and `REWRITE_JS_DIST` to the matching SDK `dist` directory. Resolve the exact
published coordinates listed in `runtime-provenance.json` using existing approved
repository access. No credentials, runtime jars, or package caches are stored here.

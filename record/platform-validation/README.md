# Published lock regeneration across platforms

Five pinned public checkouts cover npm (including a linked child project), pnpm,
Yarn Classic, modern Yarn and Bun. `cases.json` fixes the Git commits, recipes,
Node 24.22.2 and package manager versions. These tests validate dependency
installation; they do not claim that project builds or tests passed.

`generate` checks the published Java and SDK 8.100.3 distribution hashes, performs
baseline frozen and normal installs, runs the actual standard RPC recipe, checks
and applies its patch, performs patched frozen and normal installs, and requires
a zero-patch repeat. Dependency input hashes must stay unchanged during installs.

`consume` downloads the same real checkout, overlays the recorded baseline and
patched dependency inputs, verifies their hashes, and performs both native install
modes on each. It needs no CodeGenome credentials. Recorded files were generated
and validated on Linux ARM64 with published 8.100.3; their presence does not imply
Windows, macOS or x64 acceptance.

Run with a fresh absolute work directory:

```
node record/platform-validation/run.mjs consume unjs-pathe-pnpm /absolute/work
```

For generation, set `REWRITE_JAVASCRIPT_CLASSPATH` to the platform-delimited
published Java classpath and `REWRITE_JS_DIST` to the matching SDK `dist` directory.
`bootstrap.py RUNTIME_DIR` prepares these for GitHub Actions using approved
`CODEGENOME_USERNAME` and `CODEGENOME_TOKEN` environment credentials. It deletes
its temporary Maven settings. Never upload the runtime directory or credentials.

`workflow-proposal.yml` is ready to install as
`.github/workflows/lock-platform-validation.yml`. It has 15 independent jobs on
Linux x64, Windows x64 and macOS ARM64, and uploads only the case evidence.
Consumption can run without repository secrets. Generation needs the two approved
CodeGenome repository secrets; no credentials have been provisioned by this work.
The current OAuth token lacks the `workflow` scope, so this proposal has not been
installed or run in Actions.

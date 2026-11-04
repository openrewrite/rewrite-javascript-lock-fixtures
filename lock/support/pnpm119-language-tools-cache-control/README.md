# PNPM 11.9 installed-state control

The native validation campaign reported a disagreement in `vuejs/language-tools` at
`c59f9908b4912ee20141b53a99b1ce485bff0dc7`: upgrading `@vue/compiler-dom` to `3.5.44` left an unchanged root
`@lerna-lite/cli: latest` at 5.6.4 in a native control, while the engine selected 5.7.0. Cold controls show that the
engine result agrees with native PNPM 11.9.0. **This recording supports no engine preference fix.**

All runs use the same actual registry metadata snapshot, where `@lerna-lite/cli`'s `latest` is 5.7.0. Each cold
run starts with an empty HOME, XDG directories, store, metadata cache and no node_modules. The warm run installs
the baseline, edits only the four selected Vue dependency fields, then installs again in the same directories.

| Input and state | CLI selected | Lock SHA-256 | Agreement |
| --- | --- | --- | --- |
| Baseline, cold | 5.6.4 | `dcc48493ffe3cb876bbcc4d208000e507c591f57a0375f4c88bee0636ac0f914` | Original baseline, byte exact |
| Edited, cold | 5.7.0 | `5f175837297c1a464b4e0c4e3425500411b7d1361880926447519ed29b9b6479` | Archived fresh recipe patch, byte exact |
| Edited after full baseline install, warm | 5.6.4 | `094af9925f5c94b80093f07a4da00f3e421e26b7548f550b6b54e477734be010` | Archived native control, byte exact |

The initial recording contains three cold edited lock-only runs and four cold edited full installs. Two of those
full installs forbid all upstream fetches from the proxy, serving only the recorded metadata and cached tarballs.
The successful warm confirmation forbids new metadata but allows immutable tarball downloads. Metadata snapshot
hashes are unchanged across these controls. The first strict warm attempt initially needed two uncached optional tarballs, then completed after the other
control populated their shared immutable tarball cache. Its log is retained as `warm-strict-concurrent-cache.log`;
this overlapping probe is excluded from totals. The serial portable replay below independently confirms the result.

`replay.cjs` reproduces the distinction using four native commands: cold baseline full install, warm edited full
install, cold edited full install, and cold edited lock-only install. It checks every generated lock byte against
the recorded output, verifies the actual executable is 11.9.0, checks all metadata hashes, rejects new metadata
fetches, and deletes the temporary dependency trees. Tarballs may be downloaded from immutable URLs and are
integrity-checked by PNPM. `tarball-sha256.json` retains hashes of the original downloaded tarballs.

```sh
SWEEP_OPENSSL="$PWD/lock/support/pnpm119-language-tools-cache-control/openssl-current-time.py" \
  node lock/support/pnpm119-language-tools-cache-control/replay.cjs \
  /absolute/path/to/pnpm-11.9.0/package/bin/pnpm.cjs /absolute/output/directory
```

The OpenSSL adapter uses current-clock certificates for OpenSSL 3.0; no fake clock is used. A newer OpenSSL that
supports the sweep recorder's certificate date arguments can run without the adapter. `portable-replay/` retains
this command's results and logs. The other orchestration scripts retain the original investigation; their local
paths are provenance, while `replay.cjs` is the portable entry point.

These are manifest-only repository controls: `baseline/` retains every workspace manifest and the actual root
workspace file/lock, and scripts are disabled. Missing workspace source binaries produce warnings during full
installs. This evidence checks resolution and lock generation; it is not a consumer build or recipe acceptance
claim. The cold result is compared with the original campaign's actual standard RPC recipe output, retained as
`archived-engine.yaml`. No new engine/source runtime was substituted and no lock was edited by hand.

`registry/` contains the actual served metadata compressed without changing its bytes; `registry-sha256.json`
records both raw and compressed hashes. Results also retain hashes of the original raw registry fetch cache,
which is not duplicated here. `provenance.json` identifies the upstream tag/commit, npm package integrity and
original evidence archive. These large support recordings stay outside automatic unit-test discovery.

The relevant exact upstream source is retained in `upstream-v11.9.0-resolveDependencies.ts`: lines 1722–1744 check
the current node_modules lock and the actual installed dependency's package.json before skipping an unchanged
linked dependency when neither update nor proceed is requested. Lines 1767–1769 do not replace a direct
dependency's specifier with the current version. The cold/warm controls establish installed state as a confounder;
they do not separately attribute the effect to each individual HOME/store/cache/node_modules component.

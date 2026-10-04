# Re-vendor the workspace-k8s official fixture at DSH 0.2.0-rc.2

**Status: DONE.** `release.yml`'s "Test published packages" step (`cd
packages/workspace-k8s && pnpm test`, whose `pretest` is
`node tests/vendor/materialize.mjs`) now materializes and passes from a
from-scratch `pnpm install --frozen-lockfile` against a pnpm store that holds
0.2.0-rc.2 only — the CI condition that failed.

Commit: **a299d15** `test(workspace-k8s): re-vendor the official fixture at
0.2.0-rc.2 and gate it on the shipped release` (branch `main`, parent `511f8ae`).
No lockfile change was needed (see §5).

---

## 1. What version was vendored, and how it was verified to be what the deployment loads

Vendored: **`@deepseek-ai/dsh-workspace@0.2.0-rc.2`**, the whole `npm pack`
output (19 files: `lib/**`, `package.json`, `LICENSE` and the three READMEs —
the READMEs are included so the directory can be diffed against the tarball as a
whole rather than file-by-file).

How the "what the deployment loads" claim was verified — three independent ways,
all byte-exact:

1. **Provenance.** `docker/dsh-web-platform.Dockerfile` installs
   `@deepseek-ai/dsh@0.2.0-rc.2` globally (`ARG DSH_VERSION=0.2.0-rc.2`, asserted
   by `test "$(dsh --version)" = "${DSH_VERSION}"`) and copies that whole tree
   into the image. The dev box has exactly that global install:
   `dsh --version` → `0.2.0-rc.2`.
2. **Resolution.** The CLI resolves one deduped copy of the package for the whole
   tree — `npm ls @deepseek-ai/dsh-workspace --all` lists a single
   `@deepseek-ai/dsh-workspace@0.2.0-rc.2` under nine dependents
   (`dsh-web-app` is the direct `dependencies` edge). The profile is NOT the
   source: `.tmp-revendor-harness/home/profiles/web/node_modules/@deepseek-ai/`
   has no `dsh-workspace` entry at all, so the profile's `workspaceRegistry` row
   can only come from the CLI's tree:
   `createRequire(<cli>/lib/bin.js).resolve('@deepseek-ai/dsh-workspace/package.json')`
   → `/home/ovizro/.nvm/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace/package.json`,
   version `0.2.0-rc.2`.
3. **Bytes.** `diff -r` of the committed fixture against both the extracted
   `npm pack @deepseek-ai/dsh-workspace@0.2.0-rc.2` tarball and the CLI-installed
   copy is empty, and the checksums match:

```
$ sha256sum deepseek-ai-dsh-workspace-0.2.0-rc.2.tgz
369566be3897fe61b72968f402e189172d31b00778e5bb59d33c55ee74876612  deepseek-ai-dsh-workspace-0.2.0-rc.2.tgz

$ (cd tests/vendor/dsh-workspace && sha256sum package.json lib/index.js lib/types/spec.js)
b9ee07ad69a2421ce3b1848821e0ce19fbeca7ec83ff255ff5b85e5f2318718d  package.json
a33af459cfc7af29dd17412443a63655fd5037dd348b0dec20a413ce60c6c8bc  lib/index.js
c13790d2a5b5ec11d2fe24692e0776c120a6ab69546e91cebbe6b50b18ec074a  lib/types/spec.js

$ (cd <cli>/node_modules/@deepseek-ai/dsh-workspace && sha256sum package.json lib/index.js lib/types/spec.js)
b9ee07ad69a2421ce3b1848821e0ce19fbeca7ec83ff255ff5b85e5f2318718d  package.json
a33af459cfc7af29dd17412443a63655fd5037dd348b0dec20a413ce60c6c8bc  lib/index.js
c13790d2a5b5ec11d2fe24692e0776c120a6ab69546e91cebbe6b50b18ec074a  lib/types/spec.js

$ diff -r <extracted tarball> tests/vendor/dsh-workspace && echo IDENTICAL
IDENTICAL
$ diff -r <cli install>     tests/vendor/dsh-workspace && echo IDENTICAL
IDENTICAL
```

The fixture README's version table now lists 0.2.0-rc.2 for `dsh-workspace`,
`dsh-storage-domain`, `dsh-storage`, `dsh-brand` and `dsh-invariants`, plus the
third-party versions the tree actually resolves (`schemastery` 3.18.4,
`cosmokit` 1.8.5, `@standard-schema/spec` 1.1.0, `zod` 4.4.3) and the one module
that is deliberately NOT flattened (`@deepseek-ai/cordis` 4.0.4, resolved from
the package's own `dependencies`, verified by `import.meta.resolve` probes from
the vendored entry point).

## 2. What 0.2.0-rc.2's `attachSession` actually does vs 0.1.5-rc.3

**Nothing changed. The repair is not broken, and no spec was relaxed.**

Decision points diffed between `511f8ae`'s vendored bytes (0.1.5-rc.3) and the
new ones (0.2.0-rc.2), by extracting each function body and comparing:

```
semantic decision points, 0.1.5-rc.3 (511f8ae) vs 0.2.0-rc.2 (a299d15):
  IDENTICAL  get sessionIds()
  IDENTICAL  async attachSession(sessionId)
  IDENTICAL  async mutate(fn)
  IDENTICAL  async [Service.init]()
  IDENTICAL  async replaceHeaderIndex(headers)
  IDENTICAL  async indexHeaders(headers)
  IDENTICAL  async listStoredHeaders()
  IDENTICAL  async readSessionHeader(id)
  IDENTICAL  validateStoredState(state)
  IDENTICAL  async detachSession(sessionId)
  IDENTICAL  async resolveByPath(path)
  IDENTICAL  async create(path, title)
  whole file: 786 -> 949 lines (+190/-27)
```

Concretely, 0.2.0-rc.2 still:

- filters reads through the startup/live cwd index —
  `get sessionIds() { return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path) }`;
- short-circuits on the DURABLE membership FIRST —
  `if (!this.record.sessionIds.includes(sessionId)) { …readSessionHeader… realpathNormalize… stat… rememberSessionPath… }`
  — so an id the record already claims never refreshes the index;
- prunes on every write inside `mutate`'s `table.update` callback, aborting the
  slot through the unchanged sentinel when nothing changed.

What 0.2.0-rc.2 adds is orthogonal to the rebind: `initializeDefault` (first-use
workspace), session pinning (`pinnedSessionIds` in the domain global, plus
`pinSession`/`unpinSession`), activity-gated `archiveSession(sessionId,
{stopActivity})` / `unarchiveSession`, `defaultWorkspaceId` in the global
schema, and two new error classes. `static inject` is still
`["storageDomain", "sessionPersistence"]`, and the runtime import surface of
`lib/index.js` is unchanged (`node:*`, `@deepseek-ai/cordis`,
`@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-storage-domain`, `zod`).

**Consequence for the repair:** the two behaviours `src/registry.ts` depends on
are still true — an EMPTY record whose anchor appears after init IS repairable
by `attachSession`, and a record that durably claims an index-hidden id is still
a one-pass prune followed by a real attach on the next pass. The specs were
re-run against the 0.2 bytes **unchanged**; only version references in comments
(`official-registry-rebind.spec.ts`, `registry.spec.ts`) and the fixture README
were updated.

## 3. Materializer changes (`tests/vendor/materialize.mjs`)

- **Peer set / versions now come from 0.2.0-rc.2, not from literals.** No range
  in `REQUIREMENTS` is hard-coded any more; each is read from the shipped
  declaration that owns it, and the failure message says which one:

  | Requirement | Range read from |
  | --- | --- |
  | the three devDependency roots | `packages/workspace-k8s/package.json` `devDependencies` |
  | `dsh-invariants`, `zod` | the VENDORED `dsh-workspace/package.json` (`peerDependencies` / `dependencies`) |
  | `schemastery` | resolved `dsh-storage-domain`'s `dependencies` |
  | `cosmokit`, `@standard-schema/spec` | resolved `schemastery`'s `dependencies` |

  This is the class of bug that caused the failure: `^0.1.5-rc.2` for
  `dsh-invariants` was a literal read from nothing at all, which outlived the
  bytes it described.
- **Resolution stays store-only**: still name + semver range against
  `<workspace root>/node_modules/.pnpm`, no network, no absolute path, peer-hash
  suffix ignored, newest match wins. All eight packages now resolve to the
  release the frozen install provides.
- **Loud failure preserved exactly**, now naming the declaration:
  `required package(s) absent from the pnpm store` → `the vendored fixture was
  left untouched`, exit non-zero before anything is touched, plus the
  `pnpm add -D` fix line. Verified by pointing the fixture's declared
  `dsh-invariants` peer at `0.9.9-rc.1`:

```
[vendor] cannot materialize the vendored fixture peer tree: required package(s) absent from the pnpm store.
[vendor]   - @deepseek-ai/dsh-invariants (range 0.9.9-rc.1 from packages/workspace-k8s/tests/vendor/dsh-workspace/package.json peerDependencies['@deepseek-ai/dsh-invariants'], for auto-installed peer of the domain form)
    store:    /home/ovizro/Code/dsh-platform/node_modules/.pnpm
    found:    0.1.5-rc.2, 0.2.0-rc.2
    fix:      pnpm add -D @deepseek-ai/dsh-invariants@0.2.0-rc.2
[vendor] the vendored fixture was left untouched; fix the store and re-run `pnpm test`.
```

## 4. Making the drift impossible to reintroduce silently

New `tests/vendor/fixture-release.mjs` is the single place that decides whether
the committed fixture still IS the shipped package, and both entry points call
it: the `pretest` materializer (so `pnpm test` — the CI step — fails before a
single spec runs) and the new `tests/vendor-fixture.spec.ts` (so a bare
`vitest run` fails too).

The expected version is read from OUTSIDE the fixture — a copy of a package can
never tell you how old it is, and the old materializer's ranges came FROM the
fixture. The authority is the three exact DSH devDependency pins
(`dsh-brand`, `dsh-storage`, `dsh-storage-domain`), which are also the roots the
peers are materialized from and therefore the release a frozen `pnpm install`
puts in the store. They must be exact pins and must agree with each other; if a
future release versions them inconsistently the check says so instead of
guessing.

Both failure shapes name the version present and the version expected:

```
$ node tests/vendor/materialize.mjs          # fixture bytes reverted to 0.1.5-rc.3
[vendor] the vendored fixture does not match the DSH release this checkout installs.
[vendor]   - the vendored fixture is STALE: packages/workspace-k8s/tests/vendor/dsh-workspace holds @deepseek-ai/dsh-workspace@0.1.5-rc.3, but this checkout installs DSH 0.2.0-rc.2.
    present  (packages/workspace-k8s/tests/vendor/dsh-workspace/package.json): 0.1.5-rc.3
    expected (packages/workspace-k8s/package.json devDependencies: @deepseek-ai/dsh-brand, @deepseek-ai/dsh-storage, @deepseek-ai/dsh-storage-domain): 0.2.0-rc.2
    the fixture is the exact bytes the deployed image loads, so it has to be re-vendored from the release the image installs:
    npm pack @deepseek-ai/dsh-workspace@0.2.0-rc.2   # see packages/workspace-k8s/tests/vendor/README.md, "Re-vendoring"
[vendor] the vendored fixture was left untouched; re-vendor it from the expected release and re-run `pnpm test`.
EXIT=1

$ npx vitest run tests/vendor-fixture.spec.ts   # same mutation, bare vitest
 × vendored official fixture > is the @deepseek-ai/dsh-workspace release this checkout installs
   → the vendored fixture is STALE: … holds @deepseek-ai/dsh-workspace@0.1.5-rc.3, but this checkout installs DSH 0.2.0-rc.2.
     present  …: 0.1.5-rc.3
     expected …: 0.2.0-rc.2
```

The materialized tree's stamp now also carries the fixture version, so a tree
built for a different fixture is rebuilt rather than reused.

## 5. Clean-state proof (the item that caused this)

Reproduced CI's shape: every `node_modules` removed (so the virtual store too),
a **brand-new** content-addressable store directory, `--frozen-lockfile`, and
the release step verbatim.

```
$ rm -rf node_modules packages/*/node_modules
$ ls -d /home/ovizro/Code/.pnpm-store-clean
ls: cannot access '/home/ovizro/Code/.pnpm-store-clean': No such file or directory
$ pnpm install --frozen-lockfile --store-dir /home/ovizro/Code/.pnpm-store-clean
…
devDependencies:
+ esbuild 0.28.2
+ typescript 7.0.2
Done in 18.7s using pnpm v11.25.0          # EXIT 0
$ du -sh /home/ovizro/Code/.pnpm-store-clean
274M                                       # freshly created, was empty

$ ls node_modules/.pnpm | grep -E '@deepseek-ai\+dsh-(invariants|storage|storage-domain|brand)@0\.1\.5'
                                           # NONE — this is the CI condition: 0.2 only
$ ls node_modules/.pnpm | grep -E '@deepseek-ai\+dsh-(invariants|storage|storage-domain|brand)@0\.2\.0-rc\.2' | wc -l
4

$ rm -rf packages/workspace-k8s/tests/vendor/node_modules
$ cd packages/workspace-k8s && pnpm test
$ node tests/vendor/materialize.mjs
[vendor] materialized 8 fixture peers for @deepseek-ai/dsh-workspace@0.2.0-rc.2 from /home/ovizro/Code/dsh-platform/node_modules/.pnpm
[vendor]   @deepseek-ai/dsh-storage-domain@0.2.0-rc.2, @deepseek-ai/dsh-storage@0.2.0-rc.2, @deepseek-ai/dsh-brand@0.2.0-rc.2, @deepseek-ai/dsh-invariants@0.2.0-rc.2, @deepseek-ai/schemastery@3.18.4, @deepseek-ai/cosmokit@1.8.5, @standard-schema/spec@1.1.0, zod@4.4.3
$ vitest run
 Test Files  21 passed (21)
      Tests  153 passed (153)                # EXIT 0
```

**Control A — the same clean store reproduces CI's exact failure with the old
tree.** `git archive 511f8ae packages/workspace-k8s` into a scratch dir, its
`node_modules` pointed at the same fresh-store install, vendored tree removed:

```
$ node tests/vendor/materialize.mjs
[vendor] cannot materialize the vendored fixture peer tree: required package(s) absent from the pnpm store.
[vendor]   - @deepseek-ai/dsh-invariants (range ^0.1.5-rc.2, for peer of the domain form)
    found:    0.2.0-rc.2
    fix:      pnpm add -D @deepseek-ai/dsh-invariants@0.2.0-rc.2   # then re-run this script
[vendor] the vendored fixture was left untouched; fix the store and re-run `pnpm test`.
EXIT=1
```

— the CI log verbatim, with `found: 0.2.0-rc.2` proving the store holds the
shipped release only. **Control B — the new guard on the same old fixture**
gives the §4 STALE message (present 0.1.5-rc.3 / expected 0.2.0-rc.2) instead.

Afterwards the checkout was reinstalled with its normal store
(`pnpm install --frozen-lockfile` → exit 0, `Already up to date`) and the
temporary store directory was deleted; the suite was re-run to confirm.

## 6. Full verification battery

All of the following ran with the source at `a299d15`; the build/test/harness/
smoke items were run twice — once on the pre-existing store and once on the
from-scratch store of §5 — with identical results. Outputs are the
clean-store run.

| Step | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0. Default store, NOT clean (`Already up to date`). The clean-store run is §5: exit 0, store created empty. **No lockfile change was required** — the 0.2.0-rc.2 bump already put `@deepseek-ai/dsh-invariants@0.2.0-rc.2` in the importer as the auto-installed peer of `dsh-storage-domain`. |
| `pnpm -r build` | exit 0 (15 projects) |
| `pnpm -r test` | exit 0 — **416 passed, 24 skipped** (the PostgreSQL-gated `session-persistence-rdb` files), **0 load/collection failures**. 414 + the 2 new `vendor-fixture.spec.ts` tests. |
| `bash scripts/harness-profile.sh .tmp-revendor-harness` | exit 0, `harness ready` (includes its own `check-plugin-imports` ×2 and the CLI loopback-bind check) |
| `node scripts/check-plugin-imports.mjs <profile>` | exit 0 both profiles: `all 9 plugins import cleanly … profiles/web`, `all 7 … profiles/headless` |
| `node scripts/smoke-zero-patch.mjs --target <web>/node_modules` | exit 0 — `ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path` |
| `node scripts/smoke-official-integration.mjs --target <web>/node_modules` | exit 0 — `OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it` |

Per-package `pnpm -r test` totals (clean store): logging-stdout 10,
platform-domain 2, auth-oidc 7, identity-bridge 31, storage-db 1,
workspace-picker 7, session-persistence-rdb 129 passed / 24 skipped,
sandbox-daemon 36, fs-k8s 24, workspace-k8s 153, subprocess-k8s 16.

## 7. Files changed (all inside the declared write scope)

```
packages/workspace-k8s/tests/vendor/dsh-workspace/**        re-vendored at 0.2.0-rc.2 (byte-exact)
packages/workspace-k8s/tests/vendor/materialize.mjs         range sources + drift gate
packages/workspace-k8s/tests/vendor/fixture-release.mjs     NEW: the single version gate
packages/workspace-k8s/tests/vendor/README.md               version table, guard, semantics, re-vendoring
packages/workspace-k8s/tests/vendor-fixture.spec.ts         NEW: the gate inside the suite
packages/workspace-k8s/tests/official-registry-rebind.spec.ts  comments only (version reference)
packages/workspace-k8s/tests/registry.spec.ts               comments only (version reference)
```

`pnpm-lock.yaml` is untouched; no runtime dependency was added (the only new
file is test-only), no DSH version was changed, no bundle was patched, and the
deleted workspace UI was not re-vendored.

## 8. Not verified / residual risk

- **The 0.2.0-rc.2 fixture bytes were verified against the dev box's global CLI
  install, not against a built image.** The image is built by
  `docker/dsh-web-platform.Dockerfile` from `npm install --global
  @deepseek-ai/dsh@0.2.0-rc.2`, which is the same install shape as the dev box,
  and the tarball checksum matches — but no `docker build` was run here.
- **CI's real store was reproduced by construction, not by observation.** A
  fresh `--store-dir` with no prior contents is the closest available analogue;
  the actual runner's store was not inspected.
- The drift gate compares against the three DSH devDependency pins. If a future
  release ships its packages at divergent versions the gate fails loudly rather
  than deciding which one the fixture should be — deliberate, documented in the
  README, but it is a gate a human must clear.
- The gate is a version comparison, not a content hash: an in-place edit of the
  vendored bytes that kept the version string would not be caught. The README
  now records the `diff -r` + `sha256sum` procedure used here (tarball hash
  `369566be…`) for anyone re-vendoring.

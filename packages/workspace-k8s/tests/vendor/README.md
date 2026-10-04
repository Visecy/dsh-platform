# Vendored official packages (test fixtures only)

The rebind tests must run against the REAL official workspace registry, not a
fake. The previous implementation's regression test modelled
`attachSession` as "refresh the cwd index, then short-circuit", which is the
opposite of what `@deepseek-ai/dsh-workspace` actually does: it short-circuits
FIRST, so an id the record already claims never refreshes the index and the
write's prune tail drops it. A hand-written fake proves nothing about that
ordering.

`dsh-workspace/` below holds the source of truth: the exact bytes of the
official package the deployed image loads — the whole `npm pack` output,
including its READMEs, so the copy can be checked against the tarball as a
whole. The peer packages it needs at import time live in `node_modules/`, which
`.gitignore` excludes; a fresh checkout materializes them automatically — before
`pnpm test` runs a single spec — with `materialize.mjs` (below).

| Package | Version | Why |
| --- | --- | --- |
| `dsh-workspace` | 0.2.0-rc.2 | The entity + registry under test (exact bytes the deployed image loads) |
| `dsh-storage-domain` | 0.2.0-rc.2 | The registry's `DomainFacility.open(spec)` + zod record parsing |
| `dsh-storage` | 0.2.0-rc.2 | `UNIT_NAME_RE` / backend key helpers pulled in by the domain form |
| `dsh-brand` | 0.2.0-rc.2 | `brandString` / `brandNumber` used by the domain specs |
| `dsh-invariants` | 0.2.0-rc.2 | Auto-installed peer of the domain form |
| `schemastery` | 3.18.4 | The domain form plugin `Config` declaration |
| `cosmokit` | 1.8.5 | `schemastery` dependency |
| `@standard-schema/spec` | 1.1.0 | `schemastery` dependency |
| `zod` | 4.4.3 | Record schemas (runtime files only: no `src/`, `v3/`, `mini/`, `v4-mini/`, `.d.ts`, `.cjs`) |
| `@deepseek-ai/cordis` | 4.0.4 | Not flattened into the fixture: the vendored bytes resolve the package's own `dependencies` entry, exactly like any other module under `packages/workspace-k8s/` |

## The fixture version is checked against the shipped release

The one thing a copy of a package cannot tell you is how old it is: the
vendored manifest agrees with itself no matter which release it came from. So
the expected version is read from OUTSIDE the fixture — the DSH packages
`packages/workspace-k8s/package.json` pins as `devDependencies`, which are the
roots the fixture's peers are materialized from and therefore the release a
frozen `pnpm install` puts in this checkout's virtual store.

`fixture-release.mjs` makes that comparison, and BOTH entry points call it:

- `materialize.mjs`, wired as this package's `pretest`, so `pnpm test` — the
  step release CI runs before it builds an image — fails before any spec runs;
- `tests/vendor-fixture.spec.ts`, so a bare `vitest run` fails too.

A stale fixture fails like this, naming the version present and the version
expected, and never touches the tree:

```
[vendor] the vendored fixture does not match the DSH release this checkout installs.
[vendor]   - the vendored fixture is STALE: packages/workspace-k8s/tests/vendor/dsh-workspace holds @deepseek-ai/dsh-workspace@0.1.5-rc.3, but this checkout installs DSH 0.2.0-rc.2.
    present  (packages/workspace-k8s/tests/vendor/dsh-workspace/package.json): 0.1.5-rc.3
    expected (packages/workspace-k8s/package.json devDependencies: @deepseek-ai/dsh-brand, @deepseek-ai/dsh-storage, @deepseek-ai/dsh-storage-domain): 0.2.0-rc.2
    the fixture is the exact bytes the deployed image loads, so it has to be re-vendored from the release the image installs:
    npm pack @deepseek-ai/dsh-workspace@0.2.0-rc.2   # see packages/workspace-k8s/tests/vendor/README.md, "Re-vendoring"
[vendor] the vendored fixture was left untouched; re-vendor it from the expected release and re-run `pnpm test`.
```

This matters because a developer box can mask a stale fixture: its pnpm store
still caches the peers of the OLD release, so the materializer resolves them and
every spec passes locally while a clean CI store — which holds the shipped
release only — has nothing to resolve. That is how the 0.1.5-rc.3 fixture got
here, and the version check is what makes the two situations distinguishable
without inspecting a store.

If a future DSH release versions its packages inconsistently, the three roots
disagree with each other and the check says so instead of guessing; a human has
to decide what the fixture should be, loudly.

## The rebind semantics have not moved since 0.1.5-rc.3

`official-registry-harness.ts` stubs only `storageDomain` and
`sessionPersistence`; everything that decides the outcome is shipped code. On
re-vendoring `dsh-workspace` from 0.1.5-rc.3 to 0.2.0-rc.2 those decision points
were diffed line by line and are UNCHANGED:

- `get sessionIds()` still filters the durable account through
  `host.sessionPath(id) === record.path`;
- `attachSession` still short-circuits on `this.record.sessionIds.includes(id)`
  FIRST, and only its not-already-claimed branch reads the header, validates the
  cwd and calls `rememberSessionPath`;
- `mutate` still re-filters the account by that index inside
  `table.update`, aborting on the unchanged sentinel;
- `[Service.init]`, `replaceHeaderIndex`, `indexHeaders`, `listStoredHeaders`,
  `readSessionHeader` and `validateStoredState` are byte-identical.

0.2.0-rc.2 adds an `initializeDefault` first-use workspace, session pinning
(`pinnedSessionIds` in the domain global) and activity-gated archiving — none of
which the rebind path touches. The specs were re-run against the 0.2 bytes
unchanged; only version references in comments were updated. Do not "fix" a
failing rebind spec by relaxing it: if `attachSession`'s ordering ever does
change, the repair in `src/registry.ts` is what has to change with it.

## Materializing the peer tree

There is no manual copy step. `packages/workspace-k8s/package.json` wires
`tests/vendor/materialize.mjs` as its `pretest` script (pnpm runs the `pre*`
hook before the script it prefixes), so `pnpm test` in this package — and
`pnpm -r test` from the repository root — materialize the tree first, including
in release CI, which runs `cd packages/workspace-k8s && pnpm test` before it
builds any image.

The materializer copies each peer out of THIS workspace's pnpm virtual store
(`<workspace root>/node_modules/.pnpm/<name>@<version>_<peer-hash>/node_modules/…`,
or a package-local virtual store when pnpm is configured with one), flattened
into `node_modules/` so the vendored bytes resolve their peers from here. It
needs no network and no absolute store path, and it skips the copy when the
tree is already current for this fixture.

The three roots — `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-storage`
and `@deepseek-ai/dsh-brand` — are `devDependencies` of `packages/workspace-k8s`
pinned to the release in the table above, so the store always carries them and a
future `pnpm update` cannot silently move the fixture. The remaining five
packages arrive transitively through them (`dsh-invariants` as an
auto-installed peer of the domain form), so they are not declared twice.

NO range is a literal. Every one is read from the shipped declaration that owns
it, so a re-vendored fixture carries its own peer set with it and a hard-coded
range cannot outlive the bytes it described (the failure above was a stale
`^0.1.5-rc.2` for `dsh-invariants` — a range read from nothing at all):

| Requirement | Range read from |
| --- | --- |
| the three roots | `packages/workspace-k8s/package.json` `devDependencies` |
| `dsh-invariants`, `zod` | the VENDORED `dsh-workspace/package.json` (`peerDependencies` / `dependencies`) |
| `schemastery`, `cosmokit`, `@standard-schema/spec` | the `dependencies` of the package already resolved out of the store (`dsh-storage-domain`, then `schemastery`) |

The materializer resolves every requirement by package name plus that range
against the store entry — pnpm's peer-hash suffix changes on every install, and
a patch bump inside the range keeps working — then builds the new tree next to
the old one and swaps it in. When a required package is missing from the store
it exits non-zero BEFORE touching anything, naming the package, the declaration
the range came from, and the `pnpm add -D` line that fixes it, so the specs
never run against a half-populated tree.

Run it by hand when needed:

```sh
node tests/vendor/materialize.mjs          # materialize / verify the tree
node tests/vendor/materialize.mjs --force  # rebuild even when up to date
```

## Re-vendoring

`dsh-workspace` itself:

```sh
tmp=$(mktemp -d) && cd "$tmp"
npm pack @deepseek-ai/dsh-workspace@0.2.0-rc.2
tar xzf deepseek-ai-dsh-workspace-0.2.0-rc.2.tgz
# replace tests/vendor/dsh-workspace/ with package/ WHOLESALE (all of lib/,
# package.json, LICENSE and the READMEs) — do not hand-edit a file in there.
```

Then check the copy against what the deployment actually loads, byte for byte.
The image installs the official CLI globally (`docker/dsh-web-platform.Dockerfile`
stage 1) and copies its tree, so the CLI's own resolution is the reference:

```sh
dsh --version                                  # must equal the release above
npm ls @deepseek-ai/dsh-workspace --all        # must resolve to a single, deduped version
diff -r "$tmp/package" "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace"
```

The peers are re-vendored by changing what this package declares; the
materializer re-copies them from whatever the lockfile resolves, using the
ranges the vendored manifest itself declares:

```sh
cd packages/workspace-k8s
pnpm add -D @deepseek-ai/dsh-storage-domain@<version> \
             @deepseek-ai/dsh-storage@<version> \
             @deepseek-ai/dsh-brand@<version>
rm -rf tests/vendor/node_modules && pnpm test
cd ../.. && pnpm install
```

A failed materialization is the intended signal that the store and the fixture
disagree; it prints the exact `pnpm add -D` line for whichever package is
missing.

# Vendored official packages (test fixtures only)

The rebind tests must run against the REAL official workspace registry, not a
fake. The previous implementation's regression test modelled
`attachSession` as "refresh the cwd index, then short-circuit", which is the
opposite of what `@deepseek-ai/dsh-workspace` 0.1.5-rc.3 actually does (it
short-circuits FIRST, so an id the record already claims never refreshes the
index). A hand-written fake proves nothing about that ordering.

`dsh-workspace/` below holds the source of truth: the exact bytes of the
official package the deployed image loads. The peer packages it needs at import
time live in `node_modules/`, which `.gitignore` excludes; a fresh checkout
materializes them automatically — before `pnpm test` runs a single spec — with
`materialize.mjs` (below).

| Package | Version | Why |
| --- | --- | --- |
| `dsh-workspace` | 0.1.5-rc.3 | The entity + registry under test (exact bytes the deployed image loads) |
| `dsh-storage-domain` | 0.1.5-rc.2 | The registry's `DomainFacility.open(spec)` + zod record parsing |
| `dsh-storage` | 0.1.5-rc.2 | `UNIT_NAME_RE` / backend key helpers pulled in by the domain form |
| `dsh-brand` | 0.1.5-rc.2 | `brandString` / `brandNumber` used by the domain specs |
| `dsh-invariants` | 0.1.5-rc.2 | Peer of the domain form |
| `schemastery` (+ `cosmokit`, `@standard-schema/spec`) | 3.18.2 | The domain form's plugin `Config` declaration |
| `zod` | 4.4.3 | Record schemas (runtime files only: no `src/`, `v3/`, `mini/`, `v4-mini/`, `.d.ts`, `.cjs`) |

`dsh-workspace` is pinned at 0.1.5-rc.3 because that is what the deployed tree
resolves (see `.dshcmp/findings/file-backed-state-audit.md`); the peers are at
0.1.5-rc.2 because that is the highest 0.1.5 release the platform's own lockfile
already carries. The vendored `dsh-workspace` manifest itself asks for
`^0.1.5-rc.3` peers, so re-vendoring a build whose peers resolve differently
means bumping the peer pins deliberately (below) rather than letting them
float: these modules are part of the fixture's semantics, and a silent patch
bump would change what the rebind specs prove.

Do not edit the vendored files: a fixture whose bytes differ from the shipped
package proves nothing. `tests/official-registry-rebind.spec.ts` is what keeps
them honest — it fails loudly if these semantics ever change.

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
tree is already current.

The three roots — `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-storage`
and `@deepseek-ai/dsh-brand` — are `devDependencies` of `packages/workspace-k8s`
pinned to the exact builds in the table above, so the store always carries them
and a future `pnpm update` cannot silently move the fixture. The remaining five
packages arrive transitively through them (`dsh-invariants` as an
auto-installed peer of the domain form), so they are not declared twice. The
materializer resolves every requirement by package name plus a semver range
against the store entry — pnpm's peer-hash suffix changes on every install, and
a patch bump inside the range keeps working — then builds the new tree next to
the old one and swaps it in. When a required package is missing from the store
it exits non-zero BEFORE touching anything, naming the package and the
`pnpm add -D` line that fixes it, so the specs never run against a
half-populated tree.

Run it by hand when needed:

```sh
node tests/vendor/materialize.mjs          # materialize / verify the tree
node tests/vendor/materialize.mjs --force  # rebuild even when up to date
```

## Re-vendoring

`dsh-workspace` itself:

```sh
tmp=$(mktemp -d) && cd "$tmp"
npm pack @deepseek-ai/dsh-workspace@0.1.5-rc.3
tar xzf deepseek-ai-dsh-workspace-0.1.5-rc.3.tgz
# then copy package/lib, package.json and LICENSE over tests/vendor/dsh-workspace/
```

The peers are re-vendored by changing what this package declares; the
materializer re-copies them from whatever the lockfile resolves:

```sh
cd packages/workspace-k8s
pnpm add -D @deepseek-ai/dsh-storage-domain@<version> \
             @deepseek-ai/dsh-storage@<version> \
             @deepseek-ai/dsh-brand@<version>
# bump the matching transitive ranges in tests/vendor/materialize.mjs when the
# new builds moved them, then rebuild the tree and refresh the lockfile:
rm -rf tests/vendor/node_modules && pnpm test
cd ../.. && pnpm install
```

A failed materialization is the intended signal that the store and the fixture
disagree; it prints the exact `pnpm add -D` line for whichever package is
missing.

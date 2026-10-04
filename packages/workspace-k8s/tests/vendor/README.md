# Vendored official packages (test fixtures only)

The rebind tests must run against the REAL official workspace registry, not a
fake. The previous implementation's regression test modelled
`attachSession` as "refresh the cwd index, then short-circuit", which is the
opposite of what `@deepseek-ai/dsh-workspace` 0.1.5-rc.3 actually does (it
short-circuits FIRST, so an id the record already claims never refreshes the
index). A hand-written fake proves nothing about that ordering.

`dsh-workspace/` below holds the source of truth: the exact bytes of the
official package the deployed image loads. The peer packages it needs at import
time live in `node_modules/`, which `.gitignore` excludes, so a fresh checkout
materializes them with the copy commands at the bottom of this file.

| Package | Version | Why |
| --- | --- | --- |
| `dsh-workspace` | 0.1.5-rc.3 | The entity + registry under test (exact bytes the deployed image loads) |
| `dsh-storage-domain` | 0.1.5-rc.2 | The registry's `DomainFacility.open(spec)` + zod record parsing |
| `dsh-storage` | 0.1.5-rc.2 | `UNIT_NAME_RE` / backend key helpers pulled in by the domain form |
| `dsh-brand` | 0.1.5-rc.2 | `brandString` / `brandNumber` used by the domain specs |
| `dsh-invariants` | 0.1.5-rc.2 | Peer of the domain form |
| `schemastery` (+ `cosmokit`, `@standard-schema/spec`) | 3.18.2 | The domain form's plugin `Config` declaration |
| `zod` | 4.4.3 | Record schemas (runtime files only: no `src/`, `v3/`, `.d.ts`, `.cjs`) |

`dsh-workspace` is pinned at 0.1.5-rc.3 because that is what the deployed tree
resolves (see `.dshcmp/findings/file-backed-state-audit.md`); the peers are at
0.1.5-rc.2 because that is the highest 0.1.5 release the platform's own lockfile
already carries.

Do not edit the vendored files: a fixture whose bytes differ from the shipped
package proves nothing. `tests/official-registry-rebind.spec.ts` is what keeps
them honest — it fails loudly if these semantics ever change.

## Re-vendoring

`dsh-workspace` itself:

```sh
tmp=$(mktemp -d) && cd "$tmp"
npm pack @deepseek-ai/dsh-workspace@0.1.5-rc.3
tar xzf deepseek-ai-dsh-workspace-0.1.5-rc.3.tgz
# then copy package/lib, package.json and LICENSE over tests/vendor/dsh-workspace/
```

The peer packages come from an installed `dsh-platform` workspace (pnpm's store,
so no network):

```sh
cd packages/workspace-k8s/tests/vendor
S=../../../node_modules/.pnpm
copy() { # <store dir pattern> <package name>
  src=$(ls -d $S/$1/node_modules/$2 | head -1)
  dest=node_modules/$2
  rm -rf "$dest" && mkdir -p "$(dirname "$dest")"
  cp -r "$src/lib" "$dest/"
  cp "$src/package.json" "$dest/"
  [ -f "$src/LICENSE" ] && cp "$src/LICENSE" "$dest/"
}
copy '@deepseek-ai+dsh-storage-domain@0.1.5-rc.2*' '@deepseek-ai/dsh-storage-domain'
copy '@deepseek-ai+dsh-storage@0.1.5-rc.2*'        '@deepseek-ai/dsh-storage'
copy '@deepseek-ai+dsh-brand@0.1.5-rc.2*'          '@deepseek-ai/dsh-brand'
copy '@deepseek-ai+dsh-invariants@0.1.5-rc.2*'     '@deepseek-ai/dsh-invariants'
copy '@deepseek-ai+schemastery@3.18.2'             '@deepseek-ai/schemastery'
copy '@deepseek-ai+cosmokit@1.8.3'                 '@deepseek-ai/cosmokit'
copy '@standard-schema+spec@1.1.0'                 '@standard-schema/spec'
# zod keeps its runtime files only
cp -r $S/zod@4.4.3/node_modules/zod node_modules/zod
rm -rf node_modules/zod/{src,v3,mini,v4-mini}
find node_modules/zod \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.cjs' \) -delete
```

`node_modules/` is git-ignored, so it is not in the repository: a fresh checkout must
materialize it first (commands below) or the import of `dsh-storage-domain` fails
with a module-resolution error.


# The 0.2.0-rc.2 blocker — the rebind's session source (+ the stale README row)

**Status: complete.** `packages/workspace-k8s` now reads the durable session store from the
composition instead of through a proxy that throws, the session↔workspace rebind is proven to
run on a booted profile, every diagnostic the pass emits is reported once per condition (not
once per 60s tick), and the `user-domain` row is gone from `README.md`.

Branch `main`, three commits on top of `a69c4ab`, working tree clean, nothing pushed.

| commit | subject |
|---|---|
| `70493f7` | `fix(workspace-k8s): report each rebind condition once per occurrence` |
| `3105fe7` | `fix(workspace-k8s): read the session store through ctx.get, not the inject proxy` |
| `f39742b` | `docs(readme): drop the deleted user-domain package from the manifest` |

One-line verification: `pnpm -r build` clean, `pnpm -r test` **414 passed / 24 PostgreSQL-gated
skips / 0 failures and 0 load failures**, a FRESH `harness-profile.sh` profile installs and
imports all 9 platform plugins, both smokes pass, and three boots of the web profile show the
rebind repairing a real record where the pre-fix wiring could only warn (A/B/C below).

---

## 1. The defect, proven at runtime

`packages/workspace-k8s/src/index.ts` handed the reconciler a source whose `list()` read
`ctx.sessionPersistence` through the cordis context proxy — while the plugin's `inject` list
does not declare it:

```ts
const sessionHeaders: SessionHeaderSource = {
  list: async () => await ctx.sessionPersistence.list(),   // throws, every pass
}
```

Two cordis semantics make that a hard failure rather than a lazy miss:

* the proxy's `get` trap ends in `cannot get property "<name>" without inject` unless the
  reading fiber (or one of its parents) *injects* the service or holds it in its own store;
* a service provided by a **sibling row** — `session-persistence-rdb` mounts as its own fiber —
  is not reachable through the parent-fiber walk, so the root context's store never has it.

Hence every pass died with `cannot get property "sessionPersistence" without inject`. Because
the failure was caught and routed to a logger that had no sink until `27d212e`, the rebind
**never ran**, and the "sessions become Ungrouped after a pod replacement" repair did nothing.
Recorded from the deployed build (`.tmp-verify-logs/proof-with.out`):

```
WARN @visecy/dsh-workspace-k8s: workspace session rebind skipped: session persistence could not be listed:
  Error: cannot get property "sessionPersistence" without inject
```

and captured again as this work's control boot (§6, A).

---

## 2. The fix: `ctx.get`, lazily, per pass — not `inject`

`apply()` now builds the source as a per-pass resolution:

```ts
const sessionHeaders: SessionHeaderSource = {
  list: async () => {
    const persistence = ctx.get('sessionPersistence', false) as SessionHeaderSource | undefined
    if (persistence === undefined) {
      throw new Error("the 'sessionPersistence' service is not provided by this composition")
    }
    return await persistence.list()
  },
}
```

Why `ctx.get` and not `export const inject = ['sessionPersistence']`:

1. **A hard inject gates the whole plugin.** `workspace-k8s` owns the pod lifecycle, the
   endpoint resolver, the workspace API routes and the reconciler. Injecting a storage row
   would hold *all* of that pending until the store activates, and a composition without that
   row would never activate the workspace runtime at all. The two are unrelated capabilities.
2. **The shipped profiles mount the workspace row FIRST.** `dsh --profile web --dump-config`
   puts the platform inserts at the end of the list, in this order:
   `identity-bridge` (1296) → `workspace-runtime` (**1301**) → `storage-db` → `platform-domain`
   → `fs-k8s` → `subprocess-k8s` → `session-persistence-rdb` (**1330**) → `bash-local` →
   `workspace-picker`. "Session persistence is always present today" is therefore true of the
   *composition*, not of the plugin's activation moment; a hard inject would silently re-order
   the boot.
3. **Resolving per pass is strictly more correct.** A store that appears later is picked up
   without re-activating the plugin; no view is cached across passes; and `strict: false`
   accepts a provider whose fiber is still initializing (its own `list()` awaits its readiness)
   instead of reporting the composition as missing a row it has.
4. **The failure now names the missing service.** When there is no store at all, `list()`
   rejects with an error naming `sessionPersistence`, so the pass reports
   `workspace session rebind skipped: session persistence could not be listed: Error: the
   'sessionPersistence' service is not provided by this composition` — once, not every tick —
   instead of looking exactly like "no sessions to rebind".

The composition also gives a structural guarantee that the two paths meet: the official
`WorkspaceRegistry` row itself declares `static inject = ["storageDomain",
"sessionPersistence"]`, and the rebind only runs when that registry produced records — so a
pass that has anything to rebind has a live session store. That is exactly what the boots show:
no spurious "not provided" line, ever.

No public API change: `SessionHeaderSource` is internal to the package (the entry point does not
re-export it), no new runtime dependency, no DSH version change, no bundle patching, and the
plugin still has no user/permission concept.

---

## 3. The regression test that would have caught it

The existing suites were green throughout because every rebind test handed `WorkspaceReconciler`
a `SessionHeaderSource` directly — they never loaded the plugin, which is precisely where the
bug lived. A hand-built stub cannot see a wiring defect.

The trap is subtler than "no test mounts the plugin": the obvious fixture **also** misses it.
`startRegistry()` provisions both seams with `ctx.provide` on the ROOT context, and the proxy's
parent walk finds a root-provisioned service from any child. A profile mounts each seam as its
own row, so the store lives on a **sibling** fiber — the only shape that throws. The first
draft of the new test passed against the broken code for exactly that reason.

So `tests/official-registry-harness.ts` grows `startPluginComposition()`: the same real, vendored
official `WorkspaceRegistry`, but mounted as a plugin row whose two seams are provided by sibling
rows of their own — the loader's topology. `tests/plugin-session-rebind.spec.ts` mounts the
actual plugin (`apply` from `src/index.ts`) in it and asserts the rebind *reaches session
persistence*: the store's `list()` is called and the stored session ends up attached to the
record in the real registry, with no warning emitted.

RED, against the pre-fix `src/index.ts` (a probe run of the same composition):

```
registry list: [{"id":"ws-/tmp/dsh-probe-…/ws-a","path":"/tmp/dsh-probe-…/ws-a","sessionIds":[]}]
listCalls: 0
warnings: [
 "workspace session rebind skipped: session persistence could not be listed:
   Error: cannot get property \"sessionPersistence\" without inject",
 "…without inject"
]
sessions attached: [[]]
```

```
$ ./node_modules/.bin/vitest run tests/plugin-session-rebind.spec.ts
 × … > reaches ctx.sessionPersistence and repairs the association at load
   → timed out waiting for the reconcile pass
```

The second test in that file pins the inverse composition (registry, no session store): the
rebind is skipped, the pass says so once, naming the service, across many interval passes.

RED: `expected [ …(4) ] to have a length of 1 but got 4` → GREEN: 1 line.
GREEN after the fix: `Test Files 20 passed (20) / Tests 151 passed (151)` for the package.

---

## 4. Making the class of defect visible (`70493f7`)

Three changes, each with tests that were watched failing first
(`tests/reconciler-observability.spec.ts`, 7 → 10 tests):

* **Once per condition, not per tick.** Every line the pass emits describes a condition; the
  pass now remembers what the previous pass reported and emits a message only when it is new.
  A condition that clears and later returns is reported again — the line marks the change, not
  the tick. RED: `expected [ …(3) ] to have a length of 1 but got 3`.
* **Overlapping passes are serialized.** A probe boot showed the load-time pass and the
  registry-retry pass overlapping (the second started 430 ms into the first; they finished 8 ms
  apart), and each compared against the other's half-filled set — a single boot-time fault
  printed twice. `reconcile()` now queues a pass behind the one in flight, which also means the
  retry re-reads the registry that just appeared instead of sharing the snapshot taken before it
  existed. RED: `expected [ …(2) ] to have a length of 1 but got 2`.
* **The `SessionHeaderSource` contract is documented**: `list()` must reject, naming the missing
  service, when there is no store to read. That is what lets the pass distinguish "no source"
  from "no sessions".

---

## 5. README

`README.md:52` (`| user-domain | per-user settings/credentials（**尚未接线**） | Plan 3 |`) is
deleted — the package itself was removed in `5af0ea5`. No other `README.md` reference to
`user-domain` remains; the `design/*.md` mentions are historical upgrade records and stay.

---

## 6. Verification (final committed state)

All commands from `/home/ovizro/Code/dsh-platform` at `f39742b`; full log in
`.tmp-verify-logs/final-verify-rebind.log`.

### 6.1 `pnpm -r build`

```
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
BUILD_EXIT=0
```

### 6.2 `pnpm -r test` — 414 passed, 24 skipped, zero load failures

```
logging-stdout test:              Tests  10 passed (10)
platform-domain test:             Tests   2 passed (2)
auth-oidc test:                   Tests   7 passed (7)
identity-bridge test:             Tests  31 passed (31)
storage-db test:                  Tests   1 passed (1)
workspace-picker test:            Tests   7 passed (7)
session-persistence-rdb test:     Tests 129 passed | 24 skipped (153)
sandbox-daemon test:              Tests  36 passed (36)
fs-k8s test:                      Tests  24 passed (24)
workspace-k8s test:               Tests 151 passed (151)      ← was 146; +5 new tests
subprocess-k8s test:              Tests  16 passed (16)
TEST_EXIT=0            (grep -ciE "FAIL|ERR_PNPM" → 0; no suite failed to load)
```

`workspace-k8s` went from 146 to 151 tests: +2 plugin-wiring, +3 observability.

### 6.3 `bash scripts/harness-profile.sh .tmp-harness-rebind-final`

```
ok   @visecy/dsh-logging-stdout      ok   @visecy/dsh-storage-db
ok   @visecy/dsh-fs-k8s              ok   @visecy/dsh-platform-domain
ok   @visecy/dsh-subprocess-k8s      ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-workspace-k8s       ok   @visecy/dsh-identity-bridge
ok   @visecy/dsh-session-persistence-rdb
check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1)
harness ready: .tmp-harness-rebind-final
HARNESS_EXIT=0
```

### 6.4 `node scripts/check-plugin-imports.mjs <profile>`

```
check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
```

### 6.5 Both smokes

```
$ node scripts/smoke-zero-patch.mjs --target …/profiles/web
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path   (exit 0)

$ node scripts/smoke-official-integration.mjs --target …/profiles/web
ok   identity-bridge provides ctx.dshAuth over the sidecar headers
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement …             (exit 0)
```

### 6.6 Boot-time proof — the rebind now runs, and says only real things

Fixture (`.tmp-verify-logs/seed-proof.mjs`, verification-only, nothing ships): the SQLite stores
are seeded through the REAL backends — a workspace record whose anchor exists, `sessionIds: []`,
`initialized: true` (so the registry's one-shot history bootstrap is **skipped** and only the
rebind can repair it), and one stored session header whose `cwd` is that anchor. The overlay
(`.tmp-verify-logs/rebind-proof.patch.yml`) points the storage rows at those files and moves
`hostRoot` into the repo. The profile is the shipped web profile plus that overlay; the logger
row gives stdout a sink, so **this is stdout, not a debugger**.

**A — control, the pre-fix wiring, same fixture** (`.tmp-verify-logs/rebind-boot-A.out`):

```
WARN @visecy/dsh-workspace-k8s: workspace session rebind skipped: session persistence could not be
     listed: Error: cannot get property "sessionPersistence" without inject
WARN @visecy/dsh-workspace-k8s: workspace session rebind skipped: session persistence could not be
     listed: Error: cannot get property "sessionPersistence" without inject
AFTER: ws-proof sessionIds = []          ← the rebind never ran
```

(The deployed build, with no dedupe at all, wrote that line on every pass — see
`.tmp-verify-logs/proof-with.out`.)

**B — fixed wiring, same fixture** (`final-boot-B.out`):

```
BEFORE: ws-proof sessionIds = []
HTTP probe: GET / -> 302
=== stdout ===
                     ← empty: no "without inject", and no phantom replacement warning
=== stderr ===
AFTER:  ws-proof sessionIds = ["session-rebind-proof"]   (updatedAt during the boot)
```

That write can only come from `attachSession` through the rebind: the bootstrap is skipped
(`initialized: true`), there are no live sessions, and nothing else writes a record's membership.
The association survives the next pod replacement, which is the whole point of the repair.

**C — fixed wiring, stored `cwd` gone** (`final-boot-C.out`) — the pass's *reported* outcome is
now a real session-source outcome:

```
WARN @visecy/dsh-workspace-k8s: workspace session rebind skipped session 'session-rebind-proof':
  its cwd '/home/ovizro/Code/dsh-platform/.tmp-verify-logs/proof-workspaces/ws-missing' does not
  resolve: Error: ENOENT: no such file or directory, realpath '…/ws-missing'
line count: 1        ← load-time pass + registry retry report the condition once
without-inject occurrences: 0
```

The session id and path in that line can only come from a successful
`sessionPersistence.list()` through the plugin's own wiring.

---

## 7. Concerns

1. **PostgreSQL is still unexercised** — unchanged from the predecessor's report: no server, no
   docker, 24 `pg.spec.ts` tests skipped. The rebind change is backend-agnostic (it consumes
   `ctx.sessionPersistence.list()`), and the boot proofs ran the SQLite rdb backend.
2. **The boot proofs are not a deployment rehearsal.** They run the shipped web profile plus a
   verification-only SQLite overlay on this dev box, which does have a live cluster
   (`~/.kube/config` → `kube-plane-endpoint.visecy.top`), so the pass listed real PVCs and
   bridged them — useful, but still not a rehearsal of the image, and no image was built (no
   docker here).
3. **A composition with no session row now warns once at boot.** That is deliberate: silence is
   how this defect survived. If a future profile legitimately has no session persistence, the
   line is the price of never mistaking "no store" for "no sessions"; it is emitted once per
   uninterrupted occurrence, not per tick.
4. **A pass that hangs queues the next one.** `reconcile()` serializes passes without
   coalescing, so a pass stuck on a timeout-less network call would let interval passes queue
   behind it. Bounded by the 60s interval in practice; the alternative (joining the in-flight
   pass) weakens the startup retry, which is why it was not chosen.
5. **`ctx.get(name, false)` reads a registered provider whose fiber is not yet active.** That is
   intentional (its `list()` awaits its own readiness), but it does mean a future backend that
   answers `list()` with an empty array before opening its store would read as "no sessions"
   rather than as an error. No backend in the tree does that today.
6. **The C-boot line is per session.** A deployment with many unresolvable session `cwd`s emits
   one line per session per occurrence. That is bounded by the stored session count and
   deduped per pass, and each line names a session that will otherwise stay Ungrouped forever.
7. **Verification artifacts are gitignored, not committed**: `.tmp-harness-rebind-final/`
   (fresh harness), `.tmp-verify-logs/` (`seed-proof.mjs`, `rebind-proof.patch.yml`, the three
   boot captures, `final-verify-rebind.log`, `proof-*.db`). `.superpowers/sdd/.gitignore`
   ignores this report too; it is force-added like its predecessors.

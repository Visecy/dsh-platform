# Plan 8 — four operator-hit defects: root causes, fixes, verification

Status: **all four fixed and committed**, one commit per defect, each independently
revertible. Branch `main`, base `51ec5f3`.

| # | Commit | Subject |
|---|--------|---------|
| 1 | `ed944c6` | `fix(workspace-ui): style the new-workspace dialog's buttons` |
| 2 | `051ae54` | `fix(workspace-k8s): prune the record of a workspace whose PVC is gone` |
| 3 | `24a95b1` | `fix(workspace-k8s): make the panel report the observed cluster, not a stale phase` |
| 4 | `8af5d19` (+ `test(platform-domain)`) | `fix(platform-domain): keep stored credentials in PostgreSQL, not in DSH_HOME` |

Write scope respected: only `packages/workspace-k8s/**`, `packages/platform-domain/**`,
`docker/profiles/*.cordis.patch.yml`. No DSH version change, no new runtime
dependency, no bundle patching, no re-vendoring of the deleted UI bundle. The two
restored surfaces and the earlier wins are intact (their specs still pass):
name-based dialog on both `directoryFlow` seats, the `conversation.view` detail
view, no `shell.overlay` pill, delete destroys the workspace.

The action-level post-deploy checklist lives in
`.superpowers/sdd/live-verification-checklist.md` and is reproduced in §6.

---

## 1. Verification output (pasted)

### `pnpm install --frozen-lockfile`

```
Scope: all 15 workspace projects
Already up to date
Done in 1.1s using pnpm v11.25.0
```

### `pnpm -r build`

```
packages/session-persistence-rdb build: Done
packages/sandbox-daemon build: Done
packages/fs-k8s build$ node ../../scripts/build-pkg.mjs fs-k8s src/index.ts
packages/subprocess-k8s build$ node ../../scripts/build-pkg.mjs subprocess-k8s src/index.ts
packages/workspace-k8s build$ node ../../scripts/build-pkg.mjs workspace-k8s src/index.ts && node ../../scripts/build-workspace-ui.mjs
packages/subprocess-k8s build: built subprocess-k8s -> dist/index.js
packages/fs-k8s build: built fs-k8s -> dist/index.js
packages/subprocess-k8s build: Done
packages/fs-k8s build: Done
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
```

`packages/*/lib/client.js` and the four committed `packages/*/dist/index.js`
artifacts (`logging-stdout`, `platform-domain`, `session-persistence-rdb`,
`storage-db`) are updated in the same commits, and the tree is clean after a
rebuild (the build is a pure function of the sources).

### `pnpm -r test`

```
packages/workspace-k8s test:  Test Files  29 passed (29)
packages/workspace-k8s test:       Tests  239 passed (239)
packages/fs-k8s test:         Test Files   3 passed (3)
packages/fs-k8s test:              Tests  31 passed (31)
packages/session-persistence-rdb   Tests  129 passed | 24 skipped (153)
… one summary line per package …
```

Totals over the run (`TEST_EXIT=0`):

```
passed: 525
Tests  129 passed | 24 skipped        ← the PostgreSQL-gated suite
failures / load errors: none
```

488 passed before this work, 525 after — the +37 are the cases added here
(4 dialog-stylesheet, 6 wire/endpoint, 6 reconciler-prune, 6 management-phase,
13 credentials unit, 2 credentials-over-the-real-storage-stack); several of them
REPLACE weak assertions that could not fail, see below. The 24 skips are the same
PostgreSQL-gated ones as before, and no spec file failed to load.

### `bash scripts/harness-profile.sh .tmp-plan8/harness`

```
ok   @visecy/dsh-logging-stdout
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain
ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-identity-bridge

check-plugin-imports: all 9 plugins import cleanly from .tmp-plan8/harness/home/profiles/web
ok   @visecy/dsh-logging-stdout
…
check-plugin-imports: all 7 plugins import cleanly from .tmp-plan8/harness/home/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1): … use 127.0.0.1 instead
harness ready: .tmp-plan8/harness
```

### `node scripts/check-plugin-imports.mjs <profile>` (both)

```
check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
```

### Both smokes

```
$ node scripts/smoke-zero-patch.mjs --target …/profiles/web/node_modules        # exit 0
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path

$ node scripts/smoke-official-integration.mjs --target …/profiles/web/node_modules  # exit 0
ok   identity-bridge provides ctx.dshAuth over the sidecar headers
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
```

### Composition check for defect 4 (real `--dump-config`, both profiles)

```
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
  disabled: true
- id: platform-domain
  name: '@visecy/dsh-platform-domain'
  config:
    backend: postgres
```

---

## 2. Defect 1 — the restored dialog had no button styles

### Root cause (measured, not assumed)

The mask, the card, the copy, the input, the error line and the footer were all
present and injected; the two FOOTER BUTTONS were not styled at all. The dialog
renders `dsh-ws-btn` / `dsh-ws-btn primary`
(`NewWorkspaceDialog.tsx:55-56`), and **no revision of `styles.ts` since
`f9f3886` defines those classes**: that commit rewrote the stylesheet for the
vendored browser, introduced the detail page's `dsh-wsd-btn` family and dropped
the modal button rules. The dialog was then deleted (`cd70daa`), partially
restored at `9d70232` — markups and the mask/card rules, from `bc6689a^`, which
itself no longer had the button rules — and the gap survived two "restore the UI"
commits because the existing assertions only checked two selectors
(`new-workspace-slots.spec.ts:90-91`: `.dsh-ws-modal-overlay`,
`.dsh-ws-modal-error`).

So the operator's "browser-default form" is precisely: a styled card with two
user-agent buttons in it, plus (in their build) whatever else predated the mask
restore. The claim "the CSS was lost when styles.ts was rewritten" is right about
the buttons and *not* right about the mask/card, which were already back — this
report corrects that because the difference decides what a regression test has to
pin.

### Fix

Recovered the rules from the pre-rewrite stylesheet
(`git show a52517b:packages/workspace-k8s/src/client/styles.ts`, where the
dialog's buttons last had styling): `.dsh-ws-btn`, `:hover`, `.primary`,
`:disabled` — re-expressed in the design tokens the rest of the file uses
(`--dsw-alias-*`, same values as `.dsh-wsd-btn`) instead of that revision's
hard-coded GitHub grays, so the dialog follows the theme and the two button
families cannot drift apart again. Injection needed no change: `apply()` calls
`injectPanelStyles()`, the guard attribute is `data-dsh-workspace-ui`, and both
are now asserted rather than assumed.

### Tests

New `tests/workspace-dialog-styles.spec.ts`, against the SHIPPED
`lib/client.js` through the existing client harness:

1. the stylesheet is appended to `document.head`, exactly once per document, and
   carries `data-dsh-workspace-ui`;
2. every className the dialog RENDERS has a rule in the stylesheet the plugin
   actually injected (comment-stripped, whole-class-token selector matching, so
   `.dsh-ws-modal-overlay` cannot be satisfied by `.dsh-ws-modal-desc`);
3. the card is a fixed-position mask and the two footer buttons are the
   platform's, the primary visually distinct.

TDD: before the fix the coverage case failed on exactly
`['dsh-ws-btn', 'dsh-ws-btn primary']`. Supporting harness change: the document
stand-in now KEEPS the appended `<style>` and answers the plugin's guard
selector with it (it used to drop it, which is why "is it injected?" was
untestable).

### Unverifiable without a cluster/browser

The rendered appearance in a real browser (computed styles, the design system's
variables resolving, the mask stacking above the real frame). The spec proves the
rules exist, match the rendered elements and are injected exactly once.

---

## 3. Defect 2 — a deleted workspace's record survived forever

### Root cause

`WorkspaceReconciler.pass()` was add-only: it bridged k8s resources INTO the
official registry (`registry.create` for every PVC-backed id) and never looked at
a record again. The only removal path was an operator pressing the platform's
delete (which removes pod+PVC+record) or the official sidebar delete (caught by
`record-deletions.ts`). A delete that destroyed the PVC but left the record
(registry write failed/skipped, volume removed out of band, a lost condemnation
across a restart) therefore left a permanent row: nothing ever asked "does this
record still have a volume?". The two existing "does not reclaim" specs even
passed an `onDelete` option that `ReconcilerOptions` never declared — they
observed a hook the pass never called.

### Fix

`pruneStaleRecords()`, the mirror of the bridge, guarded so it can never act on
inference. A record is removed only when ALL hold:

- its id has no PVC in this pass's snapshot;
- **this process has seen that id backed by a volume before** (`volumesSeen`);
- no pod runs for it;
- it is not condemned by `record-deletions.ts`;
- the pod AND PVC listings both SUCCEEDED this pass.

The discriminator, stated in the field's comment: the cluster cannot tell "its
PVC existed and is now gone" from "it never had a PVC here" — both are "a record,
no PVC" — and they need opposite treatment, because `management.create` writes the
record BEFORE anything creates the volume (that IS what mid-provision looks
like) and an adopted-from-outside record never had one. Only observation history
separates them. Two deliberate limits, documented in the code: the memory is
in-process (a ghost older than a restart is pruned after the next observe-then-miss,
the same price `record-deletions.ts` pays), and an entry is dropped the moment its
record is pruned, so a workspace RE-created under the same id is judged from
scratch.

The listing guard is load-bearing: the pass used to read the cluster with
`.catch(() => [])`, which makes a FAILED listing indistinguishable from an empty
cluster; pruning on that would delete every workspace on one API hiccup. Reads
now carry an `ok` flag (new `readOr` helper) and a failed listing skips the prune
with a reported line instead of acting on it. A pruned record cannot be
re-created: the bridge only creates records for PVC-backed resources and the
volume is exactly what is missing — asserted, not assumed.

### Tests (`tests/reconciler.spec.ts`, 6 new cases; the three prune cases failed
before the fix)

watched-then-missing ⇒ removed (and reported); never-had-a-volume record survives
repeated passes; live-pod record survives; unreadable listing prunes nothing and
says so; a pruned record is not re-created by later passes; a re-created
workspace keeps its fresh record. The two existing specs that passed the phantom
`onDelete` now assert the registry's own state.

### Unverifiable without a cluster

That the operator's specific ghost disappears on their cluster (it depends on
whether their control plane has observed that workspace's PVC since its last
restart — if not, one observe-then-miss cycle is needed, i.e. delete and let a
pod run once, or simply delete again). Failure mode to watch in the pod log:
`workspace reconcile: could not list the cluster's …` means the prune is being
skipped, not that it is broken.

---

## 4. Defect 3 — panel says 休眠 while usable, and a workspace nobody created

### 3a. `agents` read 休眠 while it was usable

**Root cause.** `WorkspaceManagement.entry()` returned the in-memory lifecycle
phase verbatim whenever a state existed (`management.ts`, old
`if (state !== undefined) phase = state.phase`). A workspace is woken ON DEMAND
by the endpoint resolver: every fs/subprocess operation calls
`runtime.ensure(workspaceId)` (`wire.ts`, `resolveEndpoint`), which creates the
pod — and that path never passes through `management.ensure`, so the state
machine was never told and its phase stayed `sleep`. The panel then reported a
workspace that was serving requests as asleep. The inversion also existed in the
other direction (a tracked `running` reported for a pod that had already gone).

**Fix, two halves.**

1. `phaseFor()`: the catalog reports the OBSERVED cluster state — pod+PVC =
   running, pod only = orphan, PVC only = sleep, nothing = sleep — with the two
   IN-FLIGHT phases (`provision`, `waking`) as the deliberate exception. That is
   not a hole in "observed wins": while a pod is being created the cluster
   legitimately shows no pod yet, so the observation would flash 休眠 over a
   workspace being woken, and both in-flight phases end at a transition
   (`pod-ready`/`pod-lost`) — unlike `sleep`, which is exactly what a stale claim
   looks like. `deleted` survives only in the empty-observation case, where it
   cannot contradict anything.
2. `resolveEndpoint` now reports the wake (`manager.attach`, i.e. `user-attach`).
   The panel is truthful either way, but without it the transition that starts
   the IDLE TIMER never ran, so a workspace woken on demand kept its pod up
   forever instead of sleeping after the idle timeout. It is a no-op for a
   workspace already running (asserted: no re-provision per operation).

**Tests.** `management.spec.ts`: six observed-vs-tracked cases (three failed
before the fix: sleep+pod, running+no-pod, running+pod-only-without-PVC). New
`wire-endpoint.spec.ts`: a slept workspace leaves `sleep` on an on-demand wake; a
first-time wake reports running; a running workspace is not re-provisioned per
operation.

### 3b. `agents-local-md` appeared without the operator creating it

**The mechanism, traced in the code (this much is certain).** A workspace id on
this platform is simply the FIRST path segment under the host root:
`FsK8s.workspaceOf()` / `SubprocessK8s.workspaceOf()` take
`anyAbsolutePath.split('/')[0]` under `/workspaces`, and both providers resolve
the daemon endpoint through `workspaceEndpointResolver.resolve(workspaceId)`
(`fs-k8s/src/index.ts:151-158`, `subprocess-k8s/src/index.ts:99-106`), which
called `runtime.ensure(workspaceId)` → `ensurePvc` → **creates PVC
`<id>-data` and a pod for whatever id a path produced**. One reconcile pass later,
`WorkspaceReconciler` bridged that PVC into the official registry
(`registry.create('/workspaces/<id>')`) and the sidebar showed a workspace. So:
any file operation on an ordinary directory under `/workspaces` that no record
describes materializes a whole workspace — PVC, pod and sidebar row — with a name
nobody chose as a workspace name. `bash-local` runs with `cwd: '/workspaces'`
(web profile), so such a directory is exactly what a shell command or an agent
creates; `agents-local-md` has the shape of an agent-authored directory
("local markdown"), not of a workspace the operator typed, and nothing in the
name-dialog path can derive it (the dialog has one empty-controlled input and
commits the typed value verbatim; `sanitizeWorkspaceName` only lowercases,
dashes and truncates — it never appends a suffix like `-local-md`).

Two other candidate mechanisms were checked and ruled out from the code: the
official directory-picker dialog cannot be reached from workspace creation (the
platform's dialog occupies both `directoryFlow` seats at priority `-100`, and the
official slot source states the rule — *"register at a different priority to
shadow it (lowest renders)"*, entries sort ascending —
`dsh-client-ui-slots/lib/index.js:167-221`), and neither `management.create` nor
the reconciler invents names (the reconciler copies the PVC's id).

**Fix (the defect half).** A fence at the choke point every fs and subprocess
operation already goes through: `resolveEndpoint` refuses to provision an id no
record describes. An fs or subprocess operation may WAKE a workspace; it must
never CREATE one. Only a POSITIVE "no such record" refuses — a registry listing
that fails is not an answer, so the resolver's `catch` proceeds and the file view
is not gated on the registry being up. `management.ensure` (the panel's explicit
wake button, always driven by a listed row) is deliberately NOT fenced.

**Tests.** `wire-endpoint.spec.ts`: a path naming no registered workspace is
refused with a message naming it and creates NOTHING (no ensure, no PVC/pod, no
lifecycle state); a registered workspace still wakes; a registry that cannot
answer still provisions.

**What remains unproven from the code alone** — precisely: WHICH path produced
`agents-local-md` on that cluster. The chain above is proven; the origin of the
directory is an observation only the deployment can supply. Run these, in order:

```bash
NS="${WS_NAMESPACE:?}"
# 1. Did the platform create a volume for it (i.e. an ensure ran for that id)?
kubectl -n "$NS" get pvc agents-local-md-data \
  -o jsonpath='{.metadata.creationTimestamp}{"\n"}{.metadata.labels}{"\n"}'
#    a timestamp + labels {app: dsh-workspace, …} ⇒ the platform's ensurePvc
#    created it (the pre-fix chain), and the timestamp is when the phantom was born.
#    NotFound ⇒ the record came from somewhere else (check .spec.volumeName / a
#    hand-made PVC, and the directory's own mtime below).

# 2. Which session was working under that path when it appeared? (cwd is durable.)
psql "$DSH_PG_CONNECTION_STRING" -c \
  "SELECT f_session_id, f_cwd, to_timestamp(f_created_at/1000) AT TIME ZONE 'UTC'
     FROM t_sessions
    WHERE f_cwd LIKE '/workspaces/agents-local-md%' OR f_cwd = '/workspaces'
    ORDER BY f_created_at DESC LIMIT 20;"
#    A session whose cwd is /workspaces (the bash-local row's cwd) plus a
#    /workspaces/agents-local-md probe ⇒ the directory was created by a shell/
#    agent command and then adopted by a file operation, exactly as traced.

# 3. The directory itself (control-plane anchor):
kubectl -n "$NS" exec deploy/<control-plane> -- \
  sh -lc 'ls -la --time-style=full-iso /workspaces/agents-local-md; stat -c "%y %n" /workspaces'
#    Its mtime should match item 1/2's window; empty or markdown-only contents
#    confirm it was never a workspace.

# 4. Does the deployment's config differ from what the profile ships?
kubectl -n "$NS" exec deploy/<control-plane> -- dsh --profile web --dump-config \
  | grep -A2 '^- id: credentials$'
#    (used by §5 below; nothing to do with the phantom)
```

If item 1 returns `NotFound` and item 3 shows a directory the operator (not an
agent) created, the remaining explanation is the official picker's
"create directory" flow having been reachable at some point in that build: the
evidence to look for is a workspace record whose `path` is that directory
(`SELECT key, value_json FROM dsh_storage_records WHERE unit='workspace';` — the
record's `path` and `createdAt`). Either way the fence added here stops the
materialization, and the checklist's item 2.3 is the live re-test.

### Unverifiable without a cluster

Panel-vs-reality on real pods, the idle-timer behaviour after an on-demand wake,
and the phantom re-test — all four are in the checklist (§6) as clickable actions.

---

## 5. Defect 4 — the model API key died with the pod

### What the 0.2 seams actually are (quoted from the installed packages)

**Credentials — a real provider seam.** `@deepseek-ai/dsh-credentials`,
`lib/types/index.d.ts`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context { credentials: CredentialProvider; }
}
export declare abstract class CredentialProvider extends Service {
    abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
    abstract describe(ref: CredentialRef): Promise<CredentialInfo>;
    abstract set(ref: CredentialRef, value: string): Promise<void>;
    abstract unset(ref: CredentialRef): Promise<void>;
    abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
    abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;
    abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;
    abstract modifyRecord(key, mutate): Promise<CredentialRecord | undefined>;
    abstract deleteRecord(key: CredentialKey): Promise<void>;
}
```

and `dsh-credentials/lib/index.js:110` — `super(ctx, "credentials")`. The row is
swappable in the profile: `--dump-default-config` lists
`- id: credentials / name: '@deepseek-ai/dsh-credentials-local'`, whose spec
(`dsh-credentials-local/lib/index.js`) is "File-backed credentials provider over
`$DSH_HOME/.credentials.yaml`". The model key IS a credential:
`dsh-llm-deepseek-api-key/lib/index.js` resolves
`ctx.get("credentials").resolve(ref)` with `ref = credentialRef('DEEPSEEK_API_KEY')`
(its own error text: *"store ${ref} through the credentials service (the web
Models page writes it)"*), and the web page writes it through
`dsh-api-settings-controller`, whose credentials namespace calls
`credentials.set(branded, request.value)`.

**Settings — no provider seam exists in 0.2.** `@deepseek-ai/dsh-settings`,
`lib/types/index.d.ts`: `ctx.settings` is `SettingsForms`, a concrete `Service`
(no abstract base, no `SettingsProvider` — that class is gone), whose
`documentPath` is `this.ownerContext.configEditor.documentPath` and whose
`prepareDocument()` returns it; its private `importLegacyDocument()` only ever
imports the REMOVED `settings.yaml` once
(*"Move the sections of the removed `settings.yaml` into the active profile"*).
`@deepseek-ai/dsh-config-editor`: `ConfigEditor extends Service`, "Persist
complete raw configs and apply them through the normal Loader path", writing the
profile patch document whose path is `profileContext.patchPath` — a file the
Loader reads from disk at boot. A durable settings store would therefore mean
reimplementing that writer AND materializing its document before the Loader reads
it; neither is a supported seam, and a mirror under `DSH_HOME` would be exactly
the durable-state-under-DSH_HOME this task forbids.

### What was implemented

`packages/platform-domain/src/credentials.ts` — `CredentialStore`, a cordis
`Service` registering `credentials` (the service NAME is the contract, the same
structural posture this repo already takes at official seams, e.g.
`HostWorkspaceRegistry`), over the `platform_credentials` domain table the same
package already declares and opens on PostgreSQL
(`userId/scope/id/kind/payload`; `platform-domain/src/index.ts` now publishes the
provider right after `ctx.provide('platformDomains', …)`, so the record medium
and the service that owns it cannot drift apart). Reference rows are keyed
`ref:<NAME>`; record rows keep their `<scope>/<id>` address; the owner column is
the constant `platform` (documented: the seam has no user concept, so a
per-user partition would be a fiction).

Deliberately reproduced official behaviours, each pinned:

- the launching environment (the launcher's `launchEnvironment` snapshot when the
  CLI provides one, else the inherited environment) is layered OVER the store and
  is read-only: `set`/`unset` REFUSE a write the environment would shadow;
- an empty value is absent everywhere (refused on write, `unset` is what removes);
- validation at the durable boundary (non-empty api-key, env names in the
  reference grammar, non-empty env values, JSON-round-trippable grant payloads) —
  a row that cannot be read back is a credential that silently stopped working;
- `modifyRecord` is a serialized read-decide-write (queue tail), `undefined`
  writes nothing;
- `credentials/reference-updated` / `credentials/record-updated` are emitted
  after a committed write.
  Narrower on purpose, and documented: the `.env` fallback layers are never read
  from disk here (they would point into the same ephemeral `DSH_HOME`).

Both profiles disable the official row (`- id: credentials / disabled: true`),
because exactly one provider may register a service name, and both profiles must
agree or a headless run would look for the key in an empty file. Verified against
the real composition (`--dump-config`, §1). No Dockerfile change was needed:
`platform-domain` is already copied and installed in both profiles. No new
dependency: the provider adds no package.json/lockfile change, so
`pnpm install --frozen-lockfile` stays green.

### Tests

`packages/platform-domain/tests/credentials.spec.ts`, 13 cases. The first boots a
SECOND store over the same table and reads the value back — that is what
"survives a pod replacement" means — then the environment layering and its
read-only refusal, the service-name contract, unconfigured reporting, the
empty-value rule with "no write when absent", the event, the reference grammar,
the record half (including the declined write leaving the row untouched),
a verbatim grant payload read back by a replacement store, concurrent rotation
serialization (`['v1','v2']`, ending at `v3`), and the two refusals.

`packages/platform-domain/tests/credentials-storage.spec.ts`, 2 cases over the
REAL stack (`storage-db` backend + `defineDomain`/`DomainFacility` + the declared
zod schema, which the stub table cannot exercise): a value written by one context
is read back by a REPLACEMENT context over the same database file, and the stored
row is inspected directly to pin the layout the checklist's SQL queries
(`dsh_storage_records`, unit `platform_credentials`, table `credentials`, key
`ref:DEEPSEEK_API_KEY`, row shape). SQLite, since the suite has no PostgreSQL —
same table layout as the postgres backend, dialect covered by the PG-gated
suite.

### Unverifiable without a cluster

The real write/read against PostgreSQL (the suite's PG-gated cases skip without a
database), the Models page round trip, and survival across an actual pod
replacement. §6 items 5.1–5.7 are the live checks; §6 item 5.6 records the
settings limitation as an EXPECTED negative so it is not mistaken for a
regression.

---

## 6. The live-verification checklist

Written to `.superpowers/sdd/live-verification-checklist.md` (it exists; it is
the canonical copy and covers everything below in runnable form):

1. **Dialog styling** — click sidebar `+`: centred masked card, one focused name
   input, footer 取消 + filled 创建; devtools:
   `document.querySelectorAll('style[data-dsh-workspace-ui]').length === 1` and the
   text contains `.dsh-ws-btn.primary`; mask click closes; `Enter`/创建 submit; an
   invalid name shows the API message inline.
2. **Create** — type `qa-<hhmm>`, expect a sidebar row and a panel row within
   ~10 s and `kubectl get pvc qa-<hhmm>-data` Bound; open a session, do a file
   operation, check the detail view. **Phantom re-test**: write
   `/workspaces/qa-not-a-workspace/probe.txt` → the operation FAILS naming it and
   no PVC/row appears (pre-fix: PVC + row ~60 s later).
3. **Delete** — delete `qa-del` from the panel and from the official sidebar:
   row gone in ~2 s from both surfaces, and `kubectl get pvc/pod/svc` all
   `NotFound`; wait two reconcile passes and reload: it must NOT return.
   **Ghost case**: delete `qa-ghost`'s pod and PVC → within ≤2 passes the row is
   gone and the log shows `workspace reconcile: removed the record of 'qa-ghost'`.
   **Safety counterpart**: `qa-keep` (record, never a volume) must survive, and a
   record whose pod still runs must survive as an orphan until cleanup.
4. **Panel vs reality** — sleep `qa-phase` from the panel: phase 休眠, pod gone,
   PVC kept. Wake it by OPENING A SESSION (not the button): pod Running and the
   panel reads 运行中 within ~5 s of readiness, never 休眠 while serving. Press
   唤醒 on a sleeping workspace: 启动中/唤醒中 then 运行中, never a flash of 休眠.
   Cross-check every row against `kubectl get pod,pvc -l app=dsh-workspace`.
   Finally leave it idle for `WS_IDLE_TIMEOUT_MS` and expect it to sleep BY
   ITSELF (the on-demand wake must re-arm the idle timer).
5. **Credentials survive a restart** — enter the key on the Models page; verify
   the row in `dsh_storage_records` (`unit='platform_credentials'`,
   `table_name='credentials'`, key `ref:DEEPSEEK_API_KEY`); confirm no
   `.credentials.yaml` is in play and `--dump-config` shows the official row
   disabled; `kubectl rollout restart deploy/<control-plane>`; after Ready, send a
   model request WITHOUT re-entering anything (must succeed, source `postgres`);
   re-run the SQL. Negative control: a SETTINGS edit does NOT survive (documented
   0.2 limitation — report, do not re-enter the key).

---

## 7. Concerns

1. **The `agents-local-md` origin is a live question, not a code question.** The
   chain path → `ensure` → PVC → adoption is proven and fenced; which directory
   started it on that cluster needs §4 item 3b's four queries. If item 1 returns
   `NotFound` and the directory's mtime predates the record, the remaining
   candidate is the official picker's create-directory flow in the build that was
   deployed; the record's own `path`/`createdAt` in `dsh_storage_records` decides
   it.
2. **Defect 2's prune is in-process.** A ghost that predates the current pod is
   pruned after one observe-then-miss cycle rather than instantly. Making it
   durable needs a persisted "this workspace had a volume" fact (the
   `platform_workspaces` table in `platform-domain` is the natural home, currently
   unused); it is a follow-up, not a correctness gap, and the alternative —
   pruning on the bare fact "no PVC" — is a mass deletion waiting for one failed
   listing.
3. **`resolveEndpoint` now refuses unknown ids**, so a workspace whose RECORD was
   lost but whose PVC survives cannot be woken by an fs operation during the ≤1
   reconcile interval before adoption (the error names the id; the reconciler
   adopts it and the next operation succeeds). This is the deliberate cost of
   closing the phantom-workspace hole.
4. **Settings edits are still not durable, and cannot be made so through a
   supported seam in 0.2** (§5). The credential half is durable now; the model
   key is the credential. If the operator also wants the chosen MODEL, base URL or
   other row config to survive, the options are: make the profile patch path a
   real volume (deploy-repo chart change, and it would put durable state under
   `DSH_HOME`), or upstream a settings-store seam. Both are outside this task's
   scope; the report states it rather than writing a file that nothing reads.
5. **No cluster was available in this session**, so every "click X, expect Y" item
   in §6 is unexecuted here. The detached halves were verified against the
   shipped artifacts: the client bundle the image loads (dialog stylesheet,
   registration, detail view), the plugin's own unit/integration specs, the
   composed profile (`--dump-config` for both profiles), the import closure of
   both profiles, and both smokes.
6. **The client bundle is a committed artifact** (`lib/client.js`); it was
   rebuilt in the same commit as the style change and the build is reproducible
   (clean tree after `pnpm -r build`). The four committed `dist/index.js`
   artifacts were rebuilt too — `platform-domain`'s is load-bearing for defect 4,
   since the profile loads the package's `main`.
7. **Two prior tests were observing nothing**: the phantom `onDelete` option in
   `reconciler.spec.ts` and the two-selector stylesheet assertions in
   `new-workspace-slots.spec.ts`. Both are replaced by assertions on real
   behaviour here; the same "verify the verification" pass over the other
   restored surfaces would be cheap insurance.

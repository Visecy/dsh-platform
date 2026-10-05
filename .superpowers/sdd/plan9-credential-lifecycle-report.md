# Plan 9 — the v0.1.83 credential-lifecycle outage: root cause, fix, verification

**Status: fixed and verified. Route A (repair the provider) — the PostgreSQL
credential store is kept, nothing is disabled, no regression to the file-backed
row is accepted.**

| | |
|---|---|
| Base | `fe03b98` (tag v0.1.83), branch `main`, clean tree |
| Test (RED-first) | `d192f39 test(platform-domain): pin the credential provider's composed lifecycle` |
| Fix | `f6ccfd4 fix(platform-domain): keep the credential store usable for the plugin's lifetime` |
| Files | `packages/platform-domain/src/index.ts`, `src/credentials.ts`, `tests/credentials-lifecycle.spec.ts`, rebuilt `dist/index.js` — nothing else |
| Deploy impact | none: no version change, no new dependency, no lockfile change, no profile change, no bundle patching, no file writes (`readOnlyRootFilesystem` untouched) |

The three fixes the outage was holding hostage — `ed944c6` (dialog buttons),
`051ae54` (ghost-record pruning), `24a95b1` (observed-phase panel + the
"an fs op may wake but never create a workspace" fence) — are all ancestors of
this tip and all still pass; they simply need a release that is not v0.1.83.

---

## 1. Root cause

### 1.1 The line

`packages/platform-domain/src/index.ts` (as shipped in v0.1.83), lines 129–133:

```ts
    const credentialStore = new CredentialStore(ctx, domains)
    ctx.effect(async () => {
      await credentialStore.dispose()
      await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()])
    }, '@visecy/dsh-platform-domain')
```

### 1.2 Why that is a defect, in cordis's own terms

`ctx.effect(body)` treats **the body's return value** as the disposer, and runs
the body immediately. From the installed `@deepseek-ai/cordis@4.0.4`:

* `lib/types/fiber.d.ts` — *"`execute` runs immediately; the disposers it
  produces are collected and run (in reverse order) either when the returned
  disposer is called or when the fiber unloads"*.
* `lib/index.js` `Fiber._execute` (line ~1142):

  ```js
  const effect = runner.execute.call(this)          // ← the body runs HERE, at apply time
  if (typeof effect === "function") return runner.collect(effect)
  else if (isNullable(effect)) { }                  // ← a promise of undefined collects NOTHING
  else if ("then" in effect) return effect.then(safeCollect)
  ```

An `async` arrow with no `return` therefore **runs at apply time and registers no
disposer at all**. Measured in isolation against the real cordis (shape A is the
shipped code, shape B is what every other call site in this tree does):

```
$ node .tmp-probe.mjs
A body ran
--- after apply (this is "boot") ---
B disposer ran
--- after fiber dispose ---
```

`A body ran` **before** "after apply": the cleanup executed during composition,
and no disposer was ever registered for unload.

### 1.3 What that did at boot

1. `apply` opened all four domains and constructed `CredentialStore`, which
   registered `credentials` (and `platformDomains`) on the plugin fiber.
2. The very next statement ran the effect body: `credentialStore.dispose()`
   set `closed = true` and `Promise.all([...close()])` closed
   `platform_workspaces`, `platform_users`, `platform_settings` **and
   `platform_credentials`** — seconds after opening them.
3. Both services stayed registered for the whole process, so every later caller
   was handed a live store over a closed domain.

The first consumer to touch them after composition is the official
`@deepseek-ai/dsh-client-connection`, which writes its browser-cookie signing
secret during **its own** `apply`
(`dsh-client-connection/lib/index.js:798` `inject = ["credentials"]`, `:819`
`BrowserAuth.create(ctx.root, ctx.credentials, …)`, `:330`
`await credentials.modifyRecord(AUTH_RECORD_KEY, …)`, `:223`
`AUTH_RECORD_KEY = credentialKey("client-connection", "browser-session")`). That
is the reported failure — reproduced verbatim against the real official plugin
on the harness profile:

```
$ node .repro.mjs            # before the fix
--- platform-domain applied: credentials provider registered ---
--- RESULT: client-connection apply FAILED ---
Error: credentials: the platform credential store is disposed; cannot write record "client-connection/browser-session"
```

and the read half of the operator's log, same composition:

```
$ node .repro-read.mjs
DomainError: domain 'platform_credentials' is closed
```

`client-connection`'s fiber then failed, the web composition never finished
activating, the readiness probe never passed, and the pod restarted — exactly
`ready=false`, restart count 1, both ERROR lines.

### 1.4 Why it only exploded now

**The effect shape is a pre-existing regression carrier, not something 8af5d19
introduced.** The parent commit had the same `ctx.effect(async () => …)` shape
minus the `credentialStore.dispose()` line, so the four domains were already
being closed at boot; nothing read them after composition, so it stayed latent.
`8af5d19` added the first consumer that reaches into those domains **after**
boot, which is what turned a latent lifecycle slip into a control-plane outage.
The fix therefore belongs in `platform-domain`, and it fixes both the latent
defect and the outage.

Every sibling call site in this tree already used the correct shape:
`packages/subprocess-k8s/src/index.ts:67`
(`ctx.effect(() => () => this.shutdown(), …)`),
`packages/logging-stdout/src/index.ts:98,124`, and the official
`@deepseek-ai/dsh-storage-domain` (`domainCtx.effect(() => { …; return async () => { await facility.closeAll(); unmount() } })`).
`platform-domain` was the only one with the other form.

---

## 2. The fix

### 2.1 Ownership, then disposal (`src/index.ts`)

```ts
await ctx.inject([storageBackendServiceKey(backendName)], async (ready: Context) => {
  const facility = new DomainFacility(ready, { backend: backendName })
  const workspaces = await facility.open(workspacesDomain)
  … users, settings, credentials …
  ready.provide('platformDomains', domains)
  const credentialStore = new CredentialStore(ready, domains)
  ready.effect(() => async () => {          // ← the disposer is RETURNED
    await credentialStore.dispose()         // ← disposal first, then the close
    await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()])
  }, '@visecy/dsh-platform-domain')
})
```

Two properties, both load-bearing:

* **One lifetime per run.** The domains, the `platformDomains` provide, the store
  and the disposer are all registered on the fiber that *creates* them (the
  `ctx.inject` callback's own context), not on the outer plugin fiber.
  `ctx.inject` is documented to "unload and re-run the callback whenever a
  required service changes"; with the old ownership a re-run would leave four
  closed-but-referenced domains behind and then die on
  `service "platformDomains" has been registered`. Now a close is followed by a
  clean re-open of the same medium — the "re-openable after a legitimate close"
  requirement — and a caller can never reach a live service backed by a closed
  domain.
* **Disposal before closing** keeps the ordering that makes a refusal clean: the
  store's own flag is set before the domains go away, so a caller inside the
  teardown window gets the provider's error, never `DomainError`.

### 2.2 The store never hands out a closed domain (`src/credentials.ts`)

Every table access now goes through one of two guards:

```ts
private read<T>(what: string, operation: (table: CredentialTable) => T): T {
  this.assertServeable(what)
  try { return operation(this.domains.credentials.table('credentials')) }
  catch (error) { throw this.failed(what, error) }
}
private async write<T>(what: string, operation: (table: CredentialTable) => Promise<T>): Promise<T> { … }
```

* `assertServeable` refuses as soon as the store is disposed.
* `failed` recognises `DomainError('closed')` (by class **and** by `code`, so a
  second copy of the domain package cannot slip past), marks the store unusable,
  and returns the provider's own error with the original as `cause` — so
  `DomainError: domain 'platform_credentials' is closed` can no longer be what a
  consumer logs.
* Because the write guards run **inside** the serialized queue, a close that
  lands between the entry check and the write is caught too.
* Failures the medium itself raises (unreachable database, rejected durable
  write) are passed through unchanged, so the request fails with the real cause
  rather than a wrapper that hides it.

---

## 3. Regression test (TDD evidence)

`packages/platform-domain/tests/credentials-lifecycle.spec.ts` boots the **real**
`apply`, a real `Context`, the real `@visecy/dsh-storage-db` SQLite backend and
the real `DomainFacility`, then acts as the official consumer with the same call
the official plugin makes. Nothing about the lifecycle is mocked — the test fails
precisely because the composition closes the domains.

### RED — against `fe03b98` (4 cases, before the fix)

```
$ cd packages/platform-domain && npx vitest run tests/credentials-lifecycle.spec.ts
 × the credential provider over the composed lifecycle > serves the official consumer write that runs after apply resolved
 × the credential provider over the composed lifecycle > keeps every platform domain readable for the plugin lifetime
 × the credential provider over the composed lifecycle > closes the store and its domains only when the plugin unloads
 × the credential provider over the composed lifecycle > re-opens the domains, keeping stored credentials, when the backend is replaced
FAIL … > serves the official consumer write that runs after apply resolved
Error: credentials: the platform credential store is disposed; cannot write record "client-connection/browser-session"
FAIL … > keeps every platform domain readable for the plugin lifetime
DomainError: domain 'platform_credentials' is closed
FAIL … > closes the store and its domains only when the plugin unloads
Error: credentials: the platform credential store is disposed; cannot write "DEEPSEEK_API_KEY"
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

Both production messages, verbatim, from the real ordering.

### GREEN — after the fix

```
$ cd packages/platform-domain && npx vitest run tests/credentials-lifecycle.spec.ts
 ✓ tests/credentials-lifecycle.spec.ts  (5 tests) 73ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Case 5 (the logged, contained refusal, added with the hardening) is not vacuous —
mutation check, parent `credentials.ts` + fixed `index.ts`:

```
$ git checkout fe03b98 -- packages/platform-domain/src/credentials.ts && npx vitest run tests/credentials-lifecycle.spec.ts
   × … > logs a store that cannot serve once, and fails the request instead of the process
     → expected 'credentials: the platform credential …' to match /credential store is disposed; cannot …/
      Tests  1 failed | 4 passed (5)
```

### 3.1 The same boot through the real CLI and the real loader

The strongest before/after available without a cluster: `dsh --profile headless`
on the harness profile, with a throwaway `--patch` overlay that swaps PostgreSQL
for SQLite and disables the cluster-dependent rows (the profile files themselves
are untouched). The loader, the activation check and the official consumers are
the shipped ones.

**Before the fix** (pre-fix `dist` bundle, everything else identical) — the
production line, with the name the operator's log shortened to `platform-account`:

```
deepseek-account (@deepseek-ai/dsh-deepseek-account-platform): DomainError: domain 'platform_credentials' is closed
    at DomainImpl.assertReadable (…/dsh-storage-domain/lib/index.js:228:26)
    at KvTableImpl.get (…/dsh-storage-domain/lib/index.js:242:13)
    at Proxy.recordRow (…/@visecy/dsh-platform-domain/dist/index.js:192:25)
    at Proxy.readRecord (…/@visecy/dsh-platform-domain/dist/index.js:137:22)
    at [cordis.init] (…/dsh-deepseek-account-platform/lib/index.js:588:45)
    at Fiber.execute (…/cordis/lib/index.js:1070:40)
```

The stack is the proof: an official consumer's `readRecord` reached our
provider's `recordRow`, and the domain it was handed was already closed.

**After the fix** — same command, same profile:

```
dsh: warning: 7 entries did not activate        ← only the rows the overlay disabled (shell/fs/subprocess)
WARN  session-title-service: … llm-deepseek: no API key for provider route "deepseek-official";
      store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), …
dsh: MISSING_CREDENTIAL: llm-deepseek: …
$ … | grep -c "is closed"
0
```

`@deepseek-ai/dsh-llm-deepseek-api-key` — the official consumer that resolves
`DEEPSEEK_API_KEY` **through `ctx.credentials`** — activates and gets an honest
"no key stored yet" from the provider instead of a closed domain, and the
`platform_credentials` unit is created in the medium
(`dsh_storage_units`: `platform_credentials` version 1, table `credentials`).
The non-zero exit is the app's own `MISSING_CREDENTIAL` (no key in this empty
harness), not an activation or lifecycle failure.

### 3.2 End-to-end against the real official consumer (harness profile)

```
$ node .repro.mjs            # after the fix
--- platform-domain applied ---
--- RESULT: client-connection loaded (its boot credential write succeeded) ---
--- cookie record in the store: {"kind":"grant","payload":{"version":1,"secret":"6e10DpWMzd-fNXWqGL4v1 ---
```

and the pod-replacement case the live check performs, on the profile the image
installs (real official consumer, real storage, two contexts over one database):

```
[pod-1] client-connection loaded (boot credential write succeeded)
[medium] rows: [{"unit":"platform_credentials","table_name":"credentials","key":"client-connection/browser-session"},
                {"unit":"platform_credentials","table_name":"credentials","key":"ref:DEEPSEEK_API_KEY"}]
[pod-2 (after rollout restart)] client-connection loaded (boot credential write succeeded)
[pod-2] DEEPSEEK_API_KEY -> {"value":"sk-written-before-the-restart","source":"postgres"}
[pod-2] browser-session record still present: true | kind: grant
RESULT: credential survived the pod replacement
```

---

## 4. Boot resilience, and the degradation (stated, not implied)

What is now guaranteed:

* **The provider can no longer be the thing that wedges boot.** The domains and
  the service that serves them share exactly one fiber lifetime, so there is no
  window in which a registered store has a closed domain. That window was the
  entire outage.
* **A request that cannot be served fails cleanly and loudly.** It rejects with
  `credentials: the platform credential store is disposed; cannot serve <operation>`
  (never a `DomainError`), and one ERROR line naming the operation reaches
  `ctx.logger` — which the `logging-stdout` row puts on the pod's stdout:

  ```
  credentials: the platform credential store could not serve "DEEPSEEK_API_KEY"; this request fails: the store is disposed
  ```
* **No flood, no crash loop.** The report is once per store instance (the state
  is terminal for that generation), and nothing about the failure mutates the
  composition: other plugins keep running, the process stays up.
* **It re-opens rather than staying wedged.** A legitimate close (the medium's
  service goes away and returns) is followed by a fresh generation — new
  domains, new store — over the same durable medium, pinned by case 4.

**The degradation, precisely:** there is **no silent fallback**. A credential
write that cannot be served is *never* reported as success and there is no
in-memory shadow store, because a credential that appears stored and is not is
exactly the class of bug this provider exists to kill. The cost of a genuinely
unavailable medium (PostgreSQL down, schema/version mismatch, an unreadable
stored row) is therefore: **credential-backed operations fail per request** —
model-key resolution and the browser-session secret, i.e. the Models settings
page and model calls — while the rest of the control plane keeps serving, and
the failure is a named, greppable line in the pod log instead of a restart loop.
It recovers without human action as soon as the medium is back and the framework
next transitions the provider (framework reload or pod restart). What is *not*
claimed: the provider cannot catch an exception thrown inside another plugin's
`apply`, so a boot-time credential write that genuinely cannot be served still
fails that consumer's fiber — the difference after this fix is that the provider
can no longer *be* the cause of that, and any such failure is logged as the
provider's own refusal rather than as a closed domain.

---

## 5. Route taken: A (repair the provider), not B (disable it)

Route B — disable `platform-domain`'s credentials provider, restore the official
file-backed `credentials` row, accept a documented durability regression — was
the fallback, and it was **not** needed:

* the defect is a single, exactly identified expression whose semantics are
  documented by cordis and demonstrated by a probe, with the production error
  reproduced and then cleared end-to-end against the real official consumer;
* the fix is ~2 statements in the composition plus a defensive guard layer in a
  package this workstream already owns, with no new dependency and no lockfile
  change;
* route B would re-introduce precisely the bug `8af5d19` fixed — the operator
  re-entering the model API key after every upgrade (`$DSH_HOME` is an
  emptyDir) — which is a real functional regression, not a theoretical one;
* B would also need a profile edit that re-enables a row this composition
  deliberately disabled for a durability reason, and both profiles must agree.

So the other three fixes ship with the durable credential store intact.

---

## 6. Verification (at `f6ccfd4`, pasted)

```
===== pnpm install --frozen-lockfile =====
Scope: all 15 workspace projects
Already up to date
Done in 1s using pnpm v11.25.0
INSTALL_EXIT=0

===== pnpm -r build =====
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/fs-k8s build: Done
packages/subprocess-k8s build: Done
packages/workspace-k8s build: Done
BUILD_EXIT=0

===== pnpm -r test =====
packages/logging-stdout test:  Test Files  1 passed (1)   Tests  10 passed (10)
packages/auth-oidc test:       Test Files  1 passed (1)   Tests   7 passed (7)
packages/platform-domain test: Test Files  4 passed (4)   Tests  20 passed (20)
packages/identity-bridge test: Test Files  5 passed (5)   Tests  31 passed (31)
packages/storage-db test:      Test Files  1 passed (1)   Tests   1 passed (1)
packages/workspace-picker test:Test Files  2 passed (2)   Tests  10 passed (10)
packages/session-persistence-rdb: Test Files 7 passed | 2 skipped (9)
                                  Tests 129 passed | 24 skipped (153)
packages/sandbox-daemon test:  Test Files  6 passed (6)   Tests  36 passed (36)
packages/fs-k8s test:          Test Files  3 passed (3)   Tests  31 passed (31)
packages/workspace-k8s test:   Test Files 29 passed (29)  Tests 239 passed (239)
packages/subprocess-k8s test:  Test Files  1 passed (1)   Tests  16 passed (16)
TEST_EXIT=0
```

**530 passed, 24 PostgreSQL-gated skips, zero load failures** — the expected 525
plus this fix's 5 new cases (every package's totals are unchanged otherwise).

```
$ bash scripts/harness-profile.sh /home/ovizro/Code/.tmp-cred-verify
…
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1): error: --host 0.0.0.0 is intentionally not supported yet for safety: …
harness ready: /home/ovizro/Code/.tmp-cred-verify
EXIT:0

$ node scripts/check-plugin-imports.mjs …/profiles/web
ok   @visecy/dsh-logging-stdout
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain        ← now imports DomainError from the profile's storage-domain
ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-identity-bridge

check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
WEB_EXIT=0
$ node scripts/check-plugin-imports.mjs …/profiles/headless
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
HEADLESS_EXIT=0

$ node scripts/smoke-zero-patch.mjs --target …/profiles/web/node_modules
ok   1a. __DSH_TRANSPORT__ is injected through webserver/index-inject
ok   2. cookieless GET / is a 302 handoff
ok   3d. clean GET / with the cookie renders the index (200)
ok   4b. the same /api request with the cookie passes the official fence (404, not 401)
ok   5c. the principal is readable on a live request
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path
EXIT=0

$ node scripts/smoke-official-integration.mjs --target …/profiles/web/node_modules
ok   the official cookie layer is still ACTIVE (401 without it)
ok   the token exchange mints the signed browser cookie
ok   index served without any connection patch
ok   identity-bridge provides ctx.dshAuth over the sidecar headers
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
EXIT=0
```

(The smokes' full assertion lists are in the run logs; the two tails above are the
load-bearing lines. `smoke-zero-patch.mjs` was **not** modified — and note it
already stubbed `credentials` with a plain `ctx.provide`, which is why it could
never have caught this defect.)

### 6.0 Real loader boot (the closest available equivalent of "the pod is Ready")

```
$ cd /home/ovizro/Code/.tmp-cred-verify/home
$ DSH_HOME=$PWD dsh --profile headless --patch …/overlay.yml "say hi"     # --patch swaps PG→SQLite, disables the k8s rows
dsh: warning: 7 entries did not activate          ← exactly the rows the overlay disabled (shell/fs/subprocess) and their dependents
WARN  session-title-service: … llm-deepseek: no API key for provider route "deepseek-official"; …
dsh: MISSING_CREDENTIAL: llm-deepseek: …
$ … | grep -c "is closed"
0
```

Same command against the pre-fix bundle installed in the same profile produced
the production failure instead (`deepseek-account … DomainError: domain
'platform_credentials' is closed`, stack ending in our provider's `readRecord` —
§3.1). The composition activates with the fix, the official
`llm-deepseek-api-key` consumer reaches the provider through `ctx.credentials`,
and the profile's `platform-domain` row is the one serving it.

### 6.1 The four surfaces that must not regress

| Must keep working | Evidence at this tip |
|---|---|
| Name-based dialog on **both** `directoryFlow` seats | `tests/new-workspace-dialog.spec.ts` (9) — all green |
| `conversation.view` detail view | `tests/workspace-detail-view.spec.ts` (10) — all green |
| No `shell.overlay` pill | `tests/client-bundle.spec.ts:158` *"does not re-register the shell overlay pill"* + `tests/new-workspace-dialog.spec.ts:84` — green |
| Delete destroys the workspace | `tests/workspace-delete.spec.ts` (5) + `workspace-delete-by-record.spec.ts` — green |
| stdout logger row | `packages/logging-stdout` (10) green; the row is still the first `insert:` entry (`docker/profiles/web.cordis.patch.yml:179`), untouched by this fix |

Targeted run of the five UI-surface specs: **37 passed (37)**. The dialog
styling (`workspace-dialog-styles.spec.ts`, 4) and the ghost-record pruning
(`workspace-delete-by-record.spec.ts`) are green inside the 239-test
`workspace-k8s` package run above. No profile file, no `workspace-k8s` source and
no `fs-k8s` source was touched by this work — `git diff --name-only fe03b98..HEAD`
lists four paths, all under `packages/platform-domain/`.

---

## 7. Live-cluster proof (the exact sequence to run)

Built to the same conventions as `.superpowers/sdd/live-verification-checklist.md`.
Nothing here writes to the deploy repo; steps 4 and 7 are manual because they are
the *user* path that failed.

```bash
# ── 0. setup ────────────────────────────────────────────────────────────────
NS="${WS_NAMESPACE:?set WS_NAMESPACE to the workspace namespace}"
CTL=kubectl                                   # context already on the cluster
DEPLOY=$($CTL -n "$NS" get deploy -o name | grep -iE 'dsh|control|web' | head -1 | cut -d/ -f2)
SEL=$($CTL -n "$NS" get deploy "$DEPLOY" -o go-template='{{range $k,$v := .spec.selector.matchLabels}}{{$k}}={{$v}},{{end}}')
echo "NS=$NS DEPLOY=$DEPLOY SEL=${SEL%,}"

# ── 1. the release actually under test (must NOT be the v0.1.83 image) ──────
$CTL -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'

# ── 2. READINESS: the v0.1.83 failure, directly ─────────────────────────────
$CTL -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
#   Expect: deployment "…" successfully rolled out
$CTL -n "$NS" get pods -l "${SEL%,}" \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,PHASE:.status.phase
#   Expect: READY=true  RESTARTS=0  PHASE=Running      (v0.1.83: READY=false, RESTARTS>=1)

# ── 3. the two production errors are gone ───────────────────────────────────
$CTL -n "$NS" logs -l "${SEL%,}" --tail=2000 \
  | grep -nE "domain 'platform_credentials' is closed|platform credential store is disposed" \
  && echo "FAIL: the v0.1.83 errors are still present" \
  || echo "ok: no closed-domain / disposed-store errors"
#   Also expect the consumer that failed to now be up: no "client-connection" error line,
#   and a row written by the BOOT itself (step 6) — that is the direct proof.

# ── 4. WRITE a credential, through the real path (manual, ~30 s) ────────────
#   Open the control-plane URL -> Models settings page -> set DEEPSEEK_API_KEY -> save.
#   Expect the page to report it configured (source: postgres). Do NOT use the
#   environment: an env-supplied key is read-only and a write is refused by design.

# ── 5. confirm it is in PostgreSQL, not in a file ───────────────────────────
PG=$($CTL -n "$NS" get pods -o name | grep -i postgres | head -1 | cut -d/ -f2)
$CTL -n "$NS" exec "$PG" -- psql "$DSH_PG_CONNECTION_STRING" -c \
  "SELECT key, left(value_json, 80) FROM dsh_storage_records
   WHERE unit='platform_credentials' AND table_name='credentials' ORDER BY key;"
#   Expect at least:
#     ref:DEEPSEEK_API_KEY                 | {"userId":"platform","scope":"ref","id":"DEEPSEEK_API_KEY",…
#     client-connection/browser-session    | {"userId":"platform","scope":"client-connection","id":"browser-session",…
#   The browser-session row is the one client-connection writes at BOOT: its presence
#   is the outage fix made visible, with no UI involved.
$CTL -n "$NS" exec deploy/"$DEPLOY" -- sh -c 'ls -l "$DSH_HOME/.credentials.yaml" || echo "ok: no file-backed credential store"'

# ── 6. replace the pod and prove the credential outlives it ─────────────────
$CTL -n "$NS" rollout restart deploy/"$DEPLOY"
$CTL -n "$NS" rollout status deploy/"$DEPLOY" --timeout=300s
$CTL -n "$NS" get pods -l "${SEL%,}" \
  -o custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount
#   Expect the NEW pod READY=true. (A fresh pod's restartCount is 0; the old one is gone.)

# 6a. from the cluster, the row the FIRST pod's process wrote is still there:
$CTL -n "$NS" exec "$PG" -- psql "$DSH_PG_CONNECTION_STRING" -c \
  "SELECT key FROM dsh_storage_records WHERE unit='platform_credentials' ORDER BY key;"
#   Expect ref:DEEPSEEK_API_KEY still listed by a query run inside the NEW pod's lifetime.

# 6b. from the application: reload the UI — Models must show the key as configured
#     (source postgres) and ONE model request must succeed with nothing re-entered.
#     FAIL if it reports MISSING_CREDENTIAL / "no API key for provider route".

# 6c. the write path of the NEW pod works too: save the same key again in the Models
#     page; it must succeed (before the fix this is where the disposed store refused).

# ── 7. negative control — the disabled file-backed row stays disabled ───────
$CTL -n "$NS" exec deploy/"$DEPLOY" -- sh -c \
  'dsh --profile web --dump-config 2>/dev/null | grep -A1 "^- id: credentials$"'
#   Expect:  - id: credentials / disabled: true
```

---

## 8. Concerns

1. **The regression test commit is red against its parent — deliberately.**
   `d192f39` adds only the failing spec (4 cases RED with the production error
   verbatim); `f6ccfd4` makes it pass. Anyone bisecting should start at the fix
   commit. This is the TDD order the task asked for; the alternative (test and
   fix in one commit) would have hidden that the test really catches the defect.
2. **The pre-existing latent shape is the real lesson.** The same
   `ctx.effect(async () => …)` idiom had already been closing every platform
   domain at boot since before `8af5d19`; nothing observed it because nothing
   read those domains after composition. The fix removes it, but the pattern is
   easy to reintroduce, and `credentials-lifecycle.spec.ts` now guards the
   ordering (not just the credential value).
3. **Settings are still not durable** — unchanged and out of scope: 0.2 has no
   settings-provider seam, so a settings edit still lives in the profile patch
   document under the ephemeral `DSH_HOME`. Only the credential half is durable,
   which is the half the operator was re-entering.
4. **A genuinely unavailable medium (PostgreSQL down) still fails the
   `platform-domain` row at boot.** That is correct — the domains cannot be
   opened — and it is now diagnosable (a named error instead of a
   closed-domain message), but it is a real dependency failure and the pod will
   restart until the database is reachable. I did *not* add a boot retry: with
   `readOnlyRootFilesystem` and a probe-driven restart policy, a retry loop
   inside `apply` would delay readiness without changing the outcome, and it
   could mask a misconfiguration.
5. **`packages/platform-domain/dist/index.js` is tracked in git** even though
   `packages/*/dist/` is ignored, so the rebuilt bundle is part of the fix commit
   (as `8af5d19` did). `pnpm -r build` regenerates it; if a future change forgets
   to commit it, the harness — and any `file:`-installed profile — would run a
   stale bundle. `pnpm install --frozen-lockfile` is unaffected.
6. **Not verified on a live cluster here**: no cluster, no PostgreSQL and no
   container runtime are reachable from this sandbox, so §7 is the operator's to
   run. What *is* verified end-to-end is the same composition in-process (the real
   official `client-connection` plugin, the real storage stack, and two
   successive contexts over one database) and through the real CLI and loader
   (§3.1, §6.0, with SQLite standing in for PostgreSQL and the cluster-dependent
   rows disabled by a throwaway `--patch` overlay that is not part of any commit).
   The one thing that remains unexercised until §7 runs is the PostgreSQL
   dialect itself, which is the same `storage-db` path the previous release
   already used.

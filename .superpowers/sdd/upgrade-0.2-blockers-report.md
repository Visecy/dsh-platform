# DSH 0.2.0-rc.2 upgrade — Blockers 1, 2, 3 (+ the release-build pin)

**Status: complete.** All three blockers from
`.superpowers/sdd/upgrade-0.2-report.md` §7 are closed, `pnpm -r test` is green with **no
load failures**, a FRESH harness profile builds on the reconciled tree, both smokes pass, both
`--dump-config` dumps are stderr-clean, and the logger sink is proven end to end on a booted
profile (with an A/B control showing the same line was invisible without it).

Branch `main`, seven commits on top of the predecessor's `09c03f8`. Working tree clean.

| commit | subject |
|---|---|
| `537b79e` | `fix(session-persistence-rdb): take configuration from the loader entry, not the removed settings API` |
| `5af0ea5` | `chore(user-domain): remove the unported per-user settings package` |
| `27d212e` | `feat(logging-stdout): sink ctx.logger to stdout from a platform row` |
| `a3eed56` | `chore(session-persistence-rdb): rebuild dist through pnpm -r build` |
| `5eb60a0` | `fix(profiles): mount the stdout logger in both profiles, drop the pending ui-deliverables row` |
| `859639b` | `fix(release): build the image on 0.2.0-rc.2, and build the logging row` |
| `e009244` | `fix(profiles): make the logging row's DSH_LOG_LEVEL expression YAML-parseable` |

---

## 1. Blocker 1 — the RDB plugin could not activate on 0.2

### 1.1 Root cause (confirmed, not assumed)

0.2.0-rc.2's `@deepseek-ai/dsh-settings` is `SettingsForms`
(`configure/describe/update/replace/mutate/prepareDocument`) and exports no `SettingsProvider`;
the class exists nowhere in the installed 0.2 tree. But the profile DOES provide `ctx.settings`,
so the plugin's `if (settings !== undefined)` guard passed and the constructor called
`settings.register(...)` on an object that has no such method.

### 1.2 Fix

Config now comes from the plugin's own Loader entry (the profile row), matching
`session-persistence-jsonl`, which has no settings reference and does not depend on
`dsh-settings` at all:

* deleted the `settings.register` block, the `settingsNs` constant, the
  `import type { SettingsProvider }` and the `@deepseek-ai/dsh-settings` peer;
* `static inject` is now `["sessions"]`;
* deleted `src/__tests__/testing/helpers.ts` (the `EmptySettings` fake) and all nine
  `ctx.plugin(EmptySettings)` call sites across the seven suites;
* added a regression test that mounts a 0.2-shaped `settings` service with NO `register` and
  asserts the plugin activates from its entry config (schema defaults applied) and never calls
  the service.

### 1.3 Evidence

RED — the package as the predecessor left it (exit 1):

```
$ pnpm --dir packages/session-persistence-rdb test
 FAIL  src/__tests__/pg.spec.ts [ src/__tests__/pg.spec.ts ]
TypeError: Class extends value undefined is not a constructor or null
 ❯ src/__tests__/testing/helpers.ts:8:36
 …
 Test Files  7 failed | 2 passed (9)
      Tests  10 passed (10)
```

RED — the new regression test against the OLD constructor (source stashed, test kept), which
reproduces the production stack exactly:

```
$ ./node_modules/.bin/vitest run src/__tests__/rdb.spec.ts -t "SettingsForms"
 FAIL  … > activates beside 0.2's SettingsForms service, taking its config from its own entry
TypeError: settings.register is not a function
 ❯ new SessionPersistenceRdb src/index.ts:229:30
 Test Files  1 failed (1)
      Tests  1 failed | 85 skipped (86)
```

GREEN — same command with the fix:

```
$ ./node_modules/.bin/vitest run            # packages/session-persistence-rdb
 ✓ src/__tests__/write-guard.spec.ts  (8 tests) 12ms
 ↓ src/__tests__/capture-v3-fixture.spec.ts  (1 test | 1 skipped)
 ↓ src/__tests__/pg.spec.ts  (23 tests | 23 skipped)
 ✓ src/__tests__/multi-instance.spec.ts  (4 tests) 151ms
 ✓ src/__tests__/fixture-restore.spec.ts  (4 tests) 127ms
 ✓ src/__tests__/multi-session.spec.ts  (6 tests) 463ms
 ✓ src/__tests__/migration-v4.spec.ts  (19 tests) 407ms
 ✓ src/__tests__/busy-timeout.spec.ts  (2 tests) 974ms
 ✓ src/__tests__/rdb.spec.ts  (86 tests) 864ms
 Test Files  7 passed | 2 skipped (9)
      Tests  129 passed | 24 skipped (153)
```

All seven previously-unloadable suites load again; the package went from
`7 failed | 2 passed (9), 10 tests run` to `129 passed | 24 skipped` (`pg.spec.ts` still skips
its 23 tests without `TEST_PG_URL`). `dist/index.js` was rebuilt with the package's own build
script (`pnpm -r build`), and `a3eed56` restores the banner spelling every other committed dist
uses so `pnpm -r build` no longer dirties the tree.

---

## 2. Blocker 2 — `user-domain` removed

`git rm -r packages/user-domain` (7 files, 472 lines) plus the lockfile's importer and its
19-package closure. Nothing else referenced it, which I verified rather than assumed:

* no profile row in `docker/profiles/*.cordis.patch.yml`;
* not in `docker/dsh-web-platform.Dockerfile`, `scripts/harness-profile.sh` or `release.yml`;
* no package/test/plugin imports `@vicecy/dsh-user-domain`;
* `src/index.ts` was 0 bytes, and `user-context.ts` provided a `currentUser` service that
  nothing injects.

The commit message records the decision: the per-user settings/credentials layer will be
**redesigned** against 0.2's `SettingsForms` model (forms edit loader-entry config; durable
state belongs in the platform's Postgres storage domain) when per-user semantics are wired —
porting `providers.ts` would have meant rewriting it anyway.

---

## 3. Blocker 3 — a platform stdout sink for `ctx.logger`

### 3.1 What was wrong

Cordis's exporter only ring-buffers in memory (nothing reads the buffer) and `dsh-app-boot`'s
exporter keeps warn/error in memory for its StartupError path. The composition therefore had
**no sink**: every platform warning/error was dropped. The predecessor's probe proved it; this
row fixes it.

### 3.2 The row — `packages/logging-stdout` (`@visecy/dsh-logging-stdout`)

A new, private, image-only package rather than a row in an existing platform package: the
requirement was "no dependency on any other platform package", and the one existing home that
would not have created a cycle (`platform-domain`, `storage-db`) is exactly the kind of package
that must not be loadable-when-broken. The whole plugin is 133 lines incl. comments, with only
`@deepseek-ai/cordis`, `@deepseek-ai/schemastery` and node builtins at runtime.

Design decisions and their justifications:

* **STDOUT only, no file I/O at all** — `readOnlyRootFilesystem`, nothing durable under
  `DSH_HOME`. A closed stdout (EPIPE on a rotated pipe) is swallowed rather than thrown into the
  plugin that logged.
* **`level` is the row's config, the LEAST severe type written, default `warn`** — a boot emits
  a steady stream of info lines (plugin mount, hmr, listener banners) that would drown the
  actionable signal in a pod log, while every platform plugin reports failures through
  warn/error. Error is always included; `info`/`debug` are one config edit (or `DSH_LOG_LEVEL`,
  wired in the profile row with a whitelist fallback) away.
* **The threshold is applied in `export`, not through cordis's numeric `levels`** — that filter
  is not severity-ordered (`levels: { default: 1 }`, cordis's own default, already drops warn),
  so it cannot express "quiet but warn/error".
* **Exactly one line per message** — one exporter per ROOT context, reference-counted, and
  registered on the root context (cordis ties an exporter to the REGISTERING fiber, so a sink
  registered on the row's own fiber would go dark when the first of two mounted rows disposed).
  A second mount (or an overlay patch) therefore cannot duplicate output.
* **Deliberately does not replay cordis's ring buffer** — the sink is live from its mount
  onward; the pre-mount window is the StartupError path's business, and replaying it would print
  stale, out-of-order records.
* Formatter: `util.format` (the same substitution `console.log` uses), one write per record,
  `<ISO ts> <LEVEL> <logger name>: <message>` with fixed-width level labels.

Loader shape follows the repo's plugins (`export const name`, `export function apply`,
`export const Config` schemastery schema), so the loader passes the namespace's `Config` schema
and cordis applies the default before `apply`.

### 3.3 Tests (RED → GREEN)

RED — the suite cannot load the missing module:

```
$ ./node_modules/.bin/vitest run            # packages/logging-stdout
 FAIL  tests/logging-stdout.spec.ts [ tests/logging-stdout.spec.ts ]
Error: Failed to load url ../src/index.ts (resolved id: ../src/index.ts) … Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

GREEN — 10 tests:

```
 ✓ tests/logging-stdout.spec.ts  (10 tests) 48ms
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

They pin: the loader shape + `warn` default; line shape and stderr silence; the four levels
(`error`, `warn` default, `info`, `debug`); one record for a multi-line Error stack; one line
per message when the row is mounted TWICE; release only when the LAST holder disposes; and an
architecture guard that no `@visecy/*` runtime dependency and no `node:fs` import can creep in.

One design correction came out of the tests rather than review: the "last holder" test failed
(`expected [Array(1)] to have length 2 but got 1`) because `ctx.logger.exporter()` binds the
exporter to the CALLING fiber, not the logger service's — which is why the sink is registered on
`ctx.root` and released explicitly by the refcount.

### 3.4 Wiring

* `docker/profiles/web.cordis.patch.yml` and `headless.cordis.patch.yml`: the row is the FIRST
  platform insert (rows mount in list order, so everything after it is captured), with
  `level: !!js >- (['error','warn','info','debug'].includes(process.env.DSH_LOG_LEVEL) ? … :
  'warn')`.
* `scripts/harness-profile.sh` installs `file:…/packages/logging-stdout` in BOTH profiles.
* `scripts/check-plugin-imports.mjs` lists it in `DEFAULT_PLUGINS`, so the harness script and
  the image build actually import it.
* `docker/dsh-web-platform.Dockerfile`: `COPY` + `file:` in both `pnpm add` lists; the runtime
  closure comment notes that cordis/schemastery are already at the profile root.
* `release.yml` builds its `dist` (and the dist is committed, like the other image-only
  packages).

### 3.5 End-to-end proof (booted profile, with A/B control)

Channel: the fresh harness at `.tmp-harness-block` (built by `scripts/harness-profile.sh`), the
web profile booted on a free port. Because this environment has no Kubernetes, the three storage
rows are pointed at local SQLite by a verification-only overlay
(`.tmp-verify-logs/local-stack.patch.yml`), and ONE workspace record is seeded into the profile's
storage so the reconciler gets past its `registered.length === 0` early return — exactly the
state a real deployment with one workspace has.

**With the sink (as shipped):**

```
$ WS_NAMESPACE=proof DSH_HOME=…/.tmp-harness-block/home timeout 45 \
    dsh --profile web --patch …/local-stack.patch.yml --port 3097 --no-open < /dev/null
2026-10-04T18:12:08.786Z WARN  @visecy/dsh-workspace-k8s: workspace session rebind skipped: session persistence could not be listed: Error: cannot get property "sessionPersistence" without inject
2026-10-04T18:12:08.835Z WARN  @visecy/dsh-workspace-k8s: workspace session rebind skipped: session persistence could not be listed: Error: cannot get property "sessionPersistence" without inject
```

**A/B control — identical boot, `--patch no-logging.patch.yml` (row disabled):**

```
=== stdout bytes: 0
=== stderr bytes: 0
```

The config knob is exercised too: `DSH_LOG_LEVEL=info` on the same boot adds
`2026-10-04T18:09:39.287Z INFO  hmr: watching [ [length]: 0 ]`, which the default (`warn`) keeps
out.

### 3.6 A real defect the row exposed on its first boot

The warning above is not noise — it is a platform bug that has been invisible precisely because
there was no sink:

* `packages/workspace-k8s/src/index.ts:190-192` builds the reconciler's session source as
  `list: async () => await ctx.sessionPersistence.list()` from a plugin that declares **no
  `inject`** (the module exports only `name`/`apply`/`Config`; there is no `export const
  inject`), so cordis refuses the property access:
  `Error: cannot get property "sessionPersistence" without inject`;
* `rebindSessions` catches that and returns (`reconciler.ts:174`), so the session↔workspace
  association repair **never runs** — every pass reports and gives up.

Fix is one line (declare `sessionPersistence` in the plugin's inject list, or read it through
`ctx.get('sessionPersistence')`), but `packages/workspace-k8s/src/**` is outside this task's
write scope, so it is reported, not touched. This is exactly the class of silent production
failure the logging row exists to end.

---

## 4. `ui-deliverables` disabled (and a correction to the predecessor's report)

`workspace-changes` (disabled in `8835218`) has exactly one consumer in 0.2.0-rc.2 — verified by
grepping the installed tree for `workspaceChanges` across every official `lib/index.js`:
`dsh-client-ui-deliverables`. So the row is now disabled explicitly in the web profile, and the
headless comment records that neither row exists in that composition (a disable row for an
unknown id pollutes `--dump-config` stderr).

The comment states the dependency and that both rows come back together when upstream routes
those byte reads through `ctx.fs`. It also records the measured cost, which corrects
`upgrade-0.2-report.md` §7.3: the `present` **tool is not lost** — it is
`@deepseek-ai/dsh-tool-present`, which injects only `tools`/`fs`/`sessionProjections`. What is
lost with `ui-deliverables` is the `ui:deliverable-file-references` system-prompt section
(`FILE_REFERENCE_PROMPT`) and the authenticated native-open RPC (`registerPresentOpen`, which
reads `ctx.workspaceChanges.summary/diff`). That is a real, accepted cost of the instruction to
disable the row.

---

## 5. A release blocker found on the way: `DSH_VERSION=0.1.5-rc.1`

`release.yml` passed `DSH_VERSION=0.1.5-rc.1` as a **build arg**, and a build arg overrides the
Dockerfile's `ARG DSH_VERSION=0.2.0-rc.2` default. Every tagged release would have installed the
0.1.5-rc.1 official packages into a profile whose platform plugins now pin exact 0.2.0-rc.2
peers — the exact skew this upgrade removes. Fixed to `0.2.0-rc.2`, and `logging-stdout` joined
the build step (it is not published, but its `main` is `dist/index.js`).

---

## 6. Verification at the frozen revision

All commands below were run on `e009244` with a clean tree (log:
`.tmp-verify-logs/final-verify.log`).

```
=== pnpm install --frozen-lockfile
Scope: all 15 workspace projects
Already up to date
Done in 985ms using pnpm v11.25.0                                  INSTALL_EXIT=0

=== pnpm -r build
Scope: 14 of 15 workspace projects
… built logging-stdout / fs-k8s / subprocess-k8s / workspace-k8s (+ client UI) /
  workspace-picker / identity-bridge / session-persistence-rdb / storage-db / platform-domain
BUILD_EXIT=0

=== pnpm -r test
TEST_EXIT=0
packages/logging-stdout        Test Files 1 passed (1)    Tests 10 passed (10)
packages/platform-domain       Test Files 1 passed (1)    Tests 2 passed (2)
packages/auth-oidc             Test Files 1 passed (1)    Tests 7 passed (7)
packages/identity-bridge       Test Files 5 passed (5)    Tests 31 passed (31)
packages/storage-db            Test Files 1 passed (1)    Tests 1 passed (1)
packages/workspace-picker      Test Files 1 passed (1)    Tests 7 passed (7)
packages/session-persistence-rdb  Test Files 7 passed | 2 skipped (9)  Tests 129 passed | 24 skipped (153)
packages/sandbox-daemon        Test Files 6 passed (6)    Tests 36 passed (36)
packages/fs-k8s                Test Files 2 passed (2)    Tests 24 passed (24)
packages/workspace-k8s         Test Files 19 passed (19)  Tests 146 passed (146)
packages/subprocess-k8s        Test Files 1 passed (1)    Tests 16 passed (16)
# totals: 45 passed + 2 skipped files, 409 passed + 24 skipped tests, 0 load failures
# git status after build+test: empty (dist artifacts byte-stable)
```

FRESH harness — `bash scripts/harness-profile.sh .tmp-harness-block` (deleted first), exit 0:

```
ok   @visecy/dsh-logging-stdout   (+ fs-k8s, subprocess-k8s, workspace-k8s, session-persistence-rdb,
     storage-db, platform-domain, workspace-picker, identity-bridge)
check-plugin-imports: all 9 plugins import cleanly …/profiles/web
ok   @visecy/dsh-logging-stdout   (+ 6 more)
check-plugin-imports: all 7 plugins import cleanly …/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1): error: --host 0.0.0.0 is intentionally not
     supported yet for safety … use 127.0.0.1 instead
harness ready: .tmp-harness-block                                  HARNESS_EXIT=0
```

Explicit import checks (`.tmp-verify-logs/harness.log`):

```
$ node scripts/check-plugin-imports.mjs .tmp-harness-block/home/profiles/web
check-plugin-imports: all 9 plugins import cleanly …                exit 0
$ node scripts/check-plugin-imports.mjs .tmp-harness-block/home/profiles/headless
check-plugin-imports: all 7 plugins import cleanly …                exit 0
```

Both smokes (`.tmp-verify-logs/smoke-zero.log`, `smoke-official.log`):

```
$ node scripts/smoke-zero-patch.mjs --target .tmp-harness-block/home/profiles/web
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path   exit 0
$ node scripts/smoke-official-integration.mjs --target .tmp-harness-block/home/profiles/web
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge
uses it                                                                                  exit 0
```

`--dump-config`, both profiles, empty stderr:

```
$ DSH_HOME=…/.tmp-harness-block/home dsh --profile web      --dump-config > … 2> …
WEB_DUMP_EXIT=0        stderr_bytes=0       194 rows
$ DSH_HOME=…/.tmp-harness-block/home dsh --profile headless --dump-config > … 2> …
HEADLESS_DUMP_EXIT=0   stderr_bytes=0       104 rows
```

Reconciled rows visible in the web dump:

```yaml
- id: ui-deliverables
  name: '@deepseek-ai/dsh-client-ui-deliverables'
  disabled: true
- id: logging-stdout
  name: '@visecy/dsh-logging-stdout'
  config:
    level: !!js >-
      (['error','warn','info','debug'].includes(process.env.DSH_LOG_LEVEL) ?
      process.env.DSH_LOG_LEVEL : 'warn')
```

Logger proof: §3.5 (booted profile, real `WARN` from `@visecy/dsh-workspace-k8s` on stdout,
A/B control at 0 bytes).

### 6.1 One self-inflicted detour, recorded for honesty

The first version of the row used a one-line `!!js (… ? … : 'warn')`. A YAML plain scalar cannot
contain `": "`, so the ternary ended the scalar and the WHOLE patch layer failed to parse;
`check-loopback-bind.mjs` reported it as "the official loopback refusal is gone" because the CLI
died before the flag check. Fixed in `e009244` with the folded `!!js >-` block scalar the
`connection` row already uses, and re-verified with `--dump-config` on both profiles before the
harness was rebuilt. The intermediate commit `5eb60a0` therefore does not boot; `e009244` is the
one to test. (History was not rewritten because this workspace is shared with the parent
session.)

---

## 7. Concerns and out-of-scope follow-ups

1. **`workspace-k8s` cannot read `ctx.sessionPersistence` (§3.6)** — the association rebind has
   never run; one-line fix, out of scope. It will now warn loudly on every pass, which is the
   intended behaviour of the new sink but also a noisy reminder until fixed.
2. **`README.md:52` still lists `user-domain`** — outside the declared write scope. The row
   should be deleted (`| user-domain | per-user settings/credentials（尚未接线） | Plan 3 |`).
   `design/*.md` references are historical records and should stay.
3. **The `ui-deliverables` disable costs the file-reference prompt section and the native-open
   RPC** (§4) — accepted per the task, but it is a user-visible change and the `present` cards
   lose their open affordance in this deployment.
4. **PostgreSQL is still unexercised** — no server, no docker: `pg.spec.ts` skips 23 tests
   (`PostgresBackend.listChildSessions` has still never run a query), and the rdb fix was
   validated on SQLite only. Unchanged from the predecessor's report.
5. **No image build** — no docker in this environment. The Dockerfile change is exercised
   indirectly: `harness-profile.sh` mirrors the image's install list, and
   `check-plugin-imports.mjs` (the same script the image runs) imports the new row from a real
   profile.
6. **The 0.2 boot without PostgreSQL/Kubernetes is a partial boot** — the proof uses a
   verification-only SQLite overlay and one seeded workspace record; it is not a deployment
   rehearsal. The A/B control shows the sink is the only difference in stdout.
7. **`logging-stdout` is private and unpublished.** If the platform ever wants it on npm,
   `release.yml` needs it in the version-sync/publish loops (deliberately NOT added: the image
   installs platform plugins from the checkout, and a first publish cannot use Trusted
   Publishing).
8. **The seeded/hand-rolled verification data lives in `.tmp-verify-logs/`** (gitignored):
   `local-stack.patch.yml`, `no-logging.patch.yml`, `verify-storage.db`, `verify-sessions.db`,
   `proof-with.out`, `proof-without.out`, `final-verify.log`, `harness.log`, both smoke logs.
   The harness itself is `.tmp-harness-block/` — reusable for a re-run of any check above.

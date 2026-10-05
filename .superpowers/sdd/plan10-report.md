# Plan 10 — three live-cluster defects: root cause, fix, verification

**Status: fixed, TDD'd, verified against the shipped composition. One commit per
defect, so each is independently revertible. Two findings need the operator's
decision (one write-scope deviation, one component the official family does not
export); both are stated, not hidden.**

| | |
|---|---|
| Base | `441b17b` (branch `main`, clean) |
| Defect 1 | `b256cc3 fix(profiles): drop the permission-presets client half, not only its host` |
| Defect 2 | `7b536ea fix(workspace-k8s): refuse only the workspace CREATION case, not ordinary paths` |
| Defect 3 | `a9e03b7 fix(workspace-ui): rebuild the new-workspace dialog from the official components` |
| Diff | 19 files, +1,206 / −186 across the three commits (sources, tests, rebuilt `lib/client.js`) |
| Deploy impact | no DSH version change, no bundle re-vendoring, no new dependency, no lockfile change, no deploy-repo change |
| Preserved | credentials in PostgreSQL, observed-phase panel, ghost-record pruning, delete destroys the workspace, restored detail view, no `shell.overlay` pill, stdout logging |

---

## 1. Defect 1 — the settings page 404

### 1.1 The pairing, established (not guessed)

```
$ DSH_HOME=… dsh --profile web --dump-default-config | grep -n -A1 'permission'
146:- id: permission
147:  name: '@deepseek-ai/dsh-permission-presets'
595:- id: ui-permission
596:  name: '@deepseek-ai/dsh-client-ui-permission-presets'
```

* **HOST** row `permission` = `@deepseek-ai/dsh-permission-presets`.
  `lib/typert.host.js` registers the `permissionPresets` service and the
  `Remote("catalog")` method — that route IS `/api/permissionPresets/catalog`.
* **CLIENT** row `ui-permission` = `@deepseek-ai/dsh-client-ui-permission-presets`.
  `lib/client.js` calls `ctx.remote.permissionPresets.catalog()` from the
  Permissions row it registers on the settings page (and serves the
  `/permission` command).
* **Our profile** (`docker/profiles/web.cordis.patch.yml`) disabled the HOST row
  and left the CLIENT row mounted. That is the 404: the browser asked for a
  route whose only provider was switched off. (`docker/profiles/headless.cordis.patch.yml`
  has no client rows at all, so it never had the defect.)

### 1.2 Which side to drop, and why that side

The presets are a **sandbox mode + approval policy** bundle
(`read-only` / `workspace-write` / `danger-full-access`), and the sandbox half is
enforced by the host-local confinement chain: `@deepseek-ai/dsh-sandbox-local`
builds bwrap / Landlock / Seatbelt profiles against `workspaceRoot` **on the
control plane**. On this platform execution is routed by
`@visecy/dsh-subprocess-k8s` into a **per-workspace Kubernetes pod** — the pod is
the isolation boundary, and the control plane holds neither workspace bytes nor
a sandbox runner (deployment: `readOnlyRootFilesystem: true`, `/workspaces` is
an `emptyDir`, `WS_DAEMON_ENDPOINT` unset so the static fallback
`http://127.0.0.1:4390` has no listener). The host row cannot even activate here:

```
dsh-permission-presets/lib/index.js
  if (ctx.shell.sandboxMode === void 0) throw new Error(
    "permission: the mounted bash executor does not confine (no sandboxMode)
     — presets bundle a sandbox mode, so composing this plugin over an
     unconfined executor is a misconfiguration")
```

and `ctx.shell.sandboxMode` is provided only by `bash-sandbox`, which this
profile also disables (deliberately — see the profile's own notes on routing
execution to pods). Restoring the host half would therefore mean re-introducing
a control-plane sandbox around commands that run in a pod, and offering the
operator three modes that do not do what they say.

**Decision: drop the client half.** The settings page loads, and no surface
advertises a capability this deployment cannot enforce.

### 1.3 What was changed

`docker/profiles/web.cordis.patch.yml`: a top-level
`- id: ui-permission, disabled: true` row with the full rationale above it (the
file's convention is rationale-above-the-row). Cost, read off
`dsh-client-ui-permission-presets@0.2.0-rc.2`: the Permissions row on the
settings page and the `/permission` command with its current-session popup. The
`approval` row (`@deepseek-ai/dsh-user-approval`, `DSH_PERMISSION_MODE`) stays
enabled, so the deployment's approval policy is unchanged.

### 1.4 Test evidence (TDD)

`packages/workspace-k8s/tests/profile-permission-ui.spec.ts` (new, 5 cases).

RED (before the profile row):

```
 FAIL  tests/profile-permission-ui.spec.ts > web profile: the permission-presets pair
       > leaves no client half enabled for a host capability this profile removed
AssertionError: ui-permission calls the disabled permission row and has no
  replacement provider: expected false to be true
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
```

GREEN (after):

```
 ✓ tests/profile-permission-ui.spec.ts  (5 tests) 9ms
      Tests  5 passed (5)
```

The spec pins the pairing, both disables, the rationale, the headless profile's
silence (a disable row for an unknown id prints
`patch: entry "ui-permission" not found` on stderr while still exiting 0), and
the general invariant behind the 404 — *no client half stays enabled for a host
capability this profile removed* — with its one deliberate exception asserted as
such (`directory-picker`'s browse surface is backed by the inserted
`workspace-picker` provider).

**Audit of the same class of defect elsewhere.** Every installed package's
`dsh.client.inject` was scanned: no package injects
`@deepseek-ai/dsh-client-ui-permission-presets` (nothing else was loading it),
and the only inject names that are not profile rows are the web shell's static
seed words, which the loader skips by design. The CLI-rendered profile confirms
the row is off with a clean stderr (see §4).

---

## 2. Defect 2 — the resolver fence

### 2.1 The operator's line, decoded

```
workspaceEndpointResolver: '.git' is not a registered workspace of this
  platform, so no pod or volume will be created for it; the path names an
  ordinary directory under the workspace root
```

`.git` is not a workspace id. It is the **first path segment** of
`/workspaces/.git` — a dotfile beside the workspace anchors — reached by the
ordinary relative path `.git` from a session whose cwd is the workspace ROOT
(`/workspaces`). That is a real configuration on this cluster: durable session
headers with `f_cwd = '/workspaces'` were already quoted in the plan-8 report,
and the profile runs `bash-local` with `cwd: '/workspaces'`.

The fence itself was right — before it, `resolveEndpoint` called
`runtime.ensure(id)`, so one file operation on `/workspaces/<anything>` created
a PVC, a pod and (one reconcile pass later) a sidebar workspace — but it was
enforced in the wrong place: `resolveEndpoint` **threw**, so an ordinary path
became a platform failure instead of being answered.

### 2.2 The split

Membership and resolution are now two questions on the same service
(`@visecy/dsh-workspace-k8s`, `WorkspaceEndpointResolver`):

| member | answer |
|---|---|
| `isWorkspace(id)` | membership alone. No provisioning, non-throwing, cheap. Fail-open: only a **positive** "no such record" answers `false`; a registry that cannot be listed, an implementation that throws, or a composition with no registry bridge all answer `true`. |
| `resolve(id)` | the endpoint of a workspace, waking it if needed — and refusing an id no record describes. That refusal **is** the creation case, and it is the only thing the fence refuses. It stays because `@visecy/dsh-subprocess-k8s` (outside this change's write scope) holds nothing but an id. |

`packages/fs-k8s/src/index.ts` asks membership before routing a path
(`FsK8s.endpointFor`) and, on a positive "no such workspace", answers the
operation in its own terms:

* **one line**, `FS_NOT_FOUND`, naming the path, saying nothing was created and
  where to look instead;
* **no `ensure`**, so no PVC and no pod can appear for an id nobody registered;
* one `logger.warn` per path for the pod log (stdout logging stays the operator's
  window into this);
* the session continues — the failure is the operation's, not the platform's.

```
/workspaces/.git/HEAD is not inside a workspace of this platform: no workspace
named '.git' is registered under /workspaces, so no pod or volume was created for
it and the control plane keeps no copy of that path; use a path under
/workspaces/<workspace-id>
```

### 2.3 Why degrade, and not serve those paths from the control plane

The control plane is not a file world. Its `/workspaces` is an `emptyDir` of
realpath anchors (created by `management.create` and the reconciler), **no
workspace PVC is ever mounted on it**, and with `WS_DAEMON_ENDPOINT` unset the
static fallback endpoint has no listener. Serving `/workspaces/.git` locally
would present an empty, disconnected tree as the user's files and swallow writes
into a volume no pod can read — a silent lie, strictly worse than a precise
refusal. (Today that path instead reaches the dead fallback and fails as
`fetch failed`: the same non-answer with a worse message, which this change also
removes.)

### 2.4 Test evidence (TDD)

`packages/fs-k8s/tests/not-a-workspace.spec.ts` (new, 9 cases) and additions to
`packages/fs-k8s/tests/paths.spec.ts` (2 cases, against a **real** sandbox
daemon with the resolver mounted) and
`packages/workspace-k8s/tests/wire-endpoint.spec.ts` (5 cases).

RED (before the fix):

```
 FAIL  tests/not-a-workspace.spec.ts > the operator's case: '.git' …
AssertionError: expected 'served by the pod' to be an instance of FsError
      Tests  5 failed | 4 passed (9)

 FAIL  tests/wire-endpoint.spec.ts > … membership, asked without provisioning
TypeError: wired.isWorkspace is not a function
      Tests  5 failed | 6 passed (11)
```

GREEN (after):

```
 ✓ tests/not-a-workspace.spec.ts  (9 tests) 45ms
 ✓ tests/paths.spec.ts  (7 tests) 170ms
 ✓ tests/wire-endpoint.spec.ts  (11 tests)
      Tests  42 passed (42)   [fs-k8s]
      Tests  253 passed (253) [workspace-k8s]
```

Branches pinned: the operator's exact `'.git'` case degrades with one line and
never asks the resolver and never touches the network; every fs member
(`stat`, `lstat`, `listDir`, `readText`, `writeText`, `editText`) degrades the
same way; a plain non-workspace directory (`agents-local-md`, the phantom
workspace) too; a dotfile nested INSIDE a registered workspace routes to that
pod and is served (asserted through a real daemon:
`readText('.git/HEAD', { cwd: '/workspaces/ws-a' }) === 'ref: refs/heads/main\n'`);
fail-open for a missing bridge, a throwing question, and for the root path
itself, which names no workspace and keeps its old route.

### 2.5 Residual, stated

A command whose **cwd** is `/workspaces/.git` still fails that one command: the
subprocess seam has no "no such endpoint" answer (its contract is
`resolve(id) → string`), and `packages/subprocess-k8s/**` is outside this
change's write scope. The failure is the seam's documented per-command
settlement (`done` rejects with the actionable message — "spawn-level failures
belong on the done promise"), not a conversation error, and the message is the
same precise one-liner. A command with cwd `/workspaces` (the case the operator
called out) never touches the resolver at all: `workspaceOf('/workspaces')` is
`undefined`, and the route is unchanged.

---

## 3. Defect 3 — the new-workspace dialog on the official components

### 3.1 The official family is in the composition — confirmed three ways

1. **It is a seed word of the web shell's module table.** The shell ships it next
   to `react`, exactly as it hands modules to every client bundle:

   ```bash
   $ SHELL_DIST="$(dirname "$(readlink -f "$(command -v dsh)")")/../node_modules/@deepseek-ai/dsh-web-frontend/dist"
   $ grep -o '"@deepseek-ai/dsh-client-ui-primitives":[A-Za-z_$][A-Za-z0-9_$]*' "$SHELL_DIST"/assets/index-*.js
   "@deepseek-ai/dsh-client-ui-primitives":sE
   ```
   (the same object holds `react`, `react/jsx-runtime`, `react-dom`,
   `react-dom/client`, `@deepseek-ai/cordis`, `dsh-client-store`,
   `dsh-client-ui-slots`, `dsh-client-ui-dockkit`).
2. **Its stylesheet is in the shell's CSS bundle** — the CSS-module hashes for
   `.dialog`, `.wrap`, `.button` and `.tag` are present in
   `assets/index-*.css`, so a component required from the table arrives styled.
3. **Every official client bundle requires it the same way**, including the
   vendored workspace browser this repo used to carry
   (`_deepseek_ai_dsh_client_ui_primitives.Modal` / `.Button`).

So: no new dependency, no re-vendoring, no version change. The only build-side
change is one entry in the esbuild `external` list (the same treatment
`@deepseek-ai/dsh-client-ui-slots` already had). Without it the build fails
loudly — which is the property that keeps this honest:

```
✘ [ERROR] Could not resolve "@deepseek-ai/dsh-client-ui-primitives"
    packages/workspace-k8s/src/client/NewWorkspaceDialog.tsx:37:42
```

### 3.2 The dialog now

Shaped after the **official rename dialogs** in
`@deepseek-ai/dsh-client-ui-workspace` (which the operator already sees
elsewhere in this product):

* `Modal` — mask, card (`width: min(380px, 100%)`, `box-sizing: border-box`),
  header with title + close, description, a 24px-padded body, a footer row,
  Escape/mask close and focus handling;
* `Input` — the **field**. The official wrapper is an `inline-flex` span with no
  width of its own, so the card's flex column bounds it at
  `380 − 2×24 = 332px`. That is the defect fixed structurally: the width is the
  container's, not a caller's class;
* `Button variant="outline"` (取消) and `Button variant="primary"` (创建);
* `Tag tone="danger"` for a failed create, inside a `role="alert"` element;
* the field keeps `id="dsh-ws-name"` and takes the Modal's documented
  `data-modal-autofocus` hook instead of React's `autoFocus`.

Behaviour unchanged and pinned: exactly one name input, 创建/取消, Enter
submits, the API's own message shown in-dialog and reported through `onError`, a
failed create keeps the flow open, both `directoryFlow` seats occupied at
`priority: -100`, `POST {"name":"…"}` and nothing else.

### 3.3 Deleted

Every `dsh-ws-*` rule in `packages/workspace-k8s/src/client/styles.ts`: the modal
mask, card, description, field, error and footer rules, and the `dsh-ws-btn`
pair that `ed944c6` had to add after the field had already drifted once. The
plugin now ships **no CSS for this dialog at all** — and, as a consequence, no
fixed-position rule at all (the mask is the official Modal's).

### 3.4 Finding: the family exports no error-message component

`@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` exports `Modal`, `Button`,
`Input`, `Tag`, `Toast`, `Pill`, `Tooltip`, `RiskConfirmation`, the icon set,
`SettingsForm`/`SettingsValueField`/`SettingsSecretField`, … but **nothing that
renders a form/dialog error message**. The official dialogs write their own
element for it (`dsh-client-ui-workspace`'s `renameError`,
`dsh-client-ui-plugin-manager`'s `reason`,
`SettingsForm`'s `.failed`), and `SettingsValueField` is the settings form's
own control (its `reset`/`overridden` affordances belong to the composition
editor, not to a creation dialog).

So the error is rendered with the closest official thing there is,
`Tag tone="danger"`, rather than with new hand-written CSS. **Known limitation,
stated rather than hidden:** a `Tag` is a `white-space: nowrap` capsule, so an
exceptionally long API message would be clipped by the card instead of wrapping.
The create API's own failures are one-liners (`"<name>" is not a valid workspace
name`), which fit. If the operator wants guaranteed wrapping, the options are
(a) one ~4-line rule using `--dsw-alias-label-error` plus `overflow-wrap: anywhere`
— which is exactly what the official packages do — or (b) an upstream
error-message primitive. Say which and it is a one-commit change.

### 3.5 Finding: one file outside the stated write scope

`scripts/build-workspace-ui.mjs` gained **one array entry**
(`'@deepseek-ai/dsh-client-ui-primitives'` in `external`). It is the build of
`packages/workspace-k8s`'s own browser bundle (its header: *"Build
@visecy/dsh-workspace-ui"*, invoked by that package's `build` script), and there
is no way to require a module the bundle must not inline without it — the
alternative was a vendored copy, which the operator forbade. Nothing else in
`scripts/` was touched.

### 3.6 Test evidence (TDD)

The harness (`tests/client-harness.ts`) gained a stand-in for the official
family, handed to the bundle through the module table exactly as the shell hands
the real one over, plus a record of which specifiers the bundle required. The
real package cannot be imported in this workspace (it needs `react`,
`react-dom` and a CSS pipeline that are not installed), so the stand-ins keep
the parts a spec can assert: **which** official member rendered, on which
element, with which props — and the tree walk renders those stand-ins and only
those (`WorkspaceDetailView`'s row component uses `useState` and must stay a
leaf).

`tests/new-workspace-dialog.spec.ts` (+4 cases) and
`tests/workspace-dialog-styles.spec.ts` (rewritten).

RED (before the rewrite):

```
 FAIL  … requires the official family from the module table
AssertionError: expected [ 'react', 'react', 'react', …(1) ] to include
  '@deepseek-ai/dsh-client-ui-primitives'
 FAIL  … renders the official Modal as its root, with the official field and actions
AssertionError: expected 'div' to be [Function Modal]
 FAIL  … shows a failure through the official danger Tag, not a bespoke element
AssertionError: expected undefined to be 'danger'
 FAIL  … carries no plugin-authored class: every element is the official one
AssertionError: expected [ 'dsh-ws-modal-overlay', …(5) ] to deeply equal []
      Tests  4 failed | 9 passed (13)
```

GREEN (after):

```
 ✓ tests/new-workspace-dialog.spec.ts  (13 tests)
 ✓ tests/workspace-dialog-styles.spec.ts  (4 tests)
      Tests  253 passed (253)
```

The styles spec now asserts the inverse of what it used to: the plugin carries no
rule for the dialog, the dialog renders no plugin-authored class, and the
stylesheet it does inject is still the panel's and the detail view's. The two
specs that had pinned "the dialog's mask is the only fixed-position rule we
ship" now pin the stronger fact: we ship none.

---

## 4. Verification (pasted)

All of the following ran on the final tree (`a9e03b7`), on this machine.

### 4.1 `pnpm install --frozen-lockfile`

```
Scope: all 15 workspace projects
Already up to date
Done in 1s using pnpm v11.25.0
```

### 4.2 `pnpm -r build`

```
packages/workspace-picker build: Done
packages/sandbox-daemon build: Done
packages/fs-k8s build$ node ../../scripts/build-pkg.mjs fs-k8s src/index.ts
packages/subprocess-k8s build$ node ../../scripts/build-pkg.mjs subprocess-k8s src/index.ts
packages/workspace-k8s build$ node ../../scripts/build-pkg.mjs workspace-k8s src/index.ts && node ../../scripts/build-workspace-ui.mjs
packages/subprocess-k8s build: built subprocess-k8s -> dist/index.js
packages/subprocess-k8s build: Done
packages/fs-k8s build: built fs-k8s -> dist/index.js
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/fs-k8s build: Done
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
```

(logging-stdout, identity-bridge, auth-oidc, platform-domain, storage-db,
session-persistence-rdb, workspace-picker and sandbox-daemon are the other eight
projects; all 15 report `Done`, none reports an error.)

`git status` is clean after the build: `lib/client.js` is a pure function of the
sources.

### 4.3 `pnpm -r test`

```
packages/logging-stdout test:              Tests  10 passed (10)
packages/auth-oidc test:                   Tests   7 passed (7)
packages/platform-domain test:             Tests  20 passed (20)
packages/identity-bridge test:             Tests  31 passed (31)
packages/storage-db test:                  Tests   1 passed (1)
packages/workspace-picker test:            Tests  10 passed (10)
packages/session-persistence-rdb test:     Tests 129 passed | 24 skipped (153)
packages/sandbox-daemon test:              Tests  36 passed (36)
packages/fs-k8s test:                      Tests  42 passed (42)
packages/workspace-k8s test:               Tests 253 passed (253)
packages/subprocess-k8s test:              Tests  16 passed (16)
```

**555 passed, 24 skipped (PostgreSQL-gated), 0 failed, 0 load failures** across
64 test files (of which 2 are skipped whole: the PostgreSQL-gated suites).
Baseline on `441b17b` was 530 passed / 24 skipped; the +25 are the new cases
(5 profile + 9 not-a-workspace + 2 paths + 5 membership + 4 dialog).

### 4.4 `bash scripts/harness-profile.sh /home/ovizro/Code/.tmp-p10/harness`

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

check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
ok   @visecy/dsh-logging-stdout
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain

check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1): error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead
harness ready: /home/ovizro/Code/.tmp-p10/harness
```

### 4.5 `node scripts/check-plugin-imports.mjs <profile>`

```
check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
```

### 4.6 `node scripts/smoke-zero-patch.mjs --target <profile>/node_modules`

```
ok   [string guard] official connection has no cookie-layer bypass (deleted patch P2)
ok   [string guard] official connection has no isLoopback pin (deleted patch P1)
ok   [string guard] official webserver carries no registerGate fork extension
ok   [string guard] official client still reads the transport hook the plugin publishes
ok   1a. __DSH_TRANSPORT__ is injected through webserver/index-inject
ok   1b. the injected transport hook says ownsHost === true
ok   2. cookieless GET / is a 302 handoff
ok   2. the handoff Location carries the launch token
ok   3a. the launch token is exchanged with a 303
ok   3b. the exchange mints the official browser cookie
ok   3c. the exchange redirects to clean /
ok   3d. clean GET / with the cookie renders the index (200)
ok   3e. the transport global is rendered into the served HTML
ok   3f. the transport global lands before the boot-readiness tail
ok   4a. /api without the cookie is refused 401
ok   4b. the same /api request with the cookie passes the official fence (404, not 401)
ok   5a. ctx.dshAuth.currentUser reads x-forwarded-user / x-forwarded-groups
ok   5b. ctx.dshAuth.currentUser reports no principal without the user header
ok   5c. the principal is readable on a live request
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path
```

### 4.7 `node scripts/smoke-official-integration.mjs --target <profile>/node_modules`

```
ok   fixture is unpatched (no cookie bypass)
ok   fixture is unpatched (no isLoopback pin)
ok   fixture has no webserver fork extension (no registerGate)
ok   transport hook is read by the official client
ok   transport hook honours ownsHost
ok   identity-bridge publishes the transport hook as an index-inject global
ok   ownsHost hook satisfies the official isLoopback expression
ok   without the hook the same expression stays false
ok   the official connection exposes both exchange entry points
ok   authenticatedUrl carries the process launch token
ok   the official cookie layer is still ACTIVE (401 without it)
ok   the exact / route hands a cookieless browser to the token exchange
ok   the token exchange redirects to clean / (303)
ok   the token exchange mints the signed browser cookie
ok   the cookie satisfies the official check (no 401)
ok   a wrong token is refused (sent back through the handoff, never a dead 401)
ok   the Host/Origin fence still applies to a cookie holder
ok   index served without any connection patch
ok   __DSH_TRANSPORT__ injected as a head global
ok   transport global lands before the boot-readiness tail
ok   the booted webserver has no registerGate seat (no fork needed)
ok   identity-bridge provides ctx.dshAuth over the sidecar headers
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
```

### 4.8 Extra: the real CLI renders the patched profile (defect 1's mechanism)

```
$ DSH_HOME=…/harness/home dsh --profile web --dump-config > web-dump.yml 2> web-dump.err
$ echo "exit=$? stderr-bytes=$(wc -c < web-dump.err)"
exit=0 stderr-bytes=0
$ grep -A2 '^- id: ui-permission$' web-dump.yml
- id: ui-permission
  name: '@deepseek-ai/dsh-client-ui-permission-presets'
  disabled: true
```

and the host row it pairs with, in the same rendered file:

```
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config: { presets: … }
  disabled: true
```

---

## 5. Proof on the live cluster (browser / CDP)

Deploy the image built from `a9e03b7` first (`kubectl -n "$NS" rollout status
deploy/<control-plane>`), then run the three actions below.

### 5.1 Defect 1 — the settings page makes no `permissionPresets` call

**Action.** Enable CDP network capture, then open the settings page and reload it:

```
Network.enable
Page.navigate  →  https://<host>/?token=…   (the settings page)
```

**Assert (CDP):** collect the `Network.requestWillBeSent` URLs the settings page
produced and filter them:

```js
const urls = [...collected]                                   // every request since the reload
urls.filter(u => u.includes('permissionPresets'))             // MUST be [] — the client half is not loaded
urls.some(u => /\/api\/permissionPresets\/catalog/.test(u))      // MUST be false
```

**Assert (DOM):** the settings page renders its sections; no element contains the
string `permissionPresets/catalog failed`:

```js
document.body.innerText.includes('permissionPresets/catalog failed')   // MUST be false
```

Before the fix this was exactly one `POST /api/permissionPresets/catalog` → 404
plus that sentence on screen. After it, zero requests: the browser half that
would have called it is not in the boot graph any more, so there is nothing to
silence — which is why this is a fix and not a suppression. The Permissions row
is absent from the settings page by design (§1.2); every other row is unchanged.

### 5.2 Defect 2 — a turn that touches a dotfile inside a workspace

**Action.** Open a session in a workspace (sidebar → a workspace → 新会话, i.e.
cwd `/workspaces/<id>`), then send either of:

> 读取 `.git/HEAD` 的内容
> `cat .git/HEAD`（bash 工具）

**Assert (CDP).** The turn completes, and neither the conversation transcript nor
the console contains the resolver line:

```js
document.body.innerText.includes('workspaceEndpointResolver')     // MUST be false
document.body.innerText.includes('is not a registered workspace') // MUST be false
```

A workspace with no `.git` legitimately answers "not found"; the point is that
the answer is a tool result, not a platform failure. In the pod log the same turn
shows **no** `workspaceEndpointResolver:` line.

**The operator's original path (cwd = the workspace ROOT)** — use a session whose
cwd is `/workspaces` (the durable headers with `f_cwd = '/workspaces'` are the
ones that failed) and touch `.git` there:

**Assert.** The turn continues; the tool result is the one-liner of §2.2
(`/workspaces/.git … is not inside a workspace of this platform … use a path
under /workspaces/<workspace-id>`), and the pod log has exactly one matching
`fs-k8s: … is outside every workspace of this platform …` warn line per path.
Nothing new appears in `kubectl -n "$NS" get pvc` — that is the fence doing its
job:

```bash
kubectl -n "$NS" get pvc | grep -E '\.git|agents-local-md'   # MUST be empty
```

### 5.3 Defect 3 — the dialog's field width is bounded by its container

**Action.** Open the new-workspace dialog (the `+` beside the workspace group in
the sidebar, or the hero's 添加工作区), then run:

```js
// the official Modal card; keying on the aria-label also proves which dialog it is
const card = document.querySelector('div[role="dialog"][aria-label="新建工作区"]')
const field = card.querySelector('span > input')                              // the ONE name input
const wrap  = field.parentElement                                             // the official Input wrapper
const body  = wrap.parentElement                                              // the Modal's 24px-padded body
({ cardW: card.clientWidth, bodyW: body.clientWidth, wrapW: wrap.getBoundingClientRect().width,
   fieldW: field.getBoundingClientRect().width,
   cardRight: card.getBoundingClientRect().right, wrapRight: wrap.getBoundingClientRect().right })
```

**Expected (computed style / geometry), all of which must hold:**

| assertion | expectation |
|---|---|
| `card.getAttribute('aria-modal')` | `"true"` (the official Modal's card, not a stray div) |
| `getComputedStyle(card).width` | `380px` (or the viewport width when narrower: `min(380px, 100%)`) |
| `getComputedStyle(body).paddingLeft` / `paddingRight` | `24px` |
| `wrap.getBoundingClientRect().width` | **332** = `body.clientWidth − 48` (`card.clientWidth` is 380, the body's own `clientWidth` is also 380 because its 24px padding is inside it; its CONTENT column is 332) — bounded by the container, not by a caller class |
| `wrap.getBoundingClientRect().right` | **≤ `card.getBoundingClientRect().right`** |
| `field.getBoundingClientRect().right` | **≤ `wrap.getBoundingClientRect().right`** (the native input never leaves its wrapper) |
| `field.getBoundingClientRect().width` | **315** = 332 − 2×8 padding − 2×0.5 border of the wrapper (the input itself has no padding or border) |
| `document.querySelectorAll('div[role="dialog"] input').length` | `1` |
| both footer buttons | `div[role="dialog"] .footer button` → 创建 (primary) and 取消 (outline) |

The load-bearing comparison is the third row: **the field's wrapper is exactly as
wide as the card's content column and never wider**, which is precisely what the
hand-written rules got wrong (`width: 100%` on a `content-box` input inside a
`content-box` card: 380 + 18 + 2 inside a 380px column). A regression here is
visible without any CSS archaeology — `wrap.getBoundingClientRect().right`
exceeds `card.getBoundingClientRect().right`.

---

## 6. Concerns and open items

1. **The `Tag` error line does not wrap** (§3.4). Real, cosmetic, and the one
   place where "use only official components" and "long API messages fit" pull
   against each other. One word from the operator and it becomes a 4-line rule
   using the official error token, exactly as the official packages do it.
2. **One file outside the stated write scope** (§3.5):
   `scripts/build-workspace-ui.mjs`, one array entry, forced by esbuild's
   resolution rule.
3. **No live-cluster access from here.** No PostgreSQL and no cluster are
   reachable in this environment, so the three checks in §5 are the operator's
   to run. Everything provable locally is proven in §4, including the real CLI
   rendering the patched profile and both smokes booting the shipped
   composition.
4. **`permission` and `ui-permission` are a pair.** Whoever reverts one must
   revert the other; the profile comment and
   `tests/profile-permission-ui.spec.ts` say so, and the spec fails if only the
   host half comes back.
5. **The subprocess cwd case is unfixed by design** (§2.5) and is the only place
   where the old refusal can still surface — as one failed command with the same
   precise one-liner, never as a conversation error.
6. **Unrelated observation, not touched:** the new-workspace field does not guard
   Enter against IME composition, while the official rename dialogs do
   (`onCompositionStart`/`End`). For a CJK operator typing a workspace name with
   an IME, pressing Enter to accept a candidate submits the dialog. Out of scope
   for "keep the behaviour unchanged"; worth a follow-up.

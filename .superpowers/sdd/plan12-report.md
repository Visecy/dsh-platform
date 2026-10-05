# Plan 12 report — R5 and the three operator-ordered fixes

Date: 2026-10-06
Branch: `main` (was clean at `115fedd`; 4 commits added, see §0)
Write scope honoured: `packages/sandbox-daemon/**`, `packages/fs-k8s/**`,
`packages/subprocess-k8s/**` (untouched — nothing there needed a change),
`packages/workspace-k8s/src/client/**` + its tests, `design/2026-10-04-dsh-platform-2-design.md`.
The deploy repo, the chart and the profile patch files were not touched.

---

## 0. Status and commits

**Status: all three changes implemented, committed and verified; every verification
command exits 0 and the full suite is green with zero load failures. No blockers.**

| commit | subject |
|---|---|
| `75666a9` | `docs(design): record R5 — the pod plugin layer must work under any profile` |
| `572b4e9` | `fix(sandbox-daemon): keep runtime state out of the user's workspace (R5)` |
| `3fd558e` | `fix(fs-k8s): give a rootless relative path a defined base (R5)` |
| `163c7fb` | `fix(workspace-ui): match the official field behaviour in the new-workspace dialog (R5)` |

Diffstat:

```
 design/2026-10-04-dsh-platform-2-design.md         |   1 +
 packages/sandbox-daemon/src/index.ts               |  26 +-
 packages/sandbox-daemon/src/main.ts                |  10 +-
 packages/sandbox-daemon/src/runtime.ts             |  94 +++++++
 packages/sandbox-daemon/tests/runtime-state.spec.ts| 290 +++++++++++++++++
 packages/fs-k8s/src/index.ts                       |  61 +++++++-
 packages/fs-k8s/tests/resolve-rootless.spec.ts     | 201 +++++++++++++++++
 packages/workspace-k8s/lib/client.js               |  49 +++++-
 packages/workspace-k8s/src/client/NewWorkspaceDialog.tsx | 118 +++++++++++--
 packages/workspace-k8s/tests/client-harness.ts     |  21 ++-
 packages/workspace-k8s/tests/new-workspace-dialog.spec.ts | 186 +++++++++++++
```

Test delta: **+26 tests** (10 daemon runtime-state, 8 fs-k8s rootless-resolve,
8 dialog field behaviour) — 566 → 592 passed, the same 24 PostgreSQL-gated skips.

Raw verification logs are archived in `.superpowers/sdd/plan12-logs/`
(`tests.log`, `harness.log`, `imports-web.log`, `imports-headless.log`,
`smoke-zero.log`, `smoke-official.log`, `daemon-spec.log`, `fs-spec.log`,
`dialog-spec.log`).

---

## 1. R5 — the boundary (recorded, and referenced by all three commits)

`design/2026-10-04-dsh-platform-2-design.md` §1, next to R1–R4, same table style:

```markdown
| R5 | **工作区 pod 插件层必须在任意 DSH profile 下可用，完整部署不必**：`packages/fs-k8s`、
`packages/subprocess-k8s`、`packages/sandbox-daemon`（以及工作区 pod 内与它们并列挂载的任何东西）
不得假定自己是被我们的 `web`/`headless` profile 组合加载的——它们不认识的 profile、缺失的
session/workspace 上下文、别的调用者组合，都必须得到确定性的答案而不是硬失败。**chart、profile
patch 文件与部署自身的接线不在约束内**（它们本来就只服务本部署） | 操作者 2026-10-05 裁定：
"The workspace-pod plugin layer must work under any DSH profile. The complete deployment does NOT have to." |
```

Each of the three commits below ends its subject with `(R5)` and its body states
which side of the boundary the fix is on (plugin layer vs. deployment wiring —
no chart, Dockerfile or profile patch change was needed anywhere).

---

## 2. Change 1 — the daemon's runtime state leaves the user's workspace

### 2.1 What was wrong (RED, before any production change)

`tests/runtime-state.spec.ts` snapshots the whole workspace tree (relative path →
`dir` / `file:<sha256>`) and runs a real command through the real HTTP daemon:

```
 × a command through the daemon leaves the workspace byte-identical > adds nothing at all for a command that creates nothing
   → expected [ 'commands', …(7) ] to deeply equal []
- Expected
+ Received
- Array []
+ Array [
+   "commands",
+   "commands/7152e4ce-dcc3-4908-a850-7a5621801203",
+   "commands/7152e4ce-dcc3-4908-a850-7a5621801203/stderr.frames",
+   "commands/7152e4ce-dcc3-4908-a850-7a5621801203/stdout.frames",
+   "processes",
+   "processes/7152e4ce-dcc3-4908-a850-7a5621801203",
+   "processes/7152e4ce-dcc3-4908-a850-7a5621801203/exit.json",
+   "processes/7152e4ce-dcc3-4908-a850-7a5621801203/pid",
+ ]
 × keeps a terminal session out of the workspace too
   → expected [ 'ptys', …(2) ] to deeply equal []
 Test Files  1 failed (1)
      Tests  9 failed | 1 passed (10)
```

(the terminal case was the same root cause with a third directory; it is fixed by
the same split.)

### 2.2 The design

* **Two roots, named by what they are.** `FilesService` keeps `root` — the PVC
  mount the user browses, commits and hands to an agent. `CommandRegistry`,
  `launchGroup` and `PtyRegistry` get `runtimeRoot` — per-pod state that a
  command cannot outlive its pod with, that only this process ever reads back,
  and that contains no user content.
* **Location + safe default.** `DaemonOptions.runtimeRoot` (env
  `DAEMON_RUNTIME_ROOT`, `src/main.ts`), defaulting to

  ```
  <tmpdir>/dsh-sandbox-daemon/<12 hex of sha256(workspace root)>
  # in a workspace pod: /tmp/dsh-sandbox-daemon/9f2c…  (DAEMON_ROOT=/workspaces/<id>)
  ```

  The pod's writable layer is the exact lifetime of the state (both die with the
  pod), it needs **no volume mount and no chart change**, and it is outside every
  path the file API can address. The hash keys it by workspace root so two
  daemons on one host (tests, local development) never share a state directory.
* **Absolute-root invariant kept, and made explicit for the new root.**
  `resolve(opts.root)` still makes the workspace root absolute (the comment and
  the reason stay); `prepareRuntimeRoot` *refuses* a relative `runtimeRoot`
  instead of resolving it against the daemon's cwd, refuses a root that is or
  lies inside the workspace root, and reports an unusable area at boot rather
  than turning every later command into an I/O error. `startDaemon` also returns
  `runtimeRoot` now and `main.ts` logs both roots.
* **Nothing else changed**: the file API, `OUT_OF_ROOT`, framing, stdin,
  range-status and `dispose()` semantics are untouched.

### 2.3 The byte-identical proof (GREEN, after the change)

```
 ✓ a command through the daemon leaves the workspace byte-identical > adds nothing at all for a command that creates nothing
 ✓ a command through the daemon leaves the workspace byte-identical > shows exactly the file the command itself created, and nothing else
 ✓ a command through the daemon leaves the workspace byte-identical > reads its own output back through the API while the frames stay out of the tree
 ✓ a command through the daemon leaves the workspace byte-identical > keeps a terminal session out of the workspace too
 ✓ a command through the daemon leaves the workspace byte-identical > still serves the workspace itself, and still refuses to escape it
 ✓ the runtime area when nothing is configured > defaults to the pod's own ephemeral area, outside the workspace
 ✓ a runtime root that would put state back in the user's tree is refused > refuses a runtime root equal to the workspace root
 ✓ a runtime root that would put state back in the user's tree is refused > refuses a runtime root inside the workspace root
 ✓ a runtime root that would put state back in the user's tree is refused > refuses a relative runtime root instead of resolving it against the daemon cwd
 ✓ a runtime root that would put state back in the user's tree is refused > refuses to start when the runtime area cannot be created
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

What the assertions mean, concretely:

* a no-op command (`sh -c true`) leaves **every** existing file byte-identical
  and adds **no** entry at all (`added === []`, `changed === []`), while
  `runtimeRoot/commands/<id>/{stdout,stderr}.frames` and
  `runtimeRoot/processes/<id>/{pid,exit.json}` exist;
* a command that writes `made.txt` and `mkdir made-dir` produces **exactly**
  `['made-dir','made.txt']` as the added set and nothing else;
* a PTY's output is readable through the API while
  `runtimeRoot/ptys/<id>/output.frames` exists and the workspace has no `ptys/`;
* the file API still serves the workspace and still refuses `../../etc/passwd`
  with `OUT_OF_ROOT`.

(The whole `sandbox-daemon` suite is 46 passed; `paths.spec.ts` in `fs-k8s`,
which drives the real daemon with the deployment's path layout, stays green.)

### 2.4 The stray directories left in EXISTING workspaces

Nothing was deleted anywhere — not by the fix, not by this session.

**Does the daemon's own cleanup remove them? No, and it never would have.**
The only removal the daemon performs is `rm -rf` of a command directory **it has
just created itself** when that command's launch throws (`commands.ts`
`run()` catch arm, now the pod-local directory); `dispose()` kills process
groups and destroys streams but removes no directory, and the new code never
reads or writes outside `runtimeRoot`. So the old `commands/`, `processes/`
(and `ptys/`) trees inside a PVC stay exactly where they are until the operator
removes them.

Per-workspace command for the operator (pod name == workspace id; the daemon
container is `sandbox-daemon`; the PVC is mounted at `/workspaces/<id>`, which is
also `DAEMON_ROOT`):

```bash
NS=${WS_NAMESPACE:?set WS_NAMESPACE}; WS_ID=${WS_ID:?set the workspace id}

# 1. what is actually there (the exact stray dirs, at the workspace top level)
kubectl -n "$NS" exec "pod/$WS_ID" -c sandbox-daemon -- \
  find "/workspaces/$WS_ID" -maxdepth 1 \( -name commands -o -name processes -o -name ptys \) \
       -type d -print -exec du -sh {} +

# 2. look inside before deciding (frame/pid/exit files only, from commands that
#    died with an earlier pod; no user content, nothing the daemon reads back)
kubectl -n "$NS" exec "pod/$WS_ID" -c sandbox-daemon -- \
  find "/workspaces/$WS_ID/commands" "/workspaces/$WS_ID/processes" \
       -maxdepth 2 -type f -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -20
```

All workspace pods at once (same three names, one line per pod):

```bash
NS=${WS_NAMESPACE:?set WS_NAMESPACE}
for pod in $(kubectl -n "$NS" get pod -l app=dsh-workspace -o name); do
  echo "== ${pod#pod/}"
  kubectl -n "$NS" exec "$pod" -c sandbox-daemon -- \
    find /workspaces -mindepth 2 -maxdepth 2 \( -name commands -o -name processes -o -name ptys \) \
         -type d -print -exec du -sh {} +
done
```

If the operator decides to remove them (their call, not ours), the safe form is
one workspace at a time — these directories are stale runtime state, and a
running command's *live* state is not in the workspace at all any more, so
nothing being executed is affected:

```bash
kubectl -n "$NS" exec "pod/$WS_ID" -c sandbox-daemon -- \
  rm -rf "/workspaces/$WS_ID/commands" "/workspaces/$WS_ID/processes" "/workspaces/$WS_ID/ptys"
```

Both paths (/tmp and the workspace) can be confirmed on a live pod with:

```bash
kubectl -n "$NS" exec "pod/$WS_ID" -c sandbox-daemon -- sh -c \
  'echo "DAEMON_ROOT=$DAEMON_ROOT"; ls -la /tmp/dsh-sandbox-daemon 2>/dev/null; ls -d "$DAEMON_ROOT"/commands "$DAEMON_ROOT"/processes 2>/dev/null'
```

---

## 3. Change 2 — a rootless relative path is answered, not refused

### 3.1 Pre / post behaviour of `resolve(".")`

Probe of the real provider (source at `115fedd`, then after `3fd558e`; the same
config the profile mounts, `hostRoot === podRoot === /workspaces`):

| call | BEFORE (`115fedd`) | AFTER (`3fd558e`) |
|---|---|---|
| `resolve(".")` (headless line 315) | **THREW** `FsError FS_NOT_FOUND`: “. is outside the workspace root /workspaces of this platform, so it names no workspace…” | `ok`: `processPath=/workspaces displayPath=/workspaces` |
| `resolve("")` | **THREW** the same | `ok`: `/workspaces` |
| `resolve(".")` with `cwd=/workspaces/ws-a` | `ok`, but `displayPath=/workspaces/ws-a/.` | `ok`: `displayPath=/workspaces/ws-a` (normalized) |
| `resolve("/.git")` | THREW `FS_NOT_FOUND` | THREW `FS_NOT_FOUND` (unchanged — absolute stays literal) |

The pre-fix text quoted by the operator (`path escapes workspace root: .`) is the
pre-`534565e` spelling of the same failure; at `115fedd` the same call already
answers with the `FS_NOT_FOUND` degradation, and it is still a **hard failure for
`@deepseek-ai/dsh-headless`**, which needs a string back at `lib/index.js:315`
(`const cwd = fs.processPath(await fs.resolve("."))`) before any session or
workspace exists. Both spellings are gone now.

The same probe run against the **artifact the harness profile loads** (the built
`@visecy/dsh-fs-k8s` in `.tmp-harness-plan12/home/profiles/headless/node_modules`,
i.e. not the source tree):

```
process.cwd() = /home/ovizro/Code/dsh-platform/.tmp-harness-plan12
resolve(".")         -> ok processPath=/workspaces displayPath=/workspaces
resolve("")          -> ok processPath=/workspaces displayPath=/workspaces
resolve(".", cwd)    -> ok processPath=/workspaces/ws-a displayPath=/workspaces/ws-a
resolve("/.git")     -> THREW FS_NOT_FOUND: /.git is outside the workspace root /workspaces of this platform, …
```

### 3.2 The rule and its justification (also in the code comment)

* **Absolute paths are literal.** `/workspaces/<id>/x` keeps routing to its pod;
  `/.git` keeps answering “absent” (534565e); `/workspaces/.git` keeps reaching
  the membership fence at call time, not at resolve time (7b536ea).
* **Relative paths take `opts.cwd`** when the caller has one — the seam's
  documented contract (`dsh-fs/lib/types/index.d.ts`: “relative paths resolve
  against `opts.cwd`”).
* **Otherwise the provider defines the base**, in this order:
  1. **the harness process's own cwd, when it lies inside the workspace root.**
     That is what `.` means on every real filesystem, and it is the case that
     makes a dsh started *inside* a workspace pod name that workspace instead of
     the anchors directory above it (host and pod paths are identical here:
     `hostRoot === podRoot === /workspaces`).
  2. **the workspace root itself.** It is the one directory this provider always
     serves; the deployment already declares it the process world's start (the
     profile mounts `@deepseek-ai/dsh-bash-local` with `cwd: '/workspaces'`); it
     really exists on the control plane (`management.create` and the reconciler
     `mkdir` the anchors); and it is the only answer a static-endpoint
     composition (no resolver, no session, no workspace id) can give without
     inventing a workspace that does not exist. A caller that then *operates* on
     it gets the ordinary one-line membership answer (7b536ea), not a boot
     failure.
* `resolve` also normalizes the `displayPath` it hands back (it used to be built
  by string concatenation, hence the stray `/.`), and a process whose cwd has
  been removed falls back to the workspace root instead of turning
  `process.cwd()`'s ENOENT into a new hard failure.

Nothing was changed in the headless profile, the chart or the deployment wiring.

### 3.3 The paths that already worked still work

`tests/resolve-rootless.spec.ts` (8 cases) plus the pre-existing suites:

```
 ✓ answers the headless boot call instead of failing it
 ✓ resolves "." to the workspace root, as a normal target
 ✓ treats an empty (rootless) path the same way
 ✓ resolves a nested relative path against the same base
 ✓ prefers the caller-supplied base and normalizes what it hands back
 ✓ keeps taking an absolute path literally, inside the root and outside it
 ✓ leaves the root-level .git to the membership fence, as before
 ✓ resolves "." against the process cwd, and routes it to that workspace pod
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

The operator's four explicit regression checks are pinned by the suites that
already covered them, all green in the full run:

| behaviour | pinned by |
|---|---|
| a dotfile inside a registered workspace is an ordinary file | `paths.spec.ts` “serves a dotfile nested inside the registered workspace”; `outside-the-root.spec.ts` “serves a dotfile INSIDE the registered workspace from that workspace pod” |
| ordinary paths under the workspace root keep routing to their pod | `paths.spec.ts` (write/read/list/stat), `outside-the-root.spec.ts` “keeps ordinary paths under the root routed…” |
| `/workspaces/.git` answers as absent without waking a workspace, `/.git` answers as absent | `paths.spec.ts` (walk probes `[ws/.git, /workspaces/.git, /.git]`, refusals `[]`), `outside-the-root.spec.ts` (`FS_NOT_FOUND`, no daemon call, no `ensure`) |
| the pod's own `OUT_OF_ROOT` stays `FS_PERMISSION_DENIED` | `asFsError` mapping unchanged; daemon-side `OUT_OF_ROOT` pinned in `sandbox-daemon/tests/server.spec.ts` “rejects malformed payloads with ok:false” |

---

## 4. Change 3 — the new-workspace dialog's field matches the official one

### 4.1 (a) Sizing: confirmed, nothing local constrains it

* the field is the official `Input` (a `<span>` wrapper with no width of its own
  around the native input) inside the official `Modal`'s content column;
* this plugin passes **no** `className`/`style` to it — the shipped test asserts
  the wrapper class is exactly `official-input …` (`new-workspace-dialog.spec.ts`,
  “renders the official Modal as its root, with the official field and actions”);
* `styles.ts` carries **no** rule for the dialog (`workspace-dialog-styles.spec.ts`:
  “no longer carries a single rule for the dialog it replaced”, and the whole
  tree carries no `dsh-*` class). No local override exists to remove.

### 4.2 (b) The IME guard, and the composition-Enter test

The official shape is copied from the two official rename dialogs and the
official create-folder dialog: `onCompositionStart/End` into a `composingRef`,
`if (e.key === "Enter" && !composingRef.current) { e.preventDefault(); … }`, plus
the shared primitives' flag rule (`nativeEvent.isComposing || isComposing ||
keyCode === 229`) for browsers that report composing only on the keydown.

```
 ✓ new-workspace dialog: the official field behaviour > does NOT submit on the Enter that selects an IME candidate
 ✓ new-workspace dialog: the official field behaviour > submits the very next Enter once the composition has ended
 ✓ new-workspace dialog: the official field behaviour > does not submit for a keydown that reports itself as composing
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

The test drives the **shipped** `lib/client.js` (the client harness loads the
committed bundle): type `にほんご`, `onCompositionStart()`, Enter →
`createByName` **not** called, `onCancel` **not** called, the draft is still in
the field; then `onCompositionEnd()`, Enter → exactly one create with
`日本語プロジェクト` and the flow closes. RED before the fix (8 of 21 failed),
including the pre-fix bundle committing `"alpha"` on the composing keydown.

### 4.3 Further divergences found, and what was done

| # | divergence from the official dialogs | disposition |
|---|---|---|
| 1 | Enter during an IME composition submitted | **aligned** (ref guard + flag rule + `preventDefault`) |
| 2 | primary action enabled with a blank name (ours: `disabled: busy`) | **aligned** — official is `blocked = busy \|\| creating \|\| trimmed === ""`; the official create-folder dialog keeps a LOCAL `creatingFolder` beside the owner's `busy` |
| 3 | a second Enter started a second create | **aligned** — local `creating` state (official `confirm()` reentry fence), pinned by a test that re-renders between the two keystrokes (React does that between two real keydowns) |
| 4 | Escape / mask closed the dialog mid-create | **aligned** — `close()` is `if (busy \|\| creating) return`, the official `if (creating) return`; 取消 was already disabled while busy |
| 5 | a stale error stayed under a corrected name | **aligned** — `onChange` clears it, as the official rename forms do |
| 6 | focus: `data-modal-autofocus` present, but no select-on-focus | **aligned** — `onFocus: e.target.select()` (the official forms select their draft) |
| 7 | Modal `description` copy, Tag-based failure, `closeLabel` 关闭, name+trimmed commit | **kept** — this product's own copy/behaviour, previously ruled on and pinned by existing tests |

The dialog is still the official-component dialog (no local CSS, no plugin
classes, `Modal` root, official `Input`/`Button`/`Tag`), and the commit path is
unchanged (`POST /workspaces/api/create {name}` + catalog poll).

---

## 5. Verification (every command, pasted)

### 5.1 `pnpm install --frozen-lockfile` → exit 0

```
Scope: all 15 workspace projects
Already up to date
Done in 1.2s using pnpm v11.25.0
```

### 5.2 `pnpm -r build` → exit 0

```
packages/sandbox-daemon build$ tsc --noEmit
packages/sandbox-daemon build: Done
packages/fs-k8s build: built fs-k8s -> dist/index.js
packages/fs-k8s build: Done
packages/subprocess-k8s build: built subprocess-k8s -> dist/index.js
packages/subprocess-k8s build: Done
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
```

### 5.3 `pnpm -r test` → exit 0 (592 passed, 24 skipped, zero load failures)

```
logging-stdout            Test Files 1 passed (1)          Tests  10 passed (10)
platform-domain           Test Files 4 passed (4)          Tests  20 passed (20)
auth-oidc                 Test Files 1 passed (1)          Tests   7 passed (7)
identity-bridge           Test Files 5 passed (5)          Tests  31 passed (31)
storage-db                Test Files 1 passed (1)          Tests   1 passed (1)
workspace-picker          Test Files 2 passed (2)          Tests  10 passed (10)
session-persistence-rdb   Test Files 7 passed | 2 skipped  Tests 129 passed | 24 skipped (153)
sandbox-daemon            Test Files 7 passed (7)          Tests  46 passed (46)
fs-k8s                    Test Files 6 passed (6)          Tests  61 passed (61)
workspace-k8s             Test Files 30 passed (30)        Tests 261 passed (261)
subprocess-k8s            Test Files 1 passed (1)          Tests  16 passed (16)
```

`grep -c "FAIL\|failed" tests.log` → **0**. 592 = the 566 baseline + the 26 new
tests; the 24 skips are the PostgreSQL-gated ones (unchanged).

### 5.4 `bash scripts/harness-profile.sh /home/ovizro/Code/dsh-platform/.tmp-harness-plan12` → exit 0

```
check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
ok   official CLI refuses --host 0.0.0.0 (exit 1): error: --host 0.0.0.0 is intentionally not supported yet for safety: …
harness ready: /home/ovizro/Code/dsh-platform/.tmp-harness-plan12
```

The `--dump-default-config` stderr files the script captures are **0 bytes** for
both profiles (design §7: stderr must be empty, no `patch: entry … not found`):

```
$ wc -c .tmp-harness-plan12/web-init.err .tmp-harness-plan12/headless-init.err
0 .tmp-harness-plan12/web-init.err
0 .tmp-harness-plan12/headless-init.err
```

### 5.5 `node scripts/check-plugin-imports.mjs <profile>` (standalone, both profiles) → exit 0

```
web:      ok @visecy/dsh-logging-stdout, dsh-fs-k8s, dsh-subprocess-k8s, dsh-workspace-k8s,
              dsh-session-persistence-rdb, dsh-storage-db, dsh-platform-domain,
              dsh-workspace-picker, dsh-identity-bridge
          check-plugin-imports: all 9 plugins import cleanly from …/profiles/web
headless: ok @visecy/dsh-logging-stdout, dsh-fs-k8s, dsh-subprocess-k8s, dsh-workspace-k8s,
              dsh-session-persistence-rdb, dsh-storage-db, dsh-platform-domain
          check-plugin-imports: all 7 plugins import cleanly from …/profiles/headless
```

### 5.6 Smoke 1 — `node scripts/smoke-zero-patch.mjs --target …/profiles/web/node_modules` → exit 0

```
ok   1a. __DSH_TRANSPORT__ is injected through webserver/index-inject
ok   2. cookieless GET / is a 302 handoff
ok   3a. the launch token is exchanged with a 303
ok   3d. clean GET / with the cookie renders the index (200)
ok   4a. /api without the cookie is refused 401
ok   4b. the same /api request with the cookie passes the official fence (404, not 401)
ok   5a. ctx.dshAuth.currentUser reads x-forwarded-user / x-forwarded-groups
ok   fence: a foreign Host never receives the launch token (403)
ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path
```

### 5.7 Smoke 2 — `node scripts/smoke-official-integration.mjs --target …/profiles/web/node_modules` → exit 0

```
ok   the token exchange mints the signed browser cookie
ok   a wrong token is refused (sent back through the handoff, never a dead 401)
ok   the Host/Origin fence still applies to a cookie holder
ok   index served without any connection patch
ok   __DSH_TRANSPORT__ injected as a head global
ok   the booted webserver has no registerGate seat (no fork needed)
ok   identity-bridge provides ctx.dshAuth over the sidecar headers
OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
```

### 5.8 The "keep working" list (untouched, still green)

credentials in PostgreSQL (`platform-domain`), observed-phase panel
(`workspace-k8s` panel specs), ghost pruning (`reconciler`/`record-deletions`),
delete destroying the workspace (`workspace-delete*` specs), the
official-component dialog, stdout logging (`logging-stdout`), and the `.git`
degradation (`outside-the-root.spec.ts`, `paths.spec.ts`) — all inside the 592
passing tests above. No DSH version change, no new runtime dependency, no
lockfile change (`pnpm install --frozen-lockfile` is a no-op), no bundle
patching, no re-vendoring.

---

## 6. Concerns and notes

1. **`resolve(".")` with no base answers the workspace ROOT (`/workspaces`), not
   a workspace.** That is enough for headless to boot and to keep a session
   alive (the anchors root is a real directory and every refusal below it is
   `FS_NOT_FOUND`), but a headless session started in the control plane gets
   `cwd=/workspaces` — an anchor directory that names no workspace, so its file
   operations degrade one line at a time instead of touching a pod. Making that
   session *useful* needs a deployment-level answer (which workspace should a
   cwd-less headless run adopt?) and is therefore out of R5's plugin-layer scope;
   a run started with its cwd inside a workspace (`/workspaces/<id>`) now
   resolves to that workspace via rule 1.
2. **`DAEMON_RUNTIME_ROOT` default is `/tmp/...`.** The daemon images run
   without `readOnlyRootFilesystem` and as uid 1000, so `/tmp` is writable; a
   future hardening that makes the root FS read-only must mount an `emptyDir` at
   the runtime root (or set `DAEMON_RUNTIME_ROOT` to one). This is deliberately a
   deployment-level knob, per the boundary.
3. **Test-run debris**: every daemon started without an explicit `runtimeRoot`
   (a handful of existing specs) now creates a small
   `/tmp/dsh-sandbox-daemon/<hash>/` directory that is never cleaned by the
   daemon. It is per-run tiny and ephemeral by design; the new spec cleans its
   own runtime roots and uses explicit ones.
4. **Relative `runtimeRoot` is refused rather than resolved** — a deliberate
   asymmetry with `root` (which `resolve()` normalizes for historical reasons).
   If an operator ever passes `DAEMON_RUNTIME_ROOT=state`, the daemon now fails
   loudly at boot instead of writing somewhere unpredictable.
5. **The `.superpowers/sdd/` tree is git-ignored** (`.superpowers/sdd/.gitignore`
   is `*`): this report and the logs are force-added/kept locally as the repo's
   plan reports are. Nothing under `.superpowers/` is part of any package's
   published files.
6. **Not done, on purpose** (per the operator's boundary and the task): no chart,
   Dockerfile, profile-patch or deploy-repo change; no automatic deletion of the
   legacy `commands/`/`processes/`/`ptys/` directories; no headless boot attempt
   against a live PostgreSQL (not available in this session), which is why
   change 2's evidence is the plugin-level pre/post plus the specs rather than a
   live `dsh --profile headless` run.

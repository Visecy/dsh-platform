# Post-deploy live verification — action-level checklist

Every item below is a **user action** plus an **observable expectation**, plus what
a FAILURE looks like. The previous round of "browser verification" only proved the
page loads, which is why four defects shipped; an item that cannot fail is not a
check.

Run after deploying the commit that ends with `8af5d19`. Set up once:

```bash
NS="${WS_NAMESPACE:?set WS_NAMESPACE to the workspace namespace}"
CTL=kubectl           # context already pointed at the cluster
```

Throughout: a workspace `<id>` owns pod `<id>`, headless service `<id>-svc` and
PVC `<id>-data` (one name throughout — `packages/workspace-k8s/src/k8s-client.ts`).

---

## 1. Dialog styling (Defect 1)

1. **Action** — click the sidebar **`+`** (新建工作区).
   - **Expect** a centred dialog with a dark mask behind it, a white rounded card
     with a shadow, title 新建工作区, the description line, ONE text input
     (placeholder 例如：my-project) focused, and a footer with two buttons on the
     right: 取消 (bordered, light) and 创建 (filled dark, primary).
   - **FAIL if** the buttons look like the browser's own (grey gradient/blue
     focus ring), the card is unstyled, the page behind is not dimmed, or the
     form is laid out flush against the page instead of centred.
2. **Action** — inspect the injected stylesheet in devtools:
   `document.querySelectorAll('style[data-dsh-workspace-ui]').length`.
   - **Expect** exactly `1`, and its text contains `.dsh-ws-btn` and
     `.dsh-ws-btn.primary`.
   - **FAIL if** the count is 0 (nothing injected), >1 (guard broken), or the
     text has the mask/card rules but no button rules — that was Defect 1 exactly.
3. **Action** — click the mask outside the card, then re-open.
   - **Expect** the dialog closes without creating anything, and re-opens with an
     EMPTY input and no error text.
4. **Action** — in one dialog, type a name, press `Enter`; in another, click 创建.
   - **Expect** both submit; the dialog closes on success.
5. **Action** — submit a name that cannot be a workspace (e.g. `!!!!`).
   - **Expect** an INLINE red error inside the dialog with the API's own message,
     and the dialog stays open (never a silent close, never a console-only error).

## 2. Create (Defects 1 + 3b)

1. **Action** — open the dialog, type `qa-<hhmm>` (e.g. `qa-1042`), click 创建.
   - **Expect** within ~10 s a new row named `qa-<hhmm>` in the sidebar
     workspace group **and** a row for it in the status panel list.
   - `kubectl -n "$NS" get pvc qa-<hhmm>-data` → `Bound`.
2. **Action** — open a session in `qa-<hhmm>` and ask for any file operation
   (e.g. "create hello.txt with 'hi'"), then open the 工作区 detail view in the
   conversation view ring.
   - **Expect** the file operation succeeds; the detail view shows the workspace
     with a live phase, and the k8s card shows pod `qa-<hhmm>`, PVC
     `qa-<hhmm>-data`, the configured image and limits.
   - `kubectl -n "$NS" get pod qa-<hhmm>` → `Running`.
3. **Action** (the phantom check, Defect 3b) — in a shell whose cwd is
   `/workspaces` (the `bash-local` row's cwd) or through any file operation,
   touch an ordinary directory that is NOT a workspace, then run a file
   operation "inside" it, e.g. write `/workspaces/qa-not-a-workspace/probe.txt`.
   - **Expect** the operation FAILS with a message naming
     `qa-not-a-workspace` as "not a registered workspace of this platform", and
     **no** workspace appears in the sidebar.
   - `kubectl -n "$NS" get pvc qa-not-a-workspace-data` → `NotFound`.
   - **FAIL if** a PVC/pod is created or a sidebar row appears ~60 s later (that
     is the pre-fix chain: path → `ensure` → PVC → reconcile adoption).

## 3. Delete (Defect 2)

1. **Action** — pick a disposable workspace `qa-del`, open its session, create a
   file in it, then delete it from the **status panel** (删除) AND, in a second
   round, from the **official sidebar row's** delete.
   - **Expect** in both rounds: the row disappears from the sidebar and the
     panel within ~2 s; `kubectl -n "$NS" get pvc qa-del-data` → `NotFound`;
     `... get pod qa-del` → `NotFound`; `... get svc qa-del-svc` → `NotFound`.
2. **Action** — wait two reconcile intervals (default 60 s each) and reload the
   page.
   - **Expect** the workspace does NOT come back (no re-created row, no
     re-created PVC).
3. **Action** (the ghost case, Defect 2) — for a disposable workspace `qa-ghost`
   that is currently listed: `kubectl -n "$NS" delete pvc qa-ghost-data` while its
   pod is already gone (`kubectl -n "$NS" delete pod qa-ghost` first).
   - **Expect** within ≤2 reconcile passes (≤2 min) the row disappears from the
     sidebar and stays gone after a reload, and the pod log carries one line
     `workspace reconcile: removed the record of 'qa-ghost' …`.
   - **FAIL if** the row survives more than two passes, or the log shows the
     prune skipped (`could not list the cluster's …`).
4. **Action** — the safety counterpart: create `qa-keep` (leaving it with no
   session, so its pod may not exist yet), wait two passes.
   - **Expect** the row is still there (a record with no PVC and no pod that was
     never seen with a volume must never be pruned).
5. **Action** — the live-pod counterpart: `kubectl -n "$NS" delete pvc
   qa-keep-data` while `qa-keep`'s pod is running.
   - **Expect** the row STAYS (reported as an orphan, 孤立), the log line
     mentions the pod, and 清理 (cleanup) removes the pod; the record is pruned
     only after the pod is gone.

## 4. Panel vs reality — slept and woken (Defect 3a)

1. **Action** — take `qa-phase`, open a session in it so its pod runs, then in the
   status panel click 休眠 (sleep).
   - **Expect** the panel phase becomes 休眠 within ~2 s;
     `kubectl -n "$NS" get pod qa-phase` → `NotFound`;
     `kubectl -n "$NS" get pvc qa-phase-data` → still `Bound` (sleep keeps data).
2. **Action** — now WAKE it the way the operator did: open a session in
   `qa-phase` (or read/write a file in it) — do **not** press 唤醒.
   - **Expect** `kubectl -n "$NS" get pod qa-phase` → `Running` within ~30 s, the
     file operation succeeds, and the panel shows **运行中** (running), not 休眠,
     on its next poll (≤5 s after the pod is ready).
   - **FAIL if** the panel still reads 休眠 while the pod serves requests — that
     is the reported defect verbatim.
3. **Action** — press 唤醒 in the panel for a sleeping workspace.
   - **Expect** phase 启动中/唤醒中 (provision/waking) while the pod comes up,
     then 运行中 — never a flash of 休眠 over a workspace being woken.
4. **Action** — cross-check the panel against the cluster for every listed row:
   `kubectl -n "$NS" get pod,pvc -l app=dsh-workspace`.
   - **Expect** per workspace: pod+PVC ⇒ 运行中; PVC only ⇒ 休眠; pod only ⇒ 孤立;
     none ⇒ 已删除 for a just-deleted one, else 休眠.
   - **FAIL if** any row with a Running pod reads 休眠.
5. **Action** — after step 2, leave `qa-phase` idle (no session, no command) for
   the configured idle timeout (`WS_IDLE_TIMEOUT_MS`, default 5 min).
   - **Expect** the pod disappears and the panel returns to 休眠 — i.e. the
     on-demand wake really did re-arm the idle timer (it did not before the fix,
     so the pod would have stayed up forever).

## 5. Settings / credentials survive a pod restart (Defect 4)

1. **Action** — open the Models settings page and enter the model API key
   (`DEEPSEEK_API_KEY`) if it is not already set. Confirm it reports configured.
2. **Action** — verify it is in PostgreSQL, not in a file:
   ```sql
   SELECT key, value_json FROM dsh_storage_records
   WHERE unit = 'platform_credentials' AND table_name = 'credentials'
   ORDER BY key;
   ```
   - **Expect** one row per stored credential, e.g.
     `ref:DEEPSEEK_API_KEY` →
     `{"userId":"platform","scope":"ref","id":"DEEPSEEK_API_KEY","kind":"api-key","payload":{"value":"…"}}`.
   - If the result is empty, first confirm the unit name:
     `SELECT DISTINCT unit, table_name FROM dsh_storage_records;`.
   - **FAIL if** the only copy lives in `.credentials.yaml`: `kubectl -n "$NS"
     exec deploy/<control-plane> -- ls -l "$DSH_HOME/.credentials.yaml"` must NOT
     exist (or must be irrelevant), because the profile disables the
     file-backed row (`--dump-config` shows `- id: credentials / disabled:
     true`).
3. **Action** — replace the pod: `kubectl -n "$NS" rollout restart
   deploy/<control-plane>` (or delete the pod and let it be recreated).
4. **Action** — after the new pod is Ready, reload the UI and send ONE model
   request WITHOUT re-entering anything (e.g. open a session and ask "say hi").
   - **Expect** the request succeeds and the Models page still shows the key as
     configured, with source `postgres`.
   - **FAIL if** the request reports `MISSING_CREDENTIAL` / "no API key for
     provider route" or the Models page shows the key unset — that is the
     reported defect.
5. **Action** — confirm the row survived, from the cluster:
   `kubectl -n "$NS" exec <postgres-pod> -- psql "$DSH_PG_CONNECTION_STRING" -c
   "SELECT key FROM dsh_storage_records WHERE unit='platform_credentials';"`.
   - **Expect** `ref:DEEPSEEK_API_KEY` in the new pod's lifetime too.
6. **Action** — negative control: change an unrelated SETTINGS value in the
   settings UI (e.g. a model name), restart the pod, reopen settings.
   - **Expect** (documented limitation, not a regression): settings edits are
     stored in the profile patch document inside the ephemeral `DSH_HOME`, so
     this one does NOT survive. 0.2 offers no settings-provider seam — the
     credential half is the supported one and is what the operator was
     re-entering. Report it, do not re-enter the key.
7. **Action** — headless consistency: run a headless command against the same
   `DSH_HOME`/database that needs the model key.
   - **Expect** it resolves the same stored credential (both profiles disable the
     file-backed row), so web and headless cannot diverge.

window.__ModuleLoader__.load({ id: "@visecy/dsh-workspace-k8s", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/workspace-k8s/src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// packages/workspace-k8s/src/client/panel-model.ts
var WORKSPACE_PANEL_ID = "workspace-status";
var WORKSPACE_PANEL_LABEL = "\u5DE5\u4F5C\u533A\u72B6\u6001";
var WORKSPACE_POLL_MS = 2e3;
var PHASE_TEXT = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  waking: "\u5524\u9192\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
var DANGER_CONFIRM = "\u786E\u8BA4\u5220\u9664";
function phaseText(phase) {
  return PHASE_TEXT[phase] ?? String(phase);
}
function actionsFor(phase) {
  const actions = [];
  if (phase === "sleep" || phase === "unknown") actions.push({ id: "ensure", label: actionLabel("ensure") });
  if (phase === "running") actions.push({ id: "sleep", label: actionLabel("sleep") });
  if (phase === "orphan") actions.push({ id: "cleanup", label: actionLabel("cleanup") });
  if (phase === "deleted") return actions;
  actions.push({ id: "delete", label: actionLabel("delete"), danger: true });
  return actions;
}
function actionLabel(action) {
  switch (action) {
    case "ensure":
      return "\u5524\u9192";
    case "sleep":
      return "\u4F11\u7720";
    case "cleanup":
      return "\u6E05\u7406";
    case "delete":
      return "\u5220\u9664";
  }
}
function confirmLabel(action) {
  return action === "delete" ? DANGER_CONFIRM : actionLabel(action);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}
function fmtAgo(ms) {
  const s = Math.floor(Math.max(0, ms) / 1e3);
  if (s < 60) return "\u521A\u521A";
  if (s < 3600) return `${Math.floor(s / 60)} \u5206\u949F\u524D`;
  if (s < 86400) return `${Math.floor(s / 3600)} \u5C0F\u65F6\u524D`;
  return `${Math.floor(s / 86400)} \u5929\u524D`;
}
function statusDetail(row, now) {
  const name = row.title !== void 0 && row.title !== "" ? row.title : row.workspaceId;
  const { phase } = row;
  if (phase === "waking" || phase === "provision") return { name, text: "\u23F3 \u62C9\u8D77\u4E2D\u2026", tone: "warn" };
  if (phase === "running") {
    if (row.idleDeadlineAt !== void 0) {
      return { name, text: `\u23F3 ${fmtDur(row.idleDeadlineAt - now)} \u540E\u4F11\u7720`, tone: "warn" };
    }
    if (row.graceDeadlineAt !== void 0) {
      return { name, text: `\u23F3 ${fmtDur(row.graceDeadlineAt - now)} \u540E\u4F11\u7720\uFF08\u5BBD\u9650\uFF09`, tone: "warn" };
    }
    return { name, text: "\u8FD0\u884C\u4E2D \xB7 \u4F1A\u8BDD\u6D3B\u8DC3", tone: "ok" };
  }
  if (phase === "sleep") return { name, text: "\u4F11\u7720\u4E2D \xB7 PVC \u5DF2\u4FDD\u7559", tone: "muted" };
  if (phase === "orphan") return { name, text: "\u6B8B\u7559\u8D44\u6E90 \xB7 \u6709 Pod \u65E0 PVC", tone: "bad" };
  return { name, text: phaseText(phase), tone: "muted" };
}
function timelineHead(row, now) {
  const newest = row.timeline.reduce(
    (best, event) => best === void 0 || event.at > best.at ? event : best,
    void 0
  );
  if (newest === void 0) return void 0;
  return { text: newest.text, ago: fmtAgo(now - newest.at) };
}
function statusSummary(rows) {
  const sleeping = rows.filter((row) => row.phase === "sleep").length;
  const starting = rows.filter((row) => row.phase === "provision" || row.phase === "waking").length;
  const parts = [];
  if (starting > 0) parts.push(`${starting} \u4E2A\u62C9\u8D77\u4E2D`);
  if (sleeping > 0) parts.push(`${sleeping} \u4E2A\u4F11\u7720\u4E2D`);
  if (parts.length > 0) return `\u5DE5\u4F5C\u533A\u72B6\u6001\uFF1A${parts.join(" \xB7 ")}`;
  return rows.length === 0 ? "\u5DE5\u4F5C\u533A\u72B6\u6001\uFF1A\u6682\u65E0\u5DE5\u4F5C\u533A" : "\u5DE5\u4F5C\u533A\u72B6\u6001\uFF1A\u8FD0\u884C\u4E2D";
}
function metricsText(row) {
  const metrics = row.metrics;
  if (metrics === null) return "\u6307\u6807\u4E0D\u53EF\u7528";
  const cpu = `${Math.round(metrics.cpu.value * 1e3) / 1e3} \u6838`;
  const mem = `${metrics.mem.value} MB`;
  return metrics.available ? `${cpu} \xB7 ${mem}` : `${cpu} \xB7 ${mem}\uFF08\u6700\u8FD1\u91C7\u6837\uFF09`;
}

// packages/workspace-k8s/src/client/register.ts
function registerWorkspacePanel(slots, components) {
  slots.inject("main", () => slots.register({
    name: "main",
    key: WORKSPACE_PANEL_ID,
    label: () => WORKSPACE_PANEL_LABEL
  }, components.Panel));
  slots.inject("sidebar.panellist", () => slots.register({
    name: "sidebar.panellist",
    id: WORKSPACE_PANEL_ID,
    order: 20,
    label: () => WORKSPACE_PANEL_LABEL
  }, components.Icon));
}

// packages/workspace-k8s/src/client/panel.tsx
var import_react = require("react");

// packages/workspace-k8s/src/client/api.ts
async function call(method, body = {}) {
  const res = await fetch(`/workspaces/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload2 = await res.json();
  if (!payload2.ok) throw new Error(payload2.error?.message ?? "request failed");
  return payload2.data;
}
var workspaceApi = {
  list: () => call("list"),
  create: (name) => call("create", { name }),
  ensure: (workspaceId) => call("ensure", { workspaceId }),
  sleep: (workspaceId) => call("sleep", { workspaceId }),
  status: (workspaceId) => call("status", { workspaceId }),
  delete: (workspaceId) => call("delete", { workspaceId }),
  cleanup: (workspaceId) => call("cleanup", { workspaceId })
};

// packages/workspace-k8s/src/client/store.ts
var EMPTY = { at: 0, rows: [], error: "", pendingId: "", loading: false };
var payload = EMPTY;
var listeners = /* @__PURE__ */ new Set();
function getSnapshot() {
  return payload;
}
function subscribeStatus(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify() {
  for (const fn of listeners) fn();
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
async function poll() {
  payload = { ...payload, loading: true };
  notify();
  try {
    const list = await workspaceApi.list();
    payload = { at: Date.now(), rows: list, error: "", pendingId: payload.pendingId, loading: false };
  } catch (error) {
    payload = { ...payload, at: Date.now(), error: messageOf(error), loading: false };
  }
  notify();
}
function startPolling(intervalMs) {
  let inFlight = false;
  let stopped = false;
  const tick = () => {
    if (inFlight || stopped) return;
    inFlight = true;
    void poll().finally(() => {
      inFlight = false;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
function runStatusAction(workspaceId, action) {
  payload = { ...payload, pendingId: workspaceId, error: "" };
  notify();
  const dispatched = (async () => {
    switch (action) {
      case "ensure":
        await workspaceApi.ensure(workspaceId);
        break;
      case "sleep":
        await workspaceApi.sleep(workspaceId);
        break;
      case "delete":
        await workspaceApi.delete(workspaceId);
        break;
      case "cleanup":
        await workspaceApi.cleanup(workspaceId);
        break;
    }
  })();
  return dispatched.then(async () => {
    payload = { ...payload, pendingId: "" };
    notify();
    await poll();
  }, async (error) => {
    payload = { ...payload, pendingId: "", error: messageOf(error) };
    notify();
    await poll().catch(() => void 0);
    throw error;
  });
}

// packages/workspace-k8s/src/client/styles.ts
var WORKSPACE_UI_CSS = `
/* \u2500\u2500 \u5DE5\u4F5C\u533A\u72B6\u6001\u9762\u677F\uFF08main \u9762\u677F + sidebar.panellist\uFF09\u2500\u2500 */
.dsh-wsp { flex: 1 1 auto; box-sizing: border-box; width: 100%; min-width: 0; min-height: 0; overflow-y: auto; padding: 24px 32px 96px; }
.dsh-wsp-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.dsh-wsp-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsp-count { font-size: 13px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-refresh { margin-left: auto; cursor: pointer; padding: 5px 14px; font-size: 13px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 8px; background: var(--dsw-alias-button-elevated-fill, #fff); color: var(--dsw-alias-label-primary, #111); }
.dsh-wsp-refresh:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }
/* Failures are loud on purpose: a silent client error is how this platform got
   burned. The API's own message is rendered verbatim. */
.dsh-wsp-error { display: flex; flex-direction: column; gap: 2px; margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent); }
.dsh-wsp-error .k { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-error .v { font-size: 14px; color: var(--dsw-alias-label-primary, #111); overflow-wrap: anywhere; }
.dsh-wsp-empty { padding: 28px 0; text-align: center; font-size: 14px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-list { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsp-row { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-2, #fff); display: flex; flex-direction: column; gap: 8px; }
.dsh-wsp-row.pending { opacity: .6; }
.dsh-wsp-rowhead { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-wsp-name { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wsp-phase { font-size: 13px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-phase.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsp-phase.bad { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-phase.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsp-actions { margin-left: auto; display: flex; gap: 8px; }
.dsh-wsp-line { font-size: 14px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-line.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsp-line.bad { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-line.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsp-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-timeline { display: flex; gap: 10px; font-size: 13px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-timeline .t { flex: none; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-icon { display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; }
.dsh-wsp-icon.active { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }

/* \u2500\u2500 \u5DE5\u4F5C\u533A\u76F8\u4F4D\u6307\u793A\u70B9\uFF08\u9762\u677F\u884C / \u4FA7\u680F\u56FE\u6807\u5171\u7528\uFF09\u2500\u2500 */
.dsh-wsb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsb-dot.running { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsb-dot.sleep { background: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsb-dot.provision, .dsh-wsb-dot.waking { background: var(--dsw-alias-state-warn-primary, #f59e0b); animation: dsh-wsb-blink 1.2s ease-in-out infinite; }
.dsh-wsb-dot.orphan { background: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsb-dot.deleted, .dsh-wsb-dot.unknown { background: var(--dsw-alias-label-tertiary, #888); }
@keyframes dsh-wsb-blink { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* \u2500\u2500 \u6309\u94AE \u2500\u2500 */
.dsh-wsd-btn { cursor: pointer; padding: 7px 16px; font-size: 14px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 10px; background: var(--dsw-alias-button-elevated-fill, #fff); color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }
.dsh-wsd-btn.primary { background: var(--dsw-alias-button-primary-fill, #111); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-wsd-btn.danger { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsd-btn:disabled { opacity: .5; cursor: default; }
`;
function injectPanelStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-dsh-workspace-ui]") !== null) return;
  const style = document.createElement("style");
  style.dataset.dshWorkspaceUi = "true";
  style.textContent = WORKSPACE_UI_CSS;
  document.head.appendChild(style);
}

// packages/workspace-k8s/src/client/panel.tsx
function useStatus() {
  return (0, import_react.useSyncExternalStore)(subscribeStatus, getSnapshot);
}
function usePolling() {
  (0, import_react.useEffect)(() => startPolling(WORKSPACE_POLL_MS), []);
}
function WorkspaceStatusPanel() {
  injectPanelStyles();
  usePolling();
  const status = useStatus();
  const rows = status.rows;
  const now = status.at;
  return (0, import_react.createElement)(
    "div",
    { className: "dsh-wsp" },
    (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-head" },
      (0, import_react.createElement)("h3", { className: "dsh-wsp-title" }, "\u5DE5\u4F5C\u533A\u72B6\u6001"),
      (0, import_react.createElement)(
        "span",
        { className: "dsh-wsp-count" },
        rows.length === 0 ? "" : `${rows.length} \u4E2A\u5DE5\u4F5C\u533A`
      ),
      (0, import_react.createElement)("button", {
        className: "dsh-wsp-refresh",
        type: "button",
        onClick: () => {
          void poll();
        }
      }, "\u5237\u65B0")
    ),
    status.error === "" ? null : (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-error", role: "alert" },
      (0, import_react.createElement)("span", { className: "k" }, "API \u9519\u8BEF"),
      (0, import_react.createElement)("span", { className: "v" }, status.error)
    ),
    rows.length === 0 ? (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-empty" },
      status.loading ? "\u52A0\u8F7D\u4E2D\u2026" : "\u6682\u65E0\u5DE5\u4F5C\u533A"
    ) : (0, import_react.createElement)("div", { className: "dsh-wsp-list" }, rows.map((row) => (0, import_react.createElement)(RowView, {
      key: row.workspaceId,
      row,
      now,
      pending: status.pendingId === row.workspaceId
    })))
  );
}
function RowView({ row, now, pending }) {
  const [confirming, setConfirming] = (0, import_react.useState)(null);
  const detail = statusDetail(row, now);
  const head = timelineHead(row, now);
  const actions = actionsFor(row.phase);
  const dispatch = (action) => {
    if (action === "delete" && confirming !== "delete") {
      setConfirming("delete");
      return;
    }
    setConfirming(null);
    void runStatusAction(row.workspaceId, action).catch(() => void 0);
  };
  return (0, import_react.createElement)(
    "div",
    { className: `dsh-wsp-row${pending ? " pending" : ""}` },
    (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-rowhead" },
      (0, import_react.createElement)("span", { className: `dsh-wsb-dot ${row.phase}` }),
      (0, import_react.createElement)("span", { className: "dsh-wsp-name" }, detail.name),
      (0, import_react.createElement)("span", { className: `dsh-wsp-phase ${detail.tone}` }, phaseText(row.phase)),
      (0, import_react.createElement)(
        "span",
        { className: "dsh-wsp-actions" },
        actions.map((action) => (0, import_react.createElement)("button", {
          key: action.id,
          type: "button",
          className: `dsh-wsd-btn${action.danger === true ? " danger" : ""}`,
          disabled: pending,
          onClick: () => dispatch(action.id)
        }, confirming === action.id ? confirmLabel(action.id) : action.label)),
        confirming === null ? null : (0, import_react.createElement)("button", {
          type: "button",
          className: "dsh-wsd-btn",
          disabled: pending,
          onClick: () => setConfirming(null)
        }, "\u53D6\u6D88")
      )
    ),
    (0, import_react.createElement)("div", { className: `dsh-wsp-line ${detail.tone}` }, detail.text),
    (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-meta" },
      (0, import_react.createElement)("span", { className: "cpu" }, metricsText(row)),
      (0, import_react.createElement)("span", { className: "pod" }, row.hasPod ? "Pod \u8FD0\u884C" : "Pod \u505C\u6B62"),
      (0, import_react.createElement)("span", { className: "pvc" }, row.hasPvc ? "PVC \u4FDD\u7559" : "PVC \u65E0"),
      (0, import_react.createElement)("span", { className: "sessions" }, `\u4F1A\u8BDD ${row.activeSessions}`),
      (0, import_react.createElement)("span", { className: "cycles" }, `\u5524\u9192 ${row.wakeCount} \xB7 \u4F11\u7720 ${row.sleepCount}`)
    ),
    head === void 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "dsh-wsp-timeline" },
      (0, import_react.createElement)("span", { className: "t" }, head.ago),
      (0, import_react.createElement)("span", { className: "e" }, head.text)
    )
  );
}
function WorkspacePanelIcon({ size = 16, active = false }) {
  const status = useStatus();
  const worst = status.rows.find((row) => row.phase === "orphan" || row.phase === "waking" || row.phase === "provision");
  const phase = worst?.phase ?? status.rows[0]?.phase ?? "unknown";
  const dot = { width: size / 2, height: size / 2 };
  return (0, import_react.createElement)("span", {
    className: `dsh-wsp-icon${active ? " active" : ""}`,
    style: { width: size, height: size },
    // The aggregate the removed pill used to show lives here: a tooltip on the
    // row that opens the same status, where it cannot cover anything.
    title: statusSummary(status.rows)
  }, (0, import_react.createElement)("span", { className: `dsh-wsb-dot ${phase}`, style: dot }));
}

// packages/workspace-k8s/src/client/index.tsx
var inject = ["slots", "locale", "layout"];
function apply(ctx) {
  void ctx.on;
  void ctx.get;
  injectPanelStyles();
  registerWorkspacePanel(ctx.slots, {
    Panel: WorkspaceStatusPanel,
    Icon: WorkspacePanelIcon
  });
}
return module.exports; } });

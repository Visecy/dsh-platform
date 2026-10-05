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
var DIRECTORY_FLOW_SLOTS = [
  "conversation.hero.workspace.directoryFlow",
  "sidebar.workspaces.directoryFlow"
];
function registerNewWorkspaceDialog(slots, component, injected) {
  for (const name of DIRECTORY_FLOW_SLOTS) {
    slots.inject(name, () => slots.register({ name, priority: -100, inject: injected }, component));
  }
}
var WORKSPACE_VIEW_ID = "workspace";
var WORKSPACE_VIEW_LABEL = "\u5DE5\u4F5C\u533A";
function registerWorkspaceDetailView(slots, component) {
  slots.inject("conversation.view", () => slots.register({
    name: "conversation.view",
    id: WORKSPACE_VIEW_ID,
    order: 30,
    label: () => WORKSPACE_VIEW_LABEL
  }, component));
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
.dsh-wsb-phase { color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsb-phase.provision, .dsh-wsb-phase.waking { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsb-phase.orphan { color: var(--dsw-alias-state-error-primary, #ef4444); }

/* \u2500\u2500 \u5DE5\u4F5C\u533A\u8BE6\u60C5\u9875\uFF08\u53CC\u5217\uFF0C\u53C2\u8003 dsh-context\uFF09\u2500\u2500 */
.dsh-wsd { flex: 1 1 auto; box-sizing: border-box; width: 100%; min-width: 0; min-height: 0; overflow-y: auto; display: flex; }
.dsh-wsd-inner { width: 100%; max-width: 1080px; margin: 0 auto; padding: 28px 40px 96px; display: flex; flex-direction: column; gap: 16px; align-items: stretch; }
.dsh-wsd-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dsh-wsd-name { font-size: 24px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.dsh-wsd-head .dsh-wsb-dot { width: 12px; height: 12px; }
.dsh-wsd-head .dsh-wsb-phase { font-size: 16px; }
.dsh-wsd-actions { display: flex; gap: 10px; }
.dsh-wsd-cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.dsh-wsd-col { flex: 1; min-width: 340px; display: flex; flex-direction: column; gap: 16px; }
.dsh-wsd-card { background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); border-radius: 12px; padding: 18px 20px; }
.dsh-wsd-card h4 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); display: flex; align-items: baseline; gap: 8px; }
.dsh-wsd-status { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsd-phase-line { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-phase-line .dsh-wsb-dot { width: 12px; height: 12px; }
.dsh-wsd-countdown { font-size: 24px; font-weight: 600; color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsd-countdown.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsd-statgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px 16px; }
.dsh-wsd-stat .k { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-stat .v { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-metrics { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsd-metric .mk { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-metric .mv { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-metric svg { display: block; width: 100%; height: 30px; color: var(--dsw-alias-state-business-primary, #4176e6); margin-top: 2px; }
.dsh-wsd-metric.frozen svg { opacity: .45; }
.dsh-wsd-metric-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-sm { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dsh-wsd-sm .node { padding: 5px 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); color: var(--dsw-alias-label-secondary, #666); background: transparent; }
.dsh-wsd-sm .node.current { border-color: var(--dsw-alias-brand-primary, #111); color: var(--dsw-alias-brand-primary, #111); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #111) 10%, transparent); font-weight: 600; }
.dsh-wsd-sm .node.waking { border-color: var(--dsw-alias-state-warn-primary, #f59e0b); color: var(--dsw-alias-state-warn-primary, #f59e0b); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent); font-weight: 600; }
.dsh-wsd-sm .arrow { color: var(--dsw-alias-label-tertiary, #888); font-size: 14px; }
.dsh-wsd-tl { display: flex; flex-direction: column; gap: 0; max-height: 380px; overflow-y: auto; scrollbar-width: thin; }
.dsh-wsd-tl .ev { display: flex; align-items: baseline; gap: 12px; padding: 6px 2px; font-size: 14px; color: var(--dsw-alias-label-primary, #111); border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.dsh-wsd-tl .ev:last-child { border-bottom: none; }
.dsh-wsd-tl .t { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); min-width: 66px; }
.dsh-wsd-k8s { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
.dsh-wsd-k8s .k { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-k8s .v { font-size: 14px; color: var(--dsw-alias-label-primary, #111); overflow-wrap: anywhere; }
.dsh-wsd-empty { font-size: 14px; color: var(--dsw-alias-label-tertiary, #888); padding: 24px 0; text-align: center; }

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

// packages/workspace-k8s/src/client/NewWorkspaceDialog.tsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var FIELD_LABEL = "\u5DE5\u4F5C\u533A\u540D\u79F0";
function composingKeydown(e) {
  return e.nativeEvent?.isComposing === true || e.isComposing === true || e.keyCode === 229;
}
function NewWorkspaceDialog(props) {
  const { open, busy, onCancel, onError, createByName } = props;
  const [name, setName] = (0, import_react2.useState)("");
  const [error, setError] = (0, import_react2.useState)("");
  const [creating, setCreating] = (0, import_react2.useState)(false);
  const composingRef = (0, import_react2.useRef)(false);
  (0, import_react2.useEffect)(() => {
    if (open) {
      setName("");
      setError("");
      setCreating(false);
      composingRef.current = false;
    }
  }, [open]);
  if (!open) return null;
  const trimmed = name.trim();
  const blocked = busy || creating || trimmed === "";
  const submit = async () => {
    if (blocked) return;
    setCreating(true);
    setError("");
    try {
      await createByName(trimmed);
      onCancel();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      onError?.(message);
    } finally {
      setCreating(false);
    }
  };
  const close = () => {
    if (busy || creating) return;
    onCancel();
  };
  return (0, import_react2.createElement)(
    import_dsh_client_ui_primitives.Modal,
    {
      open,
      onClose: close,
      closeLabel: "\u5173\u95ED",
      title: "\u65B0\u5EFA\u5DE5\u4F5C\u533A",
      description: "\u8F93\u5165\u5DE5\u4F5C\u533A\u540D\u79F0\u3002\u521B\u5EFA\u540E\u4F1A\u51FA\u73B0\u5728\u4FA7\u8FB9\u680F\u5DE5\u4F5C\u533A\u7EC4\u4E2D\u3002",
      footer: [
        (0, import_react2.createElement)(import_dsh_client_ui_primitives.Button, {
          key: "cancel",
          variant: "outline",
          disabled: busy || creating,
          onClick: close
        }, "\u53D6\u6D88"),
        (0, import_react2.createElement)(import_dsh_client_ui_primitives.Button, {
          key: "create",
          variant: "primary",
          disabled: blocked,
          onClick: () => void submit()
        }, "\u521B\u5EFA")
      ]
    },
    (0, import_react2.createElement)(import_dsh_client_ui_primitives.Input, {
      key: "name",
      id: "dsh-ws-name",
      "aria-label": FIELD_LABEL,
      placeholder: "\u4F8B\u5982\uFF1Amy-project",
      // The Modal's documented initial-focus hook. React's `autoFocus` is
      // deliberately NOT used: it would fight the dialog's own focus restore.
      "data-modal-autofocus": true,
      value: name,
      disabled: busy,
      onChange: (e) => {
        setName(e.target.value);
        setError("");
      },
      // The official forms select the field's content when it takes focus.
      onFocus: (e) => {
        e.target.select();
      },
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        composingRef.current = false;
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" && !composingRef.current && !composingKeydown(e)) {
          e.preventDefault?.();
          void submit();
        }
      }
    }),
    // The API's own message, verbatim, in the platform's danger tone. A failed
    // create keeps the flow open so the operator can correct the name.
    error === "" ? null : (0, import_react2.createElement)(
      "div",
      { key: "error", role: "alert" },
      (0, import_react2.createElement)(import_dsh_client_ui_primitives.Tag, { tone: "danger" }, error)
    )
  );
}

// packages/workspace-k8s/src/client/WorkspaceDetailView.tsx
var import_react3 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var fmtDur2 = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1e3));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
var fmtAgo2 = (ms) => {
  const s = Math.floor(ms / 1e3);
  if (s < 60) return "\u521A\u521A";
  if (s < 3600) return `${Math.floor(s / 60)} \u5206\u949F\u524D`;
  if (s < 86400) return `${Math.floor(s / 3600)} \u5C0F\u65F6\u524D`;
  return `${Math.floor(s / 86400)} \u5929\u524D`;
};
var spark = (history, w, h) => {
  if (history.length === 0) return "";
  const max = Math.max(...history);
  const min = Math.min(...history);
  const range = max - min || 1;
  return history.map((v, i) => {
    const x = history.length === 1 ? 0 : i / (history.length - 1) * w;
    const y = h - (v - min) / range * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
};
function WorkspaceDetailView(props) {
  const { sessionId, useWorkspaces } = props;
  (0, import_react3.useEffect)(() => startPolling(WORKSPACE_POLL_MS), []);
  const status = (0, import_react3.useSyncExternalStore)(subscribeStatus, getSnapshot);
  const workspaces = useWorkspaces((s) => s.items) ?? [];
  const [confirmDelete, setConfirmDelete] = (0, import_react3.useState)(false);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const ws = workspaces.find((w) => (w.sessionIds ?? []).includes(sessionId));
  if (ws === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-inner", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-empty", children: "\u8BE5\u4F1A\u8BDD\u672A\u5173\u8054\u5DE5\u4F5C\u533A" }) }) });
  }
  const row = status.rows.find((r) => r.nativeWorkspaceId === ws.workspaceId || r.workspaceId === ws.workspaceId);
  const phase = row?.phase ?? "unknown";
  const label = phaseText(phase);
  let countdown = null;
  let countdownOk = false;
  if (row !== void 0) {
    if (phase === "waking" || phase === "provision") countdown = "\u23F3 \u62C9\u8D77\u4E2D\u2026";
    else if (phase === "running" && row.idleDeadlineAt !== void 0) countdown = `\u23F3 ${fmtDur2(row.idleDeadlineAt - status.at)} \u540E\u4F11\u7720`;
    else if (phase === "running" && row.graceDeadlineAt !== void 0) countdown = `\u23F3 ${fmtDur2(row.graceDeadlineAt - status.at)} \u540E\u4F11\u7720\uFF08\u5BBD\u9650\uFF09`;
    else if (phase === "running") {
      countdown = "\u8FD0\u884C\u4E2D \xB7 \u4F1A\u8BDD\u6D3B\u8DC3";
      countdownOk = true;
    } else if (phase === "sleep") countdown = "\u4F11\u7720\u4E2D \xB7 PVC \u5DF2\u4FDD\u7559";
    else if (phase === "orphan") countdown = "\u6B8B\u7559\u8D44\u6E90 \xB7 \u6709 Pod \u65E0 PVC";
  }
  const stats = [
    ["\u4F1A\u8BDD", row?.activeSessions ?? 0],
    ["turn", row?.openTurns ?? 0],
    ["\u547D\u4EE4", row?.activeCommands ?? 0],
    ["\u6267\u884C Pod", row === void 0 ? "\u2014" : row.hasPod ? "\u8FD0\u884C" : "\u505C\u6B62"],
    ["PVC", row === void 0 ? "\u2014" : row.hasPvc ? "\u4FDD\u7559" : "\u65E0"],
    ["\u8FD0\u884C\u65F6\u957F", row?.lastWakeAt !== void 0 ? fmtDur2(status.at - row.lastWakeAt) : "\u2014"],
    ["\u4E0A\u6B21\u4F11\u7720", row?.lastSleepAt !== void 0 ? fmtAgo2(status.at - row.lastSleepAt) : "\u2014"],
    ["\u5524\u9192 \xB7 \u4F11\u7720", `${row?.wakeCount ?? 0} \xB7 ${row?.sleepCount ?? 0}`],
    ["\u521B\u5EFA\u65F6\u95F4", row?.createdAt !== void 0 ? fmtAgo2(status.at - row.createdAt) : "\u2014"]
  ];
  const smStates = [
    { key: "provision", label: "\u521B\u5EFA\u4E2D" },
    { key: "running", label: "\u8FD0\u884C\u4E2D" },
    { key: "sleep", label: "\u4F11\u7720\u4E2D" },
    { key: "deleted", label: "\u5DF2\u5220\u9664" }
  ];
  const doAction = async (action) => {
    setBusy(true);
    try {
      await runStatusAction(row?.workspaceId ?? ws.workspaceId, action);
      setConfirmDelete(false);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  const metrics = row?.metrics ?? null;
  const metricsFrozen = phase === "sleep" || phase === "deleted";
  const k8s = row?.k8s ?? null;
  const timeline = (row?.timeline ?? []).slice().reverse();
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-inner", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-wsd-name", children: ws.title || ws.workspaceId }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-wsb-dot ${phase}` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-wsb-phase ${phase}`, children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-actions", children: [
        phase === "sleep" || phase === "unknown" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-wsd-btn primary", disabled: busy, onClick: () => void doAction("ensure"), children: "\u5524\u9192" }) : null,
        phase === "running" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-wsd-btn", disabled: busy, onClick: () => void doAction("sleep"), children: "\u4F11\u7720" }) : null,
        confirmDelete ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-wsd-btn danger", disabled: busy, onClick: () => void doAction("delete"), children: "\u786E\u8BA4\u5220\u9664" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-wsd-btn", disabled: busy, onClick: () => setConfirmDelete(false), children: "\u53D6\u6D88" })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-wsd-btn danger", onClick: () => setConfirmDelete(true), children: "\u5220\u9664" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-cols", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-col", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-card", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-status", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-phase-line", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dsh-wsb-dot ${phase}` }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label })
          ] }),
          countdown !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `dsh-wsd-countdown${countdownOk ? " ok" : ""}`, children: countdown }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-statgrid", children: stats.map(([k, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-stat", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "k", children: k }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "v", children: String(v) })
          ] }, k)) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: "\u751F\u547D\u5468\u671F" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-sm", children: smStates.map((s, i) => {
            const isWakingEdge = phase === "waking" && s.key === "sleep";
            return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react3.Fragment, { children: [
              i === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "arrow", children: isWakingEdge ? null : s.key === "sleep" ? "\u21C4" : "\u2192" }),
              isWakingEdge ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "node waking", children: "\u5524\u9192\u4E2D\u2026" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `node${phase === s.key ? " current" : ""}`, children: s.label })
            ] }, s.key);
          }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: "\u65F6\u95F4\u7EBF" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-tl", children: timeline.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-empty", children: "\u6682\u65E0\u4E8B\u4EF6" }) : timeline.map((e, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "ev", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "t", children: fmtAgo2(status.at - e.at) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: e.text })
          ] }, i)) })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-col", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: "\u8D44\u6E90\u6307\u6807" }),
          metrics === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-metric-note", children: "\u6307\u6807\u4E0D\u53EF\u7528\uFF08\u9700 metrics-server\uFF09" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-metrics", children: [
            ["cpu", "mem"].map((key) => {
              const m = metrics[key];
              const name = key === "cpu" ? "CPU" : "\u5185\u5B58";
              const value = key === "cpu" ? `${Math.round(m.value * 1e3) / 1e3} \u6838` : `${m.value} MB`;
              return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dsh-wsd-metric${metricsFrozen ? " frozen" : ""}`, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mk", children: name }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "mv", children: m.pct === null ? value : `${value} \xB7 ${m.pct}%` }),
                m.history.length > 1 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 120 26", preserveAspectRatio: "none", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "polyline",
                  {
                    points: spark(m.history, 120, 24),
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: "1.5",
                    strokeLinejoin: "round"
                  }
                ) }) : null
              ] }, key);
            }),
            !metrics.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-metric-note", children: "metrics-server \u65E0\u54CD\u5E94\uFF0C\u663E\u793A\u6700\u8FD1\u91C7\u6837" }) : null
          ] })
        ] }),
        k8s !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-wsd-card", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { children: "k8s \u8D44\u6E90" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-wsd-k8s", children: [
            ["\u6267\u884C Pod", k8s.podName],
            ["\u6570\u636E\u5377 PVC", k8s.pvcName],
            ["\u547D\u540D\u7A7A\u95F4", k8s.namespace],
            ["\u955C\u50CF", k8s.image],
            ["RuntimeClass", k8s.runtimeClass ?? "\u2014"],
            ["\u8D44\u6E90\u9650\u989D", `${k8s.cpuLimit ?? "\u2014"} / ${k8s.memLimit ?? "\u2014"}`],
            ["\u5B58\u50A8\u7C7B", k8s.storageClass ?? "\u2014"],
            ["\u5BB9\u91CF", `${k8s.capacityGB} GB`]
          ].map(([k, v]) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "k", children: k }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "v", children: String(v) })
          ] }, k)) })
        ] }) : null
      ] })
    ] })
  ] }) });
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
  const createByName = async (name) => {
    await workspaceApi.create(name);
    await poll();
  };
  registerNewWorkspaceDialog(ctx.slots, NewWorkspaceDialog, () => ({ createByName }));
  registerWorkspaceDetailView(ctx.slots, WorkspaceDetailView);
}
return module.exports; } });

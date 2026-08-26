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

// packages/workspace-k8s/src/client/NewWorkspaceDialog.tsx
var import_react = require("react");
function NewWorkspaceDialog(props) {
  const { open, busy, onCancel, onError, createByName } = props;
  const [name, setName] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    if (open) {
      setName("");
      setError("");
    }
  }, [open]);
  if (!open) return null;
  const submit = async () => {
    const value = name.trim();
    if (value === "") return;
    setError("");
    try {
      await createByName(value);
      onCancel();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      onError?.(message);
    }
  };
  return (0, import_react.createElement)(
    "div",
    { className: "dsh-ws-modal-overlay", onClick: (e) => {
      if (e.target === e.currentTarget) onCancel();
    } },
    (0, import_react.createElement)(
      "div",
      { className: "dsh-ws-modal" },
      (0, import_react.createElement)("h3", null, "\u65B0\u5EFA\u5DE5\u4F5C\u533A"),
      (0, import_react.createElement)("p", { className: "dsh-ws-modal-desc" }, "\u8F93\u5165\u5DE5\u4F5C\u533A\u540D\u79F0\u3002\u521B\u5EFA\u540E\u4F1A\u51FA\u73B0\u5728\u4FA7\u8FB9\u680F\u5DE5\u4F5C\u533A\u7EC4\u4E2D\u3002"),
      (0, import_react.createElement)("label", { htmlFor: "dsh-ws-name" }, "\u5DE5\u4F5C\u533A\u540D\u79F0"),
      (0, import_react.createElement)("input", {
        id: "dsh-ws-name",
        placeholder: "\u4F8B\u5982\uFF1Amy-project",
        autoFocus: true,
        value: name,
        disabled: busy,
        onChange: (e) => setName(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void submit();
        }
      }),
      error === "" ? null : (0, import_react.createElement)("div", { className: "dsh-ws-modal-error" }, error),
      (0, import_react.createElement)(
        "div",
        { className: "dsh-ws-modal-footer" },
        (0, import_react.createElement)("button", { className: "dsh-ws-btn", onClick: onCancel, disabled: busy }, "\u53D6\u6D88"),
        (0, import_react.createElement)("button", { className: "dsh-ws-btn primary", onClick: () => void submit(), disabled: busy }, "\u521B\u5EFA")
      )
    )
  );
}

// packages/workspace-k8s/src/client/WorkspaceStatusDock.tsx
var import_react2 = require("react");

// packages/workspace-k8s/src/client/api.ts
async function call(method, body = {}) {
  const res = await fetch(`/workspaces/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  if (!payload.ok) throw new Error(payload.error?.message ?? "request failed");
  return payload.data;
}
var workspaceApi = {
  list: () => call("list"),
  create: (name) => call("create", { name }),
  ensure: (workspaceId) => call("ensure", { workspaceId }),
  status: (workspaceId) => call("status", { workspaceId }),
  delete: (workspaceId) => call("delete", { workspaceId }),
  cleanup: (workspaceId) => call("cleanup", { workspaceId })
};

// packages/workspace-k8s/src/client/WorkspaceStatusDock.tsx
var phaseMap = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
function WorkspaceStatusDock(props) {
  const { sessionId } = props;
  const workspace = props.useWorkspaces((s) => s.items.find((x) => x.sessionIds.includes(sessionId)));
  const [row, setRow] = (0, import_react2.useState)();
  const [error, setError] = (0, import_react2.useState)("");
  (0, import_react2.useEffect)(() => {
    const nativeId = workspace?.workspaceId;
    if (nativeId === void 0) {
      setRow(void 0);
      return;
    }
    let cancelled = false;
    void workspaceApi.list().then((rows) => {
      if (cancelled) return;
      const found = rows.find((r) => r.nativeWorkspaceId === nativeId && r.path.startsWith("/workspaces/"));
      setRow(found ?? void 0);
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workspace?.workspaceId]);
  if (row === void 0) return null;
  return (0, import_react2.createElement)(
    "div",
    { className: "dsh-workspace-ui dsh-ws-status" },
    (0, import_react2.createElement)("span", null, `\u5DE5\u4F5C\u533A\uFF1A${row.workspaceId}`),
    (0, import_react2.createElement)("span", { className: `dsh-ws-badge ${row.phase}` }, phaseMap[row.phase] ?? row.phase),
    row.phase === "sleep" ? (0, import_react2.createElement)("button", {
      className: "dsh-ws-btn primary",
      onClick: async () => {
        try {
          setRow(await workspaceApi.ensure(row.workspaceId));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }, "\u5524\u9192") : null,
    error === "" ? null : (0, import_react2.createElement)("span", { className: "dsh-ws-error" }, error)
  );
}

// packages/workspace-k8s/src/client/WorkspaceFooterAction.tsx
var import_react3 = require("react");
var phaseMap2 = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
function WorkspaceFooterAction(props) {
  const [open, setOpen] = (0, import_react3.useState)(false);
  const [rows, setRows] = (0, import_react3.useState)([]);
  const [name, setName] = (0, import_react3.useState)("");
  const [error, setError] = (0, import_react3.useState)("");
  const refresh = async () => {
    try {
      setRows((await workspaceApi.list()).filter((ws) => ws.path.startsWith("/workspaces/") && ws.path !== "/workspaces"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  (0, import_react3.useEffect)(() => {
    if (open) {
      void refresh();
      setName("");
      setError("");
    }
  }, [open]);
  const create = async () => {
    const value = name.trim();
    if (!value) return;
    setError("");
    try {
      if (props.createByName) await props.createByName(value);
      else await workspaceApi.create(value);
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (0, import_react3.createElement)(
    "div",
    { className: "dsh-workspace-ui" },
    (0, import_react3.createElement)("button", {
      className: "dsh-ws-btn",
      onClick: () => setOpen(true),
      style: { width: "100%", textAlign: "left" }
    }, "\u{1F5A5} \u5DE5\u4F5C\u533A\u72B6\u6001"),
    open ? (0, import_react3.createElement)(
      "div",
      { className: "dsh-ws-modal-overlay", onClick: (e) => {
        if (e.target === e.currentTarget) setOpen(false);
      } },
      (0, import_react3.createElement)(
        "div",
        { className: "dsh-ws-modal dsh-ws-modal-wide" },
        (0, import_react3.createElement)("h3", null, "\u5DE5\u4F5C\u533A\u72B6\u6001"),
        (0, import_react3.createElement)(
          "div",
          { className: "dsh-ws-footer-list" },
          rows.map((ws) => (0, import_react3.createElement)(
            "div",
            { key: ws.workspaceId, className: "dsh-ws-item" },
            (0, import_react3.createElement)(
              "div",
              { className: "dsh-ws-head" },
              (0, import_react3.createElement)("span", { className: "dsh-ws-name" }, ws.workspaceId),
              (0, import_react3.createElement)("span", { className: `dsh-ws-badge ${ws.phase}` }, phaseMap2[ws.phase] ?? ws.phase)
            ),
            (0, import_react3.createElement)(
              "div",
              { className: "dsh-ws-actions" },
              ws.phase === "sleep" ? (0, import_react3.createElement)("button", { className: "dsh-ws-btn primary", onClick: async () => {
                try {
                  await workspaceApi.ensure(ws.workspaceId);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              } }, "\u5524\u9192") : null,
              ws.phase === "orphan" ? (0, import_react3.createElement)("button", { className: "dsh-ws-btn", onClick: async () => {
                try {
                  await workspaceApi.cleanup(ws.workspaceId);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              } }, "\u6E05\u7406") : null,
              (0, import_react3.createElement)("button", { className: "dsh-ws-btn danger", onClick: async () => {
                if (!confirm(`\u5220\u9664\u5DE5\u4F5C\u533A ${ws.workspaceId}\uFF1F\u4F1A\u5220\u9664 Pod \u548C PVC\u3002`)) return;
                try {
                  await workspaceApi.delete(ws.workspaceId);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              } }, "\u5220\u9664")
            )
          )),
          rows.length === 0 ? (0, import_react3.createElement)("div", { className: "dsh-ws-meta" }, "\u6682\u65E0\u5DE5\u4F5C\u533A") : null
        ),
        (0, import_react3.createElement)(
          "div",
          { className: "dsh-ws-create" },
          (0, import_react3.createElement)("input", { value: name, placeholder: "\u65B0\u5DE5\u4F5C\u533A\u540D\u79F0", onChange: (e) => setName(e.target.value), onKeyDown: (e) => {
            if (e.key === "Enter") void create();
          } }),
          (0, import_react3.createElement)("button", { className: "dsh-ws-btn primary", onClick: () => void create() }, "\u521B\u5EFA")
        ),
        error === "" ? null : (0, import_react3.createElement)("div", { className: "dsh-ws-error" }, error),
        (0, import_react3.createElement)(
          "div",
          { className: "dsh-ws-modal-footer" },
          (0, import_react3.createElement)("button", { className: "dsh-ws-btn", onClick: () => setOpen(false) }, "\u5173\u95ED")
        )
      )
    ) : null
  );
}

// packages/workspace-k8s/src/client/styles.ts
var WORKSPACE_UI_CSS = `

.dsh-workspace-ui { color: #1f2328; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
.dsh-workspace-ui * { box-sizing: border-box; }
.dsh-workspace-ui h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.dsh-ws-create { display: flex; gap: 6px; margin-bottom: 12px; }
.dsh-ws-create input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; background: #fff; }
.dsh-ws-create button, .dsh-ws-btn { padding: 5px 9px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.dsh-ws-create button:hover, .dsh-ws-btn:hover { background: #f6f8fa; }
.dsh-ws-btn.primary { border-color: #0969da; color: #0969da; }
.dsh-ws-btn.primary:hover { background: #ddf4ff; }
.dsh-ws-btn.danger { border-color: #cf222e; color: #cf222e; }
.dsh-ws-btn.danger:hover { background: #ffebe9; }
.dsh-ws-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-ws-item { padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
.dsh-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-ws-name { font-size: 13px; font-weight: 600; word-break: break-all; }
.dsh-ws-badge { flex: none; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
.dsh-ws-badge.running { background: #dafbe1; color: #116329; }
.dsh-ws-badge.sleep { background: #eaeef2; color: #57606a; }
.dsh-ws-badge.provision { background: #fff8c5; color: #7d4e00; }
.dsh-ws-badge.orphan { background: #ffebe9; color: #cf222e; }
.dsh-ws-badge.deleted { background: #eaeef2; color: #57606a; }
.dsh-ws-badge.unknown { background: #eaeef2; color: #57606a; }
.dsh-ws-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dsh-ws-meta { font-size: 11px; color: #57606a; margin-top: 4px; }
.dsh-ws-error { color: #cf222e; font-size: 12px; margin: 6px 0; }
.dsh-ws-hero { max-width: 520px; margin: 0 auto; padding: 20px; }
.dsh-ws-hero h2 { font-size: 18px; margin: 0 0 12px; }
.dsh-ws-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 12px; font-size: 12px; color: #57606a; border-top: 1px solid #e5e7eb; }
.dsh-ws-status .dsh-ws-badge { font-size: 11px; }

.dsh-ws-modal-overlay, .dsh-ws-modal-overlay *, .dsh-ws-modal, .dsh-ws-modal * { box-sizing: border-box; }
.dsh-ws-modal-overlay { position: fixed; inset: 0; background: rgba(31,35,40,.35); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dsh-ws-modal { width: 380px; background: #fff; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.2); padding: 20px; }
.dsh-ws-modal-wide { width: 460px; }
.dsh-ws-modal h3 { margin: 0 0 8px; font-size: 16px; }
.dsh-ws-modal-desc { margin: 0 0 14px; color: #57606a; font-size: 13px; }
.dsh-ws-modal label { display: block; margin-bottom: 5px; font-size: 13px; font-weight: 600; }
.dsh-ws-modal input { width: 100%; padding: 7px 9px; border: 1px solid #d0d7de; border-radius: 8px; font-size: 14px; }
.dsh-ws-modal-error { color: #cf222e; font-size: 12px; margin: 8px 0 0; }
.dsh-ws-modal-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.dsh-ws-footer-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
`;

// packages/workspace-k8s/src/client/index.tsx
var inject = ["slots"];
function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-dsh-workspace-ui]") !== null) return;
  const style = document.createElement("style");
  style.dataset.dshWorkspaceUi = "true";
  style.textContent = WORKSPACE_UI_CSS;
  document.head.appendChild(style);
}
function apply(ctx) {
  ensureStyles();
  const createByName = async (name) => {
    await workspaceApi.create(name);
    const workspaces = ctx.workspaces;
    await workspaces.refresh?.();
  };
  const directoryInject = () => ({ createByName });
  ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.register({
    name: "conversation.hero.workspace.directoryFlow",
    priority: -100,
    inject: directoryInject
  }, NewWorkspaceDialog));
  ctx.slots.inject("sidebar.workspaces.directoryFlow", () => ctx.slots.register({
    name: "sidebar.workspaces.directoryFlow",
    priority: -100,
    inject: directoryInject
  }, NewWorkspaceDialog));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    id: "workspace-status-dock",
    order: 30,
    inject: () => ({})
  }, WorkspaceStatusDock));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "workspace-status-action",
    inject: () => ({ createByName })
  }, WorkspaceFooterAction));
}
return module.exports; } });

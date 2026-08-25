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

// packages/workspace-k8s/src/client/WorkspaceBrowser.tsx
var import_react = require("react");

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

// packages/workspace-k8s/src/client/WorkspaceBrowser.tsx
var phaseMap = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
var visible = (rows) => rows.filter((ws) => ws.path.startsWith("/workspaces/") && ws.path !== "/workspaces");
function WorkspaceBrowser(props) {
  const { useWorkspaces } = props;
  const native = useWorkspaces((s) => s.items);
  const [rows, setRows] = (0, import_react.useState)([]);
  const [name, setName] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [loading, setLoading] = (0, import_react.useState)(true);
  const refresh = async () => {
    try {
      setRows(visible(await workspaceApi.list()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    void refresh();
  }, []);
  const create = async () => {
    if (!name.trim()) return;
    setError("");
    try {
      await workspaceApi.create(name.trim());
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (0, import_react.createElement)(
    "div",
    { className: "dsh-workspace-ui" },
    (0, import_react.createElement)("h3", null, "\u5DE5\u4F5C\u533A"),
    (0, import_react.createElement)(
      "div",
      { className: "dsh-ws-create" },
      (0, import_react.createElement)("input", {
        value: name,
        placeholder: "\u8F93\u5165\u65B0\u5DE5\u4F5C\u533A\u540D\u79F0",
        onChange: (e) => setName(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void create();
        }
      }),
      (0, import_react.createElement)("button", { onClick: () => void create() }, "\u521B\u5EFA")
    ),
    error === "" ? null : (0, import_react.createElement)("div", { className: "dsh-ws-error" }, error),
    loading ? (0, import_react.createElement)("div", null, "\u52A0\u8F7D\u4E2D\u2026") : (0, import_react.createElement)(
      "ul",
      { className: "dsh-ws-list" },
      rows.map((ws) => (0, import_react.createElement)(
        "li",
        { key: ws.workspaceId, className: "dsh-ws-item" },
        (0, import_react.createElement)(
          "div",
          { className: "dsh-ws-head" },
          (0, import_react.createElement)("span", { className: "dsh-ws-name" }, ws.workspaceId),
          (0, import_react.createElement)("span", { className: `dsh-ws-badge ${ws.phase}` }, phaseMap[ws.phase] ?? ws.phase)
        ),
        (0, import_react.createElement)(
          "div",
          { className: "dsh-ws-actions" },
          (0, import_react.createElement)("button", {
            className: "dsh-ws-btn primary",
            onClick: async () => {
              try {
                await workspaceApi.ensure(ws.workspaceId);
                props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }
          }, ws.phase === "sleep" ? "\u5524\u9192\u5E76\u6253\u5F00" : "\u6253\u5F00"),
          ws.phase === "orphan" ? (0, import_react.createElement)("button", {
            className: "dsh-ws-btn",
            onClick: async () => {
              try {
                await workspaceApi.cleanup(ws.workspaceId);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }
          }, "\u6E05\u7406") : null,
          (0, import_react.createElement)("button", {
            className: "dsh-ws-btn danger",
            onClick: async () => {
              if (!confirm(`\u5220\u9664\u5DE5\u4F5C\u533A ${ws.workspaceId}\uFF1F\u4F1A\u5220\u9664 Pod \u548C PVC\u3002`)) return;
              try {
                await workspaceApi.delete(ws.workspaceId);
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }
          }, "\u5220\u9664")
        ),
        ws.hasPod || ws.hasPvc ? (0, import_react.createElement)(
          "div",
          { className: "dsh-ws-meta" },
          ws.hasPod && ws.hasPvc ? "\u8FD0\u884C\u4E2D" : ws.hasPvc ? "\u6570\u636E\u5DF2\u4FDD\u7559" : "\u6B8B\u7559\u8D44\u6E90"
        ) : null
      ))
    )
  );
}

// packages/workspace-k8s/src/client/WorkspacePicker.tsx
var import_react2 = require("react");
var phaseMap2 = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
var visible2 = (rows) => rows.filter((ws) => ws.path.startsWith("/workspaces/") && ws.path !== "/workspaces");
function WorkspacePicker(props) {
  const { useWorkspaces } = props;
  const native = useWorkspaces((s) => s.items);
  const [rows, setRows] = (0, import_react2.useState)([]);
  const [name, setName] = (0, import_react2.useState)("");
  const [error, setError] = (0, import_react2.useState)("");
  const refresh = async () => {
    try {
      setRows(visible2(await workspaceApi.list()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const create = async () => {
    if (!name.trim()) return;
    setError("");
    try {
      await workspaceApi.create(name.trim());
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  (0, import_react2.useEffect)(() => {
    void refresh();
  }, []);
  return (0, import_react2.createElement)(
    "div",
    { className: "dsh-workspace-ui dsh-ws-hero" },
    (0, import_react2.createElement)("h2", null, "\u9009\u62E9\u6216\u65B0\u5EFA\u5DE5\u4F5C\u533A"),
    (0, import_react2.createElement)(
      "div",
      { className: "dsh-ws-create" },
      (0, import_react2.createElement)("input", {
        value: name,
        placeholder: "\u8F93\u5165\u65B0\u5DE5\u4F5C\u533A\u540D\u79F0",
        onChange: (e) => setName(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void create();
        }
      }),
      (0, import_react2.createElement)("button", { onClick: () => void create() }, "\u521B\u5EFA")
    ),
    error === "" ? null : (0, import_react2.createElement)("div", { className: "dsh-ws-error" }, error),
    (0, import_react2.createElement)(
      "ul",
      { className: "dsh-ws-list" },
      rows.map((ws) => (0, import_react2.createElement)(
        "li",
        { key: ws.workspaceId, className: "dsh-ws-item" },
        (0, import_react2.createElement)(
          "div",
          { className: "dsh-ws-head" },
          (0, import_react2.createElement)("span", { className: "dsh-ws-name" }, ws.workspaceId),
          (0, import_react2.createElement)("span", { className: `dsh-ws-badge ${ws.phase}` }, phaseMap2[ws.phase] ?? ws.phase)
        ),
        (0, import_react2.createElement)(
          "div",
          { className: "dsh-ws-actions" },
          (0, import_react2.createElement)("button", {
            className: "dsh-ws-btn primary",
            onClick: () => {
              props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId);
            }
          }, ws.phase === "sleep" ? "\u5524\u9192\u5E76\u6253\u5F00" : "\u6253\u5F00")
        )
      ))
    )
  );
}

// packages/workspace-k8s/src/client/WorkspaceStatusDock.tsx
var import_react3 = require("react");
var phaseMap3 = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
function WorkspaceStatusDock(props) {
  const { sessionId } = props;
  const [row, setRow] = (0, import_react3.useState)();
  const [error, setError] = (0, import_react3.useState)("");
  (0, import_react3.useEffect)(() => {
    if (!sessionId) return;
    const w = props.useWorkspaces((s) => s.items.find((x) => x.sessionIds.includes(sessionId)));
    const nativeId = w?.workspaceId;
    if (nativeId === void 0) return;
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
  }, [sessionId, props.useWorkspaces]);
  if (row === void 0) return null;
  return (0, import_react3.createElement)(
    "div",
    { className: "dsh-workspace-ui dsh-ws-status" },
    (0, import_react3.createElement)("span", null, `\u5DE5\u4F5C\u533A\uFF1A${row.workspaceId}`),
    (0, import_react3.createElement)("span", { className: `dsh-ws-badge ${row.phase}` }, phaseMap3[row.phase] ?? row.phase),
    row.phase === "sleep" ? (0, import_react3.createElement)("button", {
      className: "dsh-ws-btn primary",
      onClick: async () => {
        try {
          setRow(await workspaceApi.ensure(row.workspaceId));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }, "\u5524\u9192") : null,
    error === "" ? null : (0, import_react3.createElement)("span", { className: "dsh-ws-error" }, error)
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
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    priority: -100,
    inject: () => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId)
    })
  }, WorkspaceBrowser));
  ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
    name: "conversation.hero.workspace",
    priority: -100,
    inject: () => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId)
    })
  }, WorkspacePicker));
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock",
    inject: () => ({})
  }, WorkspaceStatusDock));
}
return module.exports; } });

window.__ModuleLoader__.load({ id: "@visecy/dsh-workspace-ui", factory: (require) => {
"use strict";
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

// packages/workspace-ui/src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// packages/workspace-ui/src/client/WorkspaceBrowser.tsx
var import_react = require("react");

// packages/workspace-ui/src/client/api.ts
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

// packages/workspace-ui/src/client/WorkspaceBrowser.tsx
var phaseMap = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F02\u5E38/\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
function WorkspaceBrowser(props) {
  const { useWorkspaces } = props;
  const native = useWorkspaces((s) => s.items);
  const [rows, setRows] = (0, import_react.useState)([]);
  const [name, setName] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [loading, setLoading] = (0, import_react.useState)(true);
  const refresh = async () => {
    try {
      const list = await workspaceApi.list();
      setRows(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    void refresh();
  }, []);
  const create2 = async () => {
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
    { style: { padding: 12 } },
    (0, import_react.createElement)("h3", null, "\u5DE5\u4F5C\u533A"),
    (0, import_react.createElement)(
      "div",
      null,
      (0, import_react.createElement)("input", {
        value: name,
        placeholder: "\u8F93\u5165\u65B0\u5DE5\u4F5C\u533A\u540D\u79F0",
        onChange: (e) => setName(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") void create2();
        }
      }),
      (0, import_react.createElement)("button", { onClick: () => void create2() }, "\u521B\u5EFA")
    ),
    error === "" ? null : (0, import_react.createElement)("div", { style: { color: "red" } }, error),
    loading ? (0, import_react.createElement)("div", null, "\u52A0\u8F7D\u4E2D\u2026") : (0, import_react.createElement)(
      "ul",
      null,
      rows.map((ws) => (0, import_react.createElement)(
        "li",
        { key: ws.workspaceId, style: { margin: "4px 0" } },
        (0, import_react.createElement)("span", null, `${ws.workspaceId} \xB7 ${phaseMap[ws.phase] ?? ws.phase}`),
        (0, import_react.createElement)("br"),
        (0, import_react.createElement)("button", {
          onClick: async () => {
            try {
              await workspaceApi.ensure(ws.workspaceId);
              props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }, ws.phase === "sleep" ? "\u5524\u9192\u5E76\u6253\u5F00" : "\u6253\u5F00"),
        (0, import_react.createElement)("button", {
          onClick: async () => {
            if (!confirm(`\u5220\u9664\u5DE5\u4F5C\u533A ${ws.workspaceId}\uFF1F\u4F1A\u5220\u9664 Pod \u548C PVC\u3002`)) return;
            try {
              await workspaceApi.delete(ws.workspaceId);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }, "\u5220\u9664"),
        ws.phase === "orphan" ? (0, import_react.createElement)("button", {
          onClick: async () => {
            try {
              await workspaceApi.cleanup(ws.workspaceId);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }, "\u6E05\u7406") : null
      ))
    ),
    (0, import_react.createElement)("div", { style: { color: "#666" } }, `\u539F\u751F\u5DE5\u4F5C\u533A ${native.length} \u4E2A`)
  );
}

// packages/workspace-ui/src/client/WorkspacePicker.tsx
var import_react2 = require("react");
var phaseMap2 = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F02\u5E38/\u5F85\u6E05\u7406",
  deleted: "\u5DF2\u5220\u9664",
  unknown: "\u672A\u77E5"
};
function WorkspacePicker(props) {
  const { useWorkspaces } = props;
  const native = useWorkspaces((s) => s.items);
  const [rows, setRows] = (0, import_react2.useState)([]);
  const [name, setName] = (0, import_react2.useState)("");
  const [error, setError] = (0, import_react2.useState)("");
  const refresh = async () => {
    try {
      setRows(await workspaceApi.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  (0, import_react2.useEffect)(() => {
    void refresh();
  }, []);
  return (0, import_react2.createElement)(
    "div",
    { style: { maxWidth: 520, margin: "0 auto", padding: 20 } },
    (0, import_react2.createElement)("h2", null, "\u9009\u62E9\u6216\u65B0\u5EFA\u5DE5\u4F5C\u533A"),
    (0, import_react2.createElement)(
      "div",
      null,
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
    error === "" ? null : (0, import_react2.createElement)("div", { style: { color: "red" } }, error),
    (0, import_react2.createElement)(
      "ul",
      null,
      rows.map((ws) => (0, import_react2.createElement)(
        "li",
        { key: ws.workspaceId },
        (0, import_react2.createElement)("button", {
          onClick: () => {
            props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId);
          }
        }, `${ws.workspaceId} \xB7 ${phaseMap2[ws.phase] ?? ws.phase}`)
      ))
    ),
    (0, import_react2.createElement)("div", { style: { color: "#666" } }, `\u539F\u751F\u5DE5\u4F5C\u533A ${native.length} \u4E2A`)
  );
}

// packages/workspace-ui/src/client/WorkspaceStatusDock.tsx
var import_react3 = require("react");
var phaseMap3 = {
  running: "\u8FD0\u884C\u4E2D",
  sleep: "\u4F11\u7720\u4E2D",
  provision: "\u521B\u5EFA\u4E2D",
  orphan: "\u5F02\u5E38/\u5F85\u6E05\u7406",
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
      const found = rows.find((r) => r.nativeWorkspaceId === nativeId);
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
    { style: { padding: "4px 8px", fontSize: 13, color: "#57606a", borderTop: "1px solid #d0d7de" } },
    (0, import_react3.createElement)("span", null, `\u5DE5\u4F5C\u533A\uFF1A${row.workspaceId} \xB7 ${phaseMap3[row.phase] ?? row.phase}`),
    row.phase === "sleep" ? (0, import_react3.createElement)("button", { onClick: async () => {
      try {
        setRow(await workspaceApi.ensure(row.workspaceId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } }, "\u5524\u9192") : null,
    row.hasPod ? null : (0, import_react3.createElement)("em", null, "\uFF08\u6267\u884C Pod \u672A\u8FD0\u884C\uFF09"),
    error === "" ? null : (0, import_react3.createElement)("span", { style: { color: "red" } }, error)
  );
}

// packages/workspace-ui/src/client/index.tsx
var inject = ["slots"];
function apply(ctx) {
  ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
    name: "sidebar.workspaces",
    inject: () => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId)
    })
  }, WorkspaceBrowser));
  ctx.slots.inject("conversation.hero.workspace", () => ctx.slots.register({
    name: "conversation.hero.workspace",
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

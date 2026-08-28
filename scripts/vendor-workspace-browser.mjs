#!/usr/bin/env node
/**
 * Vendor the official dsh-client-ui-workspace browser bundle into
 * @visecy/dsh-workspace-k8s with the platform status additions applied.
 *
 * The official WorkspaceBrowser has no row-level injection point, so the
 * platform vendors the bundle and applies 13 surgical patches (validated on
 * the live DSH):
 *   1. module id           2. WorkspaceBrowser signature (+useStatus/runStatusAction)
 *   3. status wiring       4. SessionTree signature
 *   5. ProjectRowItem sig  6. workspace menu platform items
 *   7. menu tail           8. menu onSelect platform dispatch
 *   9. projectText inline status  10. SessionTree call props
 *  11. ProjectRowItem call props  12. browserInjected hooks.status
 *  13. sidebar registration (children hole kept)  14. locale register guard
 *
 * The official ui-workspace row is DISABLED in the deployment, so this
 * vendored browser is the sole occupant of sidebar.workspaces (and the
 * WorkspacePicker registration stays intact).
 *
 * Output: src/client/vendored-workspace.ts exporting the patched source as a
 * JSON string literal (safe embedding; eval'd at runtime by the client half).
 *
 * Usage: node scripts/vendor-workspace-browser.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..', 'packages', 'workspace-k8s')
const require = createRequire(join(pkgRoot, 'package.json'))
const bundlePath = require.resolve('@deepseek-ai/dsh-client-ui-workspace/client')
let source = readFileSync(bundlePath, 'utf8')

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patch = (anchorLines, replLines, label) => {
  const re = new RegExp('^[ \\t]*' + anchorLines.map((l) => esc(l[0])).join('[ \\t]*\\n[ \\t]*'), 'm')
  const m = re.exec(source)
  if (m === null) throw new Error(`anchor not found: ${label} :: ${anchorLines[0][0]}`)
  const indent = m[0].match(/^[ \t]*/)[0]
  const replacement = replLines.map((l) => indent + '\t'.repeat(l[1]) + l[0]).join('\n')
  source = source.slice(0, m.index) + replacement + source.slice(m.index + m[0].length)
}
const L = (text, rel) => [text, rel]

patch([L('id: "@deepseek-ai/dsh-client-ui-workspace"', 0)], [L('id: "@visecy/dsh-workspace-k8s/vendored-browser"', 0)], 'id')
patch([L('function WorkspaceBrowser({ wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore, createWorkspace, searchSessions, searchResultLimit, useDirectoryFlow, useHostDescription, renderSlot, t }) {', 0)],
  [L('function WorkspaceBrowser({ wide, expandSidebar, useSessions, useWorkspaces, useStore, actions, startSession, open, renameSession, forkSession, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, archiveSession, insertSessionBefore, createWorkspace, searchSessions, searchResultLimit, useDirectoryFlow, useHostDescription, useStatus, runStatusAction, renderSlot, t }) {', 0)], 'signature')
patch([L('const directoryFlowAvailable = useDirectoryFlow((occupied) => occupied);', 0)], [
  L('const directoryFlowAvailable = useDirectoryFlow((occupied) => occupied);', 0),
  L('(0, react.useEffect)(() => {', 0),
  L('statusSource.setScope(workspaces.map((workspace) => workspace.workspaceId));', 1),
  L('}, [workspaces]);', 0),
  L('const statusSnapshot = useStatus((snapshot) => snapshot);', 0),
  L('const statusById = {};', 0),
  L('if (statusSnapshot !== void 0 && Array.isArray(statusSnapshot.rows)) {', 0),
  L('for (const statusRow of statusSnapshot.rows) statusById[statusRow.nativeWorkspaceId ?? statusRow.workspaceId] = statusRow;', 1),
  L('}', 0),
], 'status-wiring')
patch([L('function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t }) {', 0)],
  [L('function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, statusById, runStatusAction, t }) {', 0)], 'sessiontree-sig')
patch([L('function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {', 0)],
  [L('function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t, status, runStatusAction }) {', 0)], 'projectrow-sig')
patch([L('const workspaceMenuItems = [{', 0)], [
  L('const workspaceMenuItems = [].concat(', 0),
  L('status !== void 0 && (status.phase === "sleep" || status.phase === "unknown") ? [{ id: "ws-ensure", label: "唤醒工作区" }] : [],', 1),
  L('status !== void 0 && status.phase === "running" ? [{ id: "ws-sleep", label: "休眠工作区" }] : [],', 1),
  L('status !== void 0 && status.phase === "orphan" ? [{ id: "ws-cleanup", label: "清理残留" }] : [],', 1),
  L('[{', 1),
], 'menu-head')
patch([L('danger: true', 0), L('}];', 0)], [L('danger: true', 0), L('}]);', 0)], 'menu-tail')
patch([L('onSelect: (id) => {', 0), L('setMenuOpen(false);', 0), L('/* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */', 0)], [
  L('onSelect: (id) => {', 0),
  L('setMenuOpen(false);', 0),
  L('if (id === "ws-ensure" || id === "ws-sleep" || id === "ws-cleanup") {', 0),
  L('runStatusAction(status.workspaceId, id.slice(3));', 1),
  L('return;', 1),
  L('}', 0),
  L('/* v8 ignore next -- workspaceMenuItems carries exactly these two rows today. */', 0),
], 'onselect')
patch([L('(0, react_jsx_runtime.jsx)("span", {', 0), L('className: Rows_module_css_default.projectText,', 0), L('children: (0, react_jsx_runtime.jsx)("span", {', 0), L('className: Rows_module_css_default.title,', 0), L('children: label', 0), L('})', 0), L('}),', 0)], [
  L('(0, react_jsx_runtime.jsxs)("span", {', 0),
  L('className: Rows_module_css_default.projectText,', 1),
  L('children: [', 1),
  L('(0, react_jsx_runtime.jsxs)("span", {', 2),
  L('className: "dsh-wsb-titlerow",', 3),
  L('children: [', 3),
  L('(0, react_jsx_runtime.jsx)("span", { className: clsx(Rows_module_css_default.title, "dsh-wsb-title"), children: label }),', 4),
  L('status === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {', 4),
  L('className: "dsh-wsb-inline",', 5),
  L('children: [', 5),
  L('(0, react_jsx_runtime.jsx)("span", { className: `dsh-wsb-dot ${status.phase}` }),', 6),
  L('(0, react_jsx_runtime.jsx)("span", { className: `dsh-wsb-phase ${status.phase}`, children: status.label }),', 6),
  L(']', 5),
  L('})', 4),
  L(']', 3),
  L('})', 2),
  L(']', 1),
  L('}),', 0),
], 'projecttext')
patch([L('}) : (0, react_jsx_runtime.jsx)(SessionTree, {', 0), L('useSessions,', 0), L('onSessionRename,', 0), L('onSessionArchive,', 0), L('forkSession,', 0), L('workspaces,', 0)], [
  L('}) : (0, react_jsx_runtime.jsx)(SessionTree, {', 0),
  L('useSessions,', 1),
  L('onSessionRename,', 1),
  L('onSessionArchive,', 1),
  L('forkSession,', 1),
  L('workspaces,', 1),
  L('statusById,', 1),
  L('runStatusAction,', 1),
], 'sessiontree-call')
patch([L('(0, react_jsx_runtime.jsx)(ProjectRowItem, {', 0), L('group,', 0), L('home,', 0), L('t,', 0)], [
  L('(0, react_jsx_runtime.jsx)(ProjectRowItem, {', 0),
  L('group,', 1),
  L('home,', 1),
  L('t,', 1),
  L('status: group.workspaceId === void 0 ? void 0 : statusById[group.workspaceId],', 1),
  L('runStatusAction,', 1),
], 'call-site')
patch([L('createWorkspace: (input) => ctx.workspaces.create(input),', 0), L('hooks: {', 0), L('directoryFlow: browserFlowSource,', 0)], [
  L('createWorkspace: (input) => ctx.workspaces.create(input),', 0),
  L('runStatusAction,', 0),
  L('hooks: {', 0),
  L('directoryFlow: browserFlowSource,', 1),
  L('status: statusSource,', 1),
], 'inject-hooks')
// sidebar.workspaces: the official ui-workspace row is DISABLED in the
// deployment, so this vendored browser is the sole occupant and keeps the
// original registration (children hole included, default priority).
patch([L('ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({', 0), L('name: "sidebar.workspaces",', 0), L('children: { "sidebar.workspaces.directoryFlow": {', 0), L('kind: "single",', 0), L('scope: "root"', 0), L('} },', 0), L('store: createWorkspaceViewStore(),', 0)], [
  L('ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({', 0),
  L('name: "sidebar.workspaces",', 1),
  L('children: { "sidebar.workspaces.directoryFlow": {', 1),
  L('kind: "single",', 2),
  L('scope: "root"', 2),
  L('} },', 1),
  L('store: createWorkspaceViewStore(),', 1),
], 'reg-sidebar')
patch([L('ctx.effect(() => ctx.locale.register(NS, {', 0), L('zh,', 0), L('en', 0), L('}), "ui-workspace: dictionaries");', 0)], [
  L('ctx.effect(() => { try { ctx.locale.register(NS, {', 0),
  L('zh,', 0),
  L('en', 0),
  L('}); } catch (localeDuplicate) { /* namespace already registered elsewhere */ } }, "ui-workspace: dictionaries");', 0),
], 'locale-register')

const checks = [
  ['titlerow', source.includes('dsh-wsb-titlerow')],
  ['no statusline', !source.includes('dsh-wsb-statusline')],
  ['useStatus prop', source.includes('useStatus, runStatusAction, renderSlot')],
  ['menu items', source.includes('ws-ensure') && source.includes('ws-sleep') && source.includes('ws-cleanup')],
  ['picker kept', source.includes('}, WorkspacePicker));')],
  ['hooks.status', source.includes('status: statusSource')],
  ['locale try/catch', source.includes('catch (localeDuplicate)')],
  ['children kept', source.includes('children: { "sidebar.workspaces.directoryFlow": {')],
  ['sessiontree sig', source.includes('home, statusById, runStatusAction, t })')],
  ['sessiontree call', source.includes('statusById,') && source.includes('runStatusAction,')],
  ['no add button patch', !source.includes('onAddWorkspace();')],
]
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`vendored result check failed: ${name}`)
}

const out = join(pkgRoot, 'src', 'client', 'vendored-workspace.ts')
const ts = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/vendor-workspace-browser.mjs
 * Vendored official dsh-client-ui-workspace browser bundle with the platform
 * status patches applied (see the script header for the patch list).
 */
export const VENDORED_WORKSPACE_BROWSER: string = ${JSON.stringify(source)}
`
writeFileSync(out, ts)
console.log(`vendored browser -> ${out} (${source.length} chars)`)

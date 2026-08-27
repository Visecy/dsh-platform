/**
 * Native DSH workspace UI — platform status display.
 *
 * - sidebar.workspaces: the OFFICIAL WorkspaceBrowser bundle vendored with
 *   platform status patches (inline phase on workspace rows, wake/sleep/
 *   cleanup menu items, add-workspace button routed to the name modal).
 *   Registers at priority -1 so it shadows the shipped browser; the
 *   directory-flow holes stay owned by the shipped entry (renderSlot guarded).
 * - conversation.view "工作区": the workspace detail page (status, metrics,
 *   lifecycle, k8s details, timeline).
 * - shell.overlay: the name-based New Workspace modal.
 *
 * Status data comes from the platform HTTP API (/workspaces/api/list) polled
 * every 2s into one shared snapshot (see store.ts).
 */
import { useState, useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { workspaceApi } from './api.ts'
import { poll } from './store.ts'
import { NewWorkspaceDialog, type NewWorkspaceDialogInjected } from './NewWorkspaceDialog.tsx'
import { WorkspaceDetailView } from './WorkspaceDetailView.tsx'
import { VENDORED_WORKSPACE_BROWSER } from './vendored-workspace.ts'
import { WORKSPACE_UI_CSS } from './styles.ts'

export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection']

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-workspace-ui]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshWorkspaceUi = 'true'
  style.textContent = WORKSPACE_UI_CSS
  document.head.appendChild(style)
}

// ── New Workspace modal state (module scope: the vendored browser's add
//    button and the overlay component share it) ──
let addOpen = false
const addListeners = new Set<() => void>()

function addNotify(): void {
  for (const fn of addListeners) fn()
}

function addSubscribe(fn: () => void): () => void {
  addListeners.add(fn)
  return () => { addListeners.delete(fn) }
}

function closeAdd(): void {
  addOpen = false
  addNotify()
}

/** Invoked by the vendored browser's "add workspace" button. */
function onAddWorkspace(): void {
  addOpen = true
  addNotify()
}

function NewWorkspaceModal() {
  const open = useSyncExternalStore(addSubscribe, () => addOpen)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open) return null

  const create = async (): Promise<void> => {
    const value = name.trim()
    if (value === '') return
    setBusy(true)
    setError('')
    try {
      await workspaceApi.create(value)
      setName('')
      closeAdd()
      await poll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsh-ws-modal-overlay" onClick={closeAdd}>
      <div className="dsh-ws-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建工作区</h3>
        <p className="dsh-ws-modal-desc">输入工作区名称，创建后会在侧边栏出现并自动拉起执行 Pod。</p>
        <input
          value={name}
          autoFocus
          placeholder="例如：my-project"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
        />
        {error !== '' ? <div className="dsh-ws-modal-error">{error}</div> : null}
        <div className="dsh-ws-modal-footer">
          <button className="dsh-wsd-btn" onClick={closeAdd}>取消</button>
          <button className="dsh-wsd-btn primary" disabled={busy || name.trim() === ''} onClick={() => void create()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ensureStyles()

  // Catalog polling (2s). The snapshot is stable between polls, so the
  // vendored browser's useStatus and the detail view's useSyncExternalStore
  // both re-render exactly once per poll.
  void poll()
  const timer = setInterval(() => { void poll() }, 2000)
  ctx.on('dispose', () => clearInterval(timer))

  // ── Vendored official browser: eval + register through the module system ──
  const modId = `@visecy/dsh-workspace-k8s/vendored-browser-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  eval(VENDORED_WORKSPACE_BROWSER.replace(
    'id: "@visecy/dsh-workspace-k8s/vendored-browser"',
    `id: "${modId}"`,
  ))
  const modules = ctx.get('modules') as { import: (id: string) => Promise<{ apply: (c: unknown) => void }> } | undefined
  if (modules === undefined) throw new Error('client module system unavailable')
  void modules.import(modId).then((vendored) => {
    vendored.apply(ctx)
  }).catch((e) => {
    console.error('vendored workspace browser failed to mount', e)
  })

  // ── Workspace detail page: "工作区" tab in the conversation view ring ──
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'workspace',
    order: 30,
    label: () => '工作区',
  }, WorkspaceDetailView))

  // ── New Workspace modal (name-based) ──
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-workspace-new',
  }, NewWorkspaceModal))

  // ── Directory-flow hole occupancy: keeps the vendored browser's add
  //    button visible (it renders only while the hole is occupied). The hole
  //    itself is owned by the shipped browser entry and not rendered here. ──
  const createByName = async (name: string): Promise<void> => {
    await workspaceApi.create(name)
    await poll()
  }
  const directoryInject = (): NewWorkspaceDialogInjected => ({ createByName })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.register({
    name: 'conversation.hero.workspace.directoryFlow',
    priority: -100,
    inject: directoryInject,
  }, NewWorkspaceDialog))
  ctx.slots.inject('sidebar.workspaces.directoryFlow', () => ctx.slots.register({
    name: 'sidebar.workspaces.directoryFlow',
    priority: -100,
    inject: directoryInject,
  }, NewWorkspaceDialog))
}

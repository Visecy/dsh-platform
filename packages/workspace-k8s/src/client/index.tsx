/**
 * Native DSH workspace UI.
 *
 * Uses official DSH client slot declarations only (no better-sidebar):
 * - `sidebar.workspaces`      replaces the workspace browsing region
 * - `conversation.hero.workspace` replaces the new-session workspace picker
 * - `conversation.input.dock` shows the current workspace status in-session
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WorkspaceBrowser } from './WorkspaceBrowser.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { WorkspaceStatusDock } from './WorkspaceStatusDock.tsx'
import { WORKSPACE_UI_CSS } from './styles.ts'

export const inject = ['slots']

interface BrowserInject {
  startSession: (workspaceId?: string) => void
}

interface PickerInject {
  startSession: (workspaceId?: string) => void
}

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-workspace-ui]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshWorkspaceUi = 'true'
  style.textContent = WORKSPACE_UI_CSS
  document.head.appendChild(style)
}

export function apply(ctx: ClientContext): void {
  ensureStyles()

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -100,
    inject: (): BrowserInject => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId as any),
    }),
  }, WorkspaceBrowser))

  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
    name: 'conversation.hero.workspace',
    priority: -100,
    inject: (): PickerInject => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId as any),
    }),
  }, WorkspacePicker))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    inject: () => ({}),
  }, WorkspaceStatusDock))
}

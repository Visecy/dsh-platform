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

export const inject = ['slots']

interface BrowserInject {
  startSession: (workspaceId?: string) => void
}

interface PickerInject {
  startSession: (workspaceId?: string) => void
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    inject: (): BrowserInject => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId as any),
    }),
  }, WorkspaceBrowser))

  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
    name: 'conversation.hero.workspace',
    inject: (): PickerInject => ({
      startSession: (workspaceId) => ctx.workspaces.startSession(workspaceId as any),
    }),
  }, WorkspacePicker))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    inject: () => ({}),
  }, WorkspaceStatusDock))
}

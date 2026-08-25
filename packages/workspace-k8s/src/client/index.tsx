/**
 * Native DSH workspace UI - additive only.
 *
 * We do NOT replace official `sidebar.workspaces` or
 * `conversation.hero.workspace`; those keep the official session/workspace
 * tree and picker. We only:
 * - provide a name-based New Workspace flow into the official directory-flow
 *   holes (`conversation.hero.workspace.directoryFlow`,
 *   `sidebar.workspaces.directoryFlow`)
 * - add an in-session status bar (`conversation.input.dock`)
 * - add a workspace status/management footer action
 *   (`sidebar.footer.action`)
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NewWorkspaceDialog, type NewWorkspaceDialogInjected } from './NewWorkspaceDialog.tsx'
import { WorkspaceStatusDock } from './WorkspaceStatusDock.tsx'
import { WorkspaceFooterAction, type Props as FooterActionProps } from './WorkspaceFooterAction.tsx'
import { workspaceApi } from './api.ts'
import { WORKSPACE_UI_CSS } from './styles.ts'

export const inject = ['slots']

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

  const createByName = async (name: string): Promise<void> => {
    await workspaceApi.create(name)
    // Pull the official workspace list so the new workspace appears without
    // a full page reload.
    const workspaces = ctx.workspaces as unknown as { refresh?: () => Promise<void> }
    await workspaces.refresh?.()
  }

  const directoryInject = (): NewWorkspaceDialogInjected => ({ createByName })

  // Provide our name-based New Workspace modal to both official directory-flow
  // holes. The official ui-workspace keeps owning the menu/session tree.
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.register({
    name: 'conversation.hero.workspace.directoryFlow',
    inject: directoryInject,
  }, NewWorkspaceDialog))

  ctx.slots.inject('sidebar.workspaces.directoryFlow', () => ctx.slots.register({
    name: 'sidebar.workspaces.directoryFlow',
    inject: directoryInject,
  }, NewWorkspaceDialog))

  // In-session workspace status strip.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    inject: () => ({}),
  }, WorkspaceStatusDock))

  // Sidebar footer management/status action.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    inject: () => ({ createByName }),
  }, WorkspaceFooterAction))
}

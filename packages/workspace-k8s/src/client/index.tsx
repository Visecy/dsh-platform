/**
 * Native DSH workspace UI - minimal additive layer.
 *
 * Keeps the official `sidebar.workspaces` and `conversation.hero.workspace`
 * session/workspace tree and picker untouched. The only addition is a
 * name-based New Workspace flow into the official directory-flow holes
 * (`conversation.hero.workspace.directoryFlow`,
 * `sidebar.workspaces.directoryFlow`), which the official ui-workspace
 * picker drives through its "Add workspace" affordance.
 *
 * The workspace status dock and sidebar footer action were removed in favour
 * of the official UI while the workspace chrome is redesigned from scratch.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NewWorkspaceDialog, type NewWorkspaceDialogInjected } from './NewWorkspaceDialog.tsx'
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
  // holes. The official ui-workspace keeps owning the menu/session tree, and
  // the official directory-picker (native/browse) occupies the same holes at
  // priority 0. Registering at a lower priority shadows that occupant instead
  // of colliding with it (same-priority registrations throw a duplicate-slot
  // error and abort the whole plugin boot).
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

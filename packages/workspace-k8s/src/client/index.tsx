/**
 * @visecy/dsh-workspace-k8s — browser half: the platform's workspace surfaces
 * (k8s status panel, name-based creation dialog, session workspace page).
 *
 * Division of labour after the UI decoupling:
 * - OFFICIAL `ui-workspace` (a profile row, not this plugin) owns the sidebar
 *   workspace/session list, the conversation hero, the `sidebar.workspaces`
 *   contract and the workspace dialogs.
 * - THIS plugin adds a keyed `main` panel plus its `sidebar.panellist` entry,
 *   showing the k8s side of a workspace: pod phase, metrics, and the
 *   wake/sleep/cleanup lifecycle actions.
 * - THIS plugin also fills the two `directoryFlow` seats with the platform's
 *   name-based "新建工作区" dialog. The official flow is driven by a directory
 *   picker; here a workspace is created by NAME (`workspaceApi.create`), so the
 *   seats render that dialog instead of a browser (see register.ts).
 * - THIS plugin registers the session's "工作区" page in the conversation view
 *   ring: the session-scoped detail view of the workspace it runs in.
 *
 * Nothing here patches an official bundle, and nothing here has a user or a
 * permission concept: the panel reads `/workspaces/api/list` and dispatches
 * `/workspaces/api/{ensure,sleep,delete,cleanup}`.
 *
 * The 0.1.5 client stack has no `@deepseek-ai/dsh-client-runtime` package, so
 * the injected services are typed structurally. Every name in `inject` is
 * probed below with `ctx.get` on purpose: reading a service the running fiber
 * did not declare throws "cannot get property ... without inject", which once
 * aborted this whole apply and left every dependent client entry pending.
 */
import {
  registerNewWorkspaceDialog,
  registerWorkspaceDetailView,
  registerWorkspacePanel,
} from './register.ts'
import { WorkspacePanelIcon, WorkspaceStatusPanel } from './panel.tsx'
import { NewWorkspaceDialog } from './NewWorkspaceDialog.tsx'
import { WorkspaceDetailView } from './WorkspaceDetailView.tsx'
import { workspaceApi } from './api.ts'
import { poll } from './store.ts'
import { injectPanelStyles } from './styles.ts'

/**
 * Services this apply() touches. `slots` is required; the rest are sequenced
 * so the status panel cannot register ahead of the localisation and layout
 * surfaces the official frame provides.
 */
export const inject = ['slots', 'locale', 'layout']

/** Structural client root context consumed by apply() (no runtime package exists). */
interface ClientContext {
  on(event: string, listener: () => void): void
  get<T = unknown>(name: string): T | undefined
  slots: {
    inject(slot: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component?: unknown): unknown
  }
}

export function apply(ctx: ClientContext): void {
  void ctx.on
  void ctx.get
  injectPanelStyles()
  registerWorkspacePanel(ctx.slots, {
    Panel: WorkspaceStatusPanel,
    Icon: WorkspacePanelIcon,
  })

  // Workspace creation is name-based: the record is created by NAME and the
  // catalog is re-read so the new row is on screen when the dialog closes.
  const createByName = async (name: string): Promise<void> => {
    await workspaceApi.create(name)
    await poll()
  }
  registerNewWorkspaceDialog(ctx.slots, NewWorkspaceDialog, () => ({ createByName }))

  // The session-scoped "工作区" page in the conversation view ring.
  registerWorkspaceDetailView(ctx.slots, WorkspaceDetailView)
}

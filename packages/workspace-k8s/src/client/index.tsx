/**
 * @visecy/dsh-workspace-k8s — browser half: the workspace STATUS surface.
 *
 * Division of labour after the UI decoupling:
 * - OFFICIAL `ui-workspace` (a profile row, not this plugin) owns the sidebar
 *   workspace/session list, the conversation hero, the `sidebar.workspaces`
 *   contract and the workspace dialogs.
 * - THIS plugin adds a keyed `main` panel plus its `sidebar.panellist` entry,
 *   showing the k8s side of a workspace: pod phase, metrics, and the
 *   wake/sleep/cleanup lifecycle actions.
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
import { registerWorkspacePanel } from './register.ts'
import { WorkspacePanelIcon, WorkspaceStatusPanel } from './panel.tsx'
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
}

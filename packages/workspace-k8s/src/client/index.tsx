/**
 * Native DSH workspace UI — platform status display.
 *
 * - sidebar.workspaces: the OFFICIAL WorkspaceBrowser bundle vendored with
 *   platform status patches (inline phase on workspace rows, wake/sleep/
 *   cleanup menu items). The official `ui-workspace` row is DISABLED in the
 *   deployment (web.cordis.patch.yml), so this vendored browser is the sole
 *   occupant of the slot and keeps the official registration intact —
 *   including the `sidebar.workspaces.directoryFlow` child hole, the
 *   WorkspacePicker (conversation.hero.workspace) and the official add
 *   workspace flow (the + button opens the pick flow, whose directory
 *   browse UI is provided by the official ui-directory-picker-browse).
 * - conversation.view "工作区": the workspace detail page (status, metrics,
 *   lifecycle, k8s details, timeline).
 *
 * Status data comes from the platform HTTP API (/workspaces/api/list) polled
 * every 2s into one shared snapshot (see store.ts). The vendored bundle
 * references `statusSource` / `runStatusAction` as bare identifiers; they
 * resolve through the eval closure to this module's scope, so they must
 * stay imported here.
 *
 * The 0.1.5 client stack has no `@deepseek-ai/dsh-client-runtime` package:
 * client plugins type their ctx as the cordis Context (see the official
 * ui-workspace /client declaration: exports `apply(ctx)` + `inject`). The
 * fibers/events this apply() consumes (`ctx.slots`, `ctx.get`, `ctx.on`)
 * belong to that root context, so a minimal structural interface stands in
 * for the vanished ClientContext type. `layout` is declared in the inject
 * list because the vendored 0.1.5 browser's UiWorkspaceService navigates
 * through `ctx.layout.selectPanel/beginNavigation` (provided by ui-layout).
 */
import { poll, runStatusAction, statusSource } from './store.ts'
import { WorkspaceDetailView } from './WorkspaceDetailView.tsx'
import { VENDORED_WORKSPACE_BROWSER } from './vendored-workspace.ts'
import { WORKSPACE_UI_CSS } from './styles.ts'

// `remote` and `remote.directoryPicker` are required by the VENDORED browser,
// which this wrapper applies on its own context: it builds
// `new UiWorkspaceService(ctx, ctx.remote.directoryPicker, ...)` and reads
// `ctx.remote.$host` for host info. Reading a service that the running fiber did
// not declare throws "cannot get property ... without inject", which aborted the
// whole apply -- so `uiWorkspace` was never provided and every dependent client
// entry (sidebar, conversation, chat, ...) stayed pending. The previous published
// bundle happened not to use `ctx.remote`, so this omission stayed latent until
// the client half was rebuilt from source.
export const inject = [
  'slots', 'sessions', 'workspaces', 'locale', 'connection', 'layout',
  'remote', 'remote.directoryPicker',
]

/** Structural client root context consumed by apply() (see header note). */
interface ClientContext {
  on(event: string, listener: () => void): void
  get<T = unknown>(name: string): T | undefined
  slots: {
    inject(slot: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component?: unknown): unknown
  }
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

  // Catalog polling (2s). The snapshot is stable between polls, so the
  // vendored browser's useStatus and the detail view's useSyncExternalStore
  // both re-render exactly once per poll.
  void poll()
  const timer = setInterval(() => { void poll() }, 2000)
  ctx.on('dispose', () => clearInterval(timer))

  // ── Vendored official browser: eval + register through the module system ──
  // The eval'd factory closes over THIS module's scope, so the bare
  // `statusSource` / `runStatusAction` identifiers in the vendored source
  // resolve to the imports above (they must never be renamed or removed).
  const modId = `@visecy/dsh-workspace-k8s/vendored-browser-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  eval(VENDORED_WORKSPACE_BROWSER.replace(
    'id: "@visecy/dsh-workspace-k8s/vendored-browser"',
    `id: "${modId}"`,
  ))
  const modules = ctx.get('modules') as { import: (id: string) => Promise<{ apply: (c: unknown) => void }> } | undefined
  if (modules === undefined) throw new Error('client module system unavailable')
  void modules.import(modId).then((vendored) => {
    try {
      vendored.apply(ctx)
      // Diagnostics for the CDP/console verification pass: the vendored
      // browser finished apply without throwing.
      ;(window as unknown as { __dshWorkspaceVendored?: boolean }).__dshWorkspaceVendored = true
    } catch (e) {
      console.error('vendored workspace browser apply failed', e)
      ;(window as unknown as { __dshWorkspaceVendoredError?: string }).__dshWorkspaceVendoredError = e instanceof Error ? e.message : String(e)
    }
  }).catch((e) => {
    console.error('vendored workspace browser failed to mount', e)
    ;(window as unknown as { __dshWorkspaceVendoredError?: string }).__dshWorkspaceVendoredError = e instanceof Error ? e.message : String(e)
  })

  // ── Workspace detail page: "工作区" tab in the conversation view ring ──
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'workspace',
    order: 30,
    label: () => '工作区',
  }, WorkspaceDetailView))
}

// Keep the module-scope bindings referenced so esbuild retains them at the
// bundle top level (the eval'd vendored source is invisible to the bundler).
void statusSource
void runStatusAction

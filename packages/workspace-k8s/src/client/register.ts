/**
 * Slot wiring for the workspace status panel.
 *
 * Deliberately React-free: `index.tsx` supplies the components, so the wiring
 * itself (which slots, which ids, when the poller starts and stops) stays
 * testable without a browser. The official `ui-workspace` row owns the sidebar
 * workspace/session list, the hero and the `sidebar.workspaces` contract; this
 * module must only ever ADD to `main` and `sidebar.panellist`.
 *
 * The `shell.overlay` pill this module used to register is REMOVED. It was
 * placed top-left, over the brand mark, and its aggregate copy ("工作区：3 个
 * 休眠中") was unreadable in place and duplicated by the `main` panel and the
 * sidebar row below it. A frame-wide overlay that covers chrome to repeat
 * information already on screen is not worth the pixels; the aggregate now
 * lives in the sidebar row's tooltip (`statusSummary`).
 */
import {
  WORKSPACE_PANEL_ID,
  WORKSPACE_PANEL_LABEL,
} from './panel-model.ts'

/** The slot registry face this module consumes (a subset of the client one). */
export interface SlotRegistry {
  inject(slot: string, register: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** The two components the registration needs, supplied by `index.tsx`. */
export interface PanelComponents {
  /** Occupant of the keyed `main` panel. */
  Panel: unknown
  /** Occupant of the `sidebar.panellist` row. */
  Icon: unknown
}

/**
 * Register the status surfaces on the official slots.
 *
 * `renderSlot` hands every occupant the framework standard seat, and this
 * plugin's snapshot is a module-level observable, so the components need no
 * injected share — they subscribe through React's `useSyncExternalStore`.
 * @param slots - client slot registry.
 * @param components - panel/icon components.
 * @returns nothing; slot registrations live as long as the caller's fiber.
 */
export function registerWorkspacePanel(slots: SlotRegistry, components: PanelComponents): void {
  slots.inject('main', () => slots.register({
    name: 'main',
    key: WORKSPACE_PANEL_ID,
    label: () => WORKSPACE_PANEL_LABEL,
  }, components.Panel))

  // A sidebar row addressing the main panel by the same id; the sidebar owns
  // the button chrome, this entry supplies the glyph and the title.
  slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: WORKSPACE_PANEL_ID,
    order: 20,
    label: () => WORKSPACE_PANEL_LABEL,
  }, components.Icon))
}

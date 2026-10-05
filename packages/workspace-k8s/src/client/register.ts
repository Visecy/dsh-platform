/**
 * Slot wiring for the workspace status panel.
 *
 * Deliberately React-free: `index.tsx` supplies the components, so the wiring
 * itself (which slots, which ids, when the poller starts and stops) stays
 * testable without a browser. The official `ui-workspace` row still owns the
 * sidebar workspace/session list, the hero and the `sidebar.workspaces`
 * contract; this module ADDS the status panel on `main` /
 * `sidebar.panellist` and fills the two `directoryFlow` seats with the
 * platform's name-based new-workspace dialog (see
 * `registerNewWorkspaceDialog`).
 *
 * The `shell.overlay` pill this module used to register is REMOVED. It was
 * placed top-left, over the brand mark, and its aggregate copy ("工作区：3 个
 * 休眠中") was unreadable in place and duplicated by the `main` panel and the
 * sidebar row below it. A frame-wide overlay that covers chrome to repeat
 * information already on screen is not worth the pixels; the aggregate now
 * lives in the sidebar row's tooltip (`statusSummary`).
 */
import type { NewWorkspaceDialogInjected } from './NewWorkspaceDialog.tsx'
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

/**
 * The two `directoryFlow` seats, declared by the official picker (hero) and
 * browser (sidebar) entries.
 *
 * The name says where the seat sits in the owner's layout, NOT what belongs in
 * it. On this platform a workspace is a record with its own volume and anchor
 * directory, created by typing a name; there is no directory to browse and
 * nothing to pick from a list the sidebar already shows. The platform's dialog
 * therefore takes both seats at `priority: -100` — lowest renders, so the
 * official directory browser (default 0) stays out of them.
 */
export const DIRECTORY_FLOW_SLOTS = [
  'conversation.hero.workspace.directoryFlow',
  'sidebar.workspaces.directoryFlow',
] as const

/**
 * Fill both directory-flow seats with the name-based new-workspace dialog.
 *
 * The owner still drives the interaction: it opens the seat (`open`), reports
 * its own adoption work (`busy`) and closes the flow (`onCancel`). What changes
 * is the commit: `createByName` posts a NAME — nothing here can produce a path,
 * so no directory flow can be reached from workspace creation.
 * @param slots - client slot registry.
 * @param component - the dialog component supplied by `index.tsx`.
 * @param injected - factory returning the name-commit share for the seat.
 * @returns nothing; slot registrations live as long as the caller's fiber.
 */
export function registerNewWorkspaceDialog(
  slots: SlotRegistry,
  component: unknown,
  injected: () => NewWorkspaceDialogInjected,
): void {
  for (const name of DIRECTORY_FLOW_SLOTS) {
    slots.inject(name, () => slots.register({ name, priority: -100, inject: injected }, component))
  }
}

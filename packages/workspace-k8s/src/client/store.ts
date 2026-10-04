/**
 * Shared workspace catalog store for the client UI.
 *
 * One polled snapshot of `/workspaces/api/list` feeds the `main` status panel,
 * its `sidebar.panellist` icon and the optional `shell.overlay` pill. The
 * snapshot object is replaced only when a poll settles, so
 * `useSyncExternalStore` consumers see a stable reference between polls.
 *
 * Failure is a first-class state: a failed list poll or a rejected action kept
 * its API `error.message` in the snapshot rather than only on the console, so
 * the panel can render it. The platform has been bitten by silent client
 * failures before; this store does not have one.
 */
import { workspaceApi, type CatalogWorkspace } from './api.ts'
import type { StatusAction } from './panel-model.ts'

export interface StatusPayload {
  /** When the snapshot was produced (ms epoch); the panel's clock for countdowns. */
  at: number
  rows: CatalogWorkspace[]
  /** Last API `error.message`, or '' when the last call succeeded. */
  error: string
  /** Workspace id with an action in flight, so the panel can lock its buttons. */
  pendingId: string
  /** True while a list poll is in flight. */
  loading: boolean
}

const EMPTY: StatusPayload = { at: 0, rows: [], error: '', pendingId: '', loading: false }

let payload: StatusPayload = EMPTY
const listeners = new Set<() => void>()

/** Current snapshot; stable between polls. */
export function getSnapshot(): StatusPayload {
  return payload
}

/**
 * Subscribe to snapshot replacements.
 * @param fn - listener invoked after every poll/action settles.
 * @returns unsubscribe function.
 */
export function subscribeStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  for (const fn of listeners) fn()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Refresh the catalog. Never rejects: failures land in `snapshot.error`. */
export async function poll(): Promise<void> {
  payload = { ...payload, loading: true }
  notify()
  try {
    const list = await workspaceApi.list()
    payload = { at: Date.now(), rows: list, error: '', pendingId: payload.pendingId, loading: false }
  } catch (error) {
    payload = { ...payload, at: Date.now(), error: messageOf(error), loading: false }
  }
  notify()
}

/**
 * Keep the snapshot current: one immediate poll, then one per interval. The
 * interval is unref'd so a mounted panel can never hold the process open.
 * @param intervalMs - poll cadence.
 * @returns disposer that stops the poller.
 */
export function startPolling(intervalMs: number): () => void {
  let inFlight = false
  let stopped = false
  const tick = (): void => {
    if (inFlight || stopped) return
    inFlight = true
    void poll().finally(() => { inFlight = false })
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  // Node keeps the event loop alive for a plain interval; the web client does
  // not care, the tests and any Node-side import do.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Dispatch one lifecycle action, then refresh the snapshot.
 *
 * The returned promise resolves after the refresh and rejects when the action
 * itself failed; either way the failure text is already in the snapshot (and
 * every subscriber has been notified), so the panel shows it without a console
 * round-trip. Callers that only fire-and-forget can ignore the rejection.
 * @param workspaceId - platform workspace id (the path segment, not the native UUID).
 * @param action - lifecycle verb.
 * @returns promise settling after the refresh.
 */
export function runStatusAction(workspaceId: string, action: StatusAction): Promise<void> {
  payload = { ...payload, pendingId: workspaceId, error: '' }
  notify()
  const dispatched = (async (): Promise<void> => {
    switch (action) {
      case 'ensure': await workspaceApi.ensure(workspaceId); break
      case 'sleep': await workspaceApi.sleep(workspaceId); break
      case 'delete': await workspaceApi.delete(workspaceId); break
      case 'cleanup': await workspaceApi.cleanup(workspaceId); break
    }
  })()
  return dispatched.then(async () => {
    payload = { ...payload, pendingId: '' }
    notify()
    await poll()
  }, async (error: unknown) => {
    payload = { ...payload, pendingId: '', error: messageOf(error) }
    notify()
    await poll().catch(() => undefined)
    throw error
  })
}

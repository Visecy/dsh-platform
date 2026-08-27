/**
 * Shared workspace catalog store for the client UI.
 *
 * Both the vendored official browser (via the injected `statusSource` hook)
 * and the workspace detail view consume this one polled snapshot. The
 * snapshot is replaced only when the poll returns, so useSyncExternalStore /
 * HostObservable consumers see stable references between polls.
 */
import { workspaceApi, type CatalogWorkspace } from './api.ts'

export interface StatusRow extends CatalogWorkspace {
  /** Display label for the phase (rendered by the vendored browser). */
  label: string
}

export interface StatusPayload {
  at: number
  rows: StatusRow[]
  error: string
}

export const PHASE_LABEL: Record<string, string> = {
  running: '运行中',
  sleep: '休眠中',
  provision: '创建中',
  waking: '唤醒中',
  orphan: '待清理',
  deleted: '已删除',
  unknown: '未知',
}

let payload: StatusPayload = { at: 0, rows: [], error: '' }
const listeners = new Set<() => void>()

function notify(): void {
  for (const fn of listeners) fn()
}

export const statusSource = {
  getSnapshot: (): StatusPayload => payload,
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
  // The vendored browser reports its visible workspace ids here; the real
  // catalog polls everything, so this is a no-op.
  setScope: (): void => {},
}

export async function poll(): Promise<void> {
  try {
    const list = await workspaceApi.list()
    payload = {
      at: Date.now(),
      rows: list.map((r) => ({ ...r, label: PHASE_LABEL[r.phase] ?? r.phase })),
      error: '',
    }
  } catch (e) {
    payload = { ...payload, error: e instanceof Error ? e.message : String(e) }
  }
  notify()
}

/** Workspace action dispatch (wake/sleep/delete/cleanup) + immediate refresh. */
export async function runStatusAction(workspaceId: string, action: string): Promise<void> {
  if (action === 'ensure') await workspaceApi.ensure(workspaceId)
  else if (action === 'sleep') await workspaceApi.sleep(workspaceId)
  else if (action === 'delete') await workspaceApi.delete(workspaceId)
  else if (action === 'cleanup') await workspaceApi.cleanup(workspaceId)
  await poll()
}

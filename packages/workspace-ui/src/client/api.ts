export interface CatalogWorkspace {
  workspaceId: string
  path: string
  title?: string
  nativeWorkspaceId?: string
  phase: 'provision' | 'running' | 'sleep' | 'deleted' | 'orphan' | 'unknown'
  hasPod: boolean
  hasPvc: boolean
  activeSessions: number
  openTurns: number
  activeCommands: number
  lastSleepAt?: number
}

async function call<T>(method: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`/workspaces/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json() as { ok: boolean; data?: T; error?: { message?: string } }
  if (!payload.ok) throw new Error(payload.error?.message ?? 'request failed')
  return payload.data as T
}

export const workspaceApi = {
  list: () => call<CatalogWorkspace[]>('list'),
  create: (name: string) => call<CatalogWorkspace>('create', { name }),
  ensure: (workspaceId: string) => call<CatalogWorkspace>('ensure', { workspaceId }),
  status: (workspaceId: string) => call<CatalogWorkspace | undefined>('status', { workspaceId }),
  delete: (workspaceId: string) => call<{ ok: boolean }>('delete', { workspaceId }),
  cleanup: (workspaceId: string) => call<{ ok: boolean }>('cleanup', { workspaceId }),
}

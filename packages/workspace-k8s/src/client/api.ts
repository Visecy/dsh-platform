export interface CatalogTimelineEntry {
  at: number
  type: string
  text: string
}

export interface CatalogK8sDetails {
  podName: string
  pvcName: string
  namespace: string
  image: string
  runtimeClass: string | null
  cpuLimit: string | null
  memLimit: string | null
  storageClass: string | null
  capacityGB: number
}

export interface CatalogMetrics {
  available: boolean
  cpu: { value: number; pct: number | null; history: number[] }
  mem: { value: number; pct: number | null; history: number[] }
}

export type CatalogPhase = 'provision' | 'waking' | 'running' | 'sleep' | 'deleted' | 'orphan' | 'unknown'

export interface CatalogWorkspace {
  workspaceId: string
  path: string
  title?: string
  nativeWorkspaceId?: string
  phase: CatalogPhase
  hasPod: boolean
  hasPvc: boolean
  activeSessions: number
  openTurns: number
  activeCommands: number
  lastSleepAt?: number
  lastWakeAt?: number
  createdAt?: number
  wakeCount: number
  sleepCount: number
  idleDeadlineAt?: number
  graceDeadlineAt?: number
  timeline: CatalogTimelineEntry[]
  k8s: CatalogK8sDetails | null
  metrics: CatalogMetrics | null
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
  sleep: (workspaceId: string) => call<{ ok: boolean }>('sleep', { workspaceId }),
  status: (workspaceId: string) => call<CatalogWorkspace | undefined>('status', { workspaceId }),
  delete: (workspaceId: string) => call<{ ok: boolean }>('delete', { workspaceId }),
  cleanup: (workspaceId: string) => call<{ ok: boolean }>('cleanup', { workspaceId }),
}

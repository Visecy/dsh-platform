/**
 * WorkspaceManagement: higher-level service for workspace UI/admin operations.
 *
 * Combines the official registry bridge, k8s resource state, the in-memory
 * lifecycle status, the metrics sampler, and pod static configuration into
 * one catalog so a client workspace panel can render the full status page
 * (phase, counts, countdowns, timeline, metrics, k8s details) and offer
 * create/delete/cleanup actions.
 */
import { mkdir } from 'node:fs/promises'
import type { PodController } from './k8s-client.ts'
import type { WorkspaceRegistry, RegistryWorkspace } from './registry.ts'
import type { WorkspaceStatusService } from './wire.ts'
import type { WorkspaceMetricsSampler } from './metrics.ts'

export type CatalogPhase = 'provision' | 'waking' | 'running' | 'sleep' | 'deleted' | 'orphan' | 'unknown'

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

export interface WorkspaceCatalogEntry {
  workspaceId: string
  path: string
  title?: string
  /** Opaque id used by the official DSH client/Host workspace APIs. */
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
  /** Absolute idle/grace deadlines for countdown display (null while active). */
  idleDeadlineAt?: number
  graceDeadlineAt?: number
  timeline: CatalogTimelineEntry[]
  k8s: CatalogK8sDetails | null
  metrics: CatalogMetrics | null
}

export interface WorkspaceManagementOptions {
  controller: PodController
  registry: WorkspaceRegistry
  status: WorkspaceStatusService
  metrics: WorkspaceMetricsSampler
  namespace: string
  hostRoot: string
  image: string
  storageClassName?: string
  storageSize?: string
  runtimeClassName?: string
  resources?: { cpu?: string; memory?: string }
  idleTimeoutMs?: number
  graceMs?: number
  /** Delete a fully-managed workspace (registry + pod + PVC). */
  deleteWorkspace: (workspaceId: string) => Promise<void> | void
  /** Ensure the execution pod is running (wake a sleeping workspace). */
  ensureWorkspace: (workspaceId: string) => Promise<string>
  /** Manual sleep (user request): drain and delete the pod, keep the PVC. */
  sleepWorkspace: (workspaceId: string) => void
}

export interface WorkspaceManagementService {
  create(name: string): Promise<WorkspaceCatalogEntry>
  list(): Promise<WorkspaceCatalogEntry[]>
  get(workspaceId: string): Promise<WorkspaceCatalogEntry | undefined>
  ensure(workspaceId: string): Promise<WorkspaceCatalogEntry>
  sleep(workspaceId: string): Promise<void>
  delete(workspaceId: string): Promise<void>
  cleanupOrphan(workspaceId: string): Promise<void>
}

function sanitizeWorkspaceName(name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  if (safe === '' || safe === '.' || safe === '..') {
    throw new Error(`"${name}" is not a valid workspace name`)
  }
  return safe.slice(0, 50)
}

function pvcToWorkspaceId(name: string): string {
  return name.endsWith('-data') ? name.slice(0, -5) : name
}

/** Map a state-machine event type code to display text. */
function eventText(type: string, idleMs: number, graceMs: number): string {
  const idleMin = Math.round(idleMs / 60_000)
  const graceH = Math.round(graceMs / 3_600_000)
  switch (type) {
    case 'provision-started': return '工作区创建 · 拉起执行 Pod'
    case 'waking-started': return '正在唤醒 · 拉起执行 Pod'
    case 'pod-ready': return '执行 Pod 就绪'
    case 'pod-lost': return '执行 Pod 失联 · 自动重建'
    case 'idle-started': return `空闲计时启动 · ${idleMin} 分钟后休眠`
    case 'grace-started': return `${graceH} 小时宽限开始 · 等待遗留命令`
    case 'sleep': return '工作区已休眠 · Pod 已回收'
    case 'deleted': return '工作区已删除'
    default: return type
  }
}

function storageGiB(size: string | undefined): number {
  if (size === undefined) return 0
  const m = /^([0-9]+)([KMGTPE]i?)?$/.exec(size.trim())
  if (m === null) return 0
  const n = Number(m[1])
  const suffix = m[2] ?? ''
  const exp: Record<string, number> = { '': 0, K: 1, Ki: 1, M: 2, Mi: 2, G: 3, Gi: 3, T: 4, Ti: 4, P: 5, Pi: 5, E: 6, Ei: 6 }
  const e = exp[suffix]
  if (e === undefined) return 0
  return Math.round((n * 1024 ** e) / 1073741824)
}

export class WorkspaceManagement implements WorkspaceManagementService {
  private idleMs: number
  private graceMs: number

  constructor(private opts: WorkspaceManagementOptions) {
    this.idleMs = opts.idleTimeoutMs ?? 5 * 60 * 1000
    this.graceMs = opts.graceMs ?? 3 * 60 * 60 * 1000
  }

  async create(name: string): Promise<WorkspaceCatalogEntry> {
    const workspaceId = sanitizeWorkspaceName(name)
    const path = `${this.opts.hostRoot}/${workspaceId}`
    await mkdir(path, { recursive: true })
    const existing = await this.opts.registry.list().then((rows) => rows.find((ws) => ws.workspaceId === workspaceId))
    if (existing === undefined) {
      await this.opts.registry.create(path)
    }
    const entry = await this.get(workspaceId)
    return entry ?? this.entry({ workspaceId, path }, false, false)
  }

  async list(): Promise<WorkspaceCatalogEntry[]> {
    const { controller, registry, namespace } = this.opts
    const [registered, pods, pvcs] = await Promise.all([
      registry.list().catch(() => [] as RegistryWorkspace[]),
      controller.listPods === undefined ? Promise.resolve([] as string[]) : controller.listPods(namespace).catch(() => [] as string[]),
      controller.listPvcs === undefined ? Promise.resolve([] as string[]) : controller.listPvcs(namespace).catch(() => [] as string[]),
    ])
    const podSet = new Set(pods)
    const pvcSet = new Set(pvcs.map(pvcToWorkspaceId))
    const byId = new Map<string, RegistryWorkspace>()
    for (const ws of registered) byId.set(ws.workspaceId, ws)

    const ids = new Set<string>([...byId.keys(), ...pvcSet, ...podSet])
    const rows: WorkspaceCatalogEntry[] = []
    for (const id of ids) {
      const reg = byId.get(id)
      const hasPod = podSet.has(id)
      const hasPvc = pvcSet.has(id)
      const path = reg?.path ?? `${this.opts.hostRoot}/${id}`
      // The official registry may contain a default root row (path '/') or
      // non-platform workspaces; only /workspaces/<id> rows are real
      // platform workspaces.
      if (!path.startsWith(`${this.opts.hostRoot}/`) || path === this.opts.hostRoot) continue
      rows.push(this.entry({ workspaceId: id, path, title: reg?.title }, hasPod, hasPvc))
    }
    rows.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    return rows
  }

  async get(workspaceId: string): Promise<WorkspaceCatalogEntry | undefined> {
    const rows = await this.list()
    return rows.find((ws) => ws.workspaceId === workspaceId)
  }

  async ensure(workspaceId: string): Promise<WorkspaceCatalogEntry> {
    await this.opts.ensureWorkspace(workspaceId)
    const entry = await this.get(workspaceId)
    if (entry !== undefined) return entry
    return this.entry({ workspaceId, path: `${this.opts.hostRoot}/${workspaceId}` }, true, true)
  }

  async sleep(workspaceId: string): Promise<void> {
    this.opts.sleepWorkspace(workspaceId)
  }

  async delete(workspaceId: string): Promise<void> {
    await this.opts.registry.delete(workspaceId).catch(() => undefined)
    await this.opts.deleteWorkspace(workspaceId)
  }

  async cleanupOrphan(workspaceId: string): Promise<void> {
    const { controller, namespace } = this.opts
    // Only pod-only resources are considered "orphans". If a PVC exists,
    // the caller should use delete() so data is intentionally removed.
    await controller.deletePod(namespace, workspaceId)
  }

  private entry(
    reg: RegistryWorkspace,
    hasPod: boolean,
    hasPvc: boolean,
  ): WorkspaceCatalogEntry {
    const { controller, status, metrics, namespace, image } = this.opts
    const state = status.get(reg.workspaceId)
    let phase: CatalogPhase
    if (state !== undefined) {
      phase = state.phase
    } else if (hasPod && !hasPvc) {
      phase = 'orphan'
    } else if (hasPvc && !hasPod) {
      phase = 'sleep'
    } else if (hasPod && hasPvc) {
      phase = 'running'
    } else {
      phase = 'sleep'
    }

    const timeline: CatalogTimelineEntry[] = (state?.events ?? [])
      .slice(-40)
      .map((e) => ({ at: e.at, type: e.type, text: eventText(e.type, this.idleMs, this.graceMs) }))

    const k8s: CatalogK8sDetails | null = hasPod || hasPvc
      ? {
          podName: controller.podName(reg.workspaceId),
          pvcName: controller.pvcName(reg.workspaceId),
          namespace,
          image,
          runtimeClass: this.opts.runtimeClassName ?? null,
          cpuLimit: this.opts.resources?.cpu ?? null,
          memLimit: this.opts.resources?.memory ?? null,
          storageClass: this.opts.storageClassName ?? null,
          capacityGB: storageGiB(this.opts.storageSize),
        }
      : null

    const series = metrics.get(reg.workspaceId)
    const catalogMetrics: CatalogMetrics | null = series === undefined
      ? null
      : {
          available: metrics.available,
          cpu: {
            value: Math.round(series.sample.cpuCores * 1000) / 1000,
            pct: series.sample.cpuPct,
            history: series.history.map((h) => h.cpuCores),
          },
          mem: {
            value: Math.round(series.sample.memoryBytes / 1048576),
            pct: series.sample.memoryPct,
            history: series.history.map((h) => Math.round(h.memoryBytes / 1048576)),
          },
        }

    return {
      workspaceId: reg.workspaceId,
      path: reg.path,
      title: reg.title,
      nativeWorkspaceId: reg.internalId,
      phase,
      hasPod,
      hasPvc,
      activeSessions: state?.activeSessions ?? 0,
      openTurns: state?.openTurns ?? 0,
      activeCommands: state?.activeCommands ?? 0,
      lastSleepAt: state?.lastSleepAt,
      lastWakeAt: state?.lastWakeAt,
      createdAt: state?.createdAt,
      wakeCount: state?.wakeCount ?? 0,
      sleepCount: state?.sleepCount ?? 0,
      idleDeadlineAt: state?.phase === 'running' && state.idleSince !== undefined && state.activeCommands === 0
        ? state.idleSince + this.idleMs
        : undefined,
      graceDeadlineAt: state?.phase === 'running' && state.idleSince !== undefined && state.activeCommands > 0
        ? state.idleSince + this.graceMs
        : undefined,
      timeline,
      k8s,
      metrics: catalogMetrics,
    }
  }
}

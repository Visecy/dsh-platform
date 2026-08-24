/**
 * WorkspaceManagement: higher-level service for workspace UI/admin operations.
 *
 * Combines the official registry bridge, k8s resource state, and the in-memory
 * lifecycle status into one catalog so a client workspace panel can render
 * running/sleeping/orphan entries and offer create/delete/cleanup actions.
 */
import { mkdir } from 'node:fs/promises'
import type { PodController } from './k8s-client.ts'
import type { WorkspaceRegistry, RegistryWorkspace } from './registry.ts'
import type { WorkspaceStatusService } from './wire.ts'

export type CatalogPhase = 'provision' | 'running' | 'sleep' | 'deleted' | 'orphan' | 'unknown'

export interface WorkspaceCatalogEntry {
  workspaceId: string
  path: string
  title?: string
  phase: CatalogPhase
  hasPod: boolean
  hasPvc: boolean
  activeSessions: number
  openTurns: number
  activeCommands: number
  lastSleepAt?: number
}

export interface WorkspaceManagementOptions {
  controller: PodController
  registry: WorkspaceRegistry
  status: WorkspaceStatusService
  namespace: string
  hostRoot: string
  /** Delete a fully-managed workspace (registry + pod + PVC). */
  deleteWorkspace: (workspaceId: string) => Promise<void> | void
  /** Ensure the execution pod is running (wake a sleeping workspace). */
  ensureWorkspace: (workspaceId: string) => Promise<string>
}

export interface WorkspaceManagementService {
  create(name: string): Promise<WorkspaceCatalogEntry>
  list(): Promise<WorkspaceCatalogEntry[]>
  get(workspaceId: string): Promise<WorkspaceCatalogEntry | undefined>
  ensure(workspaceId: string): Promise<WorkspaceCatalogEntry>
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

export class WorkspaceManagement implements WorkspaceManagementService {
  constructor(private opts: WorkspaceManagementOptions) {}

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
    const state = this.opts.status.get(reg.workspaceId)
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
    return {
      workspaceId: reg.workspaceId,
      path: reg.path,
      title: reg.title,
      phase,
      hasPod,
      hasPvc,
      activeSessions: state?.activeSessions ?? 0,
      openTurns: state?.openTurns ?? 0,
      activeCommands: state?.activeCommands ?? 0,
      lastSleepAt: state?.lastSleepAt,
    }
  }
}

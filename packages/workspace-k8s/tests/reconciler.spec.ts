import { describe, expect, it } from 'vitest'
import { WorkspaceReconciler } from '../src/reconciler.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { WorkspaceRegistry } from '../src/registry.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
}

class FakeRegistry implements WorkspaceRegistry {
  readonly created: string[] = []
  readonly deleted: string[] = []
  known: Array<{ workspaceId: string; path: string }>
  constructor(known: Array<{ workspaceId: string; path: string }> = []) {
    this.known = known
  }
  async list(): Promise<Array<{ workspaceId: string; path: string }>> { return [...this.known] }
  async create(path: string): Promise<{ workspaceId: string; path: string }> {
    const id = path.split('/').filter(Boolean).at(-1) ?? ''
    this.created.push(id)
    const ws = { workspaceId: id, path }
    this.known.push(ws)
    return ws
  }
  async delete(workspaceId: string): Promise<void> {
    this.deleted.push(workspaceId)
    this.known = this.known.filter((w) => w.workspaceId !== workspaceId)
  }
}

describe('WorkspaceReconciler', () => {
  it('registers pods that are missing from the official registry', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-a')
    const reg = new FakeRegistry()
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual(['ws-a'])
  })

  it('registers sleeping workspaces from PVCs', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-b-data')
    const reg = new FakeRegistry()
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual(['ws-b'])
  })

  it('does not duplicate workspaces already known', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-c')
    const reg = new FakeRegistry([{ workspaceId: 'ws-c', path: '/workspaces/ws-c' }])
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual([])
  })

  it('reclaims resources removed from the registry after a synced pass', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-d')
    const reg = new FakeRegistry([{ workspaceId: 'ws-d', path: '/workspaces/ws-d' }])
    const deleted: string[] = []
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      onDelete: (id) => deleted.push(id),
    })

    // First pass: registry has ws-d -> synced.
    await r.reconcile()
    expect(deleted).toEqual([])

    // Simulate an explicit workspace deletion (registry entry removed).
    reg.known = []
    await r.reconcile()
    expect(deleted).toEqual(['ws-d'])
  })

  it('does not reclaim on a cold start with an empty registry', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-e')
    ctrl.pvcs.add('ws-e-data')
    const reg = new FakeRegistry([])
    const deleted: string[] = []
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      onDelete: (id) => deleted.push(id),
    })
    await r.reconcile()
    expect(deleted).toEqual([])
    expect(reg.created).toEqual(['ws-e'])
  })
})

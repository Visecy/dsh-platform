import { describe, expect, it } from 'vitest'
import { WorkspaceReconciler, type SessionHeaderSource } from '../src/reconciler.ts'
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

/** No stored sessions: these cases are about the k8s->registry bridge only. */
const noSessions: SessionHeaderSource = { list: async () => [] }

describe('WorkspaceReconciler', () => {
  it('registers running workspaces (pod + PVC) that are missing from the official registry', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-a')
    ctrl.pvcs.add('ws-a-data')
    const reg = new FakeRegistry()
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, sessions: noSessions, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual(['ws-a'])
  })

  it('does not auto-adopt pod-only orphan resources', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-orphan')
    const reg = new FakeRegistry()
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, sessions: noSessions, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual([])
  })

  it('registers sleeping workspaces from PVCs', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-b-data')
    const reg = new FakeRegistry()
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, sessions: noSessions, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual(['ws-b'])
  })

  it('does not duplicate workspaces already known', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-c')
    const reg = new FakeRegistry([{ workspaceId: 'ws-c', path: '/workspaces/ws-c' }])
    const r = new WorkspaceReconciler({ controller: ctrl, registry: reg, sessions: noSessions, namespace: 'dsh', hostRoot: '/workspaces' })
    await r.reconcile()
    expect(reg.created).toEqual([])
  })

  it('does not reclaim resources when registry list is empty', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-e')
    ctrl.pvcs.add('ws-e-data')
    const reg = new FakeRegistry([])
    const deleted: string[] = []
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      onDelete: (id) => deleted.push(id),
    })
    // Even after a prior pass, an empty registry must never trigger deletion.
    await r.reconcile()
    await r.reconcile()
    expect(deleted).toEqual([])
    expect(reg.created).toEqual(['ws-e'])
  })

  it('does not reclaim pod-only orphan resources even after repeated passes', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-orphan')
    const reg = new FakeRegistry([])
    const deleted: string[] = []
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      onDelete: (id) => deleted.push(id),
    })
    await r.reconcile()
    await r.reconcile()
    expect(deleted).toEqual([])
    expect(reg.created).toEqual([])
  })
})

/**
 * The pass's half of the record-deletion contract (see `record-deletions.ts`):
 * the destroyed workspace must not be read back out of its own surviving
 * volume, and the retry for a failed destroy belongs to the pass.
 */
describe('WorkspaceReconciler record deletions', () => {
  /** A witness with the pass's three hooks, recorded. */
  const witness = (condemned: Set<string>, retryMessages: string[] = []) => {
    const observed: Array<Array<{ workspaceId: string; path: string; internalId?: string }>> = []
    const retries: number[] = []
    return {
      observed,
      retries,
      witness: {
        observe: (rows: Array<{ workspaceId: string; path: string; internalId?: string }>) => { observed.push([...rows]) },
        isCondemned: (id: string) => condemned.has(id),
        retry: async () => { retries.push(Date.now()); return retryMessages },
      },
    }
  }

  it('never adopts back a workspace whose record was deleted but whose volume survived', async () => {
    const ctrl = new FakeController()
    // The shape the pass is built to bridge: a PVC, no record.
    ctrl.pvcs.add('ws-deleted-data')
    ctrl.pods.add('ws-deleted')
    const reg = new FakeRegistry([])
    const { witness: w } = witness(new Set(['ws-deleted']))
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      condemned: w,
    })

    await r.reconcile()

    // Adopting it here is exactly the resurrection the operator watched.
    expect(reg.created).toEqual([])
  })

  it('retries failed deletions before reading the cluster, so a retry that succeeds cannot be adopted back', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-stuck-data')
    const reg = new FakeRegistry([])
    const condemned = new Set(['ws-stuck'])
    const logger = { warnings: [] as string[], warn(message: string) { this.warnings.push(message) } }
    // The retry succeeds and condemns nothing any more — but the pass must
    // have listed the cluster AFTER it, or the volume it just destroyed would
    // still be in the snapshot it bridges from.
    const observedAfterRetry: boolean[] = []
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      logger,
      condemned: {
        observe: () => undefined,
        isCondemned: (id: string) => condemned.has(id),
        retry: async () => {
          condemned.delete('ws-stuck')
          ctrl.pvcs.delete('ws-stuck-data')
          observedAfterRetry.push(ctrl.pvcs.has('ws-stuck-data'))
          return ['workspace \'ws-stuck\': destroying the backing of the deleted workspace failed: pvc is still in use']
        },
      },
    })

    await r.reconcile()

    expect(observedAfterRetry).toEqual([false])
    expect(reg.created).toEqual([])
    // And the failure the retry reported reaches the logger.
    expect(logger.warnings.join('\n')).toContain('pvc is still in use')
  })

  it('hands every registry projection it reads to the witness (the uuid → workspace join)', async () => {
    const ctrl = new FakeController()
    const reg = new FakeRegistry([{ workspaceId: 'ws-known', path: '/workspaces/ws-known' }])
    const { observed, witness: w } = witness(new Set())
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
      condemned: w,
    })

    await r.reconcile()

    expect(observed.length).toBeGreaterThan(0)
    expect(observed[0]).toEqual([{ workspaceId: 'ws-known', path: '/workspaces/ws-known' }])
  })
})

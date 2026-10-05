import { describe, expect, it } from 'vitest'
import { WorkspaceReconciler, type SessionHeaderSource } from '../src/reconciler.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { WorkspaceRegistry } from '../src/registry.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  /** Simulate a cluster read that FAILS (not one that finds nothing). */
  podsUnreadable = false
  pvcsUnreadable = false
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> {
    if (this.podsUnreadable) throw new Error('pods unreadable')
    return [...this.pods]
  }
  async listPvcs(): Promise<string[]> {
    if (this.pvcsUnreadable) throw new Error('pvcs unreadable')
    return [...this.pvcs]
  }
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
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
    })
    // Even after a prior pass, an empty registry must never trigger deletion.
    await r.reconcile()
    await r.reconcile()
    expect(reg.deleted).toEqual([])
    expect(reg.created).toEqual(['ws-e'])
  })

  it('does not reclaim pod-only orphan resources even after repeated passes', async () => {
    const ctrl = new FakeController()
    ctrl.pods.add('ws-orphan')
    const reg = new FakeRegistry([])
    const r = new WorkspaceReconciler({
      controller: ctrl,
      registry: reg,
      sessions: noSessions,
      namespace: 'dsh',
      hostRoot: '/workspaces',
    })
    await r.reconcile()
    await r.reconcile()
    expect(reg.deleted).toEqual([])
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

/**
 * The record half of the same pass. The bridge is add-only, so before this the
 * only record with no volume that ever left the sidebar was one an operator
 * deleted by hand: a delete that destroyed the PVC left the record behind, the
 * pass had no reason to look at it again, and the workspace stayed on screen
 * forever.
 *
 * The discriminator is OBSERVATION, not the bare fact "no volume": a record the
 * pass has never seen backed by a volume is a workspace that never had one
 * (adopted from outside) or has not got one yet (mid-provision), and both must
 * survive. Only a record whose volume this process watched, and which no longer
 * has one, is stale.
 */
describe('WorkspaceReconciler stale records', () => {
  const logger = () => {
    const warnings: string[] = []
    return { warnings, warn(message: string) { warnings.push(message) } }
  }
  const options = (ctrl: FakeController, reg: FakeRegistry, log?: { warn(message: string): void }) => ({
    controller: ctrl,
    registry: reg,
    sessions: noSessions,
    namespace: 'dsh',
    hostRoot: '/workspaces',
    logger: log,
  })

  it('removes the record of a workspace whose volume this pass watched disappear', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-gone-data')
    ctrl.pods.add('ws-gone')
    const reg = new FakeRegistry([{ workspaceId: 'ws-gone', path: '/workspaces/ws-gone' }])
    const log = logger()
    const r = new WorkspaceReconciler(options(ctrl, reg, log))

    // First pass: the volume is there, so the record is a live workspace.
    await r.reconcile()
    expect(reg.deleted).toEqual([])

    // The operator's delete destroyed the pod and the PVC; the record survived.
    ctrl.pvcs.delete('ws-gone-data')
    ctrl.pods.delete('ws-gone')
    await r.reconcile()

    expect(reg.deleted).toEqual(['ws-gone'])
    expect(log.warnings.join('\n')).toContain('ws-gone')
  })

  it('keeps a record that never had a volume (adopted from outside / mid-provision)', async () => {
    const ctrl = new FakeController()
    const reg = new FakeRegistry([
      { workspaceId: 'ws-new', path: '/workspaces/ws-new' },
      { workspaceId: 'ws-foreign', path: '/workspaces/ws-foreign' },
    ])
    const r = new WorkspaceReconciler(options(ctrl, reg))

    // `management.create` writes the record BEFORE anything creates the PVC, so
    // this is exactly what a workspace looks like while it is being created.
    await r.reconcile()
    await r.reconcile()
    await r.reconcile()

    expect(reg.deleted).toEqual([])
  })

  it('keeps a record while a pod still runs for it, even with the volume gone', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-live-data')
    ctrl.pods.add('ws-live')
    const reg = new FakeRegistry([{ workspaceId: 'ws-live', path: '/workspaces/ws-live' }])
    const r = new WorkspaceReconciler(options(ctrl, reg))

    await r.reconcile()
    // Volume gone, pod still serving: not this pass's call to remove the row
    // out from under a running workspace.
    ctrl.pvcs.delete('ws-live-data')
    await r.reconcile()

    expect(reg.deleted).toEqual([])
  })

  it('prunes nothing when the cluster cannot be listed', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-blind-data')
    ctrl.pods.add('ws-blind')
    const reg = new FakeRegistry([{ workspaceId: 'ws-blind', path: '/workspaces/ws-blind' }])
    const log = logger()
    const r = new WorkspaceReconciler(options(ctrl, reg, log))

    await r.reconcile()
    // A PVC list that FAILS must not read as "no PVC anywhere": that is the
    // mass deletion this guard exists to prevent, and it is why an empty array
    // from the caller's `catch` is not enough evidence to prune on.
    ctrl.pvcsUnreadable = true
    ctrl.podsUnreadable = true
    await r.reconcile()

    expect(reg.deleted).toEqual([])
    expect(log.warnings.join("\n")).toContain("prune")
  })

  it('does not re-create a pruned record on a later pass', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-ghost-data')
    const reg = new FakeRegistry([{ workspaceId: 'ws-ghost', path: '/workspaces/ws-ghost' }])
    const r = new WorkspaceReconciler(options(ctrl, reg))

    await r.reconcile()
    ctrl.pvcs.delete('ws-ghost-data')
    await r.reconcile()
    expect(reg.deleted).toEqual(['ws-ghost'])

    await r.reconcile()
    expect(reg.created).toEqual([])
    expect(reg.deleted).toEqual(['ws-ghost'])
  })

  it('keeps a fresh record for an id it pruned earlier', async () => {
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-again-data')
    const reg = new FakeRegistry([{ workspaceId: 'ws-again', path: '/workspaces/ws-again' }])
    const r = new WorkspaceReconciler(options(ctrl, reg))

    await r.reconcile()
    ctrl.pvcs.delete('ws-again-data')
    await r.reconcile()
    expect(reg.deleted).toEqual(['ws-again'])

    // The operator creates it again: the record exists before its PVC does, and
    // the witness from the deleted volume must not sentence it.
    await reg.create('/workspaces/ws-again')
    await r.reconcile()
    expect(reg.deleted).toEqual(['ws-again'])
  })
})

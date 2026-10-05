/**
 * Both delete entry points, over the REAL official registry.
 *
 * The platform has two ways to delete a workspace and only one of them used to
 * delete the workspace:
 *
 *   1. the platform's own delete (`workspaceDeleter`, the status panel's
 *      button) — pod, service and PVC, then the record (see
 *      `workspace-delete.spec.ts`);
 *   2. the OFFICIAL sidebar's delete — `ctx.workspaceRegistry.delete(id)`,
 *      record only. The PVC survived, and the reconciler read it back into a
 *      fresh record: the operator watched the row return 68 seconds later.
 *
 * (2) is what these tests pin. They mount the real plugin beside a real
 * `WorkspaceRegistry` (see `official-registry-harness.ts`) whose in-memory
 * medium emits the same `domain/changed` events the shipped
 * `dsh-storage-domain` emits, delete the record exactly the way the official
 * controller does, and assert the volume is gone and stays gone.
 *
 * They also pin the DISCRIMINATOR, both branches:
 *
 *   - an explicitly deleted record destroys the workspace's backing;
 *   - a PVC with no record and no observed deletion is "adopted from outside":
 *     it is registered, and nothing is destroyed. The failed-destroy case is
 *     the sharp end of the same rule: the workspace stays condemned (so the
 *     pass cannot re-register it out of the surviving volume), the failure is
 *     reported, and the pass retries until the cluster cooperates.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, name } from '../src/index.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import { startPluginComposition, type Harness } from './official-registry-harness.ts'

/** One k8s fake with the resource inventory and the delete order. */
class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  /** Every mutation, in order. */
  order: string[] = []
  /** Injected failure for the PVC delete. */
  failPvcDelete: Error | undefined

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    this.pods.add(spec.workspaceId)
    return spec.workspaceId
  }
  async deletePod(_namespace: string, workspaceId: string): Promise<void> {
    this.order.push(`pod:${workspaceId}`)
    this.pods.delete(workspaceId)
  }
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://127.0.0.1:9' }
  async ensurePvc(workspaceId: string): Promise<string> { return `${workspaceId}-data` }
  async deletePvc(workspaceId: string): Promise<void> {
    this.order.push(`pvc:${workspaceId}`)
    if (this.failPvcDelete !== undefined) throw this.failPvcDelete
    this.pvcs.delete(`${workspaceId}-data`)
  }
  podName(workspaceId: string): string { return workspaceId }
  pvcName(workspaceId: string): string { return `${workspaceId}-data` }
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
  async getPodImage(): Promise<string | undefined> { return undefined }
}

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-record-delete-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const until = async (predicate: () => boolean, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the delete path')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Mounted {
  harness: Harness
  ctrl: FakeController
}

/** Mount the real plugin over the harness registry, interval timer disabled. */
const mount = async (ctrl: FakeController, hostRoot: string): Promise<Mounted> => {
  const harness = await startPluginComposition()
  void harness.ctx.plugin({ name, apply }, {
    namespace: 'dsh-platform',
    image: 'daemon:configured',
    controller: ctrl,
    hostRoot,
    reconcileIntervalMs: 0,
    metricIntervalMs: 60_000,
  })
  return { harness, ctrl }
}

/** The official controller's delete: registry record only, no k8s call. */
const deleteRecord = async (harness: Harness, path: string): Promise<void> => {
  const record = harness.registry.list().find((workspace) => workspace.path === path)
  if (record === undefined) throw new Error(`no official record for '${path}'`)
  await harness.registry.delete(record.id)
}

describe('deleting a workspace through the official registry record', () => {
  it('destroys the pod, the service and the PVC, and nothing resurrects it', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('git-data')
    ctrl.pods.add('git')
    const { harness } = await mount(ctrl, hostRoot)

    // The load-time pass bridged the PVC into a record, like any other boot.
    await until(() => harness.registry.list().length === 1)
    const workspacePath = join(hostRoot, 'git')
    expect(harness.registry.list()[0]?.path).toBe(workspacePath)

    await deleteRecord(harness, workspacePath)
    expect(harness.registry.list()).toEqual([])

    // The record is gone; the BACKING must go with it, from the deletion
    // signal alone (no k8s call was made by the official delete).
    await until(() => !ctrl.pvcs.has('git-data'))
    expect(ctrl.pods.has('git')).toBe(false)
    expect(ctrl.order).toEqual(['pod:git', 'pvc:git'])

    // And the pass that used to undo the delete finds nothing to read back.
    await harness.ctx.get('workspaceReconciler')!.reconcile()
    expect(harness.registry.list()).toEqual([])
    expect(ctrl.pvcs.has('git-data')).toBe(false)
  })

  it('adopts a PVC that was never a record instead of destroying it (the other branch of the discriminator)', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    // A volume that appeared outside the platform: no record, and no deletion
    // event this process ever saw. "No record" is ambiguous — it can mean
    // "just deleted" or "never ours" — and only an observed deletion licenses
    // destruction.
    ctrl.pvcs.add('outside-data')
    const { harness } = await mount(ctrl, hostRoot)

    await until(() => harness.registry.list().length === 1)
    expect(harness.registry.list()[0]?.path).toBe(join(hostRoot, 'outside'))

    // Adopted, untouched: no pod delete, no PVC delete, no warning.
    expect(ctrl.order).toEqual([])
    expect(ctrl.pvcs.has('outside-data')).toBe(true)
    expect(harness.warnings).toEqual([])
  })

  it('keeps a workspace whose volume refuses to go condemned, reports it, and retries on the next pass', async () => {    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('stuck-data')
    ctrl.pods.add('stuck')
    const { harness } = await mount(ctrl, hostRoot)
    await until(() => harness.registry.list().length === 1)
    const workspacePath = join(hostRoot, 'stuck')
    const warningsBefore = harness.warnings.length

    ctrl.failPvcDelete = new Error('pvc is still in use')
    await deleteRecord(harness, workspacePath)
    await until(() => harness.warnings.length > warningsBefore)

    // Loud, and named: a delete that could not finish must not look like one
    // that did.
    expect(harness.warnings.slice(warningsBefore).join('\n')).toContain('pvc is still in use')

    // The volume survives, so the pass must NOT re-register the workspace out
    // of it — that is the resurrection the whole path exists to stop.
    await harness.ctx.get('workspaceReconciler')!.reconcile()
    expect(harness.registry.list()).toEqual([])

    // The retry rides the pass: once the cluster lets the volume go, the next
    // pass finishes the deletion.
    ctrl.failPvcDelete = undefined
    await harness.ctx.get('workspaceReconciler')!.reconcile()
    await until(() => !ctrl.pvcs.has('stuck-data'))
    expect(harness.registry.list()).toEqual([])
  })
})

/**
 * The delivery assumption the whole fix rests on, pinned against the real
 * cordis: the deletion events come from the STORAGE-DOMAIN row (a sibling
 * fiber), not from this plugin's own context, so `ctx.on` must receive them
 * app-wide. If cordis ever scopes event delivery to the emitting fiber (or to
 * the listener's inject list), the fix would go silent — and this test, not a
 * live deployment, is where that must show up.
 */
class SiblingRegistry extends Service {
  private rows = new Map<string, { id: string; path: string; title: string }>()
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  list(): Array<{ id: string; path: string; title: string }> {
    return [...this.rows.values()]
  }

  async create(path: string, title?: string): Promise<{ id: string; path: string; title: string }> {
    const existing = [...this.rows.values()].find((row) => row.path === path)
    if (existing !== undefined) return existing
    const row = { id: `uuid-${this.nextId++}`, path, title: title ?? path.split('/').filter(Boolean).at(-1) ?? path }
    this.rows.set(row.id, row)
    return row
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id)
  }

  async resolveByPath(): Promise<undefined> {
    return undefined
  }

  /** The durable write the storage-domain row announces after it commits. */
  emitRecordDeleted(id: string): void {
    this.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: id, operation: 'deleted' })
  }
}

describe('the deletion signal a sibling row emits', () => {
  it('reaches this plugin and destroys the backing of the deleted record', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('git-data')
    ctrl.pods.add('git')
    const ctx = new Context()
    let official: SiblingRegistry | undefined
    // Two rows under one root, exactly like the profile: the storage/registry
    // side and this plugin are siblings, not parent and child.
    await ctx.plugin({
      name: 'harness-storage-domain-row',
      apply: (row: Context) => { official = new SiblingRegistry(row) },
    })
    void ctx.plugin({ name, apply }, {
      namespace: 'dsh-platform',
      image: 'daemon:configured',
      controller: ctrl,
      hostRoot,
      reconcileIntervalMs: 0,
      metricIntervalMs: 60_000,
    })
    await until(() => ctx.get('workspaceReconciler') !== undefined)
    await until(() => (official?.list().length ?? 0) === 1)

    official!.emitRecordDeleted(official!.list()[0]!.id)

    await until(() => !ctrl.pvcs.has('git-data'))
    expect(ctrl.order).toEqual(['pod:git', 'pvc:git'])
  })
})

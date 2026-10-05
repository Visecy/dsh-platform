/**
 * Deleting a workspace must delete the workspace.
 *
 * The reconciler's rule is "only resources backed by a PVC are real
 * workspaces": it re-registers every PVC it finds into the official registry,
 * because that is how the sidebar survives a control-plane restart. That rule
 * turns a half-deletion into a resurrection — drop the registry record while
 * the volume survives, and the next pass reads the volume and puts the
 * workspace straight back, which is exactly what "delete does nothing" looks
 * like from the UI.
 *
 * These tests mount the real plugin (load-time reconcile pass, deleter service,
 * management catalog) over fake k8s resources and a duck-typed official
 * registry, and pin:
 *
 *   - the durable backing (pod, service, PVC) is deleted BEFORE the record;
 *   - the reconciler therefore finds nothing to re-register afterwards;
 *   - a failure to remove the volume is surfaced, and the record is left alone
 *     rather than dropped (which would only invite the resurrection);
 *   - sleep still keeps the PVC.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, name } from '../src/index.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

interface OfficialRow {
  id: string
  path: string
  title: string
}

/** One k8s fake with the resource inventory AND the delete order. */
class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  images = new Map<string, string>()
  /** Every mutation, in order — the ordering oracle. */
  order: string[] = []
  listPvcsCalls = 0
  /** Injected failure for the PVC delete. */
  failPvcDelete: Error | undefined
  /** Injected failure for the pod delete. */
  failPodDelete: Error | undefined

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    this.pods.add(spec.workspaceId)
    this.images.set(spec.workspaceId, spec.image)
    return spec.workspaceId
  }
  async deletePod(_namespace: string, workspaceId: string): Promise<void> {
    this.order.push(`pod:${workspaceId}`)
    if (this.failPodDelete !== undefined) throw this.failPodDelete
    this.pods.delete(workspaceId)
    this.images.delete(workspaceId)
  }
  async waitReady(): Promise<void> {}
  // A sink that refuses instantly: the sleep path's drain must not turn a DNS
  // lookup in a cluster-less test environment into a multi-second wait.
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
  async listPvcs(): Promise<string[]> { this.listPvcsCalls += 1; return [...this.pvcs] }
  async getPodImage(_namespace: string, podName: string): Promise<string | undefined> { return this.images.get(podName) }
}

/** The slice of `ctx.workspaceRegistry` (dsh-workspace) the platform talks to. */
class FakeOfficialRegistry extends Service {
  rows = new Map<string, OfficialRow>()
  /** Every mutation, in order — the other half of the ordering oracle. */
  order: string[] = []
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** The official projection is synchronous (durable order in memory). */
  list(): OfficialRow[] {
    return [...this.rows.values()]
  }

  async create(path: string, title?: string): Promise<OfficialRow> {
    const existing = [...this.rows.values()].find((row) => row.path === path)
    if (existing !== undefined) return existing
    const row = { id: `uuid-${this.nextId++}`, path, title: title ?? path.split('/').filter(Boolean).at(-1) ?? path }
    this.rows.set(row.id, row)
    return row
  }

  async delete(id: string): Promise<boolean> {
    this.order.push(`record:${this.rows.get(id)?.path ?? id}`)
    return this.rows.delete(id)
  }

  async resolveByPath(): Promise<undefined> { return undefined }
}

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delete-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the reconcile pass')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface Mounted {
  ctx: Context
  ctrl: FakeController
  registry: FakeOfficialRegistry
}

/** Mount the real plugin over the fakes, with the interval timer disabled. */
function mount(ctrl: FakeController, hostRoot: string): Mounted {
  const ctx = new Context()
  const registry = new FakeOfficialRegistry(ctx)
  void ctx.plugin(
    { name, apply },
    {
      namespace: 'dsh',
      image: 'daemon:configured',
      controller: ctrl,
      hostRoot,
      reconcileIntervalMs: 0,
      metricIntervalMs: 60_000,
    },
  )
  return { ctx, ctrl, registry }
}

describe('workspace deletion', () => {
  it('removes the pod and the PVC before the registry record, and nothing resurrects it', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-del-data')
    ctrl.pods.add('ws-del')
    ctrl.images.set('ws-del', 'daemon:configured')
    const { ctx, registry } = mount(ctrl, hostRoot)

    // The load-time pass registers the PVC-backed workspace.
    await until(() => registry.rows.size > 0)
    expect([...registry.rows.values()].map((row) => row.path)).toEqual([`${hostRoot}/ws-del`])

    await ctx.get('workspaceDeleter')!.delete('ws-del')

    // Durable backing first, record last: the record cannot survive a volume
    // the reconciler would read back.
    expect(ctrl.order).toEqual(['pod:ws-del', 'pvc:ws-del'])
    expect(registry.order).toEqual([`record:${hostRoot}/ws-del`])
    expect(ctrl.pvcs.has('ws-del-data')).toBe(false)
    expect(registry.rows.size).toBe(0)

    // The next pass finds no PVC, so there is nothing to re-register.
    await ctx.get('workspaceReconciler')!.reconcile()
    expect(registry.rows.size).toBe(0)
    expect([...registry.rows.values()]).toEqual([])
  })

  it('surfaces a failed PVC delete and leaves the record alone', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-stuck-data')
    ctrl.pods.add('ws-stuck')
    ctrl.images.set('ws-stuck', 'daemon:configured')
    ctrl.failPvcDelete = new Error('pvc is still in use')
    const { ctx, registry } = mount(ctrl, hostRoot)
    await until(() => registry.rows.size > 0)

    // The failure is the caller's to handle: reporting success here while the
    // volume survives is the bug this whole path exists to remove.
    await expect(ctx.get('workspaceDeleter')!.delete('ws-stuck')).rejects.toThrow('pvc is still in use')
    expect(registry.rows.size).toBe(1)
    expect(ctrl.pvcs.has('ws-stuck-data')).toBe(true)
  })

  it('keeps the sleep semantics: the PVC survives a sleep', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-sleep-data')
    ctrl.pods.add('ws-sleep')
    ctrl.images.set('ws-sleep', 'daemon:configured')
    const { ctx } = mount(ctrl, hostRoot)
    await until(() => ctrl.listPvcsCalls > 0)

    await ctx.get('workspaceManagement')!.sleep('ws-sleep')

    expect(ctrl.pods.has('ws-sleep')).toBe(false)
    expect(ctrl.pvcs.has('ws-sleep-data')).toBe(true)
  })

  it('converges a drifted pod onto the configured image without touching the PVC', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-old-data')
    ctrl.pods.add('ws-old')
    ctrl.images.set('ws-old', 'daemon:v0.1.54')
    const { ctx, registry } = mount(ctrl, hostRoot)

    await until(() => !ctrl.pods.has('ws-old'))
    expect(ctrl.pvcs.has('ws-old-data')).toBe(true)
    // The workspace itself is untouched: it is registered and reads as sleeping
    // until the next wake provisions the configured image.
    await until(() => registry.rows.size > 0)
  })

  it('shows the drift recycle in the catalog timeline', async () => {
    const hostRoot = tempRoot()
    const ctrl = new FakeController()
    ctrl.pvcs.add('ws-visible-data')
    ctrl.pods.add('ws-visible')
    ctrl.images.set('ws-visible', 'daemon:v0.1.54')
    mkdirSync(join(hostRoot, 'ws-visible'), { recursive: true })
    const { ctx } = mount(ctrl, hostRoot)
    await until(() => !ctrl.pods.has('ws-visible'))

    const entries = await ctx.get('workspaceManagement')!.list()
    const entry = entries.find((row) => row.workspaceId === 'ws-visible')
    expect(entry?.timeline.map((event) => event.type)).toContain('pod-recycled')
    expect(entry?.timeline.find((event) => event.type === 'pod-recycled')?.text).toContain('新镜像')
  })
})

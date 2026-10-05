import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManagement } from '../src/management.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { WorkspaceRegistry } from '../src/registry.ts'
import { initialState, type WorkspaceState } from '../src/state-machine.ts'
import { WorkspaceMetricsSampler } from '../src/metrics.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  deletedPods: string[] = []
  /** Every deletion, in order. */
  order: string[] = []
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(_ns: string, workspaceId: string): Promise<void> { this.deletedPods.push(workspaceId); this.pods.delete(workspaceId) }
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
  podName(workspaceId: string): string { return workspaceId }
  pvcName(workspaceId: string): string { return workspaceId + '-data' }
}

class FakeRegistry implements WorkspaceRegistry {
  rows: Array<{ workspaceId: string; path: string; title?: string; internalId?: string }> = []
  deleted: string[] = []
  async list() { return [...this.rows] }
  async create(path: string) {
    const workspaceId = path.split('/').filter(Boolean).at(-1) ?? ''
    const ws = { workspaceId, path }
    this.rows.push(ws)
    return ws
  }
  async delete(workspaceId: string) { this.deleted.push(workspaceId); this.rows = this.rows.filter((r) => r.workspaceId !== workspaceId) }
}

/**
 * A status stub whose snapshot the spec can set, so a case can put the
 * in-memory lifecycle in ANY phase and assert what the catalog reports for the
 * k8s state observed beside it.
 */
const makeStatus = () => {
  const stub = {
    state: undefined as WorkspaceState | undefined,
    get(): WorkspaceState | undefined { return stub.state },
    list(): WorkspaceState[] { return stub.state === undefined ? [] : [stub.state] },
  }
  return stub
}

describe('WorkspaceManagement', () => {
  let root: string
  let ctrl: FakeController
  let reg: FakeRegistry
  let mgr: WorkspaceManagement
  let status: ReturnType<typeof makeStatus>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-ws-mgmt-'))
    ctrl = new FakeController()
    reg = new FakeRegistry()
    status = makeStatus()
    const metrics = new WorkspaceMetricsSampler({
      controller: ctrl,
      namespace: 'dsh',
      intervalMs: 0,
      limits: { cpu: '2', memory: '4Gi' },
    })
    mgr = new WorkspaceManagement({
      controller: ctrl,
      registry: reg,
      status,
      metrics,
      namespace: 'dsh',
      hostRoot: root,
      image: 'test-image:v1',
      storageClassName: 'standard',
      storageSize: '10Gi',
      resources: { cpu: '2', memory: '4Gi' },
      // Mirrors the wiring in src/index.ts: durable backing first, registry
      // record last (see tests/workspace-delete.spec.ts for the end-to-end
      // version over the real plugin).
      deleteWorkspace: async (id) => {
        ctrl.order.push(`pod:${id}`)
        await ctrl.deletePod('dsh', id)
        ctrl.order.push(`pvc:${id}`)
        await ctrl.deletePvc(id)
        await reg.delete(id)
      },
      ensureWorkspace: async (id) => { ctrl.pods.add(id); ctrl.pvcs.add(id + '-data'); return 'endpoint' },
      sleepWorkspace: async (id) => { await ctrl.deletePod('dsh', id) },
    })
  })

  it('creates a sanitized workspace anchor and registry entry', async () => {
    const entry = await mgr.create('My Test Workspace')
    expect(entry.workspaceId).toBe('my-test-workspace')
    expect(entry.path).toBe(`${root}/my-test-workspace`)
    expect(reg.rows.find((r) => r.workspaceId === 'my-test-workspace')).toBeDefined()
    const st = await import('node:fs/promises').then((m) => m.stat(`${root}/my-test-workspace`))
    expect(st.isDirectory()).toBe(true)
  })

  it('lists sleeping PVC-only workspaces as sleep', async () => {
    ctrl.pvcs.add('ws-sleep-data')
    const rows = await mgr.list()
    expect(rows.find((r) => r.workspaceId === 'ws-sleep')?.phase).toBe('sleep')
    expect(rows.find((r) => r.workspaceId === 'ws-sleep')?.hasPvc).toBe(true)
  })

  it('propagates the official native UUID from registry rows', async () => {
    reg.rows.push({
      workspaceId: 'git',
      path: `${root}/git`,
      title: 'git',
      internalId: 'a4a357de-0289-497a-ba19-ccdd18edf17e',
    })
    ctrl.pods.add('git')
    ctrl.pvcs.add('git-data')
    const rows = await mgr.list()
    const git = rows.find((r) => r.workspaceId === 'git')
    expect(git?.nativeWorkspaceId).toBe('a4a357de-0289-497a-ba19-ccdd18edf17e')
    // Pod/PVC-only rows (no registry record) keep nativeWorkspaceId undefined.
    ctrl.pods.add('ws-stale')
    const stale = (await mgr.list()).find((r) => r.workspaceId === 'ws-stale')
    expect(stale?.nativeWorkspaceId).toBeUndefined()
  })

  it('lists pod-only workspaces as orphan', async () => {
    ctrl.pods.add('ws-stale')
    const rows = await mgr.list()
    expect(rows.find((r) => r.workspaceId === 'ws-stale')?.phase).toBe('orphan')
  })

  it('delete removes the durable backing before the registry entry', async () => {
    reg.rows.push({ workspaceId: 'ws-del', path: `${root}/ws-del` })
    ctrl.pods.add('ws-del')
    ctrl.pvcs.add('ws-del-data')
    await mgr.delete('ws-del')
    expect(ctrl.deletedPods).toContain('ws-del')
    expect(ctrl.order).toEqual(['pod:ws-del', 'pvc:ws-del'])
    expect(reg.deleted).toContain('ws-del')
  })

  it('delete surfaces a failure instead of reporting success', async () => {
    reg.rows.push({ workspaceId: 'ws-stuck', path: `${root}/ws-stuck` })
    ctrl.pods.add('ws-stuck')
    ctrl.deletePvc = async () => { throw new Error('pvc is still in use') }
    await expect(mgr.delete('ws-stuck')).rejects.toThrow('pvc is still in use')
    // The record survives with the volume: dropping it here would only let the
    // reconciler read the volume back and re-register the workspace.
    expect(reg.deleted).toEqual([])
  })

  it('sleep keeps the PVC', async () => {
    reg.rows.push({ workspaceId: 'ws-sleep3', path: `${root}/ws-sleep3` })
    ctrl.pods.add('ws-sleep3')
    ctrl.pvcs.add('ws-sleep3-data')
    await mgr.sleep('ws-sleep3')
    expect(ctrl.deletedPods).toContain('ws-sleep3')
    expect(ctrl.pvcs.has('ws-sleep3-data')).toBe(true)
  })

  it('ensure wakes a sleeping workspace and populates pod/PVC state', async () => {
    reg.rows.push({ workspaceId: 'ws-sleep2', path: `${root}/ws-sleep2` })
    const entry = await mgr.ensure('ws-sleep2')
    expect(entry.hasPod).toBe(true)
    expect(entry.hasPvc).toBe(true)
    expect(ctrl.pods.has('ws-sleep2')).toBe(true)
  })

  it('cleanupOrphan deletes only the pod/service, not registry', async () => {
    reg.rows.push({ workspaceId: 'ws-orphan', path: `${root}/ws-orphan` })
    ctrl.pods.add('ws-orphan')
    await mgr.cleanupOrphan('ws-orphan')
    expect(ctrl.deletedPods).toContain('ws-orphan')
    expect(reg.deleted).toEqual([])
  })

  /**
   * The panel reads the catalog, and the catalog is the only place the
   * in-memory lifecycle and the observed cluster meet. The operator's report —
   * a workspace shown as 休眠 while it is usable — is exactly a disagreement
   * between those two, so these cases fix which one wins.
   */
  describe('phase against the observed cluster', () => {
    const state = (workspaceId: string, patch: Partial<WorkspaceState>): WorkspaceState =>
      ({ ...initialState(workspaceId), ...patch })
    const phaseOf = async (workspaceId: string): Promise<string | undefined> =>
      (await mgr.list()).find((row) => row.workspaceId === workspaceId)?.phase

    it('reports running while a pod exists, even if the tracked phase says sleep', async () => {
      // Woken by an on-demand `ensure` (an fs or subprocess operation), which
      // reaches the runtime directly and never told the state machine.
      status.state = state('ws-woken', { phase: 'sleep', provisioned: true })
      reg.rows.push({ workspaceId: 'ws-woken', path: `${root}/ws-woken` })
      ctrl.pods.add('ws-woken')
      ctrl.pvcs.add('ws-woken-data')

      expect(await phaseOf('ws-woken')).toBe('running')
    })

    it('reports sleep when the pod is gone, even if the tracked phase says running', async () => {
      status.state = state('ws-nopod', { phase: 'running', provisioned: true })
      reg.rows.push({ workspaceId: 'ws-nopod', path: `${root}/ws-nopod` })
      ctrl.pvcs.add('ws-nopod-data')

      expect(await phaseOf('ws-nopod')).toBe('sleep')
    })

    it('reports orphan when only a pod survived, whatever the tracked phase says', async () => {
      status.state = state('ws-orph', { phase: 'running', provisioned: true })
      reg.rows.push({ workspaceId: 'ws-orph', path: `${root}/ws-orph` })
      ctrl.pods.add('ws-orph')

      expect(await phaseOf('ws-orph')).toBe('orphan')
    })

    it('keeps an in-flight provision visible before its volume exists', async () => {
      // The k8s view LAGS an in-flight create (the PVC is being created right
      // now), so "no resources yet" must not overwrite it with sleep.
      status.state = state('ws-prov', { phase: 'provision' })
      reg.rows.push({ workspaceId: 'ws-prov', path: `${root}/ws-prov` })

      expect(await phaseOf('ws-prov')).toBe('provision')
    })

    it('keeps waking visible while the pod is still coming up', async () => {
      status.state = state('ws-waking', { phase: 'waking', provisioned: true })
      reg.rows.push({ workspaceId: 'ws-waking', path: `${root}/ws-waking` })
      ctrl.pvcs.add('ws-waking-data')

      expect(await phaseOf('ws-waking')).toBe('waking')
    })

    it('reports a deleted workspace as deleted once its resources are gone', async () => {
      status.state = state('ws-deleted', { phase: 'deleted', provisioned: true })
      reg.rows.push({ workspaceId: 'ws-deleted', path: `${root}/ws-deleted` })

      expect(await phaseOf('ws-deleted')).toBe('deleted')
    })
  })
})

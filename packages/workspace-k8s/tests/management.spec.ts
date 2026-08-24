import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManagement } from '../src/management.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { WorkspaceRegistry } from '../src/registry.ts'
import type { WorkspaceStatusService } from '../src/wire.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  deletedPods: string[] = []
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(_ns: string, workspaceId: string): Promise<void> { this.deletedPods.push(workspaceId); this.pods.delete(workspaceId) }
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
}

class FakeRegistry implements WorkspaceRegistry {
  rows: Array<{ workspaceId: string; path: string; title?: string }> = []
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

const makeStatus = (): WorkspaceStatusService => ({
  get: () => undefined,
  list: () => [],
})

describe('WorkspaceManagement', () => {
  let root: string
  let ctrl: FakeController
  let reg: FakeRegistry
  let mgr: WorkspaceManagement

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-ws-mgmt-'))
    ctrl = new FakeController()
    reg = new FakeRegistry()
    mgr = new WorkspaceManagement({
      controller: ctrl,
      registry: reg,
      status: makeStatus(),
      namespace: 'dsh',
      hostRoot: root,
      deleteWorkspace: async (id) => { await ctrl.deletePod('dsh', id) },
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

  it('lists pod-only workspaces as orphan', async () => {
    ctrl.pods.add('ws-stale')
    const rows = await mgr.list()
    expect(rows.find((r) => r.workspaceId === 'ws-stale')?.phase).toBe('orphan')
  })

  it('delete removes registry entry and pod', async () => {
    reg.rows.push({ workspaceId: 'ws-del', path: `${root}/ws-del` })
    ctrl.pods.add('ws-del')
    await mgr.delete('ws-del')
    expect(reg.deleted).toContain('ws-del')
    expect(ctrl.deletedPods).toContain('ws-del')
  })

  it('cleanupOrphan deletes only the pod/service, not registry', async () => {
    reg.rows.push({ workspaceId: 'ws-orphan', path: `${root}/ws-orphan` })
    ctrl.pods.add('ws-orphan')
    await mgr.cleanupOrphan('ws-orphan')
    expect(ctrl.deletedPods).toContain('ws-orphan')
    expect(reg.deleted).toEqual([])
  })
})

import { describe, expect, it, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceRuntimeService, type Config } from '../src/index.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

class MockController implements PodController {
  pods = new Set<string>()
  readyDelay = 0
  ensureCalls: WorkspacePodSpec[] = []
  failEnsure = false

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    this.ensureCalls.push(spec)
    if (this.failEnsure) throw new Error('k8s api error')
    const name = `${spec.workspaceId}`
    this.pods.add(name)
    return name
  }

  async deletePod(namespace: string, workspaceId: string): Promise<void> {
    // mirror the real controller: workspaceId -> pod name conversion happens here
    this.pods.delete(`${workspaceId}`)
  }

  async waitReady(namespace: string, name: string): Promise<void> {
    if (this.readyDelay > 0) await new Promise((res) => setTimeout(res, this.readyDelay))
    if (!this.pods.has(name)) throw new Error('pod missing')
  }

  endpoint(namespace: string, workspaceId: string, port: number): string {
    return `http://${workspaceId}-svc.${namespace}.svc.cluster.local:${port}`
  }

  async ensurePvc(workspaceId: string): Promise<string> {
    return `${workspaceId}-data`
  }

  async deletePvc(workspaceId: string): Promise<void> {
    // no-op in tests
  }
}

const config = (ctrl: MockController): Config => ({
  namespace: 'dsh',
  image: 'visecy/dsh-sandbox-daemon:test',
  controller: ctrl,
})

describe('WorkspaceRuntimeService', () => {
  let ctrl: MockController
  let rt: WorkspaceRuntimeService

  beforeEach(() => {
    ctrl = new MockController()
    rt = new WorkspaceRuntimeService(new Context(), config(ctrl))
  })

  it('ensures a pod and returns its endpoint', async () => {
    const ep = await rt.ensure('ws-1')
    expect(ep).toContain('ws-1-svc.dsh.svc.cluster.local:4390')
    expect(ctrl.pods.has('ws-1')).toBe(true)
    expect(ctrl.ensureCalls[0].image).toBe('visecy/dsh-sandbox-daemon:test')
    expect(ctrl.ensureCalls[0].daemonPort).toBe(4390)
    expect(rt.isRunning('ws-1')).toBe(true)
  })

  it('coalesces concurrent ensures into one pod creation', async () => {
    ctrl.readyDelay = 30
    const [a, b] = await Promise.all([rt.ensure('ws-2'), rt.ensure('ws-2')])
    expect(a).toBe(b)
    expect(ctrl.ensureCalls).toHaveLength(1)
  })

  it('dispose removes the pod and flips running state', async () => {
    await rt.ensure('ws-3')
    await rt.dispose('ws-3')
    expect(ctrl.pods.has('ws-3')).toBe(false)
    expect(rt.isRunning('ws-3')).toBe(false)
  })

  it('propagates pod creation failures', async () => {
    ctrl.failEnsure = true
    await expect(rt.ensure('ws-4')).rejects.toThrow('k8s api error')
    expect(rt.isRunning('ws-4')).toBe(false)
  })
})

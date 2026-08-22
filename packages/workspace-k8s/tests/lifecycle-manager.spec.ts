import { describe, expect, it, beforeEach } from 'vitest'
import { WorkspaceLifecycleManager } from '../src/lifecycle-manager.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

class FakeClock {
  private t = 1000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private nextId = 1

  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
    const due = [...this.timers.entries()].filter(([, v]) => v.at <= this.t).sort((a, b) => a[1].at - b[1].at)
    for (const [id, v] of due) {
      this.timers.delete(id)
      v.fn()
    }
  }
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout {
    const id = this.nextId++
    this.timers.set(id, { at: this.t + ms, fn })
    return { _id: id, unref: () => undefined } as unknown as NodeJS.Timeout
  }
  clearTimeout(t: NodeJS.Timeout): void {
    const id = (t as unknown as { _id?: number })._id
    if (id !== undefined) this.timers.delete(id)
  }
}

class MockController implements PodController {
  pods = new Set<string>()
  ensureCalls = 0
  deleteCalls: string[] = []

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    this.ensureCalls++
    const name = `${spec.workspaceId}`
    this.pods.add(name)
    return name
  }
  async deletePod(namespace: string, workspaceId: string): Promise<void> {
    this.deleteCalls.push(workspaceId)
    this.pods.delete(`${workspaceId}`)
  }
  async waitReady(): Promise<void> { /* instant */ }
  pvcs = new Set<string>()
  async ensurePvc(workspaceId: string): Promise<string> {
    const n = `${workspaceId}-data`
    this.pvcs.add(n)
    return n
  }
  async deletePvc(workspaceId: string): Promise<void> {
    this.pvcs.delete(`${workspaceId}-data`)
  }
  endpoint(): string { return 'http://daemon' }
}

describe('WorkspaceLifecycleManager', () => {
  let clock: FakeClock
  let ctrl: MockController
  let mgr: WorkspaceLifecycleManager

  beforeEach(() => {
    clock = new FakeClock()
    ctrl = new MockController()
    mgr = new WorkspaceLifecycleManager({
      controller: ctrl,
      namespace: 'dsh',
      image: 'img',
      idleTimeoutMs: 5 * 60 * 1000,
      graceMs: 3 * 60 * 60 * 1000,
      now: () => clock.now(),
      timer: clock,
    })
  })

  it('attach wakes a sleeping workspace through provision to running', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('running')
    expect(ctrl.pods.has('ws-1')).toBe(true)
  })

  it('session activity keeps it running; idle timeout sleeps it', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    mgr.handleSessionEvent('ws-1', { type: 'session-created' })
    mgr.handleSessionEvent('ws-1', { type: 'turn-started' })
    mgr.handleSessionEvent('ws-1', { type: 'session-disposed' }) // turn still open
    mgr.handleSessionEvent('ws-1', { type: 'turn-ended' })
    // now idle -> idle timer started
    expect(mgr.stateOf('ws-1')?.idleSince).toBeTypeOf('number')
    clock.advance(5 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('sleep')
    expect(ctrl.pods.has('ws-1')).toBe(false)
  })

  it('lingering commands use the 3h grace before sleeping', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    mgr.commandStarted('ws-1')
    mgr.handleSessionEvent('ws-1', { type: 'session-created' })
    mgr.handleSessionEvent('ws-1', { type: 'session-disposed' })
    // idle + command -> grace timer
    expect(mgr.stateOf('ws-1')?.activeCommands).toBe(1)
    clock.advance(5 * 60 * 1000) // idle timeout is NOT enough while a command lingers
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('running')
    clock.advance(3 * 60 * 60 * 1000 - 5 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('sleep')
    expect(ctrl.pods.has('ws-1')).toBe(false)
  })

  it('user returns during grace cancels sleep', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    mgr.commandStarted('ws-1')
    mgr.handleSessionEvent('ws-1', { type: 'session-created' })
    mgr.handleSessionEvent('ws-1', { type: 'session-disposed' })
    // idle + command -> grace running
    clock.advance(2 * 60 * 60 * 1000)
    mgr.attach('ws-1') // user returns
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('running')
    clock.advance(3 * 60 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('running') // timer was cancelled
  })

  it('delete removes the pod and reaches deleted', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    mgr.delete('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('deleted')
    expect(ctrl.deleteCalls).toContain('ws-1')
  })

  it('pod-lost triggers automatic re-ensure', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.pods.delete('ws-1')
    mgr.podLost('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    expect(ctrl.pods.has('ws-1')).toBe(true)
    expect(mgr.stateOf('ws-1')?.phase).toBe('running')
  })

  it('idle timer does not fire while a session is active', async () => {
    mgr.attach('ws-1')
    await new Promise((r) => setTimeout(r, 10))
    mgr.handleSessionEvent('ws-1', { type: 'session-created' })
    clock.advance(5 * 60 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-1')?.phase).toBe('running') // active, not slept
  })

  it('sleep keeps the PVC; delete removes pod and PVC', async () => {
    mgr.attach('ws-pvc')
    await new Promise((r) => setTimeout(r, 10))
    expect(ctrl.pvcs.has('ws-pvc-data')).toBe(true)
    // idle -> idle timeout -> sleep keeps PVC
    mgr.handleSessionEvent('ws-pvc', { type: 'session-created' })
    mgr.handleSessionEvent('ws-pvc', { type: 'session-disposed' })
    clock.advance(5 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-pvc')?.phase).toBe('sleep')
    expect(ctrl.pvcs.has('ws-pvc-data')).toBe(true)
    // explicit delete removes PVC too
    mgr.delete('ws-pvc')
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-pvc')?.phase).toBe('deleted')
    expect(ctrl.pvcs.has('ws-pvc-data')).toBe(false)
  })
})

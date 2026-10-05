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
  /** The image each running pod carries, as a real cluster read would report. */
  images = new Map<string, string>()
  /** Deferred image reads, to model a pod listing that is still in flight. */
  imageGate: (() => Promise<void>) | undefined

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    this.ensureCalls++
    const name = `${spec.workspaceId}`
    this.pods.add(name)
    this.images.set(name, spec.image)
    return name
  }
  async deletePod(namespace: string, workspaceId: string): Promise<void> {
    this.deleteCalls.push(workspaceId)
    this.pods.delete(`${workspaceId}`)
    this.images.delete(workspaceId)
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
  async listPods(): Promise<string[]> { return [...this.pods] }
  async getPodImage(_namespace: string, name: string): Promise<string | undefined> {
    if (this.imageGate !== undefined) await this.imageGate()
    return this.images.get(name)
  }
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

  it('sleep on an untracked workspace seeds running and disposes the pod', async () => {
    mgr.sleep('ws-untracked')
    expect(mgr.stateOf('ws-untracked')?.phase).toBe('sleep')
    expect(mgr.stateOf('ws-untracked')?.sleepCount).toBe(1)
    expect(ctrl.deleteCalls).toContain('ws-untracked')
  })

  it('attach on an untracked workspace seeds provisioned and wakes through waking', async () => {
    mgr.attach('ws-untracked2')
    expect(mgr.stateOf('ws-untracked2')?.phase).toBe('waking')
    expect(mgr.stateOf('ws-untracked2')?.provisioned).toBe(true)
  })

  // ── pod image drift ──────────────────────────────────────────────────────
  // A deployment that changes WS_IMAGE keeps every existing pod on the old
  // daemon forever: the pod spec is only applied when a pod is CREATED, and a
  // running workspace never needs creating. The lifecycle manager is the owner
  // of pod lifetime, so it converges the fleet — without killing work.

  it('recycles an idle pod whose image differs from the configured one', async () => {
    mgr.attach('ws-drift')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.images.set('ws-drift', 'old-daemon:v0.1.54')
    ctrl.deleteCalls.length = 0

    await mgr.reconcileImages()

    expect(ctrl.deleteCalls).toEqual(['ws-drift'])
    expect(mgr.stateOf('ws-drift')?.phase).toBe('sleep')
    // The PVC is the workspace's data: a recycle is not a delete.
    expect(ctrl.pvcs.has('ws-drift-data')).toBe(true)
    const events = mgr.stateOf('ws-drift')?.events.map((e) => e.type) ?? []
    expect(events).toContain('image-drift')
    expect(events).toContain('pod-recycled')
  })

  it('leaves a pod that already runs the configured image alone', async () => {
    mgr.attach('ws-current')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.deleteCalls.length = 0

    await mgr.reconcileImages()

    expect(ctrl.deleteCalls).toEqual([])
    expect(mgr.stateOf('ws-current')?.phase).toBe('running')
  })

  it('marks a busy drifted pod and recycles it when it goes idle', async () => {
    mgr.attach('ws-busy')
    await new Promise((r) => setTimeout(r, 10))
    mgr.handleSessionEvent('ws-busy', { type: 'session-created' })
    ctrl.images.set('ws-busy', 'old-daemon:v0.1.54')
    ctrl.deleteCalls.length = 0

    await mgr.reconcileImages()
    // A live session means work may be in flight: never kill it.
    expect(ctrl.deleteCalls).toEqual([])
    expect(ctrl.pods.has('ws-busy')).toBe(true)
    expect(mgr.stateOf('ws-busy')?.recyclePending).toBe(true)
    expect(mgr.stateOf('ws-busy')?.phase).toBe('running')

    // The session ends: the workspace is idle now, so the pending recycle runs.
    mgr.handleSessionEvent('ws-busy', { type: 'session-disposed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(ctrl.deleteCalls).toEqual(['ws-busy'])
    expect(mgr.stateOf('ws-busy')?.phase).toBe('sleep')
    expect(mgr.stateOf('ws-busy')?.recyclePending).toBe(false)
  })

  it('does not repeat the drift event while the condition persists', async () => {
    mgr.attach('ws-repeat')
    await new Promise((r) => setTimeout(r, 10))
    mgr.handleSessionEvent('ws-repeat', { type: 'session-created' })
    ctrl.images.set('ws-repeat', 'old-daemon:v0.1.54')

    await mgr.reconcileImages()
    await mgr.reconcileImages()
    await mgr.reconcileImages()

    const drifts = (mgr.stateOf('ws-repeat')?.events ?? []).filter((e) => e.type === 'image-drift')
    expect(drifts).toHaveLength(1)
  })

  it('does not recycle while an ensure for the same workspace is in flight', async () => {
    mgr.attach('ws-ensuring')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.images.set('ws-ensuring', 'old-daemon:v0.1.54')
    ctrl.deleteCalls.length = 0

    const busy = new WorkspaceLifecycleManager({
      controller: ctrl,
      namespace: 'dsh',
      image: 'img',
      now: () => clock.now(),
      timer: clock,
      isEnsuring: (id) => id === 'ws-ensuring',
    })
    await busy.reconcileImages()
    expect(ctrl.deleteCalls).toEqual([])
    expect(ctrl.pods.has('ws-ensuring')).toBe(true)
  })

  it('runs one image pass at a time', async () => {
    mgr.attach('ws-once')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.images.set('ws-once', 'old-daemon:v0.1.54')
    ctrl.deleteCalls.length = 0
    let release = (): void => {}
    ctrl.imageGate = () => new Promise<void>((resolve) => { release = resolve })

    const first = mgr.reconcileImages()
    const second = mgr.reconcileImages()
    // Let the first pass reach the (gated) image read before releasing it.
    await new Promise((r) => setTimeout(r, 5))
    release()
    await Promise.all([first, second])

    expect(ctrl.deleteCalls).toEqual(['ws-once'])
  })

  it('a wake after a recycle provisions the configured image', async () => {
    mgr.attach('ws-rewake')
    await new Promise((r) => setTimeout(r, 10))
    ctrl.images.set('ws-rewake', 'old-daemon:v0.1.54')
    await mgr.reconcileImages()
    expect(mgr.stateOf('ws-rewake')?.phase).toBe('sleep')

    mgr.attach('ws-rewake')
    await new Promise((r) => setTimeout(r, 10))
    expect(mgr.stateOf('ws-rewake')?.phase).toBe('running')
    expect(ctrl.images.get('ws-rewake')).toBe('img')
  })
})

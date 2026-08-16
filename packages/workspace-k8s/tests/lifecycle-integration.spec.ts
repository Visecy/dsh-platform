import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { WorkspaceLifecycleManager } from '../src/lifecycle-manager.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

class FakeClock {
  private t = 1000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private nextId = 1
  now(): number { return this.t }
  advance(ms: number): void {
    this.t += ms
    const due = [...this.timers.entries()].filter(([, v]) => v.at <= this.t).sort((a, b) => a[1].at - b[1].at)
    for (const [id, v] of due) { this.timers.delete(id); v.fn() }
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

class EndpointController implements PodController {
  pods = new Set<string>()
  deleted: string[] = []
  constructor(private daemonUrl: string) {}
  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    const n = `dsh-ws-${spec.workspaceId}`
    this.pods.add(n)
    return n
  }
  async deletePod(_ns: string, workspaceId: string): Promise<void> {
    this.deleted.push(workspaceId)
    this.pods.delete(`dsh-ws-${workspaceId}`)
  }
  async waitReady(): Promise<void> {}
  endpoint(): string { return this.daemonUrl }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
}

describe('lifecycle integration with real daemon', () => {
  let root: string
  let server: import('node:http').Server
  let url: string

  beforeAll(async () => {
    root = await mkdtemp(join(process.cwd(), '.tmp-lcint-'))
    const s = await startDaemon({ root, port: 0, commandTimeoutMs: 30_000 })
    server = s.server
    url = s.baseUrl
  })
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()))
    await rm(root, { recursive: true, force: true })
  })

  it('grace expiry drains long-running commands then deletes the pod', async () => {
    const clock = new FakeClock()
    const ctrl = new EndpointController(url)
    const drained: string[] = []
    const mgr = new WorkspaceLifecycleManager({
      controller: ctrl,
      namespace: 'dsh',
      image: 'img',
      graceMs: 3 * 60 * 60 * 1000,
      now: () => clock.now(),
      timer: clock,
      onBeforeSleep: async (ep) => {
        drained.push(ep)
        await fetch(ep + '/commands/terminate-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ graceMs: 300 }) })
      },
    })

    // start a long-running command directly in the daemon (as if a session did)
    const runRes = await fetch(url + '/commands/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { argv: ['sleep', '30'], cwd: root } }),
    })
    const { cmdId } = (await runRes.json()).data

    mgr.attach('ws-int')
    await new Promise((r) => setTimeout(r, 10))
    mgr.handleSessionEvent('ws-int', { type: 'session-created' })
    mgr.handleSessionEvent('ws-int', { type: 'session-disposed' })
    clock.advance(3 * 60 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 800))

    expect(mgr.stateOf('ws-int')?.phase).toBe('sleep')
    expect(drained).toContain(url)
    expect(ctrl.deleted).toContain('ws-int')
    // the long-running command was force-terminated
    const st = await fetch(url + `/commands/${cmdId}/status`).then((r) => r.json())
    expect(['killed', 'exited']).toContain(st.data.status.phase)
  })
})

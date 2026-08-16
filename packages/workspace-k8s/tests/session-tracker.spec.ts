import { describe, expect, it } from 'vitest'
import { SessionTracker, type SessionActivitySource } from '../src/session-tracker.ts'
import type { WorkspaceEvent } from '../src/state-machine.ts'

class FakeSource implements SessionActivitySource {
  private cbs: Record<string, (sessionId: string, cwd?: string) => void> = {}
  onSessionCreated(cb: (sessionId: string, cwd?: string) => void): void { this.cbs.created = cb }
  onSessionDisposed(cb: (sessionId: string) => void): void { this.cbs.disposed = cb }
  onTurnStarted(cb: (sessionId: string) => void): void { this.cbs.turnStarted = cb }
  onTurnEnded(cb: (sessionId: string) => void): void { this.cbs.turnEnded = cb }
  created(s: string, cwd?: string): void { this.cbs.created(s, cwd) }
  disposed(s: string): void { this.cbs.disposed(s) }
  turnStart(s: string): void { this.cbs.turnStarted(s) }
  turnEnd(s: string): void { this.cbs.turnEnded(s) }
}

describe('SessionTracker', () => {
  it('maps session cwd to workspace and emits events', () => {
    const src = new FakeSource()
    const events: Array<[string, WorkspaceEvent]> = []
    const t = new SessionTracker(src, (ws, e) => events.push([ws, e]))

    src.created('s1', '/workspaces/ws-a')
    src.created('s2', '/workspaces/ws-b')
    src.turnStart('s1')

    expect(events).toEqual([
      ['ws-a', { type: 'session-created' }],
      ['ws-b', { type: 'session-created' }],
      ['ws-a', { type: 'turn-started' }],
    ])
    expect(t.snapshot('ws-a')).toEqual({ workspaceId: 'ws-a', activeSessions: 1, openTurns: 1 })
    expect(t.snapshot('ws-b')).toEqual({ workspaceId: 'ws-b', activeSessions: 1, openTurns: 0 })
  })

  it('ignores sessions without a workspace cwd', () => {
    const src = new FakeSource()
    const events: Array<[string, WorkspaceEvent]> = []
    const t = new SessionTracker(src, (ws, e) => events.push([ws, e]))
    src.created('s-plain', '/home/user/project')
    src.turnStart('s-plain')
    expect(events).toEqual([])
    expect(t.snapshot('anything')).toBeUndefined()
  })

  it('tracks multiple sessions per workspace', () => {
    const src = new FakeSource()
    const events: Array<[string, WorkspaceEvent]> = []
    const t = new SessionTracker(src, (ws, e) => events.push([ws, e]))
    src.created('s1', '/workspaces/ws-x')
    src.created('s2', '/workspaces/ws-x')
    expect(t.snapshot('ws-x')?.activeSessions).toBe(2)
    src.disposed('s1')
    expect(t.snapshot('ws-x')?.activeSessions).toBe(1)
  })

  it('turns end with their session on disposal', () => {
    const src = new FakeSource()
    const events: Array<[string, WorkspaceEvent]> = []
    const t = new SessionTracker(src, (ws, e) => events.push([ws, e]))
    src.created('s1', '/workspaces/ws-y')
    src.turnStart('s1')
    src.disposed('s1')
    expect(t.snapshot('ws-y')).toEqual({ workspaceId: 'ws-y', activeSessions: 0, openTurns: 0 })
    expect(events).toContainEqual(['ws-y', { type: 'turn-ended' }])
    expect(events).toContainEqual(['ws-y', { type: 'session-disposed' }])
  })

  it('workspaceOf extracts id from cwd', () => {
    expect(SessionTracker.workspaceOf('/workspaces/ws-42')).toBe('ws-42')
    expect(SessionTracker.workspaceOf('/workspaces/ws-42/sub/dir')).toBe('ws-42')
    expect(SessionTracker.workspaceOf('/home/x')).toBeUndefined()
    expect(SessionTracker.workspaceOf(undefined)).toBeUndefined()
  })
})

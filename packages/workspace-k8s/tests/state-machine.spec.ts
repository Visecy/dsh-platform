import { describe, expect, it } from 'vitest'
import { initialState, transition, type WorkspaceState } from '../src/state-machine.ts'

const ws = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({ ...initialState('ws-1'), ...over })

describe('state machine', () => {
  it('sleep + user-attach -> provision with ensure (first creation)', () => {
    const t = transition(ws(), { type: 'user-attach' })
    expect(t.state.phase).toBe('provision')
    expect(t.state.provisioned).toBe(false)
    expect(t.action).toEqual({ kind: 'ensure' })
    expect(t.state.events.at(-1)?.type).toBe('provision-started')
  })

  it('sleep + user-attach after provision -> waking with ensure', () => {
    const t = transition(ws({ provisioned: true }), { type: 'user-attach' })
    expect(t.state.phase).toBe('waking')
    expect(t.action).toEqual({ kind: 'ensure' })
    expect(t.state.events.at(-1)?.type).toBe('waking-started')
  })

  it('sleep + session-created after provision -> waking', () => {
    const t = transition(ws({ provisioned: true }), { type: 'session-created' })
    expect(t.state.phase).toBe('waking')
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('sleep + ensure-requested -> provision (unprovisioned) / waking (provisioned)', () => {
    expect(transition(ws(), { type: 'ensure-requested' }).state.phase).toBe('provision')
    expect(transition(ws({ provisioned: true }), { type: 'ensure-requested' }).state.phase).toBe('waking')
  })

  it('provision + pod-ready -> running (active), provisioned set', () => {
    const t = transition(ws({ phase: 'provision', activeSessions: 1 }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.state.provisioned).toBe(true)
    expect(t.state.lastWakeAt).toBeTypeOf('number')
    expect(t.action).toEqual({ kind: 'none' })
    expect(t.state.idleSince).toBeUndefined()
    expect(t.state.events.at(-1)?.type).toBe('pod-ready')
  })

  it('provision + pod-ready with no activity starts idle timer', () => {
    const t = transition(ws({ phase: 'provision' }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'start-idle' })
    expect(t.state.idleSince).toBeTypeOf('number')
  })

  it('provision + pod-ready with lingering commands starts grace timer', () => {
    const t = transition(ws({ phase: 'provision', activeCommands: 1 }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'start-grace' })
  })

  it('waking + pod-ready -> running and increments wakeCount', () => {
    const t = transition(ws({ phase: 'waking', provisioned: true }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.state.wakeCount).toBe(1)
    expect(t.state.lastWakeAt).toBeTypeOf('number')
    expect(t.state.events.at(-1)?.type).toBe('pod-ready')
  })

  it('waking + pod-lost -> ensure (retry, stays waking)', () => {
    const t = transition(ws({ phase: 'waking', provisioned: true }), { type: 'pod-lost' })
    expect(t.state.phase).toBe('waking')
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('running + session-created cancels timers', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100 }), { type: 'session-created' })
    expect(t.state.idleSince).toBeUndefined()
    expect(t.action).toEqual({ kind: 'cancel-timers' })
  })

  it('running + session-disposed to zero starts idle timer', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1 }), { type: 'session-disposed' })
    expect(t.state.phase).toBe('running')
    expect(t.state.idleSince).toBeTypeOf('number')
    expect(t.action).toEqual({ kind: 'start-idle' })
    expect(t.state.events.at(-1)?.type).toBe('idle-started')
  })

  it('running + session-disposed to zero with lingering commands starts grace timer', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1, activeCommands: 2 }), { type: 'session-disposed' })
    expect(t.state.phase).toBe('running')
    expect(t.state.idleSince).toBeTypeOf('number')
    expect(t.action).toEqual({ kind: 'start-grace' })
    expect(t.state.events.at(-1)?.type).toBe('grace-started')
  })

  it('running + idle-expired -> sleep with dispose, counters and event', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100 }), { type: 'idle-expired' })
    expect(t.state.phase).toBe('sleep')
    expect(t.state.idleSince).toBeUndefined()
    expect(t.state.sleepCount).toBe(1)
    expect(t.state.lastSleepAt).toBeTypeOf('number')
    expect(t.action).toEqual({ kind: 'dispose' })
    expect(t.state.events.at(-1)?.type).toBe('sleep')
  })

  it('running + grace-expired while commands remain -> sleep with dispose', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100, activeCommands: 1 }), { type: 'grace-expired' })
    expect(t.state.phase).toBe('sleep')
    expect(t.state.idleSince).toBeUndefined()
    expect(t.state.sleepCount).toBe(1)
    expect(t.action).toEqual({ kind: 'dispose' })
  })

  it('running + grace-expired while active is ignored', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1 }), { type: 'grace-expired' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'none' })
  })

  it('running + idle-expired while active is ignored', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1 }), { type: 'idle-expired' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'none' })
  })

  it('command-started while idle switches idle timer to grace', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100, activeCommands: 0 }), { type: 'command-started' })
    expect(t.state.activeCommands).toBe(1)
    expect(t.action).toEqual({ kind: 'start-grace' })
  })

  it('command-ended while idle switches grace timer to idle', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100, activeCommands: 1 }), { type: 'command-ended' })
    expect(t.state.activeCommands).toBe(0)
    expect(t.action).toEqual({ kind: 'start-idle' })
  })

  it('running + pod-lost -> ensure (auto-rebuild)', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 2 }), { type: 'pod-lost' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('provision + pod-lost -> ensure (retry)', () => {
    const t = transition(ws({ phase: 'provision' }), { type: 'pod-lost' })
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('dispose-requested from any phase -> deleted with delete action', () => {
    for (const phase of ['provision', 'waking', 'running', 'sleep'] as const) {
      const t = transition(ws({ phase, activeSessions: 3 }), { type: 'dispose-requested' })
      expect(t.state.phase).toBe('deleted')
      expect(t.action).toEqual({ kind: 'delete' })
      expect(t.state.events.at(-1)?.type).toBe('deleted')
    }
  })

  it('deleted is terminal', () => {
    const t = transition(ws({ phase: 'deleted' }), { type: 'user-attach' })
    expect(t.state.phase).toBe('deleted')
    expect(t.action).toEqual({ kind: 'none' })
  })

  it('turn counters drive idle state', () => {
    // session alive with open turn -> not idle even after session-disposed (turn open)
    let st = ws({ phase: 'running', activeSessions: 1 })
    st = transition(st, { type: 'turn-started' }).state
    st = transition(st, { type: 'session-disposed' }).state
    expect(st.activeSessions).toBe(0)
    expect(st.openTurns).toBe(1)
    expect(st.idleSince).toBeUndefined() // open turn keeps it active
    const ended = transition(st, { type: 'turn-ended' })
    st = ended.state
    expect(st.idleSince).toBeTypeOf('number') // now idle -> idle timer (no commands)
    expect(ended.action).toEqual({ kind: 'start-idle' })
  })

  it('event log is bounded', () => {
    let st = initialState('ws-1')
    for (let i = 0; i < 120; i++) {
      st = transition(st, { type: 'user-attach' }).state
      st = transition(st, { type: 'pod-ready' }).state
      st = transition(st, { type: 'session-created' }).state
      st = transition(st, { type: 'session-disposed' }).state
    }
    expect(st.events.length).toBeLessThanOrEqual(50)
  })
})

import { describe, expect, it } from 'vitest'
import { initialState, transition, type WorkspaceState } from '../src/state-machine.ts'

const ws = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({ ...initialState('ws-1'), ...over })

describe('state machine', () => {
  it('sleep + user-attach -> provision with ensure', () => {
    const t = transition(ws(), { type: 'user-attach' })
    expect(t.state.phase).toBe('provision')
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('sleep + session-created -> provision with ensure', () => {
    const t = transition(ws(), { type: 'session-created' })
    expect(t.state.phase).toBe('provision')
    expect(t.action).toEqual({ kind: 'ensure' })
  })

  it('provision + pod-ready -> running (active)', () => {
    const t = transition(ws({ phase: 'provision', activeSessions: 1 }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'none' })
    expect(t.state.idleSince).toBeUndefined()
  })

  it('provision + pod-ready with no activity starts grace', () => {
    const t = transition(ws({ phase: 'provision' }), { type: 'pod-ready' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'start-grace' })
    expect(t.state.idleSince).toBeTypeOf('number')
  })

  it('running + session-created cancels grace', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100 }), { type: 'session-created' })
    expect(t.state.idleSince).toBeUndefined()
    expect(t.action).toEqual({ kind: 'cancel-grace' })
  })

  it('running + session-disposed to zero starts grace', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1 }), { type: 'session-disposed' })
    expect(t.state.phase).toBe('running')
    expect(t.state.idleSince).toBeTypeOf('number')
    expect(t.action).toEqual({ kind: 'start-grace' })
  })

  it('running + grace-expired -> sleep with dispose', () => {
    const t = transition(ws({ phase: 'running', idleSince: 100 }), { type: 'grace-expired' })
    expect(t.state.phase).toBe('sleep')
    expect(t.state.idleSince).toBeUndefined()
    expect(t.action).toEqual({ kind: 'dispose' })
  })

  it('running + grace-expired while active is ignored', () => {
    const t = transition(ws({ phase: 'running', activeSessions: 1 }), { type: 'grace-expired' })
    expect(t.state.phase).toBe('running')
    expect(t.action).toEqual({ kind: 'none' })
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

  it('sleep + ensure-requested -> provision', () => {
    const t = transition(ws(), { type: 'ensure-requested' })
    expect(t.state.phase).toBe('provision')
  })

  it('dispose-requested from any phase -> deleted with delete action', () => {
    for (const phase of ['provision', 'running', 'sleep'] as const) {
      const t = transition(ws({ phase, activeSessions: 3 }), { type: 'dispose-requested' })
      expect(t.state.phase).toBe('deleted')
      expect(t.action).toEqual({ kind: 'delete' })
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
    st = transition(st, { type: 'turn-ended' }).state
    expect(st.idleSince).toBeTypeOf('number') // now idle -> grace
  })
})

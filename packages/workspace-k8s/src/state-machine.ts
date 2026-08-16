/**
 * Workspace lifecycle state machine (pure logic, no I/O).
 *
 * States: provision -> running <-> sleep -> deleted
 * Idle rule (confirmed): a workspace is idle when it has no live sessions AND
 * no open agent turns. Once idle, a workspace-level 3h grace timer runs (one
 * timer per workspace, NOT per command/session); if the user returns before
 * it fires, the timer is cancelled. On expiry the workspace sleeps.
 */
export type WorkspacePhase = 'provision' | 'running' | 'sleep' | 'deleted'

export interface WorkspaceState {
  workspaceId: string
  phase: WorkspacePhase
  /** Live sessions bound to this workspace (via cwd). */
  activeSessions: number
  /** Sessions with an open agent turn. */
  openTurns: number
  /** Timestamp when the workspace became idle (3h grace start), undefined while active. */
  idleSince?: number
  lastTransitionAt: number
}

export type WorkspaceEvent =
  | { type: 'session-created' }
  | { type: 'session-disposed' }
  | { type: 'turn-started' }
  | { type: 'turn-ended' }
  | { type: 'user-attach' }
  | { type: 'ensure-requested' }
  | { type: 'grace-expired' }
  | { type: 'pod-ready' }
  | { type: 'pod-lost' }
  | { type: 'dispose-requested' }

export type WorkspaceAction =
  | { kind: 'none' }
  | { kind: 'ensure' }
  /** Sleep: delete the pod, KEEP the PVC. */
  | { kind: 'dispose' }
  /** Workspace deletion: delete the pod AND the PVC. */
  | { kind: 'delete' }
  | { kind: 'start-grace' }
  | { kind: 'cancel-grace' }

export interface Transition {
  state: WorkspaceState
  action: WorkspaceAction
}

const now = (): number => Date.now()

export function initialState(workspaceId: string): WorkspaceState {
  return {
    workspaceId,
    phase: 'sleep',
    activeSessions: 0,
    openTurns: 0,
    lastTransitionAt: now(),
  }
}

/**
 * Pure transition function: given the current state and one event, return the
 * next state plus the action the orchestrator must perform.
 */
export function transition(state: WorkspaceState, event: WorkspaceEvent): Transition {
  const s = { ...state, lastTransitionAt: now() }

  // ── counters ────────────────────────────────────────────────────────────
  if (event.type === 'session-created') s.activeSessions += 1
  if (event.type === 'session-disposed') s.activeSessions = Math.max(0, s.activeSessions - 1)
  if (event.type === 'turn-started') s.openTurns += 1
  if (event.type === 'turn-ended') s.openTurns = Math.max(0, s.openTurns - 1)

  const idle = s.activeSessions === 0 && s.openTurns === 0

  // ── termination (from anywhere) ─────────────────────────────────────────
  if (event.type === 'dispose-requested') {
    s.phase = 'deleted'
    s.idleSince = undefined
    return { state: s, action: { kind: 'delete' } }
  }

  switch (s.phase) {
    case 'provision': {
      if (event.type === 'pod-ready') {
        s.phase = 'running'
        if (idle) {
          s.idleSince = now()
          return { state: s, action: { kind: 'start-grace' } }
        }
        return { state: s, action: { kind: 'none' } }
      }
      if (event.type === 'pod-lost') {
        return { state: s, action: { kind: 'ensure' } }
      }
      return { state: s, action: { kind: 'none' } }
    }

    case 'running': {
      if (event.type === 'pod-lost') {
        return { state: s, action: { kind: 'ensure' } }
      }
      if (event.type === 'user-attach' && s.idleSince !== undefined) {
        s.idleSince = undefined
        return { state: s, action: { kind: 'cancel-grace' } }
      }
      if (event.type === 'grace-expired' && idle) {
        s.phase = 'sleep'
        s.idleSince = undefined
        return { state: s, action: { kind: 'dispose' } }
      }
      if (idle && s.idleSince === undefined) {
        s.idleSince = now()
        return { state: s, action: { kind: 'start-grace' } }
      }
      if (!idle && s.idleSince !== undefined) {
        s.idleSince = undefined
        return { state: s, action: { kind: 'cancel-grace' } }
      }
      return { state: s, action: { kind: 'none' } }
    }

    case 'sleep': {
      if (event.type === 'user-attach' || event.type === 'ensure-requested' || event.type === 'session-created') {
        s.phase = 'provision'
        s.idleSince = undefined
        return { state: s, action: { kind: 'ensure' } }
      }
      return { state: s, action: { kind: 'none' } }
    }

    case 'deleted': {
      return { state: s, action: { kind: 'none' } }
    }
  }
}

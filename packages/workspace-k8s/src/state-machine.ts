/**
 * Workspace lifecycle state machine (pure logic, no I/O).
 *
 * States: provision -> running <-> sleep -> deleted
 * Idle rule (confirmed): a workspace is idle when it has no live sessions AND
 * no open agent turns. Once idle:
 *   - without lingering commands => idle timer (default 5min) then sleep.
 *   - with lingering commands   => workspace grace timer (default 3h) then
 *     force-terminate commands and sleep.
 * There is one timer per workspace, NOT per command/session. Returning before
 * the timer fires cancels it.
 */
export type WorkspacePhase = 'provision' | 'running' | 'sleep' | 'deleted'

export interface WorkspaceState {
  workspaceId: string
  phase: WorkspacePhase
  /** Live sessions bound to this workspace (via cwd). */
  activeSessions: number
  /** Sessions with an open agent turn. */
  openTurns: number
  /** Background/lingering commands running in the workspace pod. */
  activeCommands: number
  /** Timestamp when the workspace became idle (timer start), undefined while active. */
  idleSince?: number
  lastTransitionAt: number
}

export type WorkspaceEvent =
  | { type: 'session-created' }
  | { type: 'session-disposed' }
  | { type: 'turn-started' }
  | { type: 'turn-ended' }
  | { type: 'command-started' }
  | { type: 'command-ended' }
  | { type: 'user-attach' }
  | { type: 'ensure-requested' }
  | { type: 'idle-expired' }
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
  /** Schedule the 5-minute idle timer (clears any grace timer). */
  | { kind: 'start-idle' }
  /** Schedule the 3-hour lingering-command grace timer (clears any idle timer). */
  | { kind: 'start-grace' }
  | { kind: 'cancel-idle' }
  | { kind: 'cancel-grace' }
  | { kind: 'cancel-timers' }

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
    activeCommands: 0,
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
  if (event.type === 'command-started') s.activeCommands += 1
  if (event.type === 'command-ended') s.activeCommands = Math.max(0, s.activeCommands - 1)

  const idle = s.activeSessions === 0 && s.openTurns === 0
  const hasCommands = s.activeCommands > 0

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
          return { state: s, action: hasCommands ? { kind: 'start-grace' } : { kind: 'start-idle' } }
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
        return { state: s, action: { kind: 'cancel-timers' } }
      }

      if (event.type === 'idle-expired' && idle && !hasCommands) {
        s.phase = 'sleep'
        s.idleSince = undefined
        s.activeCommands = 0
        return { state: s, action: { kind: 'dispose' } }
      }
      if (event.type === 'grace-expired' && idle) {
        s.phase = 'sleep'
        s.idleSince = undefined
        s.activeCommands = 0 // drain/force-terminate before pod deletion
        return { state: s, action: { kind: 'dispose' } }
      }

      // Command count changed while idle: switch timer type without waiting
      // for the previous timer to fire.
      if (idle && s.idleSince !== undefined && event.type === 'command-started' && hasCommands) {
        s.idleSince = now()
        return { state: s, action: { kind: 'start-grace' } }
      }
      if (idle && s.idleSince !== undefined && event.type === 'command-ended' && !hasCommands) {
        s.idleSince = now()
        return { state: s, action: { kind: 'start-idle' } }
      }

      if (idle && s.idleSince === undefined) {
        s.idleSince = now()
        return { state: s, action: hasCommands ? { kind: 'start-grace' } : { kind: 'start-idle' } }
      }
      if (!idle && s.idleSince !== undefined) {
        s.idleSince = undefined
        return { state: s, action: { kind: 'cancel-timers' } }
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

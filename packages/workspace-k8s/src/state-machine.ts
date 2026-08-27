/**
 * Workspace lifecycle state machine (pure logic, no I/O).
 *
 * States: provision -> running <-> sleep -> deleted, plus a waking state for
 * SLEEP -> RUNNING pod pulls (PROVISION is first creation: PVC + Pod; WAKING
 * is a later pull with the PVC already present).
 *
 * Idle rule (confirmed): a workspace is idle when it has no live sessions AND
 * no open agent turns. Once idle:
 *   - without lingering commands => idle timer (default 5min) then sleep.
 *   - with lingering commands   => workspace grace timer (default 3h) then
 *     force-terminate commands and sleep.
 * There is one timer per workspace, NOT per command/session. Returning before
 * the timer fires cancels it.
 *
 * The state also carries a bounded event log (type codes; display text is the
 * catalog layer's job), wake/sleep counters, and timestamps for the status UI.
 */
export type WorkspacePhase = 'provision' | 'waking' | 'running' | 'sleep' | 'deleted'

/** One lifecycle event log entry (type code + timestamp). */
export interface WorkspaceEventLogEntry {
  at: number
  type: string
}

export interface WorkspaceState {
  workspaceId: string
  phase: WorkspacePhase
  /** False until the first provision completes (PVC exists). Sleep before
   *  that goes to provision on attach; afterwards to waking. */
  provisioned: boolean
  /** Live sessions bound to this workspace (via cwd). */
  activeSessions: number
  /** Sessions with an open agent turn. */
  openTurns: number
  /** Background/lingering commands running in the workspace pod. */
  activeCommands: number
  /** Timestamp when the workspace became idle (timer start), undefined while active. */
  idleSince?: number
  lastTransitionAt: number
  /** Last time the pod was put to sleep. */
  lastSleepAt?: number
  /** Last time the pod became ready (uptime anchor). */
  lastWakeAt?: number
  /** How many times the workspace has been woken / slept. */
  wakeCount: number
  sleepCount: number
  /** Workspace creation instant (first state creation). */
  createdAt: number
  /** Bounded lifecycle event log (newest last; capped). */
  events: WorkspaceEventLogEntry[]
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
  | { type: 'sleep-requested' }
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

/** Bounded event log length. */
export const EVENT_LOG_CAP = 50

const now = (): number => Date.now()

export function initialState(workspaceId: string): WorkspaceState {
  return {
    workspaceId,
    phase: 'sleep',
    provisioned: false,
    activeSessions: 0,
    openTurns: 0,
    activeCommands: 0,
    lastTransitionAt: now(),
    wakeCount: 0,
    sleepCount: 0,
    createdAt: now(),
    events: [],
  }
}

/** Append a lifecycle event, keeping the log bounded. */
function log(state: WorkspaceState, type: string, at: number): void {
  state.events.push({ at, type })
  if (state.events.length > EVENT_LOG_CAP) state.events.shift()
}

/**
 * Pure transition function: given the current state and one event, return the
 * next state plus the action the orchestrator must perform.
 */
export function transition(state: WorkspaceState, event: WorkspaceEvent): Transition {
  const at = now()
  const s = { ...state, lastTransitionAt: at, events: [...state.events] }

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
    log(s, 'deleted', at)
    return { state: s, action: { kind: 'delete' } }
  }

  switch (s.phase) {
    case 'provision': {
      if (event.type === 'pod-ready') {
        s.phase = 'running'
        s.provisioned = true
        s.lastWakeAt = at
        log(s, 'pod-ready', at)
        if (idle) {
          s.idleSince = at
          return { state: s, action: hasCommands ? { kind: 'start-grace' } : { kind: 'start-idle' } }
        }
        return { state: s, action: { kind: 'none' } }
      }
      if (event.type === 'pod-lost') {
        return { state: s, action: { kind: 'ensure' } }
      }
      return { state: s, action: { kind: 'none' } }
    }

    case 'waking': {
      if (event.type === 'pod-ready') {
        s.phase = 'running'
        s.provisioned = true
        s.lastWakeAt = at
        s.wakeCount += 1
        log(s, 'pod-ready', at)
        if (idle) {
          s.idleSince = at
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
        log(s, 'pod-lost', at)
        return { state: s, action: { kind: 'ensure' } }
      }
      if (event.type === 'user-attach' && s.idleSince !== undefined) {
        s.idleSince = undefined
        return { state: s, action: { kind: 'cancel-timers' } }
      }

      // Manual sleep (user request): sleep regardless of activity.
      if (event.type === 'sleep-requested') {
        s.phase = 'sleep'
        s.idleSince = undefined
        s.activeCommands = 0
        s.lastSleepAt = at
        s.sleepCount += 1
        log(s, 'sleep', at)
        return { state: s, action: { kind: 'dispose' } }
      }

      if (event.type === 'idle-expired' && idle && !hasCommands) {
        s.phase = 'sleep'
        s.idleSince = undefined
        s.activeCommands = 0
        s.lastSleepAt = at
        s.sleepCount += 1
        log(s, 'sleep', at)
        return { state: s, action: { kind: 'dispose' } }
      }
      if (event.type === 'grace-expired' && idle) {
        s.phase = 'sleep'
        s.idleSince = undefined
        s.activeCommands = 0 // drain/force-terminate before pod deletion
        s.lastSleepAt = at
        s.sleepCount += 1
        log(s, 'sleep', at)
        return { state: s, action: { kind: 'dispose' } }
      }

      // Command count changed while idle: switch timer type without waiting
      // for the previous timer to fire.
      if (idle && s.idleSince !== undefined && event.type === 'command-started' && hasCommands) {
        s.idleSince = at
        return { state: s, action: { kind: 'start-grace' } }
      }
      if (idle && s.idleSince !== undefined && event.type === 'command-ended' && !hasCommands) {
        s.idleSince = at
        return { state: s, action: { kind: 'start-idle' } }
      }

      if (idle && s.idleSince === undefined) {
        s.idleSince = at
        log(s, hasCommands ? 'grace-started' : 'idle-started', at)
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
        const waking = s.provisioned
        s.phase = waking ? 'waking' : 'provision'
        s.idleSince = undefined
        log(s, waking ? 'waking-started' : 'provision-started', at)
        return { state: s, action: { kind: 'ensure' } }
      }
      return { state: s, action: { kind: 'none' } }
    }

    case 'deleted': {
      return { state: s, action: { kind: 'none' } }
    }
  }
}

/**
 * Session activity tracker: translates dsh session/turn lifecycle events
 * into per-workspace state-machine events.
 *
 * Workspace binding: a session's immutable cwd is the host-side workspace
 * identifier (/workspaces/<workspaceId>), so the workspace id is derived from
 * cwd. Sessions without a workspace cwd are ignored (platform sessions only).
 */
import type { WorkspaceEvent } from './state-machine.ts'

/** Injectable session activity source (the cordis wiring lives in apply()). */
export interface SessionActivitySource {
  onSessionCreated(cb: (sessionId: string, cwd?: string) => void): void
  onSessionDisposed(cb: (sessionId: string) => void): void
  onTurnStarted(cb: (sessionId: string) => void): void
  onTurnEnded(cb: (sessionId: string) => void): void
}

export interface ActivitySnapshot {
  workspaceId: string
  activeSessions: number
  openTurns: number
}

export class SessionTracker {
  private sessionWs = new Map<string, string>()
  private sessionTurns = new Map<string, number>()
  private counts = new Map<string, { sessions: number; turns: number }>()

  constructor(
    private source: SessionActivitySource,
    private onEvent: (workspaceId: string, event: WorkspaceEvent) => void,
  ) {
    source.onSessionCreated((sessionId, cwd) => this.sessionCreated(sessionId, cwd))
    source.onSessionDisposed((sessionId) => this.sessionDisposed(sessionId))
    source.onTurnStarted((sessionId) => this.turnStarted(sessionId))
    source.onTurnEnded((sessionId) => this.turnEnded(sessionId))
  }

  /** Extract workspaceId from a cwd like /workspaces/<id> or undefined. */
  static workspaceOf(cwd: string | undefined): string | undefined {
    if (cwd === undefined) return undefined
    const m = /^\/workspaces\/([^/]+)/.exec(cwd)
    return m?.[1]
  }

  private touch(workspaceId: string, sessionId: string): void {
    const c = this.counts.get(workspaceId) ?? { sessions: 0, turns: 0 }
    const turns = this.sessionTurns.get(sessionId) ?? 0
    c.sessions = [...this.sessionWs.values()].filter((w) => w === workspaceId).length
    c.turns = [...this.sessionTurns.entries()].filter(([sid, t]) => t > 0 && this.sessionWs.get(sid) === workspaceId).reduce((a, [, t]) => a + t, 0)
    this.counts.set(workspaceId, c)
    void turns
  }

  private sessionCreated(sessionId: string, cwd?: string): void {
    const ws = SessionTracker.workspaceOf(cwd)
    if (ws === undefined) return
    this.sessionWs.set(sessionId, ws)
    this.counts.set(ws, {
      sessions: (this.counts.get(ws)?.sessions ?? 0) + 1,
      turns: this.counts.get(ws)?.turns ?? 0,
    })
    this.onEvent(ws, { type: 'session-created' })
  }

  private sessionDisposed(sessionId: string): void {
    const ws = this.sessionWs.get(sessionId)
    if (ws === undefined) return
    this.sessionWs.delete(sessionId)
    const turns = this.sessionTurns.get(sessionId) ?? 0
    this.sessionTurns.delete(sessionId)
    this.counts.set(ws, {
      sessions: Math.max(0, (this.counts.get(ws)?.sessions ?? 0) - 1),
      turns: Math.max(0, (this.counts.get(ws)?.turns ?? 0) - turns),
    })
    // open turns end with their session; emit matching events so the state
    // machine's own counters stay consistent
    for (let i = 0; i < turns; i++) this.onEvent(ws, { type: 'turn-ended' })
    this.onEvent(ws, { type: 'session-disposed' })
  }

  private turnStarted(sessionId: string): void {
    const ws = this.sessionWs.get(sessionId)
    if (ws === undefined) return
    this.sessionTurns.set(sessionId, (this.sessionTurns.get(sessionId) ?? 0) + 1)
    this.counts.set(ws, {
      sessions: this.counts.get(ws)?.sessions ?? 0,
      turns: (this.counts.get(ws)?.turns ?? 0) + 1,
    })
    this.onEvent(ws, { type: 'turn-started' })
  }

  private turnEnded(sessionId: string): void {
    const ws = this.sessionWs.get(sessionId)
    if (ws === undefined) return
    this.sessionTurns.set(sessionId, Math.max(0, (this.sessionTurns.get(sessionId) ?? 0) - 1))
    this.counts.set(ws, {
      sessions: this.counts.get(ws)?.sessions ?? 0,
      turns: Math.max(0, (this.counts.get(ws)?.turns ?? 0) - 1),
    })
    this.onEvent(ws, { type: 'turn-ended' })
  }

  snapshot(workspaceId: string): ActivitySnapshot | undefined {
    const c = this.counts.get(workspaceId)
    if (c === undefined) return undefined
    return { workspaceId, activeSessions: c.sessions, openTurns: c.turns }
  }
}

/**
 * Runtime wiring for dsh-workspace-k8s: subscribes to the dsh session event
 * firehose (session/created + session/disposed + session/event turn
 * boundaries), feeds the SessionTracker -> LifecycleManager state machine,
 * and exposes the per-workspace endpoint resolver that the fs-k8s /
 * subprocess-k8s providers call on every operation.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionTracker } from './session-tracker.ts'
import { WorkspaceLifecycleManager, type LifecycleOptions } from './lifecycle-manager.ts'
import type { WorkspaceRuntime } from './index.ts'

export interface WireOptions {
  lifecycle: LifecycleOptions
  runtime: WorkspaceRuntime
}

/** Service subprocess-k8s can use to report live background command counts. */
export interface CommandActivityTracker {
  commandStarted(workspaceId: string): void
  commandEnded(workspaceId: string): void
}

type EventBus = {
  on(event: string, listener: (...args: any[]) => void): void
}

interface SessionLike {
  id?: unknown
  header?: { cwd?: string }
}

interface SessionEventLike {
  type: string
  data?: { turn?: unknown }
}

/**
 * Wire the workspace lifecycle into the running dsh host.
 *
 * - session/created / session/disposed carry the session (header.cwd ->
 *   /workspaces/<workspaceId>); they drive the tracker and state machine.
 * - Turn boundaries are published on session/event as `turn/start` and
 *   `turn/end`; the tracker keeps openTurns so a session with an in-flight
 *   agent turn is never considered idle.
 * - resolveEndpoint(workspaceId) = runtime.ensure + getEndpoint so fs/
 *   subprocess providers reach a ready pod, creating it on first use.
 */
export function wireWorkspaceLifecycle(ctx: Context & EventBus, opts: WireOptions): {
  resolveEndpoint: (workspaceId: string) => Promise<string>
  commandTracker: CommandActivityTracker
  deleteWorkspace: (workspaceId: string) => void
} {
  const manager = new WorkspaceLifecycleManager(opts.lifecycle)
  const tracker = new SessionTracker(
    {
      onSessionCreated: (cb) => {
        ctx.on('session/created', (session: SessionLike) => {
          cb(String(session.id ?? ''), session.header?.cwd)
        })
      },
      onSessionDisposed: (cb) => {
        ctx.on('session/disposed', (session: SessionLike) => {
          cb(String(session.id ?? ''))
        })
      },
      onTurnStarted: (cb) => {
        ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
          if (event.type === 'turn/start') cb(String(session.id ?? ''))
        })
      },
      onTurnEnded: (cb) => {
        ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
          if (event.type === 'turn/end') cb(String(session.id ?? ''))
        })
      },
    },
    (workspaceId, event) => manager.handleSessionEvent(workspaceId, event),
  )
  void tracker

  return {
    resolveEndpoint: async (workspaceId: string): Promise<string> => {
      // ensure creates the pod if absent; getEndpoint returns the stable DNS
      await opts.runtime.ensure(workspaceId)
      return opts.runtime.getEndpoint(workspaceId)
    },
    commandTracker: {
      commandStarted: (workspaceId) => manager.commandStarted(workspaceId),
      commandEnded: (workspaceId) => manager.commandEnded(workspaceId),
    },
    deleteWorkspace: (workspaceId) => manager.delete(workspaceId),
  }
}

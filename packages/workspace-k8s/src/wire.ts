/**
 * Runtime wiring for dsh-workspace-k8s: subscribes to the dsh session event
 * firehose (session/created + session/disposed), feeds the SessionTracker ->
 * LifecycleManager state machine, and exposes the per-workspace endpoint
 * resolver that the fs-k8s / subprocess-k8s providers call on every operation.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionTracker } from './session-tracker.ts'
import { WorkspaceLifecycleManager, type LifecycleOptions } from './lifecycle-manager.ts'
import type { WorkspaceRuntime } from './index.ts'

export interface WireOptions {
  lifecycle: LifecycleOptions
  runtime: WorkspaceRuntime
}

type EventBus = {
  on(event: string, listener: (...args: any[]) => void): void
}

/**
 * Wire the workspace lifecycle into the running dsh host.
 *
 * - session/created / session/disposed carry the session (header.cwd ->
 *   /workspaces/<workspaceId>); they drive the tracker and state machine.
 * - Turn-boundary events come through session/event; wired as TODO: the idle
 *   counters still work on session boundaries alone (turns count 0).
 * - resolveEndpoint(workspaceId) = runtime.ensure + getEndpoint so fs/
 *   subprocess providers reach a ready pod, creating it on first use.
 */
export function wireWorkspaceLifecycle(ctx: Context & EventBus, opts: WireOptions): { resolveEndpoint: (workspaceId: string) => Promise<string> } {
  const manager = new WorkspaceLifecycleManager(opts.lifecycle)
  const tracker = new SessionTracker(
    {
      onSessionCreated: (cb) => {
        ctx.on('session/created', (session: { id?: unknown; header?: { cwd?: string } }) => {
          cb(String(session.id ?? ''), session.header?.cwd)
        })
      },
      onSessionDisposed: (cb) => {
        ctx.on('session/disposed', (session: { id?: unknown }) => {
          cb(String(session.id ?? ''))
        })
      },
      onTurnStarted: (cb) => {
        // TODO(wire): map session/event turn types to the tracker
        void cb
      },
      onTurnEnded: (cb) => {
        // TODO(wire): map session/event turn types to the tracker
        void cb
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
  }
}

/**
 * Runtime wiring for dsh-workspace-k8s: subscribes to the dsh session event
 * firehose (session/created + session/disposed + session/event turn
 * boundaries), feeds the SessionTracker -> LifecycleManager state machine,
 * and exposes the per-workspace endpoint resolver that the fs-k8s /
 * subprocess-k8s providers call on every operation.
 */import { Context } from '@deepseek-ai/cordis'
import { SessionTracker } from './session-tracker.ts'
import { WorkspaceLifecycleManager, type ImageReconcileResult, type LifecycleOptions } from './lifecycle-manager.ts'
import type { WorkspaceState } from './state-machine.ts'
import type { WorkspaceRuntime } from './index.ts'

export interface WireOptions {
  lifecycle: LifecycleOptions
  runtime: WorkspaceRuntime
  /**
   * Whether a workspace id is one this platform REGISTERED.
   *
   * The resolver exists to wake a workspace, and a workspace id is just the
   * first path segment under the host root — so without this check any absolute
   * path `/workspaces/<name>/...` would `ensure` `<name>` into existence: an
   * ordinary directory (one a shell command or an agent created) would get a
   * PVC and a pod, and the reconcile pass would adopt that PVC into a sidebar
   * record the operator never asked for. That is how a workspace appears out of
   * nowhere.
   *
   * It is read by BOTH halves of that rule: the membership question the fs
   * provider asks before routing a path (`isWorkspace` below), and the
   * resolver's own refusal of the creation case for callers that hold nothing
   * but an id (subprocess-k8s).
   *
   * Only a POSITIVE "no such record" refuses the operation. A checker that
   * cannot answer — the registry is briefly unlistable — must not take the file
   * view down with it, so the caller's rejection is treated as unknown and the
   * operation proceeds (see {@link wireWorkspaceLifecycle}).
   *
   * Optional: a composition that installs no registry bridge keeps the old
   * behaviour, because it has no notion of "registered" to check against.
   */
  knownWorkspace?: (workspaceId: string) => Promise<boolean>
}

/** Service subprocess-k8s can use to report live background command counts. */
export interface CommandActivityTracker {
  commandStarted(workspaceId: string): void
  commandEnded(workspaceId: string): void
}

/**
 * The `workspaceEndpointResolver` service this wiring provides, as its
 * consumers see it (`@visecy/dsh-fs-k8s`, `@visecy/dsh-subprocess-k8s`; both
 * read it structurally, with no dependency on this package).
 *
 * Two questions, deliberately separate:
 *  - `isWorkspace(id)` — membership alone. Non-throwing (fail-open), no
 *    provisioning, cheap. The fs provider asks it before routing a path, so a
 *    path that names no workspace is answered in the provider's own terms
 *    instead of surfacing as a resolver failure.
 *  - `resolve(id)` — the endpoint of a workspace, waking it if needed. Refuses
 *    an id no record describes: that is the creation case, and it is the only
 *    thing the fence refuses. A caller holding nothing but an id
 *    (subprocess-k8s) has no other way to ask, which is why the refusal lives
 *    here as well as in the membership answer.
 */
export interface WorkspaceEndpointResolver {
  resolve(workspaceId: string): Promise<string>
  isWorkspace(workspaceId: string): Promise<boolean>
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
export interface WorkspaceStatusService {
  get(workspaceId: string): WorkspaceState | undefined
  list(): WorkspaceState[]
}

export function wireWorkspaceLifecycle(ctx: Context & EventBus, opts: WireOptions): {
  resolveEndpoint: (workspaceId: string) => Promise<string>
  isWorkspace: (workspaceId: string) => Promise<boolean>
  commandTracker: CommandActivityTracker
  deleteWorkspace: (workspaceId: string) => Promise<void>
  attach: (workspaceId: string) => void
  sleepWorkspace: (workspaceId: string) => Promise<void>
  reconcileImages: () => Promise<ImageReconcileResult>
  status: WorkspaceStatusService
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

  /**
   * "Is this id a workspace of this platform?" — the fence's question, asked
   * WITHOUT provisioning anything.
   *
   * The providers need it as a question of its own, not as a failure of
   * `resolveEndpoint`. A workspace id is just the first path segment under the
   * host root, so every ordinary path beside the workspace anchors — `.git`, a
   * directory an agent created, any file in a session whose cwd is the root —
   * produces an id that names no workspace. Those paths are not errors and
   * must not surface as platform failures; what must not happen is that
   * resolving one CREATES a workspace. Answering membership separately lets
   * fs-k8s refuse the creation while answering the operation in its own terms
   * (`see FsK8s.endpointFor`), and leaves `resolveEndpoint` — the only entry
   * point a caller with nothing but an id has, i.e. `@visecy/dsh-subprocess-k8s`
   * — refusing exactly the creation case.
   *
   * Fail-open, like the fence: only a POSITIVE "no such record" answers false.
   * A composition with no registry bridge has no notion of "registered" and
   * answers true; a listing that fails is not an answer either, so it answers
   * true and the caller proceeds as it did before the fence existed.
   */
  const isWorkspace = async (workspaceId: string): Promise<boolean> => {
    if (opts.knownWorkspace === undefined) return true
    return opts.knownWorkspace(workspaceId).catch(() => true)
  }

  return {
    isWorkspace,
    resolveEndpoint: async (workspaceId: string): Promise<string> => {
      // A path is not a workspace. Refuse to materialize one that no record
      // describes, before anything creates a PVC or a pod for it.
      if (!(await isWorkspace(workspaceId))) {
        throw new Error(
          `workspaceEndpointResolver: '${workspaceId}' is not a registered workspace of this platform, `
          + 'so no pod or volume will be created for it; the path names an ordinary directory under the workspace root',
        )
      }
      // ensure creates the pod if absent; getEndpoint returns the stable DNS.
      await opts.runtime.ensure(workspaceId)
      // …and that is a WAKE, so the lifecycle has to hear about it. This path
      // is reached from every fs and subprocess operation and never passes
      // through `management.ensure`, so a workspace woken here used to keep the
      // `sleep` phase its state machine was left in: the panel reported a
      // workspace that was serving requests as asleep, and — because the
      // transition that starts the idle timer never ran — nothing would ever
      // have put that pod back to sleep either. `attach` dispatches
      // `user-attach`, which is exactly the fact being reported: the workspace
      // is in use. It is a no-op for a workspace already running.
      manager.attach(workspaceId)
      return opts.runtime.getEndpoint(workspaceId)
    },
    commandTracker: {
      commandStarted: (workspaceId) => manager.commandStarted(workspaceId),
      commandEnded: (workspaceId) => manager.commandEnded(workspaceId),
    },
    deleteWorkspace: (workspaceId) => manager.delete(workspaceId),
    attach: (workspaceId) => manager.attach(workspaceId),
    sleepWorkspace: (workspaceId) => manager.sleep(workspaceId),
    reconcileImages: () => manager.reconcileImages(),
    status: {
      get: (workspaceId) => manager.snapshot(workspaceId),
      list: () => manager.allStates(),
    },
  }
}

/**
 * WorkspaceLifecycleManager: orchestrates the state machine with the pod
 * controller, idle/grace timers, and session/command activity events.
 *
 * Timer policy (user-confirmed):
 *   - idle without lingering commands -> idleTimeoutMs (default 5min) -> sleep
 *   - idle with lingering commands   -> graceMs (default 3h) -> drain/force -> sleep
 */
import { initialState, transition, type WorkspaceAction, type WorkspaceEvent, type WorkspaceState } from './state-machine.ts'
import type { PodController, WorkspacePodSpec } from './k8s-client.ts'

export interface Timer {
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout
  clearTimeout(t: NodeJS.Timeout): void
}

/**
 * Where the manager reports what it could not do. The same shape the
 * reconciler's logger has, and `warn` on purpose: every line is a failure the
 * caller can no longer see (an action runs detached from the request that
 * triggered it), not a normal lifecycle step.
 */
export interface LifecycleLogger {
  warn(message: string): void
  /** The convergence record (a pod actually recycled); optional. */
  info?(message: string): void
}

export interface LifecycleOptions {
  controller: PodController
  namespace: string
  image: string
  daemonPort?: number
  pvcName?: string
  resources?: { cpu?: string; memory?: string }
  storageClassName?: string
  storageSize?: string
  /** Idle timeout with no lingering commands. Default 5 minutes. */
  idleTimeoutMs?: number
  /** Lingering-command grace before force termination. Default 3 hours. */
  graceMs?: number
  now?: () => number
  timer?: Timer
  /** Called with the daemon endpoint before sleeping: drain/terminate commands. */
  onBeforeSleep?: (endpoint: string) => Promise<void>
  /**
   * Whether another owner (the workspace runtime) has an ensure in flight for
   * this workspace. A pod being created right now must not be recycled: the
   * create would either be undone or race the delete, and the pass would then
   * "converge" a pod it just removed.
   */
  isEnsuring?: (workspaceId: string) => boolean
  /** Where detached action failures are reported. */
  logger?: LifecycleLogger
}

/** What one image-reconcile pass did, for callers and tests. */
export interface ImageReconcileResult {
  /** Workspaces whose drifted pod was recycled by this pass. */
  recycled: string[]
  /** Workspaces whose drifted pod is busy and marked for recycling. */
  pending: string[]
}

export class WorkspaceLifecycleManager {
  private controller: PodController
  private opts: Required<Pick<LifecycleOptions, 'namespace' | 'image' | 'daemonPort' | 'idleTimeoutMs' | 'graceMs'>>
  private onBeforeSleep: ((endpoint: string) => Promise<void>) | undefined
  private now: () => number
  private timer: Timer
  private states = new Map<string, WorkspaceState>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  private graceTimers = new Map<string, NodeJS.Timeout>()
  private ensureInflight = new Set<string>()
  private isEnsuring: ((workspaceId: string) => boolean) | undefined
  private logger: LifecycleLogger | undefined
  /** One image pass at a time; see {@link reconcileImages}. */
  private imagesInflight = false

  constructor(opts: LifecycleOptions) {
    this.controller = opts.controller
    this.opts = {
      namespace: opts.namespace,
      image: opts.image,
      daemonPort: opts.daemonPort ?? 4390,
      idleTimeoutMs: opts.idleTimeoutMs ?? 5 * 60 * 1000,
      graceMs: opts.graceMs ?? 3 * 60 * 60 * 1000,
    }
    this.now = opts.now ?? Date.now
    this.onBeforeSleep = opts.onBeforeSleep
    this.isEnsuring = opts.isEnsuring
    this.logger = opts.logger
    this.timer = opts.timer ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    }
  }

  stateOf(workspaceId: string): WorkspaceState | undefined {
    return this.states.get(workspaceId)
  }

  /** Full snapshot for status UIs/APIs. */
  snapshot(workspaceId: string): WorkspaceState | undefined {
    const state = this.states.get(workspaceId)
    if (state === undefined) return undefined
    return { ...state }
  }

  /** All tracked workspace snapshots. */
  allStates(): WorkspaceState[] {
    return [...this.states.values()].map((s) => ({ ...s }))
  }

  /** Session/turn activity from the SessionTracker. */
  handleSessionEvent(workspaceId: string, event: WorkspaceEvent): void {
    this.dispatch(workspaceId, event)
  }

  /** A background command started in this workspace. */
  commandStarted(workspaceId: string): void {
    this.dispatch(workspaceId, { type: 'command-started' })
  }

  /** A background command ended in this workspace. */
  commandEnded(workspaceId: string): void {
    this.dispatch(workspaceId, { type: 'command-ended' })
  }

  /** User opened/activated the workspace (cancel sleep). */
  attach(workspaceId: string): void {
    // An untracked workspace (no session activity since boot) is seeded as a
    // provisioned sleeping workspace so the wake goes through WAKING and the
    // ensure path applies.
    this.seedUntracked(workspaceId)
    this.dispatch(workspaceId, { type: 'user-attach' })
  }

  /** Explicit manual sleep (user request). */
  sleep(workspaceId: string): Promise<void> {
    // Untracked workspaces may still have a live pod (created before the
    // lifecycle manager started tracking); seed as running so the sleep
    // request actually disposes the pod instead of being a no-op.
    if (!this.states.has(workspaceId)) {
      this.states.set(workspaceId, { ...initialState(workspaceId), phase: 'running', provisioned: true })
    }
    return this.handle(workspaceId, { type: 'sleep-requested' })
  }

  private seedUntracked(workspaceId: string): void {
    if (this.states.has(workspaceId)) return
    this.states.set(workspaceId, { ...initialState(workspaceId), provisioned: true })
  }

  /**
   * Explicit workspace deletion: the pod AND its PVC go away, so the record
   * cannot be re-created from a surviving volume. The returned promise
   * resolves only once the resources are gone, and rejects with whatever the
   * cluster said.
   */
  delete(workspaceId: string): Promise<void> {
    return this.handle(workspaceId, { type: 'dispose-requested' })
  }

  /** Health signal: execution pod lost (crash). */
  podLost(workspaceId: string): void {
    this.dispatch(workspaceId, { type: 'pod-lost' })
  }

  /**
   * Apply one event and run the action it produced.
   *
   * The promise is returned so a caller that must REPORT the outcome (delete,
   * sleep, the image pass) can await it; the fire-and-forget callers go
   * through {@link dispatch}, which keeps a failure from surfacing as an
   * unhandled rejection nobody reads.
   */
  private handle(workspaceId: string, event: WorkspaceEvent): Promise<void> {
    const state = this.states.get(workspaceId) ?? initialState(workspaceId)
    const { state: next, action } = transition(state, event)
    this.states.set(workspaceId, next)
    return this.runAction(workspaceId, action)
  }

  /** Fire-and-forget dispatch: report the failure instead of dropping it. */
  private dispatch(workspaceId: string, event: WorkspaceEvent): void {
    void this.handle(workspaceId, event).catch((error: unknown) => {
      this.report(`workspace '${workspaceId}': lifecycle action failed: ${String(error)}`)
    })
  }

  /** Report one failure without letting the report itself throw. */
  private report(message: string): void {
    try {
      this.logger?.warn(message)
    } catch {
      // The lifecycle's real work matters more than the diagnostic.
    }
  }

  /**
   * Converge running workspace pods onto the configured image.
   *
   * A pod's image is applied when the pod is CREATED, so a deployment that
   * changes `WS_IMAGE` leaves every existing pod on the old daemon: the fleet
   * stays mixed until each pod happens to be recreated, which for a workspace
   * that is always used is never. This pass closes that gap — the lifecycle
   * manager owns pod lifetime, so it owns the convergence.
   *
   * Safety, in this order:
   *   - a workspace with an ensure in flight is skipped entirely (the pod
   *     being created already carries the configured image);
   *   - a drifted pod is recycled only when the workspace is IDLE: no live
   *     sessions, no open turns, no tracked commands — the same guard the idle
   *     sleep path uses;
   *   - otherwise the workspace is marked `recyclePending` and the recycle
   *     runs on the transition that ends the work, never before;
   *   - the PVC is untouched: a recycle is a pod replacement, not a delete;
   *   - one pass at a time (the timer retries), so a slow pass cannot pile up.
   *
   * @returns the workspaces this pass recycled and those it marked pending.
   */
  async reconcileImages(): Promise<ImageReconcileResult> {
    const { controller } = this
    const result: ImageReconcileResult = { recycled: [], pending: [] }
    if (controller.listPods === undefined || controller.getPodImage === undefined) return result
    if (this.imagesInflight) return result
    this.imagesInflight = true
    try {
      let pods: string[]
      try {
        pods = await controller.listPods(this.opts.namespace)
      } catch (error) {
        this.report(`workspace image reconcile: could not list workspace pods: ${String(error)}`)
        return result
      }
      for (const workspaceId of pods) {
        if (this.ensureInflight.has(workspaceId) || this.isEnsuring?.(workspaceId) === true) continue
        let image: string | undefined
        try {
          image = await controller.getPodImage(this.opts.namespace, workspaceId)
        } catch (error) {
          // An unreadable pod is left alone on purpose: deleting on a guess is
          // worse than a mixed fleet, and the next pass retries.
          this.report(`workspace image reconcile: could not read the image of pod '${workspaceId}': ${String(error)}`)
          continue
        }
        if (image === undefined || image === this.opts.image) continue
        try {
          await this.noteImageDrift(workspaceId, image)
        } catch (error) {
          this.report(`workspace image reconcile: could not recycle pod '${workspaceId}': ${String(error)}`)
          continue
        }
        if (this.states.get(workspaceId)?.recyclePending === true) result.pending.push(workspaceId)
        else result.recycled.push(workspaceId)
      }
    } finally {
      this.imagesInflight = false
    }
    return result
  }

  /** Record one drifted pod and let the state machine decide when to act. */
  private async noteImageDrift(workspaceId: string, image: string): Promise<void> {
    if (!this.states.has(workspaceId)) {
      // A pod this process never attached (created before boot, or by a
      // previous control plane). Seeding it as running mirrors what `sleep`
      // does for the same case: the platform has no live session, turn or
      // command for it, so it is idle and can be recycled. The alternative —
      // never touching untracked pods — is exactly the mixed fleet this pass
      // exists to converge.
      this.states.set(workspaceId, { ...initialState(workspaceId), phase: 'running', provisioned: true })
    }
    await this.handle(workspaceId, { type: 'pod-image-drift' })
    const state = this.states.get(workspaceId)
    if (state?.recyclePending === true) {
      this.report(`workspace '${workspaceId}' runs daemon image '${image}' but '${this.opts.image}' is configured; recycling when it goes idle`)
    } else {
      this.info(`workspace '${workspaceId}' recycled: daemon image '${image}' -> '${this.opts.image}'`)
    }
  }

  /** Convergence record; the default sink hides it unless DSH_LOG_LEVEL=info. */
  private info(message: string): void {
    try {
      this.logger?.info?.(message)
    } catch {
      // see report()
    }
  }

  private clearTimers(workspaceId: string): void {
    const idle = this.idleTimers.get(workspaceId)
    if (idle !== undefined) {
      this.timer.clearTimeout(idle)
      this.idleTimers.delete(workspaceId)
    }
    const grace = this.graceTimers.get(workspaceId)
    if (grace !== undefined) {
      this.timer.clearTimeout(grace)
      this.graceTimers.delete(workspaceId)
    }
  }

  private async runAction(workspaceId: string, action: WorkspaceAction): Promise<void> {
    switch (action.kind) {
      case 'none':
        return
      case 'start-idle': {
        this.clearTimers(workspaceId)
        const timer = this.timer.setTimeout(() => {
          this.idleTimers.delete(workspaceId)
          this.handle(workspaceId, { type: 'idle-expired' })
        }, this.opts.idleTimeoutMs)
        this.idleTimers.set(workspaceId, timer)
        return
      }
      case 'start-grace': {
        this.clearTimers(workspaceId)
        const timer = this.timer.setTimeout(() => {
          this.graceTimers.delete(workspaceId)
          this.handle(workspaceId, { type: 'grace-expired' })
        }, this.opts.graceMs)
        this.graceTimers.set(workspaceId, timer)
        return
      }
      case 'cancel-idle': {
        const t = this.idleTimers.get(workspaceId)
        if (t !== undefined) {
          this.timer.clearTimeout(t)
          this.idleTimers.delete(workspaceId)
        }
        return
      }
      case 'cancel-grace': {
        const t = this.graceTimers.get(workspaceId)
        if (t !== undefined) {
          this.timer.clearTimeout(t)
          this.graceTimers.delete(workspaceId)
        }
        return
      }
      case 'cancel-timers': {
        this.clearTimers(workspaceId)
        return
      }
      case 'ensure': {
        if (this.ensureInflight.has(workspaceId)) return
        this.ensureInflight.add(workspaceId)
        try {
          const pvcName = await this.controller.ensurePvc(workspaceId)
          const spec: WorkspacePodSpec = {
            namespace: this.opts.namespace,
            workspaceId,
            image: this.opts.image,
            daemonPort: this.opts.daemonPort,
            pvcName,
            resources: undefined,
          }
          const name = await this.controller.ensurePod(spec)
          await this.controller.waitReady(this.opts.namespace, name)
          this.handle(workspaceId, { type: 'pod-ready' })
        } catch (error) {
          // transient failure: retry via pod-lost semantics
          this.report(`workspace '${workspaceId}': could not provision its pod: ${String(error)}`)
          this.dispatch(workspaceId, { type: 'pod-lost' })
        } finally {
          this.ensureInflight.delete(workspaceId)
        }
        return
      }
      case 'dispose': {
        // sleep: drain/force-terminate commands in the pod first, then the pod
        // goes away (PVC survives)
        if (this.onBeforeSleep !== undefined) {
          const ep = this.controller.endpoint(this.opts.namespace, workspaceId, this.opts.daemonPort)
          await this.onBeforeSleep(ep).catch(() => undefined)
        }
        await this.controller.deletePod(this.opts.namespace, workspaceId)
        this.clearTimers(workspaceId)
        return
      }
      case 'recycle': {
        // Image drift on an IDLE workspace: delete the pod, keep the PVC. The
        // state machine has already moved the workspace to sleep, so the next
        // wake provisions the configured image.
        //
        // No drain here, unlike sleep: the idle guard is what makes this safe
        // (no live session, no open turn, no tracked command), so there is
        // nothing to terminate gracefully — and the drain would put a network
        // round trip, to the very daemon being replaced, in front of the
        // convergence.
        await this.controller.deletePod(this.opts.namespace, workspaceId)
        this.clearTimers(workspaceId)
        return
      }
      case 'delete': {
        // workspace deletion: pod AND PVC go away
        await this.controller.deletePod(this.opts.namespace, workspaceId)
        await this.controller.deletePvc(workspaceId)
        this.clearTimers(workspaceId)
        return
      }
    }
  }
}

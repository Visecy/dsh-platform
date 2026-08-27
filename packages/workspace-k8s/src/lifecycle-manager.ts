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
    this.handle(workspaceId, event)
  }

  /** A background command started in this workspace. */
  commandStarted(workspaceId: string): void {
    this.handle(workspaceId, { type: 'command-started' })
  }

  /** A background command ended in this workspace. */
  commandEnded(workspaceId: string): void {
    this.handle(workspaceId, { type: 'command-ended' })
  }

  /** User opened/activated the workspace (cancel sleep). */
  attach(workspaceId: string): void {
    this.handle(workspaceId, { type: 'user-attach' })
  }

  /** Explicit manual sleep (user request). */
  sleep(workspaceId: string): void {
    this.handle(workspaceId, { type: 'sleep-requested' })
  }

  /** Explicit workspace deletion. */
  delete(workspaceId: string): void {
    this.handle(workspaceId, { type: 'dispose-requested' })
  }

  /** Health signal: execution pod lost (crash). */
  podLost(workspaceId: string): void {
    this.handle(workspaceId, { type: 'pod-lost' })
  }

  private handle(workspaceId: string, event: WorkspaceEvent): void {
    const state = this.states.get(workspaceId) ?? initialState(workspaceId)
    const { state: next, action } = transition(state, event)
    this.states.set(workspaceId, next)
    void this.runAction(workspaceId, action)
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
        } catch {
          // transient failure: retry via pod-lost semantics
          this.handle(workspaceId, { type: 'pod-lost' })
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

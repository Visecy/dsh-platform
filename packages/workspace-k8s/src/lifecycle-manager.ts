/**
 * WorkspaceLifecycleManager: orchestrates the state machine with the pod
 * controller, the 3h grace timer, and session activity events.
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
  graceMs?: number
  now?: () => number
  timer?: Timer
  /** Called with the daemon endpoint before sleeping: drain/terminate commands. */
  onBeforeSleep?: (endpoint: string) => Promise<void>
}

export class WorkspaceLifecycleManager {
  private controller: PodController
  private opts: Required<Pick<LifecycleOptions, 'namespace' | 'image' | 'daemonPort' | 'graceMs'>>
  private onBeforeSleep: ((endpoint: string) => Promise<void>) | undefined
  private now: () => number
  private timer: Timer
  private states = new Map<string, WorkspaceState>()
  private timers = new Map<string, NodeJS.Timeout>()
  private ensureInflight = new Set<string>()

  constructor(opts: LifecycleOptions) {
    this.controller = opts.controller
    this.opts = {
      namespace: opts.namespace,
      image: opts.image,
      daemonPort: opts.daemonPort ?? 4390,
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

  /** Session activity from the tracker (session/turn lifecycle). */
  handleSessionEvent(workspaceId: string, event: WorkspaceEvent): void {
    this.handle(workspaceId, event)
  }

  /** User opened/activated the workspace (cancel sleep). */
  attach(workspaceId: string): void {
    this.handle(workspaceId, { type: 'user-attach' })
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

  private async runAction(workspaceId: string, action: WorkspaceAction): Promise<void> {
    switch (action.kind) {
      case 'none':
        return
      case 'start-grace': {
        const timer = this.timer.setTimeout(() => {
          this.timers.delete(workspaceId)
          this.handle(workspaceId, { type: 'grace-expired' })
        }, this.opts.graceMs)
        this.timers.set(workspaceId, timer)
        return
      }
      case 'cancel-grace': {
        const t = this.timers.get(workspaceId)
        if (t !== undefined) {
          this.timer.clearTimeout(t)
          this.timers.delete(workspaceId)
        }
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
        // sleep: drain commands in the pod first, then the pod goes away (PVC survives)
        if (this.onBeforeSleep !== undefined) {
          const ep = this.controller.endpoint(this.opts.namespace, workspaceId, this.opts.daemonPort)
          await this.onBeforeSleep(ep).catch(() => undefined)
        }
        await this.controller.deletePod(this.opts.namespace, workspaceId)
        const t = this.timers.get(workspaceId)
        if (t !== undefined) {
          this.timer.clearTimeout(t)
          this.timers.delete(workspaceId)
        }
        return
      }
      case 'delete': {
        // workspace deletion: pod AND PVC go away
        await this.controller.deletePod(this.opts.namespace, workspaceId)
        await this.controller.deletePvc(workspaceId)
        const t = this.timers.get(workspaceId)
        if (t !== undefined) {
          this.timer.clearTimeout(t)
          this.timers.delete(workspaceId)
        }
        return
      }
    }
  }
}

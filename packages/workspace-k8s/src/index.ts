/**
 * dsh-workspace-k8s: workspace execution pod lifecycle owner.
 * Provides ctx.workspaceRuntime with ensure/dispose/getEndpoint for a
 * config-driven workspace pod, and wires the confirmed lifecycle state
 * machine (PROVISION/RUNNING/SLEEP/DELETED, idle 5min / lingering-command
 * 3h grace, turn-boundary awareness, command activity tracking).
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { K8sPodController, type PodController, type WorkspacePodSpec } from './k8s-client.ts'
import { ApiProxyWorkspaceRegistry } from './registry.ts'
import { WorkspaceReconciler } from './reconciler.ts'
import { wireWorkspaceLifecycle } from './wire.ts'

export const name = '@visecy/dsh-workspace-k8s'

export interface Config {
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
  /** Registry bridge interval (ms). 0 disables the periodic pass. */
  reconcileIntervalMs?: number
  /** Injectable controller for tests; defaults to the real k8s client. */
  controller?: PodController
}

export interface WorkspaceRuntime {
  ensure(workspaceId: string): Promise<string>
  dispose(workspaceId: string): Promise<void>
  getEndpoint(workspaceId: string): string
  isRunning(workspaceId: string): boolean
}

export class WorkspaceRuntimeService extends Service implements WorkspaceRuntime {
  private controller: PodController
  private running = new Set<string>()
  private inflight = new Map<string, Promise<string>>()

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'workspaceRuntime')
    this.controller = config.controller ?? this.makeController()
  }

  /** The pod controller (shared with the lifecycle manager wiring). */
  get podController(): PodController {
    return this.controller
  }

  private makeController(): PodController {
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    return new K8sPodController(kc, {
      namespace: this.config.namespace,
      storageClassName: this.config.storageClassName,
      storageSize: this.config.storageSize,
    })
  }

  async ensure(workspaceId: string): Promise<string> {
    const existing = this.inflight.get(workspaceId)
    if (existing !== undefined) return existing
    const promise = this.doEnsure(workspaceId)
    this.inflight.set(workspaceId, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(workspaceId)
    }
  }

  private async doEnsure(workspaceId: string): Promise<string> {
    // Per-workspace PVC: reuse the configured one or create <id>-data.
    const pvcName = this.config.pvcName ?? (await this.controller.ensurePvc(workspaceId))
    const spec: WorkspacePodSpec = {
      namespace: this.config.namespace,
      workspaceId,
      image: this.config.image,
      daemonPort: this.config.daemonPort ?? 4390,
      pvcName,
      resources: this.config.resources,
      storageClassName: this.config.storageClassName,
      storageSize: this.config.storageSize,
    }
    const name = await this.controller.ensurePod(spec)
    await this.controller.waitReady(this.config.namespace, name)
    this.running.add(workspaceId)
    return this.controller.endpoint(this.config.namespace, workspaceId, spec.daemonPort)
  }

  async dispose(workspaceId: string): Promise<void> {
    await this.controller.deletePod(this.config.namespace, workspaceId)
    this.running.delete(workspaceId)
  }

  getEndpoint(workspaceId: string): string {
    return this.controller.endpoint(this.config.namespace, workspaceId, this.config.daemonPort ?? 4390)
  }

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Service constructor already registers under 'workspaceRuntime'; providing
  // again would collide with the auto-registration.
  const runtime = new WorkspaceRuntimeService(ctx, config)

  // Plan 2 wiring: session/turn events -> state machine + per-workspace
  // endpoint resolution for the fs/subprocess providers.
  // Sleep drain: stop accepting new work in the pod and force-terminate any
  // lingering commands. The daemon route already exists (commands.killAll).
  const onBeforeSleep = async (endpoint: string): Promise<void> => {
    try {
      await fetch(`${endpoint}/commands/terminate-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graceMs: 300 }),
      })
    } catch {
      // The pod may already be gone; the delete path is idempotent.
    }
  }

  const { resolveEndpoint, commandTracker, deleteWorkspace } = wireWorkspaceLifecycle(ctx, {
    lifecycle: {
      controller: runtime.podController,
      namespace: config.namespace,
      image: config.image,
      daemonPort: config.daemonPort ?? 4390,
      storageClassName: config.storageClassName,
      storageSize: config.storageSize,
      idleTimeoutMs: config.idleTimeoutMs,
      graceMs: config.graceMs,
      onBeforeSleep,
    },
    runtime,
  })
  ctx.provide('workspaceEndpointResolver', { resolve: resolveEndpoint })
  ctx.provide('workspaceCommandTracker', commandTracker)

  // Official dsh registry bridge + reconciler: k8s resources are authoritative;
  // the registry is only what the frontend/session.create consume.
  const registry = new ApiProxyWorkspaceRegistry(
    { get: (name) => ctx.get(name) },
    '/workspaces',
  )
  const reconciler = new WorkspaceReconciler({
    controller: runtime.podController,
    registry,
    namespace: config.namespace,
    hostRoot: '/workspaces',
    onDelete: (workspaceId) => deleteWorkspace(workspaceId),
  })
  ctx.provide('workspaceReconciler', { reconcile: () => reconciler.reconcile() })
  ctx.provide('workspaceDeleter', {
    delete: async (workspaceId: string): Promise<void> => {
      await registry.delete(workspaceId).catch(() => undefined)
      deleteWorkspace(workspaceId)
    },
  })
  void reconciler.reconcile()

  const intervalMs = config.reconcileIntervalMs ?? 60_000
  if (intervalMs > 0) {
    const timer = setInterval(() => { void reconciler.reconcile() }, intervalMs)
    timer.unref?.()
  }
}

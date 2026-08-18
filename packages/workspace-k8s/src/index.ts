/**
 * dsh-workspace-k8s (v1 minimal): workspace execution pod lifecycle owner.
 * Provides ctx.workspaceRuntime with ensure/dispose/getEndpoint for a
 * config-driven workspace pod. The full state machine (PROVISION/RUNNING/
 * SLEEP/DELETED, idle detection, 3h grace) lands in Plan 2.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { K8sPodController, type PodController, type WorkspacePodSpec } from './k8s-client.ts'
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
  graceMs?: number
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
    // Per-workspace PVC: reuse the configured one or create dsh-ws-<id>-data.
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

  // Plan 2 wiring: session events -> state machine + per-workspace endpoint
  // resolution for the fs/subprocess providers.
  const { resolveEndpoint } = wireWorkspaceLifecycle(ctx, {
    lifecycle: {
      controller: runtime.podController,
      namespace: config.namespace,
      image: config.image,
      daemonPort: config.daemonPort ?? 4390,
      storageClassName: config.storageClassName,
      storageSize: config.storageSize,
      graceMs: config.graceMs,
    },
    runtime,
  })
  ctx.provide('workspaceEndpointResolver', { resolve: resolveEndpoint })
}
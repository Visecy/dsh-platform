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
import { registerWorkspaceApi } from './api.ts'
import { WorkspaceManagement } from './management.ts'
import { WorkspaceMetricsSampler } from './metrics.ts'
import { HostWorkspaceRegistry } from './registry.ts'
import { WorkspaceRecordDeletions } from './record-deletions.ts'
import { WorkspaceReconciler, type SessionHeaderSource } from './reconciler.ts'
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
  runtimeClassName?: string
  /** Idle timeout with no lingering commands. Default 5 minutes. */
  idleTimeoutMs?: number
  /** Lingering-command grace before force termination. Default 3 hours. */
  graceMs?: number
  /** Metrics sampling interval (metrics.k8s.io). Default 15s. */
  metricIntervalMs?: number
  /** Registry bridge interval (ms). 0 disables the periodic pass. */
  reconcileIntervalMs?: number
  /**
   * Control-plane directory the workspace anchors live in, and the canonical
   * spelling every session `cwd` must have to belong to a platform workspace.
   * Defaults to `/workspaces`, the mount the deployment provides.
   */
  hostRoot?: string
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
  private podIps = new Map<string, string>()

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
    if (this.controller.getPodIp !== undefined) {
      const ip = await this.controller.getPodIp(this.config.namespace, name)
      this.podIps.set(workspaceId, ip)
    }
    this.running.add(workspaceId)
    return this.getEndpoint(workspaceId)
  }

  /**
   * Tear the workspace's execution world down completely: its pod, its
   * headless service and its PVC.
   *
   * This is the runtime's DISPOSE, not its sleep: `WorkspaceLifecycleManager`
   * owns the sleep path (pod gone, PVC kept) and is the only caller that should
   * ever want to keep a workspace's data. Removing only the pod here left the
   * volume behind, and a surviving PVC is exactly what the reconciler treats as
   * a real workspace — so the next pass re-registered the workspace the caller
   * had just disposed of.
   */
  async dispose(workspaceId: string): Promise<void> {
    await this.controller.deletePod(this.config.namespace, workspaceId)
    await this.controller.deletePvc(workspaceId)
    this.running.delete(workspaceId)
    this.podIps.delete(workspaceId)
  }

  /**
   * Whether an ensure for this workspace is in flight right now. The
   * image-drift pass must not recycle a pod that is being created (it would
   * undo the create or race its delete).
   */
  isEnsuring(workspaceId: string): boolean {
    return this.inflight.has(workspaceId)
  }

  getEndpoint(workspaceId: string): string {
    const ip = this.podIps.get(workspaceId)
    const port = this.config.daemonPort ?? 4390
    return ip !== undefined ? `http://${ip}:${port}` : this.controller.endpoint(this.config.namespace, workspaceId, port)
  }

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId)
  }
}

export function apply(ctx: Context, config: Config | undefined): void {
  // The same package is mounted twice in the web profile: once as the host
  // workspace-runtime row (with config) and once as the client bundle row
  // (workspace-ui, without host config). Only the configured row owns the
  // host services; the client row only contributes the browser bundle.
  if (config === undefined || Object.keys(config).length === 0) return
  // Service constructor already registers under 'workspaceRuntime'; providing
  // again would collide with the auto-registration.
  const runtime = new WorkspaceRuntimeService(ctx, config)

  // Plan 2 wiring: session/turn events -> state machine + per-workspace
  // endpoint resolution for the fs/subprocess providers.
  // Sleep drain: stop accepting new work in the pod and force-terminate any
  // lingering commands. The daemon route already exists (commands.killAll).
  /**
   * Graceful drain before a pod goes away: stop accepting work, then force
   * any lingering command to terminate.
   *
   * Bounded on purpose. The drain is politeness, the pod deletion behind it is
   * the actual operation, and an unreachable daemon (DNS that never answers, a
   * pod that is already half-dead) must not delay a sleep — or, with the grace
   * timer expired, block the lifecycle action forever.
   */
  const onBeforeSleep = async (endpoint: string): Promise<void> => {
    try {
      await fetch(`${endpoint}/commands/terminate-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graceMs: 300 }),
        signal: AbortSignal.timeout(2_000),
      })
    } catch {
      // The pod may already be gone; the delete path is idempotent.
    }
  }

  // Official dsh workspace registry bridge + reconciler: k8s resources are
  // authoritative; the registry is only what the frontend/session.create
  // consume. DSH 0.1.2 removed apiProxy.workspace.*; the bridge now writes
  // host-to-host through ctx.workspaceRegistry (dsh-workspace) and the
  // official workspace controller serves the browser from the same records.
  //
  // Built BEFORE the lifecycle wiring because the endpoint resolver needs it:
  // the resolver refuses to provision a workspace id no record describes, which
  // is what keeps an ordinary directory under the host root from becoming a
  // workspace (see WireOptions.knownWorkspace).
  const hostRoot = config.hostRoot ?? '/workspaces'
  const registry = new HostWorkspaceRegistry(
    { get: (name) => ctx.get(name) },
    hostRoot,
  )

  const { resolveEndpoint, commandTracker, deleteWorkspace, attach, sleepWorkspace, reconcileImages, status: workspaceStatus } = wireWorkspaceLifecycle(ctx, {
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
      // Detached lifecycle actions (an idle sleep, a drift recycle, a lost pod)
      // have no caller left to reject to; without a sink their failures were
      // invisible, and the sink only exists since DSH 0.2 removed the last one.
      logger: ctx.logger,
      isEnsuring: (workspaceId) => runtime.isEnsuring(workspaceId),
    },
    runtime,
    // "Registered" means the official registry lists a record for it. A listing
    // that FAILS is not an answer, so the rejection propagates to the resolver's
    // own `catch`, which proceeds: the fence stops a phantom workspace, it does
    // not gate the file view on the registry being up.
    knownWorkspace: async (workspaceId) => (await registry.list()).some((ws) => ws.workspaceId === workspaceId),
  })
  ctx.provide('workspaceEndpointResolver', { resolve: resolveEndpoint })
  ctx.provide('workspaceCommandTracker', commandTracker)
  ctx.provide('workspaceStatus', workspaceStatus)

  // The session store is the join key for the association repair: durable
  // session headers carry the `cwd` each stored session was created in.
  //
  // Read it through `ctx.get`, NOT through the `ctx.sessionPersistence` proxy,
  // and deliberately do NOT declare `sessionPersistence` in this plugin's
  // `inject`:
  //
  //  - A hard inject gates this plugin's WHOLE activation (pod lifecycle,
  //    endpoint resolver, workspace API routes, reconciler) on a storage row
  //    that has nothing to do with the k8s resources it owns. The shipped
  //    profiles mount `workspace-runtime` BEFORE `session-persistence-rdb`, so
  //    the plugin would simply sit pending until the store row activates, and a
  //    composition without that row would lose the workspace runtime entirely.
  //  - `ctx.get` is the inject-free read the proxy error message points at. The
  //    proxy THROWS for a service the fiber does not inject (and a sibling row's
  //    service is not reachable through the parent walk), which is exactly how
  //    every rebind pass died with `cannot get property "sessionPersistence"
  //    without inject` while the failure was swallowed by a sink-less logger.
  //  - Resolving per pass (never cached) means a store that appears later is
  //    picked up without re-activating this plugin, and a torn view is never
  //    held across passes. `strict: false` accepts a registered provider whose
  //    fiber is still initializing — its own `list()` awaits its readiness —
  //    instead of reporting the composition as missing a row it has.
  const sessionHeaders: SessionHeaderSource = {
    list: async () => {
      const persistence = ctx.get('sessionPersistence', false) as SessionHeaderSource | undefined
      if (persistence === undefined) {
        // Naming the service is the point: "no session source" and "no sessions
        // to rebind" are otherwise indistinguishable, and the pass reports this
        // once per uninterrupted occurrence rather than on every tick.
        throw new Error("the 'sessionPersistence' service is not provided by this composition")
      }
      return await persistence.list()
    },
  }

  /**
   * The official sidebar's delete is record-only, so the deletion itself is
   * the only signal that the workspace is gone. `domain/changed` is the
   * documented event the official storage-domain facility emits per durable
   * write, and the official workspace registry persists through it — which
   * makes a `deleted` event for a mapped record the one supported statement of
   * "an operator deleted this workspace". See `record-deletions.ts` for the
   * discriminator this relies on and the ambiguity it refuses to guess at.
   */
  const recordDeletions = new WorkspaceRecordDeletions({
    hostRoot,
    // The k8s half only: the record is already gone (that is what fired the
    // event), so this must not touch the registry.
    destroy: (workspaceId) => deleteWorkspace(workspaceId),
    logger: ctx.logger,
  })
  ctx.on('domain/changed', (change: unknown) => recordDeletions.handle(change))

  const reconciler = new WorkspaceReconciler({
    controller: runtime.podController,
    registry,
    sessions: sessionHeaders,
    namespace: config.namespace,
    hostRoot,
    // Every rebind failure used to return in silence, which is why the live
    // deployment's missing associations were undiagnosable from the pod logs.
    logger: ctx.logger,
    // The pass is also the retry loop for a deletion whose PVC removal failed,
    // and the guard that keeps such a workspace from being adopted back.
    condemned: recordDeletions,
  })
  ctx.provide('workspaceReconciler', { reconcile: () => reconciler.reconcile() })
  /**
   * Delete a workspace for real: the durable backing first (pod, service,
   * PVC), the registry record only after it is gone.
   *
   * The order is the whole point. The reconciler re-registers every workspace
   * a surviving PVC describes, so dropping the record first opens a window in
   * which the next pass re-creates the workspace out of the volume that has
   * not been deleted yet — "delete does nothing". With the volume gone there is
   * nothing left to re-register, and a failure to delete it rejects instead of
   * being swallowed, so the caller never reports a deletion that did not
   * happen.
   */
  const deleteWorkspaceAsync = async (workspaceId: string): Promise<void> => {
    await deleteWorkspace(workspaceId)
    await registry.delete(workspaceId)
  }
  ctx.provide('workspaceDeleter', {
    delete: deleteWorkspaceAsync,
  })

  // Metrics sampling (metrics.k8s.io) for the status page; frozen while a
  // workspace sleeps so the UI does not jump.
  const metricsSampler = new WorkspaceMetricsSampler({
    controller: runtime.podController,
    namespace: config.namespace,
    intervalMs: config.metricIntervalMs,
    limits: config.resources,
  })
  metricsSampler.start()
  ctx.on('dispose', () => metricsSampler.stop())

  const management = new WorkspaceManagement({
    controller: runtime.podController,
    registry,
    status: workspaceStatus,
    metrics: metricsSampler,
    namespace: config.namespace,
    hostRoot,
    image: config.image,
    storageClassName: config.storageClassName,
    storageSize: config.storageSize,
    runtimeClassName: config.runtimeClassName,
    resources: config.resources,
    idleTimeoutMs: config.idleTimeoutMs,
    graceMs: config.graceMs,
    deleteWorkspace: deleteWorkspaceAsync,
    ensureWorkspace: async (workspaceId) => {
      const endpoint = await runtime.ensure(workspaceId)
      // Drive the state machine: sleep -> waking/provision, then pod-ready
      // via the manager's own (idempotent) ensure path.
      attach(workspaceId)
      return endpoint
    },
    sleepWorkspace: (workspaceId) => sleepWorkspace(workspaceId),
  })
  ctx.provide('workspaceManagement', management)

  // Register routes only when the Web carrier is present. Using ctx.inject
  // (rather than a load-time ctx.get) lets cordis defer this block until
  // after the webserver service has actually been constructed.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer') as { register(route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => unknown }): () => void } | undefined
    if (webServer === undefined) return
    ctx.effect(() => registerWorkspaceApi(webServer, management), 'dsh-workspace-k8s: /workspaces/api routes')
  })

  // The reconcile pass must not wait for the interval. It is the only creator
  // of the `/workspaces/<id>` anchors the official registry validates every
  // stored session header against, and that validation is one-shot: a session
  // whose cwd does not resolve at registry init is left out of the grouping and
  // can only be repaired by a rebind afterwards.
  const runReconcile = (): void => {
    // A reconcile failure (no k8s API yet, registry still opening its domain,
    // session store unreachable) must never fail plugin load: the timer below
    // retries, and every step of the pass is idempotent.
    void reconciler.reconcile().catch((error: unknown) => {
      ctx.logger?.warn?.(`workspace reconcile pass failed: ${String(error)}`)
    })
    // Same cadence, same reason: converge running pods onto the configured
    // daemon image. It is a separate pass because it must NOT share the
    // registry pass's failure (a registry that cannot be listed must not stop
    // the fleet from converging, and vice versa).
    void reconcileImages().catch((error: unknown) => {
      ctx.logger?.warn?.(`workspace image reconcile pass failed: ${String(error)}`)
    })
  }
  runReconcile()
  // Second chance, and the one that actually repairs on a normal boot: the pass
  // above can run while the official registry is still invisible, because
  // `ctx.get` only exposes it after its async `Service.init()` (storage open,
  // header index, history bootstrap) has finished.
  ctx.inject(['workspaceRegistry'], () => runReconcile())

  const intervalMs = config.reconcileIntervalMs ?? 60_000
  if (intervalMs > 0) {
    const timer = setInterval(runReconcile, intervalMs)
    timer.unref?.()
  }
}

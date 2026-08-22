/**
 * Workspace reconciler: keeps the official dsh workspace registry in sync
 * with the k8s execution resources.
 *
 * k8s is authoritative, so a workspace that exists as a pod or PVC but is
 * missing from the official registry is bridged back into `workspace.list`.
 * This restores the frontend menu after a control-plane restart.
 *
 * When a workspace is REMOVED from the registry after a synced pass (i.e. the
 * earlier pass actually saw it in the registry), the reconciler reclaims its
 * managed k8s resources (pod + PVC) via the lifecycle deleter. The first-pass
 * guard prevents an empty/lost registry from wiping PVCs on cold start.
 */
import type { PodController } from './k8s-client.ts'
import type { WorkspaceRegistry } from './registry.ts'

export interface ReconcilerOptions {
  controller: PodController
  registry: WorkspaceRegistry
  namespace: string
  hostRoot: string
  onDelete?: (workspaceId: string) => void
}

function pvcToWorkspaceId(name: string): string {
  return name.endsWith('-data') ? name.slice(0, -5) : name
}

export class WorkspaceReconciler {
  private knownIds = new Set<string>()
  private hasSynced = false

  constructor(private opts: ReconcilerOptions) {}

  async reconcile(): Promise<void> {
    const { controller, registry, namespace, hostRoot } = this.opts
    if (controller.listPods === undefined || controller.listPvcs === undefined) return

    const [registered, pods, pvcs] = await Promise.all([
      registry.list().catch(() => []),
      controller.listPods(namespace).catch(() => []),
      controller.listPvcs(namespace).catch(() => []),
    ])

    const currentKnown = new Set(registered.map((ws) => ws.workspaceId))
    const resources = new Set<string>([...pods, ...pvcs.map(pvcToWorkspaceId)])

    // Reclaim resources whose official registry entry was explicitly removed.
    // Only after a synced pass: a fresh restart with an empty/lost registry
    // alone must never be interpreted as mass deletion.
    const reclaiming = new Set<string>()
    if (this.hasSynced) {
      for (const id of resources) {
        if (!currentKnown.has(id) && this.knownIds.has(id)) {
          reclaiming.add(id)
          try {
            this.opts.onDelete?.(id)
          } catch {
            // Deleting is best-effort; a later pass can retry.
          }
        }
      }
    }

    // Bridge remaining missing k8s resources back into the official registry.
    // Deleted workspaces are not re-created on this pass.
    for (const id of resources) {
      if (currentKnown.has(id) || reclaiming.has(id)) continue
      try {
        await registry.create(`${hostRoot}/${id}`)
        currentKnown.add(id)
      } catch {
        // A failed bridge-creation must not block the rest of reconciliation;
        // it will be retried on the next pass.
      }
    }

    this.knownIds = new Set(currentKnown)
    this.hasSynced = currentKnown.size > 0
  }
}

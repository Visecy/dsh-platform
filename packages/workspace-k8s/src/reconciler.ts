/**
 * Workspace reconciler: keeps the official dsh workspace registry in sync
 * with the k8s execution resources.
 *
 * k8s is authoritative, so a workspace that exists as a pod or PVC but is
 * missing from the official registry is bridged back into `workspace.list`.
 * This restores the frontend menu after a control-plane restart.
 *
 * Deletion is intentionally explicit (workspaceDeleter) rather than diff-driven:
 * a transient registry-list failure or empty/lost registry must never be
 * interpreted as mass deletion.
 */
import type { PodController } from './k8s-client.ts'
import type { WorkspaceRegistry } from './registry.ts'

export interface ReconcilerOptions {
  controller: PodController
  registry: WorkspaceRegistry
  namespace: string
  hostRoot: string
}

function pvcToWorkspaceId(name: string): string {
  return name.endsWith('-data') ? name.slice(0, -5) : name
}

export class WorkspaceReconciler {
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

    // Bridge missing k8s resources back into the official registry.
    for (const id of resources) {
      if (currentKnown.has(id)) continue
      try {
        await registry.create(`${hostRoot}/${id}`)
        currentKnown.add(id)
      } catch {
        // A failed bridge-creation must not block the rest of reconciliation;
        // it will be retried on the next pass.
      }
    }
  }
}

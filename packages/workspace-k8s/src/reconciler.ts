/**
 * Workspace reconciler: keeps the official dsh workspace registry in sync
 * with the k8s execution resources, and repairs the session<->workspace
 * association that only the registry's records hold.
 *
 * k8s is authoritative, so a workspace that exists as a pod or PVC but is
 * missing from the official registry is bridged back into `workspace.list`.
 * This restores the frontend menu after a control-plane restart.
 *
 * Deletion is intentionally explicit (workspaceDeleter) rather than diff-driven:
 * a transient registry-list failure or empty/lost registry must never be
 * interpreted as mass deletion.
 */
import { mkdir, realpath } from 'node:fs/promises'
import type { PodController } from './k8s-client.ts'
import type { SessionRebind, WorkspaceRegistry } from './registry.ts'

/**
 * The slice of `ctx.sessionPersistence` the rebind needs: one snapshot per
 * stored session. `list()` returns them in no promised order, so the rebind
 * sorts by header `createdAt` itself.
 */
export interface SessionHeaderSource {
  list(): Promise<readonly { readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt: number } }[]>
}

export interface ReconcilerOptions {
  controller: PodController
  registry: WorkspaceRegistry
  /** Durable session headers; the join key for the association repair. */
  sessions: SessionHeaderSource
  namespace: string
  hostRoot: string
}

function pvcToWorkspaceId(name: string): string {
  return name.endsWith('-data') ? name.slice(0, -5) : name
}

/**
 * Canonicalize a stored session `cwd` exactly the way the official registry
 * does before it compares against a record path (`realpath`, both spellings
 * fully qualified). A cwd that does not resolve is not this pass's business:
 * the official attach would reject it, so the session is skipped.
 */
async function canonicalPath(path: string): Promise<string | undefined> {
  if (!path.startsWith('/')) return undefined
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
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
    // Only resources backed by a PVC are real workspaces. Pod-only resources
    // are stale prototypes/orphans and must NOT be auto-adopted; they are
    // surfaced for manual cleanup instead.
    const pvcIds = new Set(pvcs.map(pvcToWorkspaceId))
    const resources = new Set(pvcIds)
    for (const pod of pods) {
      if (pvcIds.has(pod)) resources.add(pod)
    }

    // Bridge missing k8s resources back into the official registry.
    for (const id of resources) {
      if (currentKnown.has(id)) continue
      try {
        // workspace.create validates with fs.realpath, so a missing host-side
        // anchor would make a legitimately-existing pod/PVC fail forever.
        // The anchor is best-effort: if the control plane cannot create it,
        // registry.create will fail and the reconciler will retry later.
        await mkdir(`${hostRoot}/${id}`, { recursive: true }).catch(() => undefined)
        await registry.create(`${hostRoot}/${id}`)
        currentKnown.add(id)
      } catch {
        // A failed bridge-creation must not block the rest of reconciliation;
        // it will be retried on the next pass.
      }
    }

    await this.rebindSessions(registered, hostRoot)
  }

  /**
   * Re-derive the session<->workspace membership from the durable join key
   * (session header `cwd` <-> record `path`).
   *
   * The association lives ONLY in the official record's `sessionIds`, which is
   * index-filtered on read and pruned on every write, so a workspace whose
   * anchor was missing at registry-init time reads as empty forever. This pass
   * repairs that — for deployments already broken by it, not just for new
   * ones — and it is idempotent: a membership already in rebind order costs
   * zero writes.
   */
  private async rebindSessions(registered: readonly { workspaceId: string; path: string }[], hostRoot: string): Promise<void> {
    const { registry, sessions } = this.opts
    // Without the durable session store there is no join key; never invent one.
    if (sessions === undefined || registered.length === 0) return

    let headers: readonly { readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt: number } }[]
    try {
      headers = await sessions.list()
    } catch {
      // A storage fault must not be mistaken for "no sessions": skip the pass
      // and let the next tick retry.
      return
    }

    // Canonicalize the root the same way the sessions are: an anchor created by
    // the control plane's own mount always exists, so this only ever rescues a
    // root whose spelling is not canonical (a symlinked /workspaces would
    // otherwise make every cwd look like it belongs outside the platform).
    const root = await realpath(hostRoot).catch(() => undefined)
    if (root === undefined) return

    // Group the sessions this pass may touch by their canonical cwd. A cwd
    // outside the host root cannot belong to a platform workspace.
    const byPath = new Map<string, SessionRebind[]>()
    for (const snapshot of headers) {
      const { id, cwd, createdAt } = snapshot.header
      if (cwd === undefined) continue
      const path = await canonicalPath(cwd)
      if (path === undefined || !path.startsWith(root + '/')) continue
      const bucket = byPath.get(path)
      const entry: SessionRebind = { id, path, createdAt }
      if (bucket === undefined) byPath.set(path, [entry])
      else bucket.push(entry)
    }
    if (byPath.size === 0) return

    // One session id may satisfy the join key for at most one record: the
    // official registry rejects a stored state where two workspaces account
    // for the same session. Seeding the set with the sessions already attached
    // keeps their relative (newest-first) order stable across passes.
    const claimed = new Set<string>()
    for (const workspace of registered) {
      const sessionsForPath = byPath.get(workspace.path)
      if (sessionsForPath === undefined) continue
      // Oldest-first: the official attach prepends, so replaying history in
      // creation order leaves the membership newest-first.
      const candidates = sessionsForPath
        .filter((session) => !claimed.has(session.id))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      if (candidates.length === 0) continue
      try {
        const attached = await registry.rebind(workspace.path, candidates)
        for (const id of attached) claimed.add(id)
      } catch {
        // One unrepairable workspace (missing anchor, session persistence
        // miss) must not abort the rest; the next pass retries it.
      }
    }
  }
}

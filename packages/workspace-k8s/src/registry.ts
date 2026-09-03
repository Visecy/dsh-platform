/**
 * Workspace registry bridge (DSH 0.1.2).
 *
 * Frontend menus, session.create and the official workspace controller
 * consume the OFFICIAL `ctx.workspaceRegistry` (dsh-workspace: durable
 * workspace records over the domain data form), so the platform keeps it as a
 * thin bridge while k8s remains the source of truth for execution resources.
 *
 * 0.1.2 delta: the old `apiProxy.workspace.*` RPC surface was removed (the
 * release notes: "旧版 APIProxy 已迁移并移除"); the browser-facing remote is
 * now the official workspace controller over the SAME host registry, so the
 * bridge talks host-to-host to `ctx.workspaceRegistry` directly.
 *
 * Both directions are reconciled by the reconciler: registry records keyed by
 * official UUID over canonical paths (`fs.realpath`), platform ids are the
 * stable path segment (/workspaces/<id>) that is also the pod name, cwd
 * segment and PVC name — the bridge maps between the two.
 */

export interface RegistryWorkspace {
  workspaceId: string
  path: string
  title?: string
  /** Opaque id used by the official registry API (may differ from the platform id). */
  internalId?: string
}

export interface WorkspaceRegistry {
  list(): Promise<RegistryWorkspace[]>
  create(path: string): Promise<RegistryWorkspace>
  delete(workspaceId: string): Promise<void>
}

/** Duck-typed official workspace registry surface (dsh-workspace 0.1.2). */
interface OfficialWorkspaceRegistry {
  /** Create or reuse the workspace owning an EXISTING canonical directory. */
  create(path: string, title?: string): Promise<OfficialWorkspace>
  /** Synchronous durable-order projection. */
  list(): readonly OfficialWorkspace[]
  /** Delete one registration (retains the directory and session logs). */
  delete(id: string): Promise<boolean>
}

/** One official registry row: UUID id + canonical path (realpath). */
interface OfficialWorkspace {
  id: string
  path: string
  title?: string
}

function pathSegment(path: string, hostRoot: string): string {
  if (path.startsWith(hostRoot + '/')) {
    const rest = path.slice(hostRoot.length + 1)
    const seg = rest.split('/')[0]
    if (seg !== '') return seg
  }
  // Foreign/default rows (e.g. a root row at '/') have no platform segment.
  return path.split('/').filter(Boolean)[0] ?? ''
}

export class HostWorkspaceRegistry implements WorkspaceRegistry {
  constructor(
    private channel: { get: <T>(name: string) => T | undefined },
    private hostRoot: string,
  ) {}

  private official(): OfficialWorkspaceRegistry | undefined {
    return this.channel.get('workspaceRegistry') as OfficialWorkspaceRegistry | undefined
  }

  private mapRow(ws: OfficialWorkspace): RegistryWorkspace {
    return {
      workspaceId: pathSegment(ws.path, this.hostRoot),
      path: ws.path,
      title: ws.title,
      internalId: ws.id,
    }
  }

  async list(): Promise<RegistryWorkspace[]> {
    const registry = this.official()
    if (registry === undefined) return []
    try {
      return registry
        .list()
        .filter((ws) => ws.path === this.hostRoot || ws.path.startsWith(this.hostRoot + '/'))
        .map((ws) => this.mapRow(ws))
    } catch {
      // A failing registry (storage fault) must never be mistaken for an
      // empty one by the reconciler; surface the failure so the reconcile
      // pass skips and retries.
      throw new Error('workspace registry unavailable')
    }
  }

  async create(path: string): Promise<RegistryWorkspace> {
    const registry = this.official()
    if (registry === undefined) throw new Error('workspace registry unavailable')
    // create validates via fs.realpath and rejects nonexistent paths; the
    // caller (reconciler/management) creates the anchor directory first.
    const ws = await registry.create(path)
    return this.mapRow(ws)
  }

  async delete(workspaceId: string): Promise<void> {
    const registry = this.official()
    if (registry === undefined) return
    // The official registry keys records by UUID; the platform id is the
    // path segment, so resolve the record before deleting. When the row is
    // gone or foreign, fall back to a direct delete (unknown ids are an
    // idempotent no-op on the official side).
    const rows = await this.list().catch(() => [])
    const row = rows.find((r) => r.workspaceId === workspaceId || r.path.endsWith('/' + workspaceId))
    await registry.delete(row?.internalId ?? workspaceId)
  }
}

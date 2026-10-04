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
 *
 * The bridge also owns the only repair path for the session<->workspace
 * association: `rebind()` re-attaches sessions through the official entity so
 * its canonical-cwd index is refreshed. See {@link WorkspaceRegistry.rebind}.
 */

export interface RegistryWorkspace {
  workspaceId: string
  path: string
  title?: string
  /** Opaque id used by the official registry API (may differ from the platform id). */
  internalId?: string
}

/**
 * One session to (re)bind to the workspace that owns its `cwd`.
 *
 * `path` must already be canonical (`fs.realpath`): the official registry
 * compares it against record paths verbatim. `createdAt` (epoch ms) is the
 * ordering key — the rebind attaches oldest-first.
 */
export interface SessionRebind {
  id: string
  path: string
  createdAt: number
}

export interface WorkspaceRegistry {
  list(): Promise<RegistryWorkspace[]>
  create(path: string): Promise<RegistryWorkspace>
  delete(workspaceId: string): Promise<void>
  /**
   * Restore the session<->workspace association on the official record.
   *
   * The association lives ONLY in the record's `sessionIds`, and the official
   * registry filters that array on read by a canonical-cwd index it builds
   * once, at init. Any session whose `cwd` did not resolve at that moment is
   * therefore invisible — and is pruned from the medium by the next write. A
   * rebind is the only repair: an official `attachSession` refreshes that index
   * (`rememberSessionPath`) and prepends the id, but it short-circuits when the
   * record already claims the session, so the caller's id must be detached
   * first or the index is never refreshed.
   *
   * @returns the session ids actually attached, in final (newest-first) order.
   */
  rebind(workspacePath: string, sessions: readonly SessionRebind[]): Promise<string[]>
}

/** Duck-typed official workspace registry surface (dsh-workspace 0.1.2). */
interface OfficialWorkspaceRegistry {
  /** Create or reuse the workspace owning an EXISTING canonical directory. */
  create(path: string, title?: string): Promise<OfficialWorkspace>
  /** Synchronous durable-order projection. */
  list(): readonly OfficialWorkspace[]
  /** Delete one registration (retains the directory and session logs). */
  delete(id: string): Promise<boolean>
  /**
   * Resolve the record owning a canonical directory (dsh-workspace's
   * `resolveByPath`). Rejects while the path does not resolve; resolves
   * `undefined` for an existing directory no record owns.
   */
  resolveByPath(path: string): Promise<OfficialWorkspace | undefined>
}

/**
 * One official registry row: UUID id + canonical path (realpath) + the live
 * entity the registry hands back for session membership.
 */
interface OfficialWorkspace {
  id: string
  path: string
  title?: string
  /**
   * The record's session membership, filtered by the registry's cwd index —
   * an id whose `cwd` does not resolve right now is absent even though it is
   * still stored in the record.
   */
  readonly sessionIds?: readonly string[]
  /** Add a session to the record, refreshing the index and prepending the id. */
  attachSession?(sessionId: string): Promise<void>
  /** Remove a session from the record; the write prunes by the cwd index. */
  detachSession?(sessionId: string): Promise<void>
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
    // DSH 0.1.5's realpathNormalize rejects non-fully-qualified paths with a
    // TypeError BEFORE any I/O; fail with the platform's own actionable
    // message first so a caller passing a bare id is not left guessing.
    if (!path.startsWith('/')) {
      throw new Error(`workspace path must be absolute: ${JSON.stringify(path)}`)
    }
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

  async rebind(workspacePath: string, sessions: readonly SessionRebind[]): Promise<string[]> {
    const registry = this.official()
    if (registry === undefined || sessions.length === 0) return []
    // `resolveByPath` realpaths its argument, so a missing anchor rejects here
    // and the reconciler retries on its next pass.
    const entity = await registry.resolveByPath(workspacePath)
    if (entity === undefined) return []
    if (entity.attachSession === undefined || entity.detachSession === undefined) {
      throw new Error('workspace registry entity cannot attach sessions')
    }

    // `entity.sessionIds` is the record's membership filtered by the registry's
    // canonical-cwd index — and that index is exactly what a pod replacement
    // loses. An id absent here is invisible to the sidebar and is pruned from
    // the medium by the record's next write, so this getter is the honest
    // answer to "what does this record currently own?".
    const current = [...(entity.sessionIds ?? [])]
    // Oldest-first: `attachSession` prepends, so replaying history in creation
    // order leaves the membership newest-first, exactly like a live attach.
    const desired = [...sessions].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const wanted = desired.map((session) => session.id)
    const inScope = new Set(wanted)
    // Detaching pulls the in-scope ids out of the list, then each attach
    // prepends, so replaying oldest-first leaves the re-attached ids
    // newest-first at the FRONT and any membership outside this rebind's scope
    // (still indexed, attached through the ordinary controller path) behind
    // them. That is the state the record holds once this method returns.
    const next = [...desired.map((session) => session.id).reverse(), ...current.filter((id) => !inScope.has(id))]
    // Steady state: the record already owns exactly these sessions in this
    // order. Re-attaching would be idempotent, but it would still rewrite the
    // record (and its `updatedAt`) on every periodic pass.
    if (isSameOrder(current, next)) return current

    // The detach is NOT optional: `attachSession` short-circuits on an id the
    // record already claims, and only its other branch calls
    // `rememberSessionPath` — the index refresh that makes the membership
    // visible to the filtered getter again. Detach every id this rebind will
    // re-attach that the record can currently SEE (the filtered view). An id
    // the record claims but the index already hides must not be detached: that
    // write would prune it before the re-attach could refresh the index, which
    // is the durable half of this bug.
    for (const id of current) {
      if (inScope.has(id)) await entity.detachSession(id)
    }
    for (const id of wanted) await entity.attachSession(id)
    // Report what the record now owns, not the pre-prepend plan: attaches
    // prepend, so the entity's own order is the authoritative answer.
    return [...(entity.sessionIds ?? [])]
  }

}

/** Element-wise comparison: the rebind's no-op check, which keeps repeated passes free of writes. */
function isSameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

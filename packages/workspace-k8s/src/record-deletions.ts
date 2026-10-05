/**
 * Workspace record deletions: the one signal that means "this workspace was
 * deleted", and the destruction it authorizes.
 *
 * Two delete entry points exist in a deployment, and only one of them used to
 * delete the workspace:
 *
 *  - the platform's own delete (`workspaceDeleter`, the status panel's
 *    button) removes the pod, the headless service and the PVC, then the
 *    record — so nothing is left for the reconciler to read back;
 *  - the OFFICIAL sidebar's delete calls `ctx.workspaceRegistry.delete(id)`
 *    and nothing else. The record went, the volume stayed, and the next
 *    reconcile pass re-registered the workspace from that volume (measured
 *    live: it returned 68 seconds later).
 *
 * This module closes the second path from the only seam that can see it: the
 * documented `domain/changed` event. The official `dsh-storage-domain`
 * facility emits exactly one event per durable write, after durability, and
 * the official workspace registry (`@deepseek-ai/dsh-workspace`, domain
 * `workspace`, table `workspaces`) persists every record through it. Its keys
 * are the record uuids, so a `deleted` event for a key this process mapped to
 * a platform workspace id is a POSITIVE statement that an operator deleted
 * that workspace's record — the same act, whichever surface issued it.
 *
 * ## The discriminator (the ambiguity is real, so it is resolved explicitly)
 *
 * A PVC with no record can mean two different things:
 *
 *  1. "its record was just deleted" — the workspace is gone and its volume is
 *     now litter that must be destroyed (this is what the operator asked for
 *     twice); or
 *  2. "adopted from outside" — a volume that was never this platform's, or one
 *     whose record this process never saw.
 *
 * Destroying on the bare fact "a PVC has no record" cannot tell them apart,
 * and it would make a wiped/lost registry — or a registry that failed to list
 * once — a mass deletion of every volume on the cluster. So destruction
 * requires POSITIVE EVIDENCE: an observed `deleted` event for a record this
 * process had mapped to a platform workspace id. Everything else is branch 2:
 * the reconciler registers the volume (that is how the sidebar survives a
 * control-plane restart) and nothing is destroyed.
 *
 * Two consequences, both deliberate:
 *
 *  - A deletion this process never observed (the plugin was not mounted) is
 *    treated as adoption. The volume's data outlives every guess about why a
 *    record is missing.
 *  - The evidence is not durable. After a restart, the platform cannot
 *    reconstruct "an operator deleted this record at some point"; the operator
 *    deletes again, and this time it lands. That is the price of never
 *    destroying data on inference.
 *
 * ## Failure is a state, not an event
 *
 * A destroy that fails leaves the workspace CONDEMNED: its backing is still
 * there, so the reconciler must not adopt it back while it retries, and the
 * failure is reported through the platform's stdout logger row. The retry
 * rides the reconcile pass (`retry()`), so a transient cluster failure heals
 * by itself instead of silently resurrecting the workspace.
 *
 * One edge the condemnation deliberately does not cancel: re-creating a
 * workspace with the SAME id while its destroy is still pending re-condemns
 * the same volume on the next retry. The volume was already sentenced by an
 * explicit delete, and cancelling that because a new record appeared would be
 * the resurrection bug again, one layer down.
 */
import type { RegistryWorkspace } from './registry.ts'

/** The official workspace registry's durable domain name (`dsh-workspace`). */
const WORKSPACE_DOMAIN = 'workspace'
/** …and its record table. */
const WORKSPACE_TABLE = 'workspaces'

/** One `domain/changed` payload (the fields this module reads). */
export interface DomainChange {
  readonly domain: string
  readonly table: string
  readonly key: string
  readonly operation: string
  readonly value?: unknown
}

/** Where the pass's diagnostics go (the platform's stdout logger row). */
export interface DeletionLogger {
  warn(message: string): void
}

export interface RecordDeletionOptions {
  /** Control-plane root: only records under `<hostRoot>/<id>` are platform workspaces. */
  hostRoot: string
  /** Destroy a workspace's k8s backing (pod, service, PVC). Never touches the registry. */
  destroy: (workspaceId: string) => Promise<void>
  logger?: DeletionLogger
}

/** What the reconciler needs from this module, so the two stay independently testable. */
export interface CondemnedWitness {
  /** Merge the registry's current record projection (the uuid → workspace join). */
  observe(rows: readonly RegistryWorkspace[]): void
  /** Whether this workspace's record was deleted and its backing not yet destroyed. */
  isCondemned(workspaceId: string): boolean
  /** Retry the destroys that failed; resolves with one diagnostic per still-failing workspace. */
  retry(): Promise<readonly string[]>
}

export class WorkspaceRecordDeletions implements CondemnedWitness {
  /** Record uuid → platform workspace id, for records this process has seen. */
  private readonly mapped = new Map<string, string>()
  /**
   * Records that are NOT platform workspaces (a home directory, another
   * mount). Their deletion is not this plugin's business and must not be
   * reported as "a workspace I cannot identify".
   */
  private readonly foreign = new Set<string>()
  /** Workspaces whose record is gone but whose backing is still there. */
  private readonly condemned = new Set<string>()

  constructor(private readonly opts: RecordDeletionOptions) {}

  /** The platform workspace id a record path denotes, or undefined when foreign. */
  private workspaceIdOf(path: string): string | undefined {
    const prefix = this.opts.hostRoot.endsWith('/') ? this.opts.hostRoot : `${this.opts.hostRoot}/`
    if (!path.startsWith(prefix)) return undefined
    const segment = path.slice(prefix.length).split('/')[0]
    return segment === '' ? undefined : segment
  }

  private remember(key: unknown, path: unknown, internalId?: unknown): void {
    const id = typeof key === 'string' ? key : typeof internalId === 'string' ? internalId : undefined
    if (id === undefined || typeof path !== 'string') return
    const workspaceId = this.workspaceIdOf(path)
    if (workspaceId === undefined) this.foreign.add(id)
    else this.mapped.set(id, workspaceId)
  }

  /**
   * Merge the registry's current projection. Merging (never replacing) is what
   * keeps a listing failure — an empty array from the caller's `catch` — from
   * erasing the join a later deletion event depends on.
   * @param rows - the official registry's records.
   */
  observe(rows: readonly RegistryWorkspace[]): void {
    for (const row of rows) this.remember(row.internalId, row.path)
  }

  /** Whether this workspace's record was deleted and its backing not yet destroyed. */
  isCondemned(workspaceId: string): boolean {
    return this.condemned.has(workspaceId)
  }

  /**
   * The `domain/changed` listener. Synchronous by contract — the emit is
   * synchronous and a throw would reach the registry's own delete call — so
   * every outcome, including a destroy failure, is handled here and reported
   * through the logger.
   * @param change - the event payload (unknown: it arrives from another package).
   */
  handle(change: unknown): void {
    try {
      const event = change as Partial<DomainChange> | undefined
      if (event === null || typeof event !== 'object') return
      if (event.domain !== WORKSPACE_DOMAIN || event.table !== WORKSPACE_TABLE) return
      if (typeof event.key !== 'string' || event.key === '') return
      if (event.operation === 'put') {
        const value = event.value as { path?: unknown } | undefined
        this.remember(event.key, value?.path)
        return
      }
      if (event.operation !== 'deleted') return
      this.onDeleted(event.key)
    } catch (error) {
      this.report(`workspace record deletion: could not process a domain change: ${String(error)}`)
    }
  }

  /**
   * One explicit record deletion. This is the ONLY branch that destroys
   * anything, and it destroys only when the record's workspace is known: the
   * evidence is the deletion itself, never the mere existence of a volume.
   */
  private onDeleted(key: string): void {
    if (this.foreign.has(key)) return
    const workspaceId = this.mapped.get(key)
    if (workspaceId === undefined) {
      this.report(`workspace record '${key}' was deleted, but no workspace of this control plane maps to it; its k8s resources were left in place (they may belong to another platform)`);
      return
    }
    this.mapped.delete(key)
    this.condemned.add(workspaceId)
    void this.destroy(workspaceId)
  }

  /**
   * Destroy one condemned workspace's backing and lift the condemnation only
   * when it actually succeeded.
   * @param workspaceId - workspace whose record was deleted.
   * @returns resolution after the attempt (failures are reported, not thrown).
   */
  private async destroy(workspaceId: string): Promise<void> {
    try {
      await this.opts.destroy(workspaceId)
      this.condemned.delete(workspaceId)
    } catch (error) {
      this.report(`workspace '${workspaceId}': its record was deleted but destroying its pod/PVC failed: ${String(error)}; the reconciler will retry and will not re-register it`)
    }
  }

  /**
   * Retry every condemned workspace's destroy. Called from the reconcile pass,
   * so a cluster that refused the deletion is retried on the platform's own
   * cadence instead of resurrecting the workspace.
   * @returns one diagnostic per still-failing workspace, for the pass to report.
   */
  async retry(): Promise<readonly string[]> {
    const messages: string[] = []
    for (const workspaceId of [...this.condemned]) {
      try {
        await this.opts.destroy(workspaceId)
        this.condemned.delete(workspaceId)
      } catch (error) {
        messages.push(`workspace '${workspaceId}': destroying the backing of the deleted workspace failed: ${String(error)}`)
      }
    }
    return messages
  }

  /** Report one diagnostic without letting the report itself become a failure. */
  private report(message: string): void {
    try {
      this.opts.logger?.warn(message)
    } catch {
      // The deletion path matters more than the diagnostic.
    }
  }
}

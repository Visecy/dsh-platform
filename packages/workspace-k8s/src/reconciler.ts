/**
 * Workspace reconciler: keeps the official dsh workspace registry in sync
 * with the k8s execution resources, and repairs the session<->workspace
 * association that only the registry's records hold.
 *
 * k8s is authoritative, so a workspace that exists as a pod or PVC but is
 * missing from the official registry is bridged back into `workspace.list`.
 * This restores the frontend menu after a control-plane restart.
 *
 * The pass is not add-only. A record whose volume is gone is a workspace that
 * no longer exists — the shape a delete leaves when it destroys the PVC but the
 * record survives — and it used to stay on screen forever, because nothing ever
 * looked at a record again. Removing it is deliberately NARROWER than the
 * bridge: see {@link WorkspaceReconciler.pruneStaleRecords} for the
 * observation that has to hold first, and why the bare fact "no volume" cannot
 * authorize it.
 *
 * Deletion of the RUBBLE is separate and stays explicit (workspaceDeleter,
 * record-deletions): a transient registry-list failure or empty/lost registry
 * must never be interpreted as mass deletion.
 */
import { mkdir, realpath } from 'node:fs/promises'
import type { PodController } from './k8s-client.ts'
import type { SessionRebind, WorkspaceRegistry } from './registry.ts'

/**
 * The slice of `ctx.sessionPersistence` the rebind needs: one snapshot per
 * stored session. `list()` returns them in no promised order, so the rebind
 * sorts by header `createdAt` itself.
 *
 * The source is re-read on EVERY pass (never cached) and it is the source's job
 * to say why it is unavailable: `list()` must REJECT when there is no session
 * store to read, with an error that names the missing service. A pass that
 * cannot get a source and a pass that found no sessions are otherwise
 * indistinguishable from the outside, which is how a plugin that could not read
 * `ctx.sessionPersistence` at all stayed invisible for the life of the feature.
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
  /** Where the pass reports the failures it used to swallow. */
  logger?: ReconcilerLogger
  /**
   * The workspaces whose RECORD was deleted while their volume survived (see
   * `record-deletions.ts`). The pass is the platform's retry loop, so it:
   *
   *  - observes every registry projection it reads (the uuid → workspace join
   *    a later deletion event needs),
   *  - retries the destroys that failed, and
   *  - treats a condemned workspace as NOT adoptable.
   *
   * The last point is what stops the resurrection: a condemned workspace has
   * no record and does have a PVC, which is exactly the shape this pass was
   * built to bridge back into the registry. Without the guard, a delete whose
   * PVC removal failed would silently undo itself one pass later.
   */
  condemned?: CondemnedWitness
}

/**
 * The slice of {@link WorkspaceRecordDeletions} the pass consumes. Declared
 * structurally so the pass can be tested with a stub, and so the reconciler
 * stays independent of the event plumbing.
 */
export interface CondemnedWitness {
  observe(rows: readonly { workspaceId: string; path: string; internalId?: string }[]): void
  isCondemned(workspaceId: string): boolean
  retry(): Promise<readonly string[]>
}

/**
 * The slice of `ctx.logger` the pass reports through.
 *
 * Every branch that used to `return`/`catch` in silence is a branch that can
 * leave a session Ungrouped forever, and the live deployment had no way to tell
 * which one fired. None of them is recoverable in place (the next pass
 * retries), so they are all `warn`: the noise floor stays "something is wrong"
 * rather than "the pod booted".
 */
export interface ReconcilerLogger {
  warn(message: string): void
}

function pvcToWorkspaceId(name: string): string {
  return name.endsWith('-data') ? name.slice(0, -5) : name
}

/**
 * One cluster read, with FAILURE kept distinct from EMPTINESS.
 *
 * The prune removes records on the ABSENCE of a volume, and an empty array
 * produced by a `catch` is not evidence of absence — it is how one failed
 * listing would read as "no PVC exists anywhere" and become a mass deletion of
 * every workspace on the cluster. The additive half of the pass can treat a
 * failed read as an empty one (the next tick retries); the destructive half
 * must not, so the flag travels with the value.
 */
async function readOr<T>(read: () => Promise<T>, fallback: T): Promise<{ value: T; ok: boolean }> {
  try {
    return { value: await read(), ok: true }
  } catch {
    return { value: fallback, ok: false }
  }
}

/**
 * Run one diagnostic line without letting the diagnostic break the pass: a
 * logger that throws must not turn a reporting path into a new silent failure.
 */
function emit(logger: ReconcilerLogger | undefined, message: string): void {
  try {
    logger?.warn(message)
  } catch {
    // The pass's real work matters more than the diagnostic.
  }
}

/**
 * Canonicalize a stored session `cwd` exactly the way the official registry
 * does before it compares against a record path (`realpath`, both spellings
 * fully qualified). A cwd that does not resolve is not this pass's business:
 * the official attach would reject it, so the session is skipped — but the
 * caller reports WHY, because "skipped" and "attached" look identical from the
 * outside.
 */
async function canonicalPath(path: string): Promise<{ path: string } | { error: string }> {
  if (!path.startsWith('/')) return { error: 'is not an absolute path' }
  try {
    return { path: await realpath(path) }
  } catch (error) {
    return { error: `does not resolve: ${String(error)}` }
  }
}

export class WorkspaceReconciler {
  /**
   * The messages the PREVIOUS pass reported.
   *
   * Every line this pass emits describes a condition (a store that cannot be
   * listed, a cwd that does not resolve, a bridge write that failed), and a
   * condition that is still true on the next tick is the SAME condition: the
   * pass runs every 60 seconds, so repeating it would turn one fault into a
   * flood and bury the moment it appeared. The set is replaced at the end of
   * every pass rather than accumulated, so a condition that clears and later
   * returns is reported again — the line marks the change, not the tick.
   */
  private reported: ReadonlySet<string> = new Set()
  /** The messages reported so far in the pass being run, if one is running. */
  private reporting: Set<string> | undefined
  /** Tail of the pass queue; see {@link reconcile}. */
  private tail: Promise<void> = Promise.resolve()

  /**
   * The workspaces this process has OBSERVED backed by a volume.
   *
   * This set is the DISCRIMINATOR the stale-record prune reads, and it is the
   * only honest one available at this layer. A record with no PVC means one of
   * two things and they need opposite treatment:
   *
   *  - "its PVC existed and is now gone" — the workspace is gone; the record is
   *    a ghost that must be removed, which is the case the operator hit; or
   *  - "it never had a PVC here" — either adopted from outside this platform,
   *    or created moments ago and still mid-provision (`management.create`
   *    writes the record BEFORE anything creates the volume, so this is the
   *    normal shape of a workspace being created).
   *
   * The cluster alone cannot tell them apart: both are "a record, no PVC". What
   * separates them is history, and this pass is the only place that has it: a
   * workspace that HAD a volume was seen with one on an earlier tick (or earlier
   * in this one), and a workspace that never had one never will have been.
   *
   * Two limits are deliberate. The memory is in-process, so a ghost that
   * outlived a control-plane restart is only pruned after its volume is seen and
   * then missed again — the operator deletes again and this time it lands, the
   * same price `record-deletions.ts` pays for never destroying on inference. And
   * an entry is dropped the moment its record is pruned, so a workspace
   * RE-created under the same id is judged from scratch instead of inheriting
   * the deleted volume's witness.
   */
  private readonly volumesSeen = new Set<string>()

  constructor(private opts: ReconcilerOptions) {}

  /**
   * Run one pass, queued behind any pass still in flight.
   *
   * `reconcile()` has three callers — the load-time pass, the retry that waits
   * for the official registry, and the interval — and the first two race at
   * boot: a measured boot started the second 430ms into the first and the two
   * finished 8ms apart. Overlapping passes re-read the same state, interleave
   * their registry writes, and (before this queue) each compared against the
   * other's half-filled condition set, which printed a single boot-time fault
   * twice. Chaining also keeps the retry honest: a pass queued behind the
   * in-flight one re-reads the registry that just appeared instead of sharing
   * the snapshot taken before it existed.
   */
  async reconcile(): Promise<void> {
    const pass = this.tail.then(() => this.runPass())
    // A pass reports failures instead of throwing; this only stops a rejected
    // promise (a bug in the pass itself) from reaching every later caller.
    this.tail = pass.then(() => undefined, () => undefined)
    return await pass
  }

  /** Report one condition, at most once per uninterrupted occurrence. */
  private report(message: string): void {
    // Carrying a suppressed message into this pass's set is what keeps a
    // PERSISTENT condition suppressed: the previous-pass set is only compared,
    // never merged, so a condition that does not re-register here would count
    // as cleared and be emitted again on alternate ticks.
    if (this.reporting?.has(message) === true) return
    this.reporting?.add(message)
    if (this.reported.has(message)) return
    emit(this.opts.logger, message)
  }

  /** One pass. The reporting scope is created here, so passes never share it. */
  private async runPass(): Promise<void> {
    const reporting = new Set<string>()
    this.reporting = reporting
    try {
      await this.pass()
    } finally {
      this.reporting = undefined
      this.reported = reporting
    }
  }

  private async pass(): Promise<void> {
    const { controller, registry, namespace, hostRoot, condemned } = this.opts
    if (controller.listPods === undefined || controller.listPvcs === undefined) return

    // Finish (or retry) the deletions whose PVC removal failed BEFORE reading
    // the cluster. The other order is a resurrection bug: the pass would
    // snapshot the still-existing volume, the retry would then succeed, the
    // condemnation would lift, and the very same pass would bridge the
    // snapshot's volume back into a fresh record.
    if (condemned !== undefined) {
      for (const message of await condemned.retry()) this.report(message)
    }

    const [knownRead, podsRead, pvcsRead] = await Promise.all([
      readOr(() => registry.list(), [] as RegistryWorkspace[]),
      readOr(() => controller.listPods(namespace), [] as string[]),
      readOr(() => controller.listPvcs(namespace), [] as string[]),
    ])
    const known = knownRead.value
    const pods = podsRead.value
    const pvcs = pvcsRead.value

    // The registry projection is also the uuid → workspace join the deletion
    // signal resolves against. `known` is empty when the listing failed, which
    // is why the witness merges instead of replacing.
    condemned?.observe(known)

    const currentKnown = new Set(known.map((ws) => ws.workspaceId))
    // Only resources backed by a PVC are real workspaces. Pod-only resources
    // are stale prototypes/orphans and must NOT be auto-adopted; they are
    // surfaced for manual cleanup instead.
    const pvcIds = new Set(pvcs.map(pvcToWorkspaceId))
    const podIds = new Set(pods)
    // Every volume this pass sees is a workspace whose backing exists. Recorded
    // before the prune, so a pass that cannot judge a workspace (an unreadable
    // listing) still remembers the volume it did see.
    for (const id of pvcIds) this.volumesSeen.add(id)

    if (pvcsRead.ok && podsRead.ok) {
      await this.pruneStaleRecords(known, pvcIds, podIds)
    } else {
      const missing = [podsRead.ok ? undefined : 'pods', pvcsRead.ok ? undefined : 'PVCs'].filter((what) => what !== undefined)
      this.report(`workspace reconcile: could not list the cluster's ${missing.join(' and ')}; the stale-record prune was skipped this pass (${known.length} record(s) left in place)`)
    }

    const resources = new Set([...pvcIds].filter((id) => condemned?.isCondemned(id) !== true))
    for (const pod of pods) {
      if (pvcIds.has(pod) && condemned?.isCondemned(pod) !== true) resources.add(pod)
    }

    // Every resource needs its host-side anchor, whether or not the registry
    // already has the record. The official registry realpaths the directory in
    // `create` AND in the session paths (`resolveByPath`, `attachSession`), so a
    // record whose anchor went missing — a re-created PVC, a wiped control
    // plane — can never be repaired by the rebind below while the directory is
    // absent. `mkdir` is idempotent, so this runs for known and unknown ids
    // alike and a failure simply leaves the retry to the next pass.
    for (const id of resources) {
      try {
        await mkdir(`${hostRoot}/${id}`, { recursive: true })
      } catch (error) {
        this.report(`workspace reconcile: could not create the host anchor '${hostRoot}/${id}': ${String(error)}`)
      }
    }

    // Bridge missing k8s resources back into the official registry.
    for (const id of resources) {
      if (currentKnown.has(id)) continue
      try {
        await registry.create(`${hostRoot}/${id}`)
        currentKnown.add(id)
      } catch (error) {
        // A failed bridge-creation must not block the rest of reconciliation;
        // it will be retried on the next pass.
        this.report(`workspace reconcile: could not register '${id}' at '${hostRoot}/${id}': ${String(error)}`)
      }
    }

    // Re-read the registry for the rebind: the view fetched above is from
    // BEFORE the bridge loop, so on the pass that creates a record it does not
    // contain that record — and the rebind's own guard would see "no
    // workspaces" and return without attaching anything. Both the official
    // `list()` and the bridge that wraps it return a fresh array per call, so
    // the pre-bridge view never grows in place.
    const registered = await registry.list().catch((error: unknown) => {
      this.report(`workspace reconcile: could not list workspaces for the session rebind: ${String(error)}`)
      return undefined
    })
    if (registered === undefined) return

    await this.rebindSessions(registered, hostRoot)
  }

  /**
   * Remove the records of workspaces whose volume is gone.
   *
   * This is the mirror of the bridge above and it is intentionally narrower. A
   * record is removed only when ALL of these hold:
   *
   *  - its id has no PVC in this pass's snapshot (the workspace's durable
   *    backing is gone);
   *  - this process has SEEN that id backed by a volume before
   *    ({@link volumesSeen}) — so "no PVC" means "the PVC existed and is now
   *    gone", never "this record never described a volume here": a workspace
   *    adopted from outside, or one created seconds ago and still
   *    mid-provision, has no volume YET and must survive every pass;
   *  - no pod runs for it, so a workspace whose volume was removed underneath a
   *    live pod is reported as an orphan (and cleaned up deliberately) instead
   *    of disappearing from the sidebar while it still serves requests;
   *  - it is not condemned (see `record-deletions.ts`): a destroy being retried
   *    has no record to remove, and if one reappeared the condemnation, not this
   *    pass, is the authority;
   *  - the pod AND PVC listings both succeeded this pass. A failed listing is
   *    indistinguishable from an empty cluster at this layer, and acting on it
   *    would delete every workspace on a cluster hiccup. The caller skips this
   *    method entirely in that case.
   *
   * A removed record cannot come back on a later pass: the bridge only creates
   * records for PVC-backed resources, and the volume is what is missing — so the
   * prune is permanent, which is what "delete destroys the workspace" means.
   * @param known - the registry's current records.
   * @param pvcIds - workspace ids backed by a PVC in this pass's snapshot.
   * @param podIds - workspace ids with a pod in this pass's snapshot.
   */
  private async pruneStaleRecords(
    known: readonly RegistryWorkspace[],
    pvcIds: ReadonlySet<string>,
    podIds: ReadonlySet<string>,
  ): Promise<void> {
    const { registry, condemned } = this.opts
    for (const ws of known) {
      const id = ws.workspaceId
      if (pvcIds.has(id)) continue
      if (!this.volumesSeen.has(id)) continue
      if (podIds.has(id)) continue
      if (condemned?.isCondemned(id) === true) continue
      try {
        await registry.delete(id)
        // The observation history ends with the volume it described. Keeping it
        // would sentence the record of a workspace RE-created under the same id:
        // that fresh record has no volume yet, and the deleted volume's witness
        // would read it as a ghost on the very next pass.
        this.volumesSeen.delete(id)
        this.report(`workspace reconcile: removed the record of '${id}' (${ws.path}): its PVC is gone and no pod runs for it`)
      } catch (error) {
        // Leave the witness in place: the record is still stale, and the next
        // pass must be able to try again.
        this.report(`workspace reconcile: could not remove the record of '${id}' (${ws.path}): ${String(error)}`)
      }
    }
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
    // Without a session source there is no join key; never invent one. The
    // source is resolved per pass by the caller, so a composition without
    // session persistence is a fact about the composition — but one the caller
    // makes VISIBLE once (see `SessionHeaderSource`), because a store that is
    // present and unreachable looks exactly like this from the outside.
    if (sessions === undefined || registered.length === 0) return

    let headers: readonly { readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt: number } }[]
    try {
      headers = await sessions.list()
    } catch (error) {
      // A store that cannot be listed must not be mistaken for "no sessions":
      // skip the pass and let the next tick retry. The source names the missing
      // service in the error, so the line says WHICH read failed.
      this.report(`workspace session rebind skipped: session persistence could not be listed: ${String(error)}`)
      return
    }

    // Canonicalize the root the same way the sessions are: an anchor created by
    // the control plane's own mount always exists, so this only ever rescues a
    // root whose spelling is not canonical (a symlinked /workspaces would
    // otherwise make every cwd look like it belongs outside the platform).
    const root = await realpath(hostRoot).catch((error: unknown) => {
      this.report(`workspace session rebind skipped: host root '${hostRoot}' does not resolve: ${String(error)}`)
      return undefined
    })
    if (root === undefined) return

    // Group the sessions this pass may touch by their canonical cwd. A cwd
    // outside the host root cannot belong to a platform workspace.
    const byPath = new Map<string, SessionRebind[]>()
    for (const snapshot of headers) {
      const { id, cwd, createdAt } = snapshot.header
      if (cwd === undefined) {
        // The header's cwd is the ONLY join key this pass has. A header without
        // one is a session that stays Ungrouped until the user re-opens it, and
        // the persistence backend does not require a cwd, so it is a real case.
        this.report(`workspace session rebind skipped session '${id}': its stored header carries no cwd`)
        continue
      }
      const canonical = await canonicalPath(cwd)
      if ('error' in canonical) {
        // Not repairable here on purpose: the official attach re-validates the
        // cwd with realpath+stat and would reject the session anyway. Report it,
        // because a missing anchor and a healthy pass look identical otherwise.
        this.report(`workspace session rebind skipped session '${id}': its cwd '${cwd}' ${canonical.error}`)
        continue
      }
      if (!canonical.path.startsWith(root + '/')) {
        this.report(`workspace session rebind skipped session '${id}': its cwd '${cwd}' resolves to '${canonical.path}', outside the platform host root '${root}'`)
        continue
      }
      const entry: SessionRebind = { id, path: canonical.path, createdAt }
      const bucket = byPath.get(canonical.path)
      if (bucket === undefined) byPath.set(canonical.path, [entry])
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
      } catch (error) {
        // One unrepairable workspace (missing anchor, session persistence
        // miss) must not abort the rest; the next pass retries it.
        this.report(`workspace session rebind failed for '${workspace.path}' (${candidates.length} session(s)): ${String(error)}`)
      }
    }
  }
}

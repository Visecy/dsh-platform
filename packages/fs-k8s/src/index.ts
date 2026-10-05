/**
 * dsh-fs-k8s: ctx.fs provider routing file operations to a workspace pod's
 * sandbox daemon. Paths translate host workspace id <-> pod /workspace.
 *
 * Routing: each call resolves the daemon endpoint from the target's workspace
 * id via the resolver (typically workspace-k8s's workspaceEndpointResolver:
 * ensure + getEndpoint), so concurrent sessions on different workspaces reach
 * their own pod. Without a resolver, the static daemonEndpoint is used.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { DaemonFilesClient, DaemonError } from './client.ts'
import { PathTranslator } from './translate.ts'

export const name = '@visecy/dsh-fs-k8s'

export interface Config {
  /** Workspace pod daemon base URL (used when no resolver is configured). */
  daemonEndpoint: string
  /** Host-side workspace identifier root, e.g. /workspaces/<id>. */
  hostRoot: string
  /** Pod-side workspace root. Default '/workspaces' so host and pod paths match. */
  podRoot?: string
  /** Per-call endpoint resolution by workspace id (ensure + getEndpoint). */
  resolveEndpoint?: (workspaceId: string) => Promise<string> | string
  /**
   * Poll interval (ms) for `watch`. Watching is implemented as a cheap
   * `files/info` poll (type/size/mtime), not as an inotify subscription: the
   * bytes live in a per-workspace pod, so the control plane has nothing local
   * to subscribe to. Default 1000.
   */
  watchIntervalMs?: number
  /**
   * Ceiling (ms) the watch interval backs off to while polls keep failing.
   * Default 30000. A watcher that is polling a dead daemon must get quieter,
   * not busier.
   */
  watchMaxIntervalMs?: number
}

/**
 * The `workspaceEndpointResolver` service this provider consumes, read
 * structurally (this package depends on no other platform package, and a
 * static-endpoint composition supplies neither member).
 *
 * `WorkspaceEndpointResolver` in `@visecy/dsh-workspace-k8s` is the contract's
 * home: `resolve` wakes a registered workspace (and refuses to materialize one
 * that no record describes), `isWorkspace` answers membership alone, without
 * provisioning and without throwing.
 */
interface WorkspaceEndpointService {
  resolve?: (workspaceId: string) => Promise<string> | string
  /** Fail-open membership test for a first path segment under the host root. */
  isWorkspace?: (workspaceId: string) => Promise<boolean> | boolean
}

const BINARY_SAMPLE = 8192

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, BINARY_SAMPLE))
    return true
  } catch {
    return false
  }
}

export class FsK8s extends FileSystem {
  private client: DaemonFilesClient
  private translate: PathTranslator
  private resolver: ((workspaceId: string) => Promise<string> | string) | undefined
  private watchIntervalMs: number
  private watchMaxIntervalMs: number
  /**
   * Paths already reported as outside every workspace. One line per path per
   * process: a file view probing several such paths is one condition, not one
   * line per operation (the same rule `degradedWatches` applies).
   */
  private reportedOutside = new Set<string>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.client = new DaemonFilesClient(config.daemonEndpoint)
    this.translate = new PathTranslator(config.hostRoot, config.podRoot ?? '/workspaces')
    this.resolver = config.resolveEndpoint
    this.watchIntervalMs = Math.max(1, Math.trunc(config.watchIntervalMs ?? 1000))
    this.watchMaxIntervalMs = Math.max(this.watchIntervalMs, Math.trunc(config.watchMaxIntervalMs ?? 30_000))
  }

  /** Attach the per-workspace resolver (from workspace-k8s wiring). */
  attachResolver(resolver: (workspaceId: string) => Promise<string> | string): void {
    this.resolver = resolver
  }

  private podPathOf(target: FsTarget): string {
    // targetKey encodes the pod path: dsh-k8s:<podPath>
    return target.targetKey.slice('dsh-k8s:'.length)
  }

  /** The workspace id from a host path like /workspaces/<id>/... */
  private workspaceOf(displayPath: string): string | undefined {
    const root = this.translate.hostRoot
    if (!displayPath.startsWith(root + '/')) return undefined
    const rest = displayPath.slice(root.length + 1)
    const seg = rest.split('/')[0]
    return seg === '' ? undefined : seg
  }

  /**
   * The pod-side path of the workspace directory a target belongs to
   * (`<podRoot>/<workspaceId>` — the PVC mount, which is also the daemon's
   * root), or undefined when the target is not inside a platform workspace
   * (a static-endpoint composition, or a path outside hostRoot).
   */
  private podWorkspaceRoot(target: FsTarget): string | undefined {
    const workspaceId = this.workspaceOf(target.displayPath)
    if (workspaceId === undefined) return undefined
    const base = this.translate.podRoot.endsWith('/')
      ? this.translate.podRoot.slice(0, -1)
      : this.translate.podRoot
    return `${base}/${workspaceId}`
  }

  /**
   * The path the DAEMON's file API expects, which is NOT the pod path.
   *
   * A workspace pod mounts its PVC at `/workspaces/<id>` and runs the daemon
   * with `DAEMON_ROOT=/workspaces/<id>`, so the daemon's file root IS the
   * workspace directory: `FilesService.confine()` resolves `join(root, path)`,
   * making `/` the daemon's own root and `/name` a direct child. Handing it the
   * pod path (`/workspaces/<id>/name`) would address
   * `<root>/workspaces/<id>/name` — a path that does not exist — which is how
   * every stat/read/list in the file view turned into "not found" while the
   * pod's own shell saw a full directory.
   *
   * `processPath`/`fileUrl` deliberately keep reporting the POD path: that one
   * is a real path in the pod and is what the subprocess provider uses as a
   * cwd.
   */
  private daemonPathOf(target: FsTarget): string {
    const podPath = this.podPathOf(target)
    const root = this.podWorkspaceRoot(target)
    if (root === undefined || root === '/') return podPath
    if (podPath === root) return '/'
    if (podPath.startsWith(root + '/')) return podPath.slice(root.length)
    // Not the deployed layout (a caller-built target, a static endpoint): pass
    // the path through unchanged rather than inventing a root it does not have.
    return podPath
  }

  /** The inverse of {@link daemonPathOf}: a daemon-reported path -> pod path. */
  private podPathForDaemon(daemonPath: string, target: FsTarget): string {
    const root = this.podWorkspaceRoot(target)
    if (root === undefined || root === '/') return daemonPath
    if (daemonPath === '' || daemonPath === '/') return root
    return daemonPath.startsWith('/') ? root + daemonPath : `${root}/${daemonPath}`
  }

  /**
   * Resolve the daemon endpoint for one target.
   *
   * The workspace id is the first path segment under the host root, so this is
   * also where "is this path even a workspace?" is decided — see the fence in
   * the body.
   */
  private async endpointFor(target: FsTarget): Promise<string> {
    const service = this.ctx.get('workspaceEndpointResolver') as WorkspaceEndpointService | undefined
    const resolver = this.resolver ?? service?.resolve
    if (resolver === undefined) return this.client.defaultEndpoint
    const ws = this.workspaceOf(target.displayPath)
    if (ws === undefined) return this.client.defaultEndpoint
    // A workspace id is just the FIRST path segment under the host root, so a
    // path that names no workspace — `.git` beside the anchors, a directory an
    // agent created, anything under a session whose cwd is the root — must not
    // be routed to a pod, and resolving it must never create one. The resolver
    // refuses that creation case (correctly: `ensure` would raise a PVC and a
    // pod for an id nobody registered), but its refusal is a platform-level
    // failure, and a path beside the anchors is not an error the caller can act
    // on. So the provider asks the membership question first and answers in its
    // own terms: one precise line, no ensure, no pod, and the session goes on.
    //
    // Fail-open, exactly like the fence: only a POSITIVE "no such workspace"
    // degrades, and a question that cannot be answered (an implementation that
    // throws, a composition with no bridge at all) proceeds as it did before
    // the fence existed.
    if (service?.isWorkspace !== undefined) {
      const known = await Promise.resolve(service.isWorkspace(ws)).catch(() => true)
      if (!known) throw this.outsideEveryWorkspace(target.displayPath, ws)
    }
    return resolver(ws)
  }

  /**
   * The degradation for a path whose first segment is not a registered
   * workspace.
   *
   * Why the operation is refused rather than served locally: the control plane
   * is not a file world. Its `/workspaces` is an emptyDir of realpath anchors
   * (`management.create` and the reconciler `mkdir` them), no workspace PVC is
   * ever mounted on it, and with `WS_DAEMON_ENDPOINT` unset the static
   * fallback (`http://127.0.0.1:4390`) has no listener — so serving these paths
   * from here would present an empty, disconnected tree as if it were the
   * user's files and swallow writes into a volume no pod can read. One precise
   * line is the honest answer, and it costs the session nothing.
   */
  private outsideEveryWorkspace(displayPath: string, workspaceId: string): FsError {
    const root = this.translate.hostRoot
    if (!this.reportedOutside.has(displayPath)) {
      this.reportedOutside.add(displayPath)
      try {
        this.ctx.logger?.warn?.(
          `fs-k8s: ${displayPath} is outside every workspace of this platform `
          + `('${workspaceId}' is not registered under ${root}); no pod or volume was created for it`,
        )
      } catch {
        // A broken log sink must not replace the caller's precise answer with a
        // logging failure.
      }
    }
    return new FsError(
      `${displayPath} is not inside a workspace of this platform: no workspace named '${workspaceId}' is registered under ${root}, `
      + `so no pod or volume was created for it and the control plane keeps no copy of that path; `
      + `use a path under ${root}/<workspace-id>`,
      'FS_NOT_FOUND',
    )
  }

  private asFsError(e: unknown): FsError {
    if (e instanceof FsError) return e
    if (e instanceof DaemonError) {
      switch (e.code) {
        case 'NOT_FOUND':
          return new FsError(e.message, 'FS_NOT_FOUND')
        case 'VERSION_CONFLICT':
          return new FsError(e.message, 'FS_STALE_VERSION')
        case 'OUT_OF_ROOT':
          return new FsError(e.message, 'FS_PERMISSION_DENIED')
        case 'NOT_DIRECTORY':
          return new FsError(e.message, 'FS_NOT_DIRECTORY')
        case 'NOT_REGULAR_FILE':
          return new FsError(e.message, 'FS_NOT_REGULAR_FILE')
        default:
          return new FsError(e.message, 'FS_IO_ERROR')
      }
    }
    return new FsError((e as Error).message, 'FS_IO_ERROR')
  }

  private mapError(e: unknown): never {
    throw this.asFsError(e)
  }

  override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    const abs = opts?.cwd !== undefined && !path.startsWith('/') ? opts.cwd + '/' + path : path
    let podPath: string
    try {
      podPath = this.translate.toPod(abs)
    } catch (e) {
      throw new FsError((e as Error).message, 'FS_PERMISSION_DENIED')
    }
    return {
      targetKey: FsTargetKey(`dsh-k8s:${podPath}`),
      displayPath: abs,
    }
  }

  override processPath(target: FsTarget): string {
    return this.podPathOf(target)
  }

  /**
   * DSH 0.1.2 adds this member to the fs seam: the harness asks whether an
   * absolute HOST path names the same file inside the execution world (image
   * attachments reach the model through it). A workspace pod is a separate
   * execution world — the PVC copy is not the host file — and no control-plane
   * directory is shared into the pod by default, so no host path ever maps.
   * Revisit when a real shared mount (e.g. an attachments volume bind-mounted
   * into workspace pods) is introduced.
   */
  override processPathFromHostPath(_hostPath: string): string | undefined {
    return undefined
  }

  override fileUrl(target: FsTarget): string {
    return 'file://' + this.podPathOf(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const p = this.podPathOf(parent)
    const c = this.podPathOf(child)
    return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
  }

  /**
   * Target-shaped metadata: follows symbolic links (the seam's `stat`).
   */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    try {
      const info = await this.client.info(this.daemonPathOf(target), await this.endpointFor(target), { follow: true })
      if (info === undefined) return undefined
      return {
        version: FsVersion(info.version ?? `v-${info.modifiedTime ?? 0}-${info.size ?? 0}`),
        type: info.type === 'directory' ? 'directory' : info.type === 'file' ? 'file' : 'other',
        size: info.size,
      }
    } catch (e) {
      this.mapError(e)
    }
  }

  /**
   * Path-shaped metadata: does NOT follow symbolic links, so a consumer can
   * reject the path itself before any follow happens (the seam's `lstat`).
   * Previously this delegated to `stat`, which made the two members
   * indistinguishable and reported a symlink as `other`.
   */
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, opts)
    try {
      const info = await this.client.info(this.daemonPathOf(target), await this.endpointFor(target))
      if (info === undefined) return undefined
      return {
        version: FsVersion(info.version ?? `v-${info.modifiedTime ?? 0}-${info.size ?? 0}`),
        type: info.type === 'directory' ? 'directory' : info.type === 'file' ? 'file' : info.type === 'symlink' ? 'symlink' : 'other',
        size: info.size,
      }
    } catch (e) {
      this.mapError(e)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const bytes = await this.client.read(this.daemonPathOf(target), undefined, await this.endpointFor(target))
      if (!isText(bytes)) throw new FsError('binary or invalid UTF-8', 'FS_NOT_TEXT')
      return new TextDecoder('utf-8').decode(bytes)
    } catch (e) {
      this.mapError(e)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return {
      async *[Symbol.asyncIterator]() {
        yield text
      },
    }
  }

  /**
   * DSH 0.1.2 member: whole-file raw read with an inclusive `maxBytes` cap.
   * Implemented as a bounded window read of `maxBytes + 1` bytes so the cap is
   * enforced on the BYTES ACTUALLY READ rather than on a prior `info()` size —
   * a file that grows between the stat and the read now fails with
   * `FS_TOO_LARGE` instead of being silently truncated.
   */
  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = await this.readByteRange(target, { offset: 0, length: maxBytes + 1 }, signal)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  /**
   * DSH 0.1.5 member: one byte window of the regular file. The window is the
   * bound, not the file — the daemon performs a positional read so a large file
   * is never buffered whole, and an offset at or past EOF legitimately returns
   * an empty result (no `info()` pre-check: it would both race and reject that
   * legal empty window).
   */
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      const endpoint = await this.endpointFor(target)
      return await this.client.read(this.daemonPathOf(target), { offset: range.offset, maxBytes: range.length }, endpoint)
    } catch (e) {
      this.mapError(e)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    try {
      const endpoint = await this.endpointFor(target)
      const entries = await this.client.list(this.daemonPathOf(target), endpoint)
      const out: FsDirEntry[] = []
      for (const e of entries) {
        const daemonPath = e.path.startsWith('/') ? e.path : this.daemonPathOf(target) + '/' + e.path
        const podPath = this.podPathForDaemon(daemonPath, target)
        const childTarget: FsTarget = { targetKey: FsTargetKey(`dsh-k8s:${podPath}`), displayPath: this.translate.toHost(podPath) }
        out.push({
          name: e.name,
          type: e.type === 'directory' ? 'directory' : e.type === 'file' ? 'file' : 'other',
          target: childTarget,
          size: e.size,
        })
      }
      return out
    } catch (e) {
      this.mapError(e)
    }
  }

  /**
   * The observed signature of one target: everything a poll can compare
   * cheaply. The daemon reports a content hash for regular files, but hashing
   * a large file on every tick is exactly the cost a poll must avoid, so the
   * signature is type + size + mtime (a directory has no size, and its mtime
   * moves when a direct entry is added, removed or renamed).
   */
  private async sample(daemonPath: string, endpoint: string): Promise<string | undefined> {
    const info = await this.client.info(daemonPath, endpoint, { follow: true })
    if (info === undefined) return undefined
    return `${info.type}:${info.size ?? ''}:${info.modifiedTime ?? ''}`
  }

  /**
   * The degradations already reported, keyed by target. The file view opens a
   * watcher per visible directory and re-opens them as the user navigates, so
   * "the daemon cannot report changes" is one condition per path per process,
   * not one line per attempt — and it must never repeat per poll either.
   */
  private degradedWatches = new Set<string>()

  /** Report one inert watcher, once per target, through the platform logger. */
  private reportWatchDegraded(target: FsTarget, error: unknown): void {
    if (this.degradedWatches.has(target.targetKey)) return
    this.degradedWatches.add(target.targetKey)
    const detail = error instanceof Error ? error.message : String(error)
    try {
      this.ctx.logger?.warn?.(
        `fs-k8s: live refresh unavailable for ${target.displayPath}: the sandbox daemon cannot report file changes (${detail}); listing and reading still work`,
      )
    } catch {
      // A broken log sink must not turn degradation into a file-view failure —
      // that is the very outcome this path exists to prevent.
    }
  }

  /**
   * DSH 0.2 member: observe one file, or a directory's direct entries, in the
   * workspace pod.
   *
   * The provider has no local inode to watch — the bytes live in a per-pod PVC
   * behind the daemon — so observation is a `files/info` poll of the daemon.
   * The contract is the seam's, not the implementation's:
   *
   *   - the promise resolves only once observation is ACTIVE (the first sample
   *     has been taken), and the returned close is asynchronous;
   *   - an absent target is a legal thing to observe (creation is a change);
   *   - `changed()` reports an observed-state move, `changed(error)` reports a
   *     failed poll — it must never surface as an unhandled rejection;
   *   - after `close()` resolves, no callback ever runs again and no timer is
   *     left behind (the timer is unref'd so a watcher never holds the process
   *     open either);
   *   - a signal aborted before initialization rejects instead of resolving;
   *   - a daemon that cannot answer the initial poll produces an INERT watcher,
   *     not a rejection (see below).
   *
   * Poll failures after initialization back off exponentially (base
   * `watchIntervalMs`, ceiling `watchMaxIntervalMs`) and are reported on every
   * failed poll, so the caller learns the watcher is blind rather than sitting
   * on a dead subscription. Once a poll succeeds again the interval resets to
   * the base.
   *
   * Initialization failure is deliberately NOT a rejection. The official
   * caller (`dsh-api-workspace-files`' change feed) wraps this call in a
   * try/catch and turns any throw into `workspace-file/watch-unsupported`,
   * which fails the file view's mount — so rejecting here costs the user the
   * WHOLE file view (listing, reading, everything) over what is only lost live
   * refresh. A daemon that cannot report change (an older sandbox-daemon image
   * whose `files/info` contract differs, a pod that is still starting up)
   * therefore degrades: the promise resolves with a watcher that never fires,
   * and the degradation is reported once through the platform logger, which
   * the stdout sink (`@visecy/dsh-logging-stdout`) puts in the pod log.
   * Genuinely invalid input — an aborted signal — still rejects.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    const daemonPath = this.daemonPathOf(target)
    let endpoint: string
    let last: string | undefined
    try {
      endpoint = await this.endpointFor(target)
      last = await this.sample(daemonPath, endpoint)
    } catch (e) {
      // An abort during initialization is the caller withdrawing the request,
      // not a daemon fault: that stays a rejection.
      signal.throwIfAborted()
      this.reportWatchDegraded(target, e)
      // Nothing was scheduled and nothing was handed to `changed`, so closing
      // an inert watcher is a no-op.
      return async (): Promise<void> => {}
    }
    // Initialization ends here: from this point on the watcher owns a timer and
    // the caller owns the returned close.
    signal.throwIfAborted()

    const base = this.watchIntervalMs
    const max = this.watchMaxIntervalMs
    let interval = base
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const stop = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => { stop() }
    signal.addEventListener('abort', onAbort, { once: true })

    /** A consumer callback must not be able to kill the poll loop. */
    const notify = (error?: Error): void => {
      try {
        changed(error)
      } catch {
        // the consumer's failure is its own; observation continues
      }
    }

    const schedule = (ms: number): void => {
      if (closed) return
      timer = setTimeout(() => { void tick() }, ms)
      // A watcher must never keep a process (or a vitest worker) alive.
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }

    const tick = async (): Promise<void> => {
      if (closed) return
      let next: string | undefined
      try {
        next = await this.sample(daemonPath, endpoint)
      } catch (e) {
        if (closed) return
        interval = Math.min(interval * 2, max)
        notify(this.asFsError(e))
        schedule(interval)
        return
      }
      if (closed) return
      if (next !== last) {
        last = next
        interval = base
        notify()
      } else if (interval !== base) {
        interval = base
      }
      schedule(interval)
    }

    schedule(base)
    return async (): Promise<void> => { stop() }
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<FsWriteOutcome> {
    try {
      const daemonPath = this.daemonPathOf(target)
      const endpoint = await this.endpointFor(target)
      let before: string | null = null
      try {
        const info = await this.client.info(daemonPath, endpoint)
        if (info !== undefined && info.type === 'file') {
          const bytes = await this.client.read(daemonPath, undefined, endpoint)
          if (isText(bytes)) before = new TextDecoder('utf-8').decode(bytes).replace(/\r\n/g, '\
')
        }
      } catch {
        // absent
      }
      const intent = expected === undefined
        ? undefined
        : expected.kind === 'createIfAbsent'
          ? { kind: 'createIfAbsent' as const }
          : { kind: 'replaceIfVersion' as const, version: expected.version }
      const outcome = await this.client.write(daemonPath, new TextEncoder().encode(content), intent, endpoint)
      return {
        operation: outcome.operation === 'create' ? 'create' : 'update',
        version: FsVersion(outcome.version),
        before: outcome.operation === 'create' ? null : before,
        after: content.replace(/\r\n/g, '\
'),
      }
    } catch (e) {
      this.mapError(e)
    }
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<FsEditOutcome> {
    try {
      const daemonPath = this.daemonPathOf(target)
      const endpoint = await this.endpointFor(target)
      const info = await this.client.info(daemonPath, endpoint)
      if (info === undefined) throw new FsError('no such file', 'FS_EDIT_NOT_FOUND')
      let currentVersion: FsVersion | undefined
      if (expected !== undefined) {
        const st = await this.stat(target)
        currentVersion = st?.version
        if (currentVersion === undefined || currentVersion !== expected.version) {
          throw new FsError('stale version', 'FS_STALE_VERSION')
        }
      }
      const bytes = await this.client.read(daemonPath, undefined, endpoint)
      if (!isText(bytes)) throw new FsError('binary file', 'FS_NOT_TEXT')
      const current = new TextDecoder('utf-8').decode(bytes)
      let next: string
      if (edit.replaceAll) {
        if (!current.includes(edit.oldString)) throw new FsError('pattern not found', 'FS_EDIT_NOT_FOUND')
        next = current.split(edit.oldString).join(edit.newString)
      } else {
        const idx = current.indexOf(edit.oldString)
        if (idx === -1) throw new FsError('pattern not found', 'FS_EDIT_NOT_FOUND')
        const second = current.indexOf(edit.oldString, idx + edit.oldString.length)
        if (second !== -1) throw new FsError('ambiguous edit', 'FS_AMBIGUOUS_EDIT')
        next = current.slice(0, idx) + edit.newString + current.slice(idx + edit.oldString.length)
      }
      const st2 = await this.stat(target)
      const outcome = await this.client.write(daemonPath, new TextEncoder().encode(next), { kind: 'replaceIfVersion', version: st2?.version ?? '' }, endpoint)
      return { version: FsVersion(outcome.version), before: current.replace(/\r\n/g, '\
'), after: next.replace(/\r\n/g, '\
') }
    } catch (e) {
      this.mapError(e)
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  // FileSystem base constructor already registers under 'fs' (super(ctx, "fs"));
  // providing again would collide.
  new FsK8s(ctx, config)
}

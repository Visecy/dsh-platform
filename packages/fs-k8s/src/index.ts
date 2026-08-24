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

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.client = new DaemonFilesClient(config.daemonEndpoint)
    this.translate = new PathTranslator(config.hostRoot, config.podRoot ?? '/workspaces')
    this.resolver = config.resolveEndpoint
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

  private async endpointFor(target: FsTarget): Promise<string> {
    const resolver = this.resolver
      ?? (this.ctx.get('workspaceEndpointResolver') as { resolve?: (id: string) => Promise<string> | string } | undefined)?.resolve
    if (resolver === undefined) return this.client.defaultEndpoint
    const ws = this.workspaceOf(target.displayPath)
    if (ws === undefined) return this.client.defaultEndpoint
    return resolver(ws)
  }

  private mapError(e: unknown): never {
    if (e instanceof FsError) throw e
    if (e instanceof DaemonError) {
      switch (e.code) {
        case 'NOT_FOUND':
          throw new FsError(e.message, 'FS_NOT_FOUND')
        case 'VERSION_CONFLICT':
          throw new FsError(e.message, 'FS_STALE_VERSION')
        case 'OUT_OF_ROOT':
          throw new FsError(e.message, 'FS_PERMISSION_DENIED')
        case 'NOT_DIRECTORY':
          throw new FsError(e.message, 'FS_NOT_DIRECTORY')
        default:
          throw new FsError(e.message, 'FS_IO_ERROR')
      }
    }
    throw new FsError((e as Error).message, 'FS_IO_ERROR')
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

  override fileUrl(target: FsTarget): string {
    return 'file://' + this.podPathOf(target)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const p = this.podPathOf(parent)
    const c = this.podPathOf(child)
    return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    try {
      const info = await this.client.info(this.podPathOf(target), await this.endpointFor(target))
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

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, opts)
    const info = await this.stat(target, signal)
    return info
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const bytes = await this.client.read(this.podPathOf(target), undefined, await this.endpointFor(target))
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

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    try {
      const endpoint = await this.endpointFor(target)
      const info = await this.client.info(this.podPathOf(target), endpoint)
      if (info !== undefined && info.size !== undefined && info.size > maxBytes) {
        throw new FsError(`file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return await this.client.read(this.podPathOf(target), { maxBytes }, endpoint)
    } catch (e) {
      this.mapError(e)
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    try {
      const endpoint = await this.endpointFor(target)
      const entries = await this.client.list(this.podPathOf(target), endpoint)
      const out: FsDirEntry[] = []
      for (const e of entries) {
        const podPath = e.path.startsWith('/') ? e.path : this.podPathOf(target) + '/' + e.path
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

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: unknown): Promise<FsWriteOutcome> {
    try {
      const podPath = this.podPathOf(target)
      const endpoint = await this.endpointFor(target)
      let before: string | null = null
      try {
        const info = await this.client.info(podPath, endpoint)
        if (info !== undefined && info.type === 'file') {
          const bytes = await this.client.read(podPath, undefined, endpoint)
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
      const outcome = await this.client.write(podPath, new TextEncoder().encode(content), intent, endpoint)
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
      const podPath = this.podPathOf(target)
      const endpoint = await this.endpointFor(target)
      const info = await this.client.info(podPath, endpoint)
      if (info === undefined) throw new FsError('no such file', 'FS_EDIT_NOT_FOUND')
      let currentVersion: FsVersion | undefined
      if (expected !== undefined) {
        const st = await this.stat(target)
        currentVersion = st?.version
        if (currentVersion === undefined || currentVersion !== expected.version) {
          throw new FsError('stale version', 'FS_STALE_VERSION')
        }
      }
      const bytes = await this.client.read(podPath, undefined, endpoint)
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
      const outcome = await this.client.write(podPath, new TextEncoder().encode(next), { kind: 'replaceIfVersion', version: st2?.version ?? '' }, endpoint)
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

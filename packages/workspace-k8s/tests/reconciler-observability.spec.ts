/**
 * Every path in the rebind pass that used to `return`/`catch` in silence.
 *
 * The live deployment's `dsh-web` container logged nothing while six of seven
 * sessions stayed unattached, and each of these four paths is a candidate
 * explanation. A defect that can only be diagnosed by attaching a debugger to a
 * production pod is not diagnosable; these tests pin one warn-or-worse line per
 * path, carrying the workspace path and the reason.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import { WorkspaceReconciler, type SessionHeaderSource } from '../src/reconciler.ts'
import type { RegistryWorkspace, SessionRebind, WorkspaceRegistry } from '../src/registry.ts'

class FakeController implements PodController {
  constructor(readonly pvcs: string[] = []) {}
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
}

/**
 * A registry whose `list()` returns a FRESH array every call, like both the
 * official `list()` (a `.map` over the durable order) and the bridge that wraps
 * it (a `.filter().map()`). The stale-snapshot defect is invisible to a fake
 * that hands back its live internal array.
 */
class FreshArrayRegistry implements WorkspaceRegistry {
  readonly rebinds: Array<{ path: string; sessions: SessionRebind[] }> = []
  constructor(
    public rows: RegistryWorkspace[] = [],
    public rebindError: Error | undefined = undefined,
  ) {}
  async list(): Promise<RegistryWorkspace[]> { return [...this.rows] }
  async create(path: string): Promise<RegistryWorkspace> {
    const row: RegistryWorkspace = { workspaceId: path.split('/').filter(Boolean).at(-1) ?? '', path }
    this.rows = [...this.rows, row]
    return row
  }
  async delete(): Promise<void> {}
  async rebind(workspacePath: string, sessions: readonly SessionRebind[]): Promise<string[]> {
    if (this.rebindError !== undefined) throw this.rebindError
    this.rebinds.push({ path: workspacePath, sessions: [...sessions] })
    return sessions.map((session) => session.id)
  }
}

class RecordingLogger {
  readonly lines: string[] = []
  warn(message: unknown): void { this.lines.push(String(message)) }
}

const roots: string[] = []
/** A real directory: the pass canonicalizes cwds with `realpath` before joining. */
const realRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-observable-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const headers = (list: Array<{ id: string; cwd?: string; createdAt: number }>): SessionHeaderSource => ({
  async list() { return list.map((header) => ({ header })) },
})

const setup = (options: {
  rows?: RegistryWorkspace[]
  sessions: SessionHeaderSource
  hostRoot: string
  rebindError?: Error
}) => {
  const registry = new FreshArrayRegistry(options.rows ?? [], options.rebindError)
  const logger = new RecordingLogger()
  const reconciler = new WorkspaceReconciler({
    controller: new FakeController(),
    registry,
    sessions: options.sessions,
    namespace: 'dsh-platform',
    hostRoot: options.hostRoot,
    logger,
  })
  return { registry, reconciler, logger }
}

describe('rebind observability', () => {
  it('reports a session store that cannot be listed, with the reason', async () => {
    const root = realRoot()
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: { list: async () => { throw new Error('pg: connection refused') } },
      hostRoot: root,
    })

    await reconciler.reconcile()

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain('pg: connection refused')
  })

  it('reports a host root that does not resolve instead of skipping the pass silently', async () => {
    const root = realRoot()
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-a', cwd: join(root, 'ws-a'), createdAt: 1 }]),
      hostRoot: join(root, 'does-not-exist'),
    })

    await reconciler.reconcile()

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain(join(root, 'does-not-exist'))
  })

  it('reports a rebind that throws, naming the workspace and the failure', async () => {
    const root = realRoot()
    // A real anchor: this case is about the registry rejecting the rebind, not
    // about the cwd failing to resolve.
    mkdirSync(join(root, 'ws-a'), { recursive: true })
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-a', cwd: join(root, 'ws-a'), createdAt: 1 }]),
      hostRoot: root,
      rebindError: new Error('workspace registry entity cannot attach sessions'),
    })

    await reconciler.reconcile()

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain(join(root, 'ws-a'))
    expect(logger.lines[0]).toContain('workspace registry entity cannot attach sessions')
  })

  it('reports a session whose stored header carries no cwd, naming the session', async () => {
    const root = realRoot()
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-no-cwd', createdAt: 1 }]),
      hostRoot: root,
    })

    await reconciler.reconcile()

    // The one join key the pass has is the header's cwd. A header without one
    // is not "no work to do": it is a session that will stay Ungrouped forever,
    // and the only place that can be seen is this line.
    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain('sess-no-cwd')
  })

  it('reports a cwd that resolves outside the platform host root, naming the session', async () => {
    const root = realRoot()
    const outside = realRoot()
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-outside', cwd: outside, createdAt: 1 }]),
      hostRoot: root,
    })

    await reconciler.reconcile()

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain('sess-outside')
    expect(logger.lines[0]).toContain(outside)
  })

  it('reports a cwd that no longer resolves, naming the session and the path', async () => {
    const root = realRoot()
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-gone', cwd: join(root, 'deleted'), createdAt: 1 }]),
      hostRoot: root,
    })

    await reconciler.reconcile()

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toContain('sess-gone')
    expect(logger.lines[0]).toContain(join(root, 'deleted'))
  })

  it('stays quiet when the pass has nothing to report', async () => {
    const root = realRoot()
    mkdirSync(join(root, 'ws-a'), { recursive: true })
    const { reconciler, logger } = setup({
      rows: [{ workspaceId: 'ws-a', path: join(root, 'ws-a') }],
      sessions: headers([{ id: 'sess-a', cwd: join(root, 'ws-a'), createdAt: 1 }]),
      hostRoot: root,
    })

    await reconciler.reconcile()

    expect(logger.lines).toEqual([])
  })
})

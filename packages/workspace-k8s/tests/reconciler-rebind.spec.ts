/**
 * Reconciler rebind pass: re-derive the session<->workspace association from
 * the durable join key (session header `cwd` <-> record `path`).
 *
 * The association exists in exactly one place — the official record's
 * `sessionIds` — and that array is filtered on read by a canonical-cwd index
 * the registry builds once, at init. A workspace whose `/workspaces/<id>`
 * anchor did not exist at that moment therefore reads as empty forever. These
 * tests pin the repair: matching sessions are re-attached through the official
 * entity, non-matching and unresolvable ones are left alone, and the order the
 * reconciler feeds them in is oldest-first (attach prepends).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceReconciler, type SessionHeaderSource } from '../src/reconciler.ts'
import type { SessionRebind, WorkspaceRegistry, RegistryWorkspace } from '../src/registry.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
}

/** A registry bridge that records what the reconciler asked it to rebind. */
class FakeRegistry implements WorkspaceRegistry {
  readonly rebinds: Array<{ path: string; sessions: SessionRebind[] }> = []
  constructor(readonly rows: RegistryWorkspace[] = []) {}
  async list(): Promise<RegistryWorkspace[]> { return [...this.rows] }
  async create(path: string): Promise<RegistryWorkspace> {
    const row = { workspaceId: path.split('/').filter(Boolean).at(-1) ?? '', path }
    this.rows.push(row)
    return row
  }
  async delete(): Promise<void> {}
  async rebind(workspacePath: string, sessions: readonly SessionRebind[]): Promise<string[]> {
    this.rebinds.push({ path: workspacePath, sessions: [...sessions] })
    return sessions.map((session) => session.id)
  }
}

const headers = (list: Array<{ id: string; cwd?: string; createdAt: number }>): SessionHeaderSource => ({
  async list() {
    return list.map((header) => ({ header }))
  },
})

const reconcilerFor = (
  rows: RegistryWorkspace[],
  sessions: SessionHeaderSource,
  hostRoot = '/workspaces',
) => {
  const registry = new FakeRegistry(rows)
  const reconciler = new WorkspaceReconciler({
    controller: new FakeController(),
    registry,
    sessions,
    namespace: 'dsh',
    hostRoot,
  })
  return { registry, reconciler }
}

/**
 * Real directories: the reconciler canonicalizes `cwd` the way the official
 * registry does, and the cleanup must await the body before it removes the tree
 * (an unawaited `finally` deletes the root out from under the pass).
 */
const withTempRoot = async <T>(body: (root: string) => Promise<T>): Promise<T> => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rebind-'))
  try {
    return await body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A real side directory that is NOT under `root`, for the outside-the-host-root case. */
const withOutsideDir = async <T>(body: (outside: string) => Promise<T>): Promise<T> => {
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
  try {
    return await body(outside)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}

describe('WorkspaceReconciler.rebindSessions', () => {
  it('re-attaches every session whose cwd is a registered workspace path', async () => {
    await withTempRoot(async (root) => {
      const wsA = join(root, 'ws-a')
      mkdirSync(wsA, { recursive: true })
      const { registry, reconciler } = reconcilerFor(
        [{ workspaceId: 'ws-a', path: realpathSync(wsA) }],
        headers([
          { id: 'sess-a1', cwd: wsA, createdAt: 200 },
          { id: 'sess-a2', cwd: wsA, createdAt: 100 },
          { id: 'sess-elsewhere', cwd: root, createdAt: 50 },
          { id: 'sess-gone', cwd: join(root, 'missing'), createdAt: 10 },
          { id: 'sess-nocwd', createdAt: 1 },
        ]),
        root,
      )

      await reconciler.reconcile()

      expect(registry.rebinds).toHaveLength(1)
      expect(registry.rebinds[0]?.path).toBe(realpathSync(wsA))
      // Oldest-first, so the prepend yields newest-first.
      expect(registry.rebinds[0]?.sessions.map((session) => session.id)).toEqual(['sess-a2', 'sess-a1'])
    })
  })

  it('gives one session to one record only, even when two records share a path', async () => {
    await withTempRoot(async (root) => {
      const wsA = join(root, 'ws-a')
      mkdirSync(wsA, { recursive: true })
      const { registry, reconciler } = reconcilerFor(
        [
          { workspaceId: 'ws-a', path: realpathSync(wsA) },
          { workspaceId: 'ws-a-alias', path: realpathSync(wsA) },
        ],
        headers([{ id: 'sess-1', cwd: wsA, createdAt: 1 }]),
        root,
      )

      await reconciler.reconcile()

      expect(registry.rebinds).toHaveLength(1)
      expect(registry.rebinds[0]?.sessions.map((session) => session.id)).toEqual(['sess-1'])
    })
  })

  it('repeats the same rebind on every pass and skips sessions outside the host root', async () => {
    await withTempRoot(async (hostRoot) => {
      await withOutsideDir(async (outside) => {
        const wsA = join(hostRoot, 'ws-a')
        mkdirSync(wsA, { recursive: true })
        const sessions = headers([
          { id: 'sess-in', cwd: wsA, createdAt: 1 },
          { id: 'sess-out', cwd: outside, createdAt: 2 },
        ])
        const { registry, reconciler } = reconcilerFor([{ workspaceId: 'ws-a', path: realpathSync(wsA) }], sessions, hostRoot)

        await reconciler.reconcile()
        await reconciler.reconcile()

        expect(registry.rebinds.map((rebind) => rebind.sessions.map((session) => session.id))).toEqual([
          ['sess-in'],
          ['sess-in'],
        ])
      })
    })
  })

  it('does not fail the pass when session persistence is unavailable or the registry has no rows', async () => {
    const failing: SessionHeaderSource = { list: async () => { throw new Error('persistence down') } }
    const { registry, reconciler } = reconcilerFor(
      [{ workspaceId: 'ws-a', path: '/workspaces/ws-a' }],
      failing,
      '/workspaces',
    )

    await expect(reconciler.reconcile()).resolves.toBeUndefined()
    expect(registry.rebinds).toEqual([])
  })
})

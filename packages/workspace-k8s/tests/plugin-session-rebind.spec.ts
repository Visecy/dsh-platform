/**
 * The plugin's OWN wiring to the durable session store.
 *
 * The defect this file exists for: `apply()` handed the reconciler a
 * `SessionHeaderSource` whose `list()` read `ctx.sessionPersistence` through
 * the context proxy — but the plugin never declares `sessionPersistence` in
 * `inject`, so cordis threw `cannot get property "sessionPersistence" without
 * inject` on EVERY pass. The failure was reported through a logger that had no
 * sink at the time, so the session<->workspace rebind silently never ran.
 *
 * Every other rebind suite stayed green through all of that, because they hand
 * `WorkspaceReconciler` a `SessionHeaderSource` (or a `Harness.sessions` seam)
 * directly and never load the plugin. The thing that was broken is the wiring
 * between `apply()` and the store, so these tests mount the REAL plugin in a
 * composition shaped like the profile rows:
 *
 * - a real official `WorkspaceRegistry` over the harness medium,
 * - a `sessionPersistence` service registered on the ROOT context, exactly like
 *   the rdb backend row (a `Service` whose name is the service),
 * - the workspace plugin loaded from `src/index.ts` with a fake pod controller.
 *
 * They also pin the inverse composition: without session persistence the pass
 * must skip the rebind and say WHY once, naming the missing service — not
 * every 60-second tick, and not as "no sessions to rebind".
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, name } from '../src/index.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { RegistryWorkspace, SessionRebind } from '../src/registry.ts'
import { startPluginComposition } from './official-registry-harness.ts'

/** The smallest PodController the reconcile pass can run against. */
class FakeController implements PodController {
  listPodsCalls = 0
  listPvcsCalls = 0
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { this.listPodsCalls += 1; return [] }
  async listPvcs(): Promise<string[]> { this.listPvcsCalls += 1; return [] }
}

/** A duck-typed official `ctx.workspaceRegistry` for the composition without a session store. */
class RecordingRegistry extends Service {
  readonly rebinds: Array<{ path: string; sessions: SessionRebind[] }> = []
  constructor(ctx: Context, readonly rows: RegistryWorkspace[]) {
    super(ctx, 'workspaceRegistry')
  }
  list(): RegistryWorkspace[] { return [...this.rows] }
  async create(path: string): Promise<RegistryWorkspace> {
    const row = { workspaceId: path.split('/').filter(Boolean).at(-1) ?? '', path }
    this.rows.push(row)
    return row
  }
  async delete(): Promise<void> {}
  async resolveByPath(path: string) {
    const row = this.rows.find((workspace) => workspace.path === path)
    if (row === undefined) return undefined
    return {
      id: `uuid-${row.workspaceId}`,
      path: row.path,
      sessionIds: this.rebinds.find((rebind) => rebind.path === path)?.sessions.map((s) => s.id) ?? [],
      async attachSession() {},
      async detachSession() {},
    }
  }
  async rebind(workspacePath: string, sessions: readonly SessionRebind[]): Promise<string[]> {
    this.rebinds.push({ path: workspacePath, sessions: [...sessions] })
    return sessions.map((session) => session.id)
  }
}

const roots: string[] = []
/** A canonical root: the pass realpaths `hostRoot` and every session `cwd`. */
const tempRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-wiring-')))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Poll instead of sleeping a fixed number of ticks: both passes touch the fs. */
const until = async (predicate: () => boolean, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the reconcile pass')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const pluginConfig = (controller: PodController, hostRoot: string, reconcileIntervalMs = 0) => ({
  namespace: 'dsh-platform',
  image: 'visecy/dsh-sandbox-daemon:test',
  controller,
  hostRoot,
  reconcileIntervalMs,
})

describe('workspace-k8s plugin session wiring', () => {
  it('reaches ctx.sessionPersistence and repairs the association at load', async () => {
    const hostRoot = tempRoot()
    const workspacePath = join(hostRoot, 'ws-a')
    // The anchor exists, so the session's cwd resolves — but the record is
    // already `initialized` and does not account the session, so the registry's
    // one-shot bootstrap is SKIPPED and only the rebind can repair it. This is
    // the state a pod replacement leaves behind.
    mkdirSync(workspacePath, { recursive: true })
    const harness = await startPluginComposition({
      records: [{ path: workspacePath, sessionIds: [] }],
      storedSessions: [{ id: 'session-wired', cwd: workspacePath, createdAt: 100 }],
      global: { initialized: true, workspaceIds: [`ws-${workspacePath}`], archivedSessionIds: [] },
    })
    expect(harness.registry.list()[0]?.sessionIds).toEqual([])
    const warningsBefore = harness.warnings.length
    let listCalls = 0
    const list = harness.sessions.list.bind(harness.sessions)
    harness.sessions.list = async () => {
      listCalls += 1
      return await list()
    }

    void harness.ctx.plugin({ name, apply }, pluginConfig(new FakeController(), hostRoot))

    // The reconciler must actually read the store (the wiring that was broken)
    // AND the join key must land on the record.
    await until(() => listCalls > 0)
    await until(() => (harness.registry.list()[0]?.sessionIds ?? []).includes('session-wired'))

    expect(listCalls).toBeGreaterThan(0)
    expect(harness.registry.list()[0]?.sessionIds).toEqual(['session-wired'])
    // No phantom failure: the pass had a working session source.
    expect(harness.warnings.slice(warningsBefore)).toEqual([])
  })

  it('skips the rebind without a session store, naming the service once per condition', async () => {
    const hostRoot = tempRoot()
    const workspacePath = join(hostRoot, 'ws-a')
    mkdirSync(workspacePath, { recursive: true })
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as never
    // No `sessionPersistence` in this composition — only the registry the
    // rebind would write through.
    new RecordingRegistry(ctx, [{ workspaceId: 'ws-a', path: workspacePath }])
    const ctrl = new FakeController()
    // A short interval so "once" is measured against many real passes, not one.
    void ctx.plugin({ name, apply }, pluginConfig(ctrl, hostRoot, 20))

    await until(() => ctrl.listPvcsCalls >= 4)

    // One line, naming the missing service: not one per tick, and not silent.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sessionPersistence')
  })
})

/**
 * The reconciler's rebind pass, driven through the REAL official registry.
 *
 * The plugin creates one `/workspaces/<id>` anchor and record per k8s resource
 * during the bridge step of the SAME pass that then re-derives the
 * session<->workspace association. These tests drive both steps against a real
 * `WorkspaceRegistry` (see `official-registry-harness.ts`) over a real
 * filesystem, which is the only way the pass's ordering bug shows up: the fake
 * registry used before this returned a LIVE array from `list()`, so the
 * pre-bridge snapshot silently grew in place and hid the stale-view defect.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import { WorkspaceReconciler } from '../src/reconciler.ts'
import { HostWorkspaceRegistry } from '../src/registry.ts'
import { startRegistry, type Harness } from './official-registry-harness.ts'

class FakeController implements PodController {
  constructor(readonly pods: string[], readonly pvcs: string[]) {}
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { return [...this.pods] }
  async listPvcs(): Promise<string[]> { return [...this.pvcs] }
}

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-live-rebind-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class RecordingLogger {
  readonly warnings: string[] = []
  warn(message: unknown): void { this.warnings.push(String(message)) }
}

const reconcilerFor = (harness: Harness, hostRoot: string, pods: string[], pvcs: string[]) => {
  const logger = new RecordingLogger()
  const registry = new HostWorkspaceRegistry(
    { get: (name) => harness.ctx.get(name as never) as never },
    hostRoot,
  )
  const reconciler = new WorkspaceReconciler({
    controller: new FakeController(pods, pvcs),
    registry,
    sessions: harness.sessions,
    namespace: 'dsh-platform',
    hostRoot,
    logger,
  })
  return { registry, reconciler, logger }
}

/** The record's durable membership, index filter included (the live read path). */
const attached = (harness: Harness, path: string): string[] => {
  const record = harness.registry.list().find((workspace) => workspace.path === path)
  if (record === undefined) throw new Error(`no official record for '${path}'`)
  return [...record.sessionIds]
}

/** The record's RAW durable membership, read straight off the medium. */
const durable = (harness: Harness, path: string): string[] => {
  for (const record of harness.durable.records.values()) {
    if (record['path'] === path) return [...(record['sessionIds'] as string[])]
  }
  throw new Error(`no durable record for '${path}'`)
}

describe('WorkspaceReconciler rebind against the real official registry', () => {
  it('repairs the association in the SAME pass that creates the record and anchor', async () => {
    const root = realpathSync(tempRoot())
    // A production-shaped deployment: the PVC exists, no record does, and the
    // stored session already points at the anchor that does not exist yet.
    const harness = await startRegistry({
      storedSessions: [{ id: 'session-live', cwd: join(root, 'test-pod'), createdAt: 100 }],
    })
    const { reconciler } = reconcilerFor(harness, root, ['test-pod'], ['test-pod-data'])

    // One pass is all a correct reconciler needs: it must rebind against what
    // the bridge just wrote, not the empty snapshot it read at the top.
    await reconciler.reconcile()

    const workspacePath = join(root, 'test-pod')
    expect(durable(harness, workspacePath)).toEqual(['session-live'])
    expect(attached(harness, workspacePath)).toEqual(['session-live'])
  })

  it('repairs a deployment that is already broken: empty records and unindexed sessions', async () => {
    const root = realpathSync(tempRoot())
    // The live state: `sessionIds: []` records whose anchors were missing when
    // the registry indexed the stored headers, so the sessions are invisible.
    const harness = await startRegistry({
      records: [{ path: join(root, 'test-pod'), title: 'test-pod', sessionIds: [] }],
      storedSessions: [
        { id: 'session-older', cwd: join(root, 'test-pod'), createdAt: 100 },
        { id: 'session-newer', cwd: join(root, 'test-pod'), createdAt: 300 },
      ],
    })
    expect(attached(harness, join(root, 'test-pod'))).toEqual([])
    const { reconciler } = reconcilerFor(harness, root, ['test-pod'], ['test-pod-data'])

    await reconciler.reconcile()

    // Newest-first, exactly like a live attach.
    expect(attached(harness, join(root, 'test-pod'))).toEqual(['session-newer', 'session-older'])
    expect(durable(harness, join(root, 'test-pod'))).toEqual(['session-newer', 'session-older'])
  })

  it('re-creates a missing anchor for a record the registry already knows', async () => {
    const root = realpathSync(tempRoot())
    const workspacePath = join(root, 'test-pod')
    const harness = await startRegistry({
      records: [{ path: workspacePath, title: 'test-pod', sessionIds: [] }],
      storedSessions: [{ id: 'session-live', cwd: workspacePath, createdAt: 100 }],
    })
    // A bridge that only creates an anchor while REGISTERING a workspace leaves
    // this state unrecoverable: the record is known, so the bridge skips it and
    // nothing ever creates the directory the official attach needs. The
    // reconciler owns the anchors, so it has to own this case too.
    expect(existsSync(workspacePath)).toBe(false)
    const { reconciler } = reconcilerFor(harness, root, ['test-pod'], ['test-pod-data'])

    await reconciler.reconcile()

    expect(existsSync(workspacePath)).toBe(true)
    expect(attached(harness, workspacePath)).toEqual(['session-live'])
  })

  it('writes nothing on a second attempt once the association is repaired', async () => {
    const root = realpathSync(tempRoot())
    const harness = await startRegistry({
      records: [{ path: join(root, 'test-pod'), title: 'test-pod', sessionIds: [] }],
      storedSessions: [{ id: 'session-live', cwd: join(root, 'test-pod'), createdAt: 100 }],
    })
    const { reconciler } = reconcilerFor(harness, root, ['test-pod'], ['test-pod-data'])

    await reconciler.reconcile()
    const afterFirst = harness.writes.length
    expect(attached(harness, join(root, 'test-pod'))).toEqual(['session-live'])

    await reconciler.reconcile()

    expect(harness.writes.length).toBe(afterFirst)
  })

  it('repairs every session of the live deployment in one pass', async () => {
    // The acceptance shape, read off the deployed database: seven sessions
    // whose cwd is `/workspaces/<name>` and six bridge-created records with
    // `sessionIds: []`. Three sessions share `test-pod`, four share
    // `test-upgrade`, and the ids and timestamps are the live ones.
    const root = realpathSync(tempRoot())
    const names = ['test-pod', 'test-final', 'test-db', 'test-upgrade', 'git', 'f49f56f4-803a-43aa-bd95-a955ef9ecd91']
    const sessions = [
      { id: 'session-5fecf1e8-d7a3-4400-86c5-adecad81aa5a', name: 'test-pod', createdAt: 1787855234237 },
      { id: 'session-d869bf5a-32c8-4415-a386-6055ee49d481', name: 'test-pod', createdAt: 1787503968396 },
      { id: 'session-1ea4a6a4-bc3a-4e58-87cd-489eb41689e1', name: 'test-pod', createdAt: 1787504113120 },
      { id: 'session-e01ccdd0-5dd9-4bb7-b1d3-603b1d5366ff', name: 'test-pod', createdAt: 1791126833347 },
      { id: 'session-1809876e-8c7b-452d-a27b-533a95f47829', name: 'test-upgrade', createdAt: 1791126451295 },
      { id: 'session-cb74a018-07f0-4abd-a9bb-a3aeca445ada', name: 'test-upgrade', createdAt: 1787594788375 },
      { id: 'session-b785b590-af1f-4162-ac54-53ac83a0b3ac', name: 'test-upgrade', createdAt: 1787761187934 },
    ]
    const harness = await startRegistry({
      records: names.map((name) => ({ path: join(root, name), title: name, sessionIds: [] })),
      storedSessions: sessions.map((session) => ({
        id: session.id,
        cwd: join(root, session.name),
        createdAt: session.createdAt,
      })),
    })
    const { reconciler } = reconcilerFor(
      harness,
      root,
      names,
      names.map((name) => `${name}-data`),
    )

    await reconciler.reconcile()

    for (const name of names) {
      const expected = sessions
        .filter((session) => session.name === name)
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((session) => session.id)
      expect(attached(harness, join(root, name)), name).toEqual(expected)
      expect(durable(harness, join(root, name)), name).toEqual(expected)
    }
  })
})

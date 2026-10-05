import { describe, expect, it } from 'vitest'
import { HostWorkspaceRegistry } from '../src/registry.ts'

/** A channel whose get() answers 'workspaceRegistry' with the given official impl. */
const channel = (impl: {
  create?: (path: string, title?: string) => any
  list?: () => readonly any[]
  delete?: (id: string) => Promise<boolean>
  resolveByPath?: (path: string) => Promise<any>
}) => ({
  get: (name: string) => (name === 'workspaceRegistry' ? { ...impl } : undefined),
})

/**
 * A channel that hands out the official registry object itself. `channel`
 * above spreads, which snapshots accessors — fine for plain rows, wrong for a
 * live entity whose `sessionIds` getter is the whole point.
 */
const liveChannel = (registry: unknown) => ({
  get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined),
})

/**
 * The official record's session membership as `@deepseek-ai/dsh-workspace`
 * (0.2.0-rc.2, `lib/index.js`) actually behaves — the same ordering these
 * specs pinned against 0.1.5-rc.3, re-checked when the fixture was re-vendored:
 *
 * - reads are filtered by a canonical-cwd index the registry builds once at
 *   init, so an unindexed id reads as unowned even while the record claims it;
 * - `attachSession` short-circuits on the DURABLE membership FIRST
 *   (`if (!this.record.sessionIds.includes(sessionId))`), and only its
 *   not-already-claimed branch reads the header, validates the cwd and calls
 *   `rememberSessionPath`;
 * - every write goes through a mutate tail that re-filters the durable
 *   membership by that same index.
 *
 * The real semantics are pinned by `official-registry-rebind.spec.ts`, which
 * runs the shipped registry; this fake exists so the bridge's own unit tests do
 * not have to build a filesystem and a storage backend. It has to model the
 * short-circuit exactly, because that ordering is why the bridge must never
 * detach an id the index hides.
 */
class FakeOfficialEntity {
  /** Durable membership (what the record claims). */
  ids: string[]
  /** The registry's canonical-cwd index: a session absent here reads as unowned. */
  indexed: Set<string>
  readonly calls: string[] = []
  constructor(ids: string[], indexed: string[] = [...ids]) {
    this.ids = [...ids]
    this.indexed = new Set(indexed)
  }
  get sessionIds(): readonly string[] {
    return this.ids.filter((id) => this.indexed.has(id))
  }
  async attachSession(id: string): Promise<void> {
    this.calls.push(`attach:${id}`)
    // Official order: the durable-membership short-circuit comes FIRST, so an id
    // the record already claims never refreshes the index, and the mutate tail
    // then prunes it. Only a not-already-claimed id reaches the header read and
    // `rememberSessionPath`.
    if (!this.ids.includes(id)) this.indexed.add(id)
    if (!this.ids.includes(id)) this.ids = [id, ...this.ids]
    this.pruneDurably()
  }
  async detachSession(id: string): Promise<void> {
    this.calls.push(`detach:${id}`)
    this.ids = this.ids.filter((existing) => existing !== id)
    this.pruneDurably()
  }
  /**
   * The official entity's `mutate` tail: every write re-filters the durable
   * membership by the cwd index, which is what makes a hidden session's
   * association disappear for good if a write happens before an attach can
   * refresh the index.
   */
  private pruneDurably(): void {
    this.ids = this.ids.filter((id) => this.indexed.has(id))
  }
}

describe('HostWorkspaceRegistry.rebind (session<->workspace repair)', () => {
  it('recovers a membership the index hides, at the cost of one pruning pass', async () => {
    // A record can still durably claim a session the index hides. The official
    // `attachSession` cannot refresh the index for it (the durable-membership
    // short-circuit runs first), and its mutate tail prunes the id: the first
    // pass therefore LOSES the durable claim. That is not the end of the story,
    // because the association's source of truth (the session header's cwd) is
    // untouched, so the pass after the prune attaches it for real.
    const entity = new FakeOfficialEntity(['sess-1'], [])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    expect(entity.sessionIds).toEqual([])
    await reg.rebind('/workspaces/ws-a', [{ id: 'sess-1', path: '/workspaces/ws-a', createdAt: 1 }])
    expect(entity.ids).toEqual([])

    const attached = await reg.rebind('/workspaces/ws-a', [{ id: 'sess-1', path: '/workspaces/ws-a', createdAt: 1 }])

    expect(entity.calls).toEqual(['attach:sess-1', 'attach:sess-1'])
    expect(entity.sessionIds).toEqual(['sess-1'])
    expect(attached).toEqual(['sess-1'])
  })

  it('repairs an empty record the registry never indexed, which is the production shape', async () => {
    // The live deployment's six records carry `"sessionIds": []`: the bridge
    // created them after the registry's one-shot index had already given up on
    // their cwd. The attach then takes its not-already-claimed branch, which
    // reads the header, validates the now-existing cwd and refreshes the index.
    const entity = new FakeOfficialEntity([], [])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    const attached = await reg.rebind('/workspaces/ws-a', [{ id: 'sess-1', path: '/workspaces/ws-a', createdAt: 1 }])

    expect(entity.calls).toEqual(['attach:sess-1'])
    expect(entity.ids).toEqual(['sess-1'])
    expect(entity.sessionIds).toEqual(['sess-1'])
    expect(attached).toEqual(['sess-1'])
  })

  it('re-attaches a mis-ordered membership through detach then attach', async () => {
    // Both sessions are visible but the durable order is wrong (oldest first),
    // so this pass must go through detach: an attach alone would short-circuit
    // and leave the order — and the index refresh that comes with it — as is.
    const entity = new FakeOfficialEntity(['sess-old', 'sess-new'])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    const attached = await reg.rebind('/workspaces/ws-a', [
      { id: 'sess-new', path: '/workspaces/ws-a', createdAt: 300 },
      { id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 },
    ])

    expect(entity.calls).toEqual(['detach:sess-old', 'detach:sess-new', 'attach:sess-old', 'attach:sess-new'])
    expect(entity.sessionIds).toEqual(['sess-new', 'sess-old'])
    expect(attached).toEqual(['sess-new', 'sess-old'])
  })

  it('attaches oldest-first so the prepend yields newest-first, and skips unrelated records', async () => {
    const entity = new FakeOfficialEntity([])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    // Deliberately unsorted input: the rebind owns the ordering.
    await reg.rebind('/workspaces/ws-a', [
      { id: 'sess-new', path: '/workspaces/ws-a', createdAt: 300 },
      { id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 },
      { id: 'sess-mid', path: '/workspaces/ws-a', createdAt: 200 },
    ])

    expect(entity.calls).toEqual(['attach:sess-old', 'attach:sess-mid', 'attach:sess-new'])
    expect(entity.sessionIds).toEqual(['sess-new', 'sess-mid', 'sess-old'])
  })

  it('is idempotent: a repeated pass writes the same membership, never a duplicate', async () => {
    const entity = new FakeOfficialEntity([])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')
    const sessions = [
      { id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 },
      { id: 'sess-new', path: '/workspaces/ws-a', createdAt: 300 },
    ]

    await reg.rebind('/workspaces/ws-a', sessions)
    const afterFirst = [...entity.calls]
    await reg.rebind('/workspaces/ws-a', sessions)

    expect(entity.ids).toEqual(['sess-new', 'sess-old'])
    expect(entity.sessionIds).toEqual(['sess-new', 'sess-old'])
    // The repair itself takes detach+attach per session; the second pass is a
    // no-op because the first one left the record in rebind order.
    expect(afterFirst).toEqual(['attach:sess-old', 'attach:sess-new'])
    expect(entity.calls).toEqual(afterFirst)
  })

  it('does not re-attach a membership that is already in rebind order', async () => {
    const entity = new FakeOfficialEntity(['sess-new', 'sess-old'])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    await reg.rebind('/workspaces/ws-a', [
      { id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 },
      { id: 'sess-new', path: '/workspaces/ws-a', createdAt: 300 },
    ])
    entity.calls.length = 0
    await reg.rebind('/workspaces/ws-a', [
      { id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 },
      { id: 'sess-new', path: '/workspaces/ws-a', createdAt: 300 },
    ])

    // Steady state: no write, so the periodic pass costs nothing.
    expect(entity.calls).toEqual([])
  })

  it('leaves membership outside the rebind scope alone', async () => {
    const entity = new FakeOfficialEntity(['sess-new', 'sess-foreign'])
    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')

    await reg.rebind('/workspaces/ws-a', [{ id: 'sess-old', path: '/workspaces/ws-a', createdAt: 100 }])

    expect(entity.calls).toEqual(['attach:sess-old'])
    expect(entity.sessionIds).toEqual(['sess-old', 'sess-new', 'sess-foreign'])
  })

  it('is a no-op for an unknown path, an absent registry or an empty session list', async () => {
    const entity = new FakeOfficialEntity([])
    const unknownPath = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => undefined }), '/workspaces')
    await expect(unknownPath.rebind('/workspaces/ws-a', [{ id: 's', path: '/workspaces/ws-a', createdAt: 1 }]))
      .resolves.toEqual([])

    const absent = new HostWorkspaceRegistry({ get: () => undefined }, '/workspaces')
    await expect(absent.rebind('/workspaces/ws-a', [{ id: 's', path: '/workspaces/ws-a', createdAt: 1 }]))
      .resolves.toEqual([])

    const reg = new HostWorkspaceRegistry(liveChannel({ resolveByPath: async () => entity }), '/workspaces')
    await expect(reg.rebind('/workspaces/ws-a', [])).resolves.toEqual([])
    expect(entity.calls).toEqual([])
  })
})

describe('HostWorkspaceRegistry (ctx.workspaceRegistry bridge, DSH 0.1.2)', () => {
  it('lists workspaces from the official registry rows', async () => {
    const reg = new HostWorkspaceRegistry(channel({
      list: () => [
        { id: 'opaque-uuid', path: '/workspaces/ws-a', title: 'A' },
        { id: 'other-uuid', path: '/workspaces/ws-b', title: 'B' },
      ],
    }), '/workspaces')
    expect(await reg.list()).toEqual([
      { workspaceId: 'ws-a', path: '/workspaces/ws-a', title: 'A', internalId: 'opaque-uuid' },
      { workspaceId: 'ws-b', path: '/workspaces/ws-b', title: 'B', internalId: 'other-uuid' },
    ])
  })

  it('uses the stable path segment for platform workspace ids, not the official UUID', async () => {
    const reg = new HostWorkspaceRegistry(channel({
      list: () => [{ id: 'opaque-uuid', path: '/workspaces/ws-abc', title: 'ABC' }],
    }), '/workspaces')
    const rows = await reg.list()
    expect(rows[0]?.workspaceId).toBe('ws-abc')
    expect(rows[0]?.internalId).toBe('opaque-uuid')
  })

  it('excludes foreign registry rows outside the platform host root', async () => {
    const reg = new HostWorkspaceRegistry(channel({
      list: () => [
        { id: 'root-uuid', path: '/', title: 'workspaces' },
        { id: 'foreign-uuid', path: '/home/me/proj', title: 'P' },
        { id: 'ok-uuid', path: '/workspaces/ws-a', title: 'A' },
      ],
    }), '/workspaces')
    const rows = await reg.list()
    expect(rows).toEqual([{ workspaceId: 'ws-a', path: '/workspaces/ws-a', title: 'A', internalId: 'ok-uuid' }])
  })

  it('creates a workspace through the official registry and maps its row', async () => {
    const created = { id: 'new-uuid', path: '/workspaces/ws-new', title: 'New' }
    const reg = new HostWorkspaceRegistry(channel({
      create: async (path: string) => {
        expect(path).toBe('/workspaces/ws-new')
        return created
      },
    }), '/workspaces')
    expect(await reg.create('/workspaces/ws-new')).toEqual({
      workspaceId: 'ws-new',
      path: '/workspaces/ws-new',
      title: 'New',
      internalId: 'new-uuid',
    })
  })

  it('deletes by resolving the platform id to the official UUID', async () => {
    const deleted: string[] = []
    const reg = new HostWorkspaceRegistry(channel({
      list: () => [
        { id: 'opaque-uuid', path: '/workspaces/ws-x', title: 'X' },
        { id: 'keep-uuid', path: '/workspaces/ws-keep', title: 'Keep' },
      ],
      delete: async (id: string) => {
        deleted.push(id)
        return true
      },
    }), '/workspaces')
    await reg.delete('ws-x')
    expect(deleted).toEqual(['opaque-uuid'])
  })

  it('surfaces a listing failure instead of deleting the wrong record', async () => {
    // The official registry is present but its durable store cannot be read.
    // Falling back to a delete by platform id would be a no-op there: the
    // record would survive, and the reconciler would put the workspace back.
    const deletions: string[] = []
    const reg = new HostWorkspaceRegistry(channel({
      list: () => { throw new Error('storage fault') },
      delete: async (id: string) => { deletions.push(id); return true },
    }), '/workspaces')
    await expect(reg.delete('ws-x')).rejects.toThrow('workspace registry unavailable')
    expect(deletions).toEqual([])
  })

  it('is a no-op when the official workspace registry is absent (headless profiles)', async () => {
    const reg = new HostWorkspaceRegistry({ get: () => undefined }, '/workspaces')
    expect(await reg.list()).toEqual([])
    await expect(reg.delete('ws-a')).resolves.toBeUndefined()
  })
})

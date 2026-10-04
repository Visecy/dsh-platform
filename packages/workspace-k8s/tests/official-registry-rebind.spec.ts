/**
 * The rebind repair, driven through the REAL official registry.
 *
 * The defect the previous implementation could not settle is a semantic of
 * `@deepseek-ai/dsh-workspace` 0.1.5-rc.3 (`lib/index.js`), and its own test
 * suite answered it with a fake that had the ordering backwards. These tests
 * run the shipped code instead: a real `WorkspaceRegistry` over a real
 * filesystem, driven through `HostWorkspaceRegistry.rebind`.
 *
 * The production situation is the one the live deployment is in:
 *
 * 1. The control plane pod starts. `/workspaces/<id>` anchors do not exist yet
 *    (the reconciler creates them), so at registry init every stored session
 *    header whose cwd points at one is indexed as "cwd does not resolve" and is
 *    therefore INVISIBLE to the registry's `sessionIds` filter.
 * 2. The reconciler then creates the anchor.
 *
 * What happens next is the whole question. These tests pin the answer.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostWorkspaceRegistry, type SessionRebind } from '../src/registry.ts'
import { startRegistry, type Harness } from './official-registry-harness.ts'

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-official-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const bridge = (harness: Harness, hostRoot: string): HostWorkspaceRegistry =>
  new HostWorkspaceRegistry({ get: (name) => harness.ctx.get(name as never) as never }, hostRoot)

/** The raw durable membership of the record owning `path` (never index-filtered). */
const durableSessionIds = (harness: Harness, path: string): string[] => {
  for (const record of harness.durable.records.values()) {
    if (record['path'] === path) return [...(record['sessionIds'] as string[])]
  }
  throw new Error(`no durable record for '${path}'`)
}

const entity = (harness: Harness, path: string) => {
  const found = harness.registry.list().find((workspace) => workspace.path === path)
  if (found === undefined) throw new Error(`official registry has no record for '${path}'`)
  return found
}

describe('official dsh-workspace semantics vs. HostWorkspaceRegistry.rebind', () => {
  it('repairs an association the registry could not index at init, once the anchor exists', async () => {
    const root = tempRoot()
    const workspacePath = join(root, 'ws-a')
    const sessionId = 'session-a'

    // Boot with the anchor missing and the record EMPTY — exactly the production
    // state (`dsh_storage_records` holds `"sessionIds":[]` for the six records
    // the bridge created). The session is not accounted by the record at all,
    // and the registry's init marked its cwd unresolvable, so it is invisible.
    const firstBoot = await startRegistry({
      records: [{ path: workspacePath, sessionIds: [] }],
      storedSessions: [{ id: sessionId, cwd: workspacePath, createdAt: 100 }],
    })
    expect(firstBoot.registry.list()[0]?.sessionIds).toEqual([])

    // The reconciler creates the anchor. Records only ever carry canonical
    // paths (`create` realpaths them), so the pass joins on that spelling.
    mkdirSync(workspacePath, { recursive: true })
    const canonical = realpathSync(workspacePath)
    const rebind: SessionRebind[] = [{ id: sessionId, path: canonical, createdAt: 100 }]
    const attached = await bridge(firstBoot, root).rebind(canonical, rebind)

    // The official attach takes its NOT-already-claimed branch: it reads the
    // header, validates the now-existing cwd, calls `rememberSessionPath` (the
    // index refresh), and prepends the id. So this shape of the bug IS
    // repairable — provided the pass runs against a view that can see the
    // record.
    expect(attached).toEqual([sessionId])
    expect(firstBoot.registry.list()[0]?.sessionIds).toEqual([sessionId])
    expect(durableSessionIds(firstBoot, workspacePath)).toEqual([sessionId])

    // And the repair survives the next pod replacement, because the record's
    // cwd now resolves at init.
    const secondBoot = await startRegistry({
      records: [...firstBoot.durable.records.values()].map((record) => ({
        path: record['path'] as string,
        title: record['title'] as string,
        sessionIds: record['sessionIds'] as string[],
      })),
      storedSessions: [{ id: sessionId, cwd: workspacePath, createdAt: 100 }],
      global: { initialized: true, workspaceIds: [...firstBoot.durable.records.keys()], archivedSessionIds: [] },
    })
    expect(secondBoot.registry.list()[0]?.sessionIds).toEqual([sessionId])

  })

  it('is a silent no-op for a session the record already claims but the index still hides', async () => {
    // A record can durably claim an id the index hides: the id was indexed on an
    // earlier boot (so it entered the record), and a later boot could not
    // re-index it because its anchor was gone. `attachSession` cannot rescue
    // that state: its index refresh lives INSIDE the not-already-claimed branch.
    const root = tempRoot()
    const workspacePath = join(root, 'ws-b')
    const sessionId = 'session-b'
    const harness = await startRegistry({
      records: [{ path: workspacePath, sessionIds: [sessionId] }],
      storedSessions: [{ id: sessionId, cwd: workspacePath, createdAt: 100 }],
    })
    expect(durableSessionIds(harness, workspacePath)).toEqual([sessionId])

    mkdirSync(workspacePath, { recursive: true })
    const canonical = realpathSync(workspacePath)
    const before = harness.writes.length
    const attached = await bridge(harness, root).rebind(canonical, [
      { id: sessionId, path: canonical, createdAt: 100 },
    ])

    // This is the ordering the previous implementer asserted backwards. The
    // short-circuit runs FIRST (`record.sessionIds.includes(sessionId)`), so no
    // header is read, `rememberSessionPath` is never called, `mutate` prunes the
    // hidden id out of the durable membership, and the repair does not happen.
    expect(attached).toEqual([])
    expect(harness.registry.list()[0]?.sessionIds).toEqual([])
    expect(durableSessionIds(harness, workspacePath)).toEqual([])
    // The one write is a PRUNE, not a repair — and it happened even though the
    // bridge never called `detachSession`, because `attachSession`'s mutate tail
    // filters the record by the index on every write.
    expect(harness.writes.slice(before)).toEqual([`update:ws-${workspacePath}`])
  })
})

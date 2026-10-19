/**
 * The rebind repair, driven through the REAL official registry.
 *
 * The defect the previous implementation could not settle is a semantic of
 * `@deepseek-ai/dsh-workspace` (`lib/index.js`), and its own test suite answered
 * it with a fake that had the ordering backwards. These tests run the shipped
 * code instead: a real `WorkspaceRegistry` over a real filesystem, driven
 * through `HostWorkspaceRegistry.rebind`.
 *
 * The vendored bytes are 0.2.1-rc.2 (see `tests/vendor/README.md`); the
 * decision points these tests pin — the `sessionIds` candidate filter, the
 * durable-membership short-circuit in `attachSession`, and the prune inside
 * `mutate` — were diffed across 0.1.5-rc.3, 0.2.0-rc.2 and 0.2.1-rc.2. The
 * 0.2.1 line RELAXED the filter: an id whose stored cwd is fully qualified but
 * resolves with ENOENT is now a candidate member (`missingSessionPaths`), so a
 * temporarily missing anchor no longer hides or prunes it.
 *
 * The production situation is the one the live deployment is in:
 *
 * 1. The control plane pod starts. `/workspaces/<id>` anchors do not exist yet
 *    (the reconciler creates them), so at registry init every stored session
 *    header whose cwd points at one fails to resolve.
 * 2. The reconciler then creates the anchor.
 *
 * What happens next is the whole question. These tests pin the answer, and the
 * two cases are now different: an EMPTY record has nothing to preserve (the
 * first spec), while a record that already claims an id keeps it through the
 * ENOENT tolerance (the second spec), where 0.2.0 would have pruned it.
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
    // the bridge created). The session is not accounted by the record at all, so
    // there is nothing for the ENOENT candidate tolerance to preserve.
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

  it('tolerates a claimed session whose cwd is missing at init (0.2.1 ENOENT candidates)', async () => {
    // A record can durably claim an id whose anchor is gone at boot. Up to
    // 0.2.0 the registry indexed that header as "cwd does not resolve", so the
    // id was invisible to `sessionIds` and the record's next write PRUNED it —
    // `attachSession` could not rescue it either, because its index refresh
    // lives INSIDE the not-already-claimed branch and the short-circuit runs
    // first.
    //
    // 0.2.1 changed the candidate filter: a fully-qualified cwd that fails with
    // ENOENT lands in `missingSessionPaths`, and `candidateMatches` keeps such
    // an id a member. The membership is therefore preserved across the boot,
    // and the rebind pass has nothing to repair.
    const root = tempRoot()
    const workspacePath = join(root, 'ws-b')
    const sessionId = 'session-b'
    const harness = await startRegistry({
      records: [{ path: workspacePath, sessionIds: [sessionId] }],
      storedSessions: [{ id: sessionId, cwd: workspacePath, createdAt: 100 }],
    })
    expect(durableSessionIds(harness, workspacePath)).toEqual([sessionId])
    // The tolerance is visible already at init: the missing anchor does not hide
    // the claimed id.
    expect(harness.registry.list()[0]?.sessionIds).toEqual([sessionId])

    mkdirSync(workspacePath, { recursive: true })
    const canonical = realpathSync(workspacePath)
    const before = harness.writes.length
    const attached = await bridge(harness, root).rebind(canonical, [
      { id: sessionId, path: canonical, createdAt: 100 },
    ])

    // `current` already equals `next`, so the steady-state check returns before
    // any detach/attach: no write, no prune, and the association never left.
    expect(attached).toEqual([sessionId])
    expect(harness.registry.list()[0]?.sessionIds).toEqual([sessionId])
    expect(durableSessionIds(harness, workspacePath)).toEqual([sessionId])
    expect(harness.writes.slice(before)).toEqual([])
  })
})

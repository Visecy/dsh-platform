/**
 * The record-deletion signal: what turns the official sidebar's record-only
 * delete into a real delete.
 *
 * The platform's own delete (`workspaceDeleter`) removes pod + service + PVC
 * before the record, so nothing can resurrect it. The official sidebar's
 * delete only calls `ctx.workspaceRegistry.delete(id)` — the volume survives,
 * and the reconciler re-registers the workspace from it (measured live: the
 * row came back 68 seconds later).
 *
 * The seam that closes this is the documented `domain/changed` event the
 * official `dsh-storage-domain` facility emits once per durable write; the
 * official workspace registry persists its records through that facility
 * (domain `workspace`, table `workspaces`, key = the record's uuid), so an
 * explicit deletion is observable WITHOUT patching anything and without
 * inferring intent from a PVC's existence.
 *
 * The discriminator, stated once here and once at the deletion branch below:
 *
 *   - DESTROY only on a POSITIVE, observed deletion of a record this process
 *     mapped to a platform workspace id. That evidence cannot be produced by a
 *     restart, an empty registry, a failed listing, or a wiped medium, so none
 *     of those can mass-delete volumes.
 *   - A PVC with no record and no observed deletion is "adopted from
 *     outside": the reconciler registers it, and NOTHING is destroyed. That is
 *     the safe reading of an ambiguity this process cannot resolve — the
 *     volume's data outlives every guess about why the record is missing.
 *
 * A deletion the process never saw (the plugin was not mounted at the time) is
 * therefore treated as adoption, not as a delete. That is deliberate: the
 * evidence is the deletion event, and inventing one from "a PVC exists and no
 * record does" is exactly the blind destruction the discriminator exists to
 * prevent.
 */
import { describe, expect, it } from 'vitest'
import { WorkspaceRecordDeletions, type DomainChange } from '../src/record-deletions.ts'
import type { RegistryWorkspace } from '../src/registry.ts'

class RecordingLogger {
  readonly warnings: string[] = []
  warn(message: unknown): void { this.warnings.push(String(message)) }
}

const HOST_ROOT = '/workspaces'

const record = (workspaceId: string, path = `${HOST_ROOT}/${workspaceId}`): RegistryWorkspace => ({
  workspaceId,
  path,
  title: workspaceId,
  internalId: `uuid-${workspaceId}`,
})

const change = (over: Partial<DomainChange> = {}): DomainChange => ({
  domain: 'workspace',
  table: 'workspaces',
  key: 'uuid-git',
  operation: 'deleted',
  ...over,
})

interface Rig {
  deletions: WorkspaceRecordDeletions
  destroyed: string[]
  failures: string[]
  warnings: string[]
  failNext: (error: unknown, times?: number) => void
}

const rig = (): Rig => {
  const destroyed: string[] = []
  const failures: string[] = []
  const logger = new RecordingLogger()
  const pending: unknown[] = []
  const deletions = new WorkspaceRecordDeletions({
    hostRoot: HOST_ROOT,
    logger,
    destroy: async (workspaceId: string) => {
      const failure = pending.shift()
      if (failure !== undefined) {
        failures.push(workspaceId)
        throw failure
      }
      destroyed.push(workspaceId)
    },
  })
  return {
    deletions,
    destroyed,
    failures,
    warnings: logger.warnings,
    failNext: (error, times = 1) => { for (let i = 0; i < times; i += 1) pending.push(error) },
  }
}

/** Let the fire-and-forget destroy settle. */
const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

const until = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await settle()
  }
}

describe('workspace record deletions', () => {
  it('destroys the backing of the workspace whose record was deleted', async () => {
    const r = rig()
    r.deletions.observe([record('git')])

    r.deletions.handle(change())

    await until(() => r.destroyed.length === 1)
    expect(r.destroyed).toEqual(['git'])
    // The condition clears only once the resources are actually gone, so the
    // reconciler's adoption guard lifts at the same moment.
    await until(() => !r.deletions.isCondemned('git'))
    expect(r.deletions.isCondemned('git')).toBe(false)
    expect(r.warnings).toEqual([])
  })

  it('learns the record identity from the put event that created it', async () => {
    const r = rig()
    // No listing ever ran: the record was created after this process mounted,
    // so only its `put` event carries the uuid → path join.
    r.deletions.handle(change({
      operation: 'put',
      value: { path: `${HOST_ROOT}/test-pod`, title: 'test-pod' },
      key: 'uuid-created-now',
    }))

    r.deletions.handle(change({ key: 'uuid-created-now' }))

    await until(() => r.destroyed.length === 1)
    expect(r.destroyed).toEqual(['test-pod'])
  })

  it('ignores every write that is not a workspace record', async () => {
    const r = rig()
    r.deletions.observe([record('git')])
    // The domain's global singleton (table ''), another domain, another table
    // and an unknown operation must all be inert.
    for (const event of [
      change({ table: '', key: '' }),
      change({ domain: 'platform' }),
      change({ table: 'settings' }),
      change({ operation: 'cleared' }),
    ]) {
      r.deletions.handle(event)
    }
    await settle()
    expect(r.destroyed).toEqual([])
    expect(r.warnings).toEqual([])
    // …and the real deletion still works afterwards.
    r.deletions.handle(change())
    await until(() => r.destroyed.length === 1)
  })

  it('leaves the resources alone when the deleted record cannot be identified, and says so', async () => {
    const r = rig()
    // A record whose uuid this process never saw: it cannot be mapped to a
    // workspace id, and guessing one from the surviving PVCs is exactly the
    // blind destruction the discriminator forbids.
    r.deletions.handle(change({ key: 'uuid-unknown' }))
    await settle()
    expect(r.destroyed).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('uuid-unknown')
  })

  it('ignores the deletion of a record outside the platform host root', async () => {
    const r = rig()
    // The official registry may carry rows for directories this platform does
    // not own (a home directory, another mount). They have no k8s backing, and
    // their deletion is not this plugin's business — and not a warning either.
    const foreign: RegistryWorkspace = { workspaceId: 'home', path: '/home/operator', internalId: 'uuid-home' }
    r.deletions.observe([foreign])

    r.deletions.handle(change({ key: 'uuid-home' }))

    await settle()
    expect(r.destroyed).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('keeps a workspace condemned until its backing is really gone, and retries', async () => {
    const r = rig()
    r.deletions.observe([record('stuck')])
    r.failNext(new Error('pvc is still in use'), 2)

    r.deletions.handle(change({ key: 'uuid-stuck' }))
    await until(() => r.failures.length === 1)

    // A failed destroy must NOT lift the condemnation: the volume is still
    // there, and a reconciler pass that adopted it would resurrect the
    // workspace the operator just deleted.
    expect(r.deletions.isCondemned('stuck')).toBe(true)
    const messages = await r.deletions.retry()
    expect(r.failures).toEqual(['stuck', 'stuck'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('stuck')
    expect(messages[0]).toContain('pvc is still in use')

    // Once the cluster cooperates, the retry finishes the job and the
    // workspace stops being condemned.
    await r.deletions.retry()
    expect(r.destroyed).toEqual(['stuck'])
    expect(r.deletions.isCondemned('stuck')).toBe(false)
    expect(await r.deletions.retry()).toEqual([])
  })

  it('never throws out of the emit path, whatever the destroy or the payload does', async () => {
    const destroyed: string[] = []
    const logger = new RecordingLogger()
    const deletions = new WorkspaceRecordDeletions({
      hostRoot: HOST_ROOT,
      logger,
      // A synchronous throw is the worst case: `domain/changed` is a
      // synchronous emit, and the domain only contains listener failures — a
      // throw here would reach the registry's own delete call.
      destroy: (workspaceId: string) => { destroyed.push(workspaceId); throw new Error('boom') },
    })
    deletions.observe([record('git')])

    expect(() => deletions.handle(change())).not.toThrow()
    expect(() => deletions.handle(undefined)).not.toThrow()
    expect(() => deletions.handle({ domain: 'workspace' })).not.toThrow()
    await settle()
    expect(destroyed).toEqual(['git'])
    expect(logger.warnings.some((line) => line.includes('boom'))).toBe(true)
  })
})

/**
 * The durable credential store, against the table `platform-domain` declares
 * for exactly this purpose.
 *
 * The operator's report — "the model API key must be re-entered after every
 * upgrade" — is the whole point of the store: `settings.yaml` and
 * `.credentials.yaml` live under `DSH_HOME`, which the chart mounts as an
 * emptyDir, so every pod replacement wipes them. This provider keeps the same
 * seam (`ctx.credentials`) and moves the medium to the platform's own
 * PostgreSQL-backed storage.
 *
 * The cases are written against the REQUIREMENT, not the implementation: the
 * first one builds a second store over the same table and reads the value back,
 * which is what "survives a pod replacement" means. The rest pin the official
 * seam's semantics that a replacement must not lose: the environment layer and
 * its read-only refusal, the empty-value rule, the validation at the durable
 * boundary, and the record half including a verbatim grant payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialStore, type CredentialRecord, type CredentialRow } from '../src/credentials.ts'

/** The declared table surface the provider consumes, backed by one map. */
class FakeTable {
  readonly rows = new Map<string, CredentialRow>()
  readonly puts: string[] = []
  readonly deletes: string[] = []
  get(key: string): CredentialRow | undefined { return this.rows.get(key) }
  entries(): IterableIterator<[string, CredentialRow]> { return this.rows.entries() }
  get size(): number { return this.rows.size }
  async put(key: string, value: CredentialRow): Promise<void> { this.puts.push(key); this.rows.set(key, value) }
  async delete(key: string): Promise<boolean> { this.deletes.push(key); return this.rows.delete(key) }
}

const domainsOver = (table: FakeTable) => ({ credentials: { table: () => table } })

/**
 * One control plane over `table`. The return value is the service a consumer
 * would reach: the seam has no exported type here on purpose (this provider
 * implements the official surface structurally), so the spec drives the same
 * method names the official consumers call.
 */
const boot = async (table: FakeTable): Promise<CredentialStore> => {
  const ctx = new Context()
  return new CredentialStore(ctx, domainsOver(table))
}

const DEEPSEEK = 'DEEPSEEK_API_KEY'
const savedEnv = process.env[DEEPSEEK]

beforeEach(() => { delete process.env[DEEPSEEK] })
afterEach(() => {
  if (savedEnv === undefined) delete process.env[DEEPSEEK]
  else process.env[DEEPSEEK] = savedEnv
})

describe('the durable credential store', () => {
  it('keeps a stored reference across a replacement control plane', async () => {
    const table = new FakeTable()

    const first = await boot(table)
    await first.set(DEEPSEEK, 'sk-stored-once')

    // The pod is replaced: nothing of the old process survives, the database
    // does. This is the operator's "re-enter the key after every upgrade".
    const second = await boot(table)
    expect(await second.resolve(DEEPSEEK)).toEqual({ value: 'sk-stored-once', source: 'postgres' })
    expect(await second.describe(DEEPSEEK)).toEqual({ configured: true, source: 'postgres', writable: true })
  })

  it('registers the service under the name the seam defines', async () => {
    // The NAME is the contract: consumers reach the provider through
    // `ctx.credentials` / `inject: ['credentials']`, not through a type.
    const table = new FakeTable()
    const ctx = new Context()
    new CredentialStore(ctx, domainsOver(table))

    // Cordis exposes a service through its own proxy, so this asserts the NAME
    // and reachability, not object identity.
    const registered = ctx.get('credentials', false) as CredentialStore | undefined
    expect(registered).toBeDefined()
    await registered?.set(DEEPSEEK, 'sk-via-service')
    expect(await registered?.resolve(DEEPSEEK)).toEqual({ value: 'sk-via-service', source: 'postgres' })
  })

  it('lays the launching environment over the store, read-only', async () => {
    const table = new FakeTable()
    const store = await boot(table)
    await store.set(DEEPSEEK, 'sk-stored')

    process.env[DEEPSEEK] = 'sk-from-env'
    expect(await store.resolve(DEEPSEEK)).toEqual({ value: 'sk-from-env', source: 'env' })
    expect(await store.describe(DEEPSEEK)).toEqual({ configured: true, source: 'env', writable: false })
    // The write would be shadowed by the environment, so it must refuse rather
    // than appear to succeed.
    await expect(store.set(DEEPSEEK, 'sk-other')).rejects.toThrow(/DEEPSEEK_API_KEY/)
    expect(table.rows.get('ref:' + DEEPSEEK)?.payload.value).toBe('sk-stored')
  })

  it('reports an unconfigured reference as unconfigured', async () => {
    const store = await boot(new FakeTable())
    expect(await store.resolve('NOT_SET_ANYWHERE')).toBeUndefined()
    expect(await store.describe('NOT_SET_ANYWHERE')).toEqual({ configured: false, writable: true })
  })

  it('refuses an empty value and removes a reference without writing when absent', async () => {
    const table = new FakeTable()
    const store = await boot(table)

    await expect(store.set(DEEPSEEK, '')).rejects.toThrow(/empty/)
    expect(table.puts).toEqual([])

    // No row, no write: an unset of something never stored is a no-op.
    await store.unset(DEEPSEEK)
    expect(table.deletes).toEqual([])

    await store.set(DEEPSEEK, 'sk-1')
    await store.unset(DEEPSEEK)
    expect(table.rows.has('ref:' + DEEPSEEK)).toBe(false)
  })

  it('emits the seam event after a committed reference write', async () => {
    const table = new FakeTable()
    const ctx = new Context()
    const store = new CredentialStore(ctx, domainsOver(table))
    const seen: string[] = []
    ctx.on('credentials/reference-updated', (ref: string) => { seen.push(String(ref)) })

    await store.set(DEEPSEEK, 'sk-1')

    expect(seen).toEqual([DEEPSEEK])
  })

  it('refuses a reference name outside the seam grammar', async () => {
    const store = await boot(new FakeTable())
    await expect(store.set('not a name', 'x')).rejects.toThrow(/reference/)
    await expect(store.set('9LEADING_DIGIT', 'x')).rejects.toThrow(/reference/)
    await expect(store.unset('not/a/name')).rejects.toThrow(/reference/)
  })

  it('stores, enumerates and removes records through the record half', async () => {
    const table = new FakeTable()
    const store = await boot(table)
    const key = 'llm-deepseek/deepseek-official'

    expect(await store.readRecord(key)).toBeUndefined()
    expect(await store.describeRecord(key)).toEqual({ configured: false, writable: true })

    // A read-decide-replace: the refresh path this half exists for.
    await store.modifyRecord(key, async (current) => {
      expect(current).toBeUndefined()
      return { kind: 'api-key', key: 'sk-record', env: { AWS_PROFILE: 'prod' } }
    })

    expect(await store.readRecord(key)).toEqual({ kind: 'api-key', key: 'sk-record', env: { AWS_PROFILE: 'prod' } })
    expect(await store.describeRecord(key)).toEqual({ configured: true, kind: 'api-key', writable: true })
    expect(await store.listRecords()).toEqual([{ key, kind: 'api-key' }])

    // Declining the write leaves the row untouched (and reports the current one).
    const untouched = await store.modifyRecord(key, async () => undefined)
    expect(untouched).toEqual({ kind: 'api-key', key: 'sk-record', env: { AWS_PROFILE: 'prod' } })
    expect(table.puts).toHaveLength(1)

    // The reference half shares the table but not the address space.
    await store.set(DEEPSEEK, 'sk-1')
    expect(await store.listRecords()).toEqual([{ key, kind: 'api-key' }])

    await store.deleteRecord(key)
    expect(await store.readRecord(key)).toBeUndefined()
    await store.deleteRecord(key)
    expect(table.deletes).toHaveLength(2)
  })

  it('round-trips a grant payload verbatim', async () => {
    const table = new FakeTable()
    const store = await boot(table)
    const key = 'oauth-example/grant'
    const payload = { access_token: 'a', nested: { expires: 42, scopes: ['x', 'y'] }, nothing: null }

    await store.modifyRecord(key, async () => ({ kind: 'grant', payload }))

    expect(await store.readRecord(key)).toEqual({ kind: 'grant', payload })
    // And it is the same store a replacement control plane reads.
    const replacement = await boot(table)
    expect(await replacement.readRecord(key)).toEqual({ kind: 'grant', payload })
  })

  it('serializes concurrent record mutations instead of losing one', async () => {
    const table = new FakeTable()
    const store = await boot(table)
    const key = 'llm-deepseek/rotate'
    await store.modifyRecord(key, async () => ({ kind: 'api-key', key: 'v1' }))

    // Two rotations racing: each must see the other's committed value, which is
    // the whole reason the seam exposes a read-decide-write instead of a set.
    const seen: Array<string | undefined> = []
    await Promise.all([
      store.modifyRecord(key, async (current) => {
        seen.push(current?.kind === 'api-key' ? current.key : undefined)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { kind: 'api-key', key: 'v2' }
      }),
      store.modifyRecord(key, async (current) => {
        seen.push(current?.kind === 'api-key' ? current.key : undefined)
        return { kind: 'api-key', key: 'v3' }
      }),
    ])

    expect(seen).toEqual(['v1', 'v2'])
    expect((await store.readRecord(key)) as CredentialRecord).toEqual({ kind: 'api-key', key: 'v3' })
  })

  it('refuses a record that could not be read back', async () => {
    const table = new FakeTable()
    const store = await boot(table)

    await expect(store.modifyRecord('llm-deepseek/broken', async () => ({ kind: 'api-key', key: '' }))).rejects.toThrow(/empty/)
    await expect(store.modifyRecord('llm-deepseek/broken', async () => ({ kind: 'grant', payload: Number.NaN }))).rejects.toThrow(/non-finite/)
    expect(table.rows.size).toBe(0)
  })
})

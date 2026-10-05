/**
 * The credential store over the REAL storage stack, not a stub table.
 *
 * The unit spec hands the provider a fake table, which proves the seam and the
 * provider's own rules but not the boundary the deployment actually crosses:
 * `defineDomain`'s zod schema validating every stored row on the way back, the
 * `dsh_storage_records` layout, and the domain facility's durable write chain.
 * The operator's report is a durability bug, so the round trip is asserted
 * against the same machinery the profile runs: `storage-db`'s SQLite backend
 * writes the identical table layout Postgres does (`unit`, `table_name`, `key`,
 * `value_json`), and the PG-gated suite covers the dialect.
 *
 * The second half boots a REPLACEMENT context over the same database file —
 * nothing of the first context survives — which is the pod-replacement case the
 * whole defect is about.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as storageDb from '../../storage-db/src/index.ts'
import { credentialsDomain, type PlatformDomains } from '../src/index.ts'
import { CredentialStore } from '../src/credentials.ts'

const BACKEND = 'sqlite'

// `node:sqlite` is loaded the way `storage-db` loads it: a bare specifier that
// a bundler must not try to resolve, since it is a Node built-in.
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

interface Booted {
  ctx: Context
  facility: DomainFacility
  store: CredentialStore
}

/** One control plane over `path`: real backend, real domain, real provider. */
const boot = async (path: string): Promise<Booted> => {
  const ctx = new Context()
  await ctx.plugin(storageDb as never, { type: BACKEND, path })
  const facility = new DomainFacility(ctx, { backend: BACKEND })
  const credentials = await facility.open(credentialsDomain)
  const store = new CredentialStore(ctx, { credentials } as unknown as PlatformDomains)
  return { ctx, facility, store }
}

describe('the credential store over the platform storage stack', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-'))
    dbPath = join(dir, 'platform.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes through the domain schema and reads the value back in a replacement control plane', async () => {
    const first = await boot(dbPath)
    await first.store.set('DEEPSEEK_API_KEY', 'sk-durable')
    await first.store.modifyRecord('llm-deepseek/deepseek-official', async () => ({ kind: 'api-key', key: 'sk-record' }))
    await first.facility.closeAll()

    // A new pod: new context, new facility, same database.
    const second = await boot(dbPath)
    expect(await second.store.resolve('DEEPSEEK_API_KEY')).toEqual({ value: 'sk-durable', source: 'postgres' })
    expect(await second.store.readRecord('llm-deepseek/deepseek-official')).toEqual({ kind: 'api-key', key: 'sk-record' })
    expect(await second.store.listRecords()).toEqual([{ key: 'llm-deepseek/deepseek-official', kind: 'api-key' }])
    await second.store.unset('DEEPSEEK_API_KEY')
    await second.facility.closeAll()
  })

  it('stores the reference in the record table the platform already runs', async () => {
    const { store, facility } = await boot(dbPath)
    await store.set('DEEPSEEK_API_KEY', 'sk-row')
    await facility.closeAll()

    // The declared layout: the reference lives in `dsh_storage_records` under
    // the `platform_credentials` unit, keyed `ref:<NAME>` — the fact the
    // post-deploy checklist asks the operator to confirm with SQL.
    const db = new DatabaseSync(dbPath)
    const rows = db.prepare('SELECT unit, table_name, key, value_json FROM dsh_storage_records').all() as Array<Record<string, string>>
    db.close()

    expect(rows).toHaveLength(1)
    expect(rows[0].unit).toBe('platform_credentials')
    expect(rows[0].table_name).toBe('credentials')
    expect(rows[0].key).toBe('ref:DEEPSEEK_API_KEY')
    expect(JSON.parse(rows[0].value_json)).toMatchObject({
      userId: 'platform',
      scope: 'ref',
      id: 'DEEPSEEK_API_KEY',
      kind: 'api-key',
      payload: { value: 'sk-row' },
    })
  })
})

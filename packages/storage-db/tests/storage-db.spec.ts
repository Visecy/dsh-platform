import { describe, expect, it, afterEach } from 'vitest'
import { DbStorageBackend, createDriver, type DbStorageBackend as BackendType } from '../src/index.ts'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

let backend: BackendType | undefined

afterEach(async () => {
  await backend?.close()
  backend = undefined
})

const descriptor: KvUnitDescriptor = {
  name: 'workspaces',
  version: 1,
  tables: ['workspaces', 'users'],
  hasGlobal: true,
}

describe('DbStorageBackend', () => {
  it('persists records and global through a sqlite unit', async () => {
    backend = new DbStorageBackend(createDriver({ type: 'sqlite', path: ':memory:' }))
    const unit = await backend.kv!.open(descriptor)

    await unit.putRecord('workspaces', 'ws-1', { name: 'alpha' })
    await unit.putRecord('users', 'user-1', { email: 'a@x' })
    await unit.setGlobal({ active: true })

    const all = await unit.loadAll()
    expect(all.tables.workspaces['ws-1']).toEqual({ name: 'alpha' })
    expect(all.tables.users['user-1']).toEqual({ email: 'a@x' })
    expect(all.global).toEqual({ active: true })

    await unit.deleteRecord('workspaces', 'ws-1')
    const afterDelete = await unit.loadAll()
    expect(afterDelete.tables.workspaces['ws-1']).toBeUndefined()
    expect(afterDelete.tables.users['user-1']).toEqual({ email: 'a@x' })
  })
})

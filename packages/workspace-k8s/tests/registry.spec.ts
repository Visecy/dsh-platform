import { describe, expect, it } from 'vitest'
import { HostWorkspaceRegistry } from '../src/registry.ts'

/** A channel whose get() answers 'workspaceRegistry' with the given official impl. */
const channel = (impl: {
  create?: (path: string, title?: string) => any
  list?: () => readonly any[]
  delete?: (id: string) => Promise<boolean>
}) => ({
  get: (name: string) => (name === 'workspaceRegistry' ? { ...impl } : undefined),
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

  it('is a no-op when the official workspace registry is absent (headless profiles)', async () => {
    const reg = new HostWorkspaceRegistry({ get: () => undefined }, '/workspaces')
    expect(await reg.list()).toEqual([])
    await expect(reg.delete('ws-a')).resolves.toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { ApiProxyWorkspaceRegistry } from '../src/registry.ts'

const single = (impl: Record<string, (req: any) => any>) => ({
  get: () => ({ workspace: impl }),
})

describe('ApiProxyWorkspaceRegistry', () => {
  it('lists workspaces from the official registry response envelope', async () => {
    const reg = new ApiProxyWorkspaceRegistry(single({
      list: async () => ({
        result: {
          ok: true,
          value: {
            workspaces: [
              { workspaceId: 'ws-a', path: '/workspaces/ws-a', title: 'A' },
            ],
          },
        },
      }),
    }), '/workspaces')
    expect(await reg.list()).toEqual([{ workspaceId: 'ws-a', path: '/workspaces/ws-a', title: 'A', internalId: 'ws-a' }])
  })

  it('uses the stable path segment for platform workspace ids, not the official opaque UUID', async () => {
    const reg = new ApiProxyWorkspaceRegistry(single({
      list: async () => ({
        result: {
          ok: true,
          value: {
            workspaces: [
              { workspaceId: 'opaque-uuid', path: '/workspaces/ws-abc', title: 'ABC' },
            ],
          },
        },
      }),
    }), '/workspaces')
    expect(await reg.list()).toEqual([{ workspaceId: 'ws-abc', path: '/workspaces/ws-abc', title: 'ABC', internalId: 'opaque-uuid' }])
  })

  it('creates a workspace and normalizes the workspace payload', async () => {
    const reg = new ApiProxyWorkspaceRegistry(single({
      create: async () => ({
        result: {
          ok: true,
          value: { workspace: { workspaceId: 'ws-new', path: '/workspaces/ws-new' } },
        },
      }),
    }), '/workspaces')
    expect(await reg.create('/workspaces/ws-new')).toEqual({ workspaceId: 'ws-new', path: '/workspaces/ws-new', title: undefined })
  })

  it('degrades to an empty list when the official apiProxy is absent', async () => {
    const reg = new ApiProxyWorkspaceRegistry({ get: () => undefined }, '/workspaces')
    expect(await reg.list()).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WorkspacePicker } from '../src/index.ts'

const makeMockKc = (pods: Array<{ name: string; podIP?: string }>) => {
  const podMap = new Map(pods.map((p) => [p.name, p]))
  return {
    loadFromDefault: () => {},
    makeApiClient: () => ({
      listNamespacedPod: async ({ labelSelector }: { labelSelector?: string }) => ({
        body: { items: pods.map((p) => ({ metadata: { name: p.name }, status: { podIP: p.podIP } })) },
      }),
      readNamespacedPod: async ({ name }: { name: string }) => ({
        body: { status: { podIP: podMap.get(name)?.podIP } },
      }),
    }),
  }
}

describe('WorkspacePicker', () => {
  it('lists workspace pods at the root', async () => {
    const kc = makeMockKc([{ name: 'dsh-ws-aaa', podIP: '10.0.0.1' }, { name: 'dsh-ws-bbb', podIP: '10.0.0.2' }])
    const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', kc: kc as never })
    const res = await picker.list('/workspaces')
    expect(res.entries.map((e) => e.name)).toEqual(['dsh-ws-aaa', 'dsh-ws-bbb'])
    expect(res.crumbs[0].name).toBe('workspaces')
  })

  it('lists daemon dirs inside a workspace', async () => {
    const kc = makeMockKc([{ name: 'dsh-ws-aaa', podIP: '10.0.0.1' }])
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/files/list')) {
        return new Response(JSON.stringify({ ok: true, data: { entries: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file' }] } }))
      }
      return origFetch(url)
    })
    const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', kc: kc as never })
    const res = await picker.list('/workspaces/dsh-ws-aaa')
    expect(res.entries.map((e) => e.name)).toEqual(['src'])
    expect(res.entries[0].path).toBe('/workspaces/dsh-ws-aaa/src')
    globalThis.fetch = origFetch
  })

  it('createDirectory calls daemon mkdir', async () => {
    const kc = makeMockKc([{ name: 'dsh-ws-aaa', podIP: '10.0.0.1' }])
    const origFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/files/mkdir')) {
        return new Response(JSON.stringify({ ok: true, data: { created: true } }))
      }
      return origFetch(url)
    })
    const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', kc: kc as never })
    const path = await picker.createDirectory('/workspaces/dsh-ws-aaa', 'newdir')
    expect(path).toBe('/workspaces/dsh-ws-aaa/newdir')
    globalThis.fetch = origFetch
  })
})

import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspacePicker } from '../src/index.ts'

const makeMockKc = (pods: Array<{ name: string; podIP?: string }>) => {
  return {
    loadFromDefault: () => {},
    makeApiClient: () => ({
      listNamespacedPod: async ({ labelSelector }: { labelSelector?: string }) => ({
        body: { items: pods.map((p) => ({ metadata: { name: p.name }, status: { podIP: p.podIP } })) },
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

  it('does not expose subdirectories inside a workspace', async () => {
    const kc = makeMockKc([{ name: 'dsh-ws-aaa', podIP: '10.0.0.1' }])
    const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', kc: kc as never })
    const res = await picker.list('/workspaces/dsh-ws-aaa')
    expect(res.entries).toEqual([])
    // The workspace itself remains selectable (atomic unit).
    expect(res.crumbs.at(-1)?.path).toBe('/workspaces/dsh-ws-aaa')
  })

  it('rejects creating directories inside a workspace', async () => {
    const kc = makeMockKc([{ name: 'dsh-ws-aaa', podIP: '10.0.0.1' }])
    const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', kc: kc as never })
    await expect(picker.createDirectory('/workspaces/dsh-ws-aaa', 'newdir')).rejects.toThrow()
  })

  it('creates a host-side anchor directory when creating a workspace at root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-picker-'))
    try {
      const kc = makeMockKc([])
      const picker = new WorkspacePicker(new Context(), { namespace: 'dsh', hostRoot: root, kc: kc as never })
      const path = await picker.createDirectory(root, 'new-ws')
      expect(path).toBe(`${root}/new-ws`)
      const { stat } = await import('node:fs/promises')
      expect((await stat(path)).isDirectory()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

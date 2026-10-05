/**
 * The resolver fence's OTHER half: what an fs operation does with a path whose
 * first segment is not a workspace.
 *
 * The fence itself ("an fs or subprocess operation may WAKE a workspace but
 * never CREATE one") is right and stays. What was wrong is where it landed: it
 * was enforced by `workspaceEndpointResolver.resolve` THROWING, so every
 * operation on such a path died with a platform-level failure. The operator's
 * conversation hit exactly that, with the workspace root as the resolving base:
 *
 *   workspaceEndpointResolver: '.git' is not a registered workspace of this
 *     platform, so no pod or volume will be created for it; the path names an
 *     ordinary directory under the workspace root
 *
 * `.git` is not a workspace id at all — it is the first path segment of
 * `/workspaces/.git`, i.e. a dotfile beside the workspace anchors, reached by
 * the ordinary relative path `.git` from a session whose cwd is `/workspaces`
 * (sessions with that cwd exist on the live cluster, and `bash-local` runs with
 * `cwd: '/workspaces'`).
 *
 * So this spec pins the three branches the resolution has to keep apart:
 *
 *   1. a path INSIDE a registered workspace — dotfiles and nested directories
 *      included — routes to that workspace's pod and is served;
 *   2. a path whose first segment is NOT a registered workspace is refused
 *      WITHOUT creating anything and WITHOUT an unresolvable platform error:
 *      the provider answers with one precise line, because the control plane
 *      holds no copy of that path to serve instead (its `/workspaces` is an
 *      emptyDir of realpath anchors, and no daemon listens on the static
 *      fallback endpoint);
 *   3. only the creation case is refused — and it is refused before any
 *      ensure, so no PVC and no pod can appear for an id nobody registered.
 *
 * Fail-open is preserved: a membership question that cannot be answered
 * (no registry bridge, a listing failure) is NOT an answer, and the operation
 * proceeds to the resolver exactly as it did before the fence existed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FsK8s } from '../src/index.ts'

/** The host root AND pod root the shipped profile configures. */
const ROOT = '/workspaces'
/** The static fallback endpoint (what the profile gets when WS_DAEMON_ENDPOINT is unset). */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4390'

interface Call {
  url: string
  body: unknown
}

interface Harness {
  fs: FsK8s
  /** Workspace ids the resolver was asked about, in order. */
  resolved: string[]
  /** Workspace ids the membership question was asked about, in order. */
  asked: string[]
  /** Every daemon request that actually left the process. */
  calls: Call[]
}

/**
 * One provider over a stand-in `workspaceEndpointResolver` service.
 *
 * `members` is what the registry knows; `undefined` stands for a composition
 * with no registry bridge at all, and a function may instead throw to model a
 * listing that fails.
 */
function harness(members: readonly string[] | undefined | (() => Promise<boolean>)): Harness {
  const ctx = new Context()
  const resolved: string[] = []
  const asked: string[] = []
  const calls: Call[] = []
  const service = {
    resolve: (workspaceId: string): string => {
      resolved.push(workspaceId)
      return `http://${workspaceId}.pod:4390`
    },
    ...(members === undefined
      ? {}
      : {
          isWorkspace: async (workspaceId: string): Promise<boolean> => {
            asked.push(workspaceId)
            if (typeof members === 'function') return await members()
            return members.includes(workspaceId)
          },
        }),
  }
  ctx.provide('workspaceEndpointResolver', service)
  vi.stubGlobal('fetch', (url: string, init: { body?: unknown }) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return Promise.resolve({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          bytes: Buffer.from('served by the pod').toString('base64'),
          info: { type: 'file', size: 16, version: 'v1' },
          entries: [{ name: 'HEAD', type: 'file', path: 'HEAD', size: 16 }],
          outcome: { operation: 'replace', version: 'v2' },
        },
      }),
    })
  })
  return {
    fs: new FsK8s(ctx, { daemonEndpoint: DEFAULT_ENDPOINT, hostRoot: ROOT, podRoot: ROOT }),
    resolved,
    asked,
    calls,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the operator's case: '.git' as the first segment under the workspace root", () => {
  it('degrades with ONE line naming the path instead of a platform failure', async () => {
    const { fs } = harness(['ws-a'])
    const target = await fs.resolve('.git/HEAD', { cwd: ROOT })

    const error = await fs.readText(target).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FsError)
    const failure = error as FsError
    expect(failure.code).toBe('FS_NOT_FOUND')
    expect(failure.message).toContain('/workspaces/.git/HEAD')
    expect(failure.message).toContain("'.git'")
    expect(failure.message).toMatch(/not (?:a|inside a) workspace/)
    // One line, not a stack of platform layers.
    expect(failure.message).not.toContain('\n')
  })

  it('never asks the resolver and never touches the network, so nothing can be created', async () => {
    const { fs, resolved, asked, calls } = harness(['ws-a'])
    const target = await fs.resolve('.git/HEAD', { cwd: ROOT })

    await expect(fs.readText(target)).rejects.toBeInstanceOf(FsError)

    // The membership question WAS asked — that is what makes the refusal
    // precise — and the resolver (the only path to ensure/PVC/pod) was not.
    expect(asked).toEqual(['.git'])
    expect(resolved).toEqual([])
    expect(calls).toEqual([])
  })

  it('degrades every member the same way, not just the read path', async () => {
    const { fs, calls } = harness(['ws-a'])
    const target = await fs.resolve('.git', { cwd: ROOT })

    for (const operation of [
      () => fs.stat(target),
      () => fs.lstat('.git', { cwd: ROOT }),
      () => fs.listDir(target),
      () => fs.writeText(target, 'x'),
      () => fs.editText(target, { oldString: 'a', newString: 'b' }),
    ]) {
      const error = await operation().catch((e: unknown) => e)
      expect(error, 'every member must degrade with the same precise error').toBeInstanceOf(FsError)
      expect((error as FsError).message).toContain('/workspaces/.git')
    }
    expect(calls).toEqual([])
  })

  it('degrades a plain non-workspace directory the same way', async () => {
    // The phantom-workspace case the fence exists for: a directory under the
    // root that no record describes must not become a workspace...
    const { fs, resolved } = harness(['ws-a'])
    const target = await fs.resolve('/workspaces/agents-local-md/notes.md')

    const error = await fs.readText(target).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).message).toContain("'agents-local-md'")
    expect(resolved).toEqual([])
  })
})

describe('a path inside a registered workspace still routes to its pod', () => {
  it('serves a dotfile nested in the workspace (the live-cluster proof)', async () => {
    const { fs, resolved, asked, calls } = harness(['ws-a'])
    const target = await fs.resolve('.git/HEAD', { cwd: '/workspaces/ws-a' })

    await fs.readText(target)

    expect(asked).toEqual(['ws-a'])
    expect(resolved).toEqual(['ws-a'])
    expect(calls[0]?.url).toBe('http://ws-a.pod:4390/files/read')
  })

  it('serves nested directories and the workspace root itself', async () => {
    const { fs, resolved, calls } = harness(['ws-a'])
    await fs.readText(await fs.resolve('/workspaces/ws-a/a/b/c.txt'))
    await fs.listDir(await fs.resolve('/workspaces/ws-a'))
    expect(resolved).toEqual(['ws-a', 'ws-a'])
    expect(calls).toHaveLength(2)
  })
})

describe('the membership question is a fence, not an authorization boundary', () => {
  it('proceeds to the resolver when no registry bridge is installed', async () => {
    const { fs, asked, resolved } = harness(undefined)
    await fs.readText(await fs.resolve('/workspaces/whatever/f.txt'))
    expect(asked).toEqual([])
    expect(resolved).toEqual(['whatever'])
  })

  it('proceeds when the listing fails instead of taking the file view down', async () => {
    const { fs, resolved } = harness(async () => { throw new Error('registry unavailable') })
    await fs.readText(await fs.resolve('/workspaces/unknown/f.txt'))
    expect(resolved).toEqual(['unknown'])
  })

  it('does not ask about the workspace root itself, which names no workspace', async () => {
    // `/workspaces` is the root, not a workspace: it keeps whatever route it
    // had (the static endpoint fallback) rather than being turned into a
    // refusal it never was.
    const { fs, asked, resolved, calls } = harness(['ws-a'])
    const target = await fs.resolve(ROOT)
    await fs.listDir(target).catch(() => undefined)
    expect(asked).toEqual([])
    expect(resolved).toEqual([])
    expect(calls[0]?.url).toBe(`${DEFAULT_ENDPOINT}/files/list`)
  })
})

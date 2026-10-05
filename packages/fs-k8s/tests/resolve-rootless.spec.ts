/**
 * A relative path with no caller-supplied base must be answered, not refused.
 *
 * `@deepseek-ai/dsh-headless` boots with
 *
 *   const cwd = fs === void 0 ? process.cwd() : fs.processPath(await fs.resolve("."))
 *                                                   (lib/index.js:315)
 *
 * — the caller cannot supply a cwd, because it is ASKING for one. `FsK8s.resolve`
 * used to treat `.` as a host path outside `hostRoot` and hand back
 * `FS_PERMISSION_DENIED` (before 534565e) or `FS_NOT_FOUND` (after it): either
 * way the plugin itself was the reason the composition could not start. Under
 * R5 the plugin layer must work under ANY profile, so a containment failure may
 * not become a hard failure for a caller that cannot give a base (7b536ea,
 * 534565e — the same lesson, a third time).
 *
 * The rule this spec pins:
 *
 *   - an ABSOLUTE path is taken literally: `/workspaces/<id>/x` keeps routing to
 *     its pod, `/.git` keeps answering "absent" (the two anchors the message-time
 *     walk depends on), and nothing outside the root is served;
 *   - a RELATIVE path resolves against the caller's `opts.cwd` when it has one
 *     (the seam's documented contract) and against a base the provider DEFINES
 *     when it does not: the harness process's own working directory when that
 *     directory is inside the workspace root (a dsh started inside a workspace
 *     pod — `.` then means exactly what POSIX says it means), otherwise the
 *     workspace root itself, the one directory this provider always serves.
 *
 * The fallback is not arbitrary: the deployment already declares that directory
 * as the process world's start (`docker/profiles/*.cordis.patch.yml` mounts
 * `@deepseek-ai/dsh-bash-local` with `cwd: '/workspaces'`), it is a real,
 * existing directory (`management.create` and the reconciler mkdir the
 * anchors), and it is the only path a static-endpoint composition can name
 * without inventing a workspace id. `.` must never be the reason a profile
 * cannot boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FsK8s } from '../src/index.ts'

/** The host root AND pod root the shipped profile configures. */
const ROOT = '/workspaces'
/** One registered workspace under it. */
const WORKSPACE = 'ws-a'
const WS_ROOT = `${ROOT}/${WORKSPACE}`
/** The static fallback endpoint (what the profile gets when WS_DAEMON_ENDPOINT is unset). */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4390'

function provider(): FsK8s {
  return new FsK8s(new Context(), { daemonEndpoint: DEFAULT_ENDPOINT, hostRoot: ROOT, podRoot: ROOT })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a relative path with no caller-supplied cwd', () => {
  it('answers the headless boot call instead of failing it', async () => {
    const fs = provider()

    // Exactly the headless line: it needs a STRING back, and it needs it before
    // any session or workspace exists to ask about.
    const cwd = fs.processPath(await fs.resolve('.'))

    expect(cwd).toBe(ROOT)
  })

  it('resolves "." to the workspace root, as a normal target', async () => {
    const fs = provider()

    const target = await fs.resolve('.')

    expect(target.displayPath).toBe(ROOT)
    expect(target.targetKey).toBe(`dsh-k8s:${ROOT}`)
  })

  it('treats an empty (rootless) path the same way', async () => {
    const fs = provider()

    const target = await fs.resolve('')

    expect(fs.processPath(target)).toBe(ROOT)
  })

  it('resolves a nested relative path against the same base', async () => {
    const fs = provider()

    const target = await fs.resolve('made/by-the-platform.txt')

    expect(fs.processPath(target)).toBe(`${ROOT}/made/by-the-platform.txt`)
    expect(target.displayPath).toBe(`${ROOT}/made/by-the-platform.txt`)
  })

  it('prefers the caller-supplied base and normalizes what it hands back', async () => {
    const fs = provider()

    const root = await fs.resolve('.', { cwd: WS_ROOT })
    const sibling = await fs.resolve('../other.txt', { cwd: `${WS_ROOT}/sub` })

    expect(fs.processPath(root)).toBe(WS_ROOT)
    // The base is joined and normalized, not string-concatenated: a caller that
    // renders displayPath never sees a stray `/.` (`/workspaces/ws-a/.`).
    expect(root.displayPath).toBe(WS_ROOT)
    expect(fs.processPath(sibling)).toBe(`${WS_ROOT}/other.txt`)
  })

  it('keeps taking an absolute path literally, inside the root and outside it', async () => {
    const fs = provider()

    const inside = await fs.resolve(`${WS_ROOT}/src/a.ts`)
    expect(fs.processPath(inside)).toBe(`${WS_ROOT}/src/a.ts`)

    // The outermost anchor the message-time walk probes: an absolute path above
    // the workspace root stays "absent" — it is NOT reinterpreted relative to
    // the root just because a relative path now has a base.
    const error = await fs.resolve('/.git').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_NOT_FOUND')
  })

  it('leaves the root-level .git to the membership fence, as before', async () => {
    const asked: string[] = []
    const ctx = new Context()
    ctx.provide('workspaceEndpointResolver', {
      resolve: (workspaceId: string): string => { asked.push(workspaceId); return DEFAULT_ENDPOINT },
      isWorkspace: async (workspaceId: string): Promise<boolean> => { asked.push(workspaceId); return false },
    })
    const fs = new FsK8s(ctx, { daemonEndpoint: DEFAULT_ENDPOINT, hostRoot: ROOT, podRoot: ROOT })

    // `resolve` hands out the target (the path IS under the host root); the
    // call that would ensure a pod is where the fence answers "no such
    // workspace" — the behaviour 7b536ea put there, unchanged by the new base.
    const target = await fs.resolve(`${ROOT}/.git`)
    expect(target.displayPath).toBe(`${ROOT}/.git`)
    const error = await fs.stat(target).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_NOT_FOUND')
    expect(asked).toContain('.git')
  })
})

/**
 * The same rule when the harness process itself runs INSIDE the workspace root:
 * a dsh started in a workspace pod (`.`) must name that workspace, not the
 * anchors directory above it. This is the case that makes the plugin layer work
 * under another profile rather than merely refusing to break it.
 */
describe('a relative path when the process itself runs inside the workspace root', () => {
  let logicalRoot: string
  let originalCwd: string

  const inside = (): FsK8s => new FsK8s(new Context(), {
    daemonEndpoint: DEFAULT_ENDPOINT,
    hostRoot: logicalRoot,
    podRoot: logicalRoot,
  })

  it('resolves "." against the process cwd, and routes it to that workspace pod', async () => {
    logicalRoot = await mkdtemp(join(tmpdir(), 'dsh-fs-logical-'))
    const workspaceDir = join(logicalRoot, WORKSPACE)
    await mkdir(workspaceDir, { recursive: true })
    originalCwd = process.cwd()

    const calls: Array<{ url: string; body: { path?: string } }> = []
    const ctx = new Context()
    ctx.provide('workspaceEndpointResolver', {
      resolve: (workspaceId: string): string => `http://${workspaceId}.pod:4390`,
      isWorkspace: async (workspaceId: string): Promise<boolean> => workspaceId === WORKSPACE,
    })
    vi.stubGlobal('fetch', (url: string, init: { body?: unknown }) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as { path?: string } })
      return Promise.resolve({
        ok: true,
        json: async () => ({ ok: true, data: { info: { path: '/', name: '.', type: 'directory' } } }),
      })
    })

    try {
      process.chdir(workspaceDir)
      const fs = new FsK8s(ctx, { daemonEndpoint: DEFAULT_ENDPOINT, hostRoot: logicalRoot, podRoot: logicalRoot })

      const target = await fs.resolve('.')
      expect(target.displayPath).toBe(workspaceDir)
      expect(fs.processPath(target)).toBe(workspaceDir)

      // …and it is a real target, not just a string: the stat reaches the
      // workspace pod's own daemon root (`/` in the daemon's path space).
      expect(await fs.stat(target)).toBeDefined()
      expect(calls).toEqual([
        { url: `http://${WORKSPACE}.pod:4390/files/info`, body: { path: '/', follow: true } },
      ])
    } finally {
      process.chdir(originalCwd)
      await rm(logicalRoot, { recursive: true, force: true })
    }
  })
})

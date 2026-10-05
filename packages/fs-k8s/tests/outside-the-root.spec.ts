/**
 * The SECOND fence: a host path that is not even under the workspace root.
 *
 * `translate.toPod` refuses any host path outside `hostRoot` with
 *
 *   path escapes workspace root: <path>
 *
 * and `FsK8s.resolve` used to hand that refusal to the caller as
 * `FS_PERMISSION_DENIED`. That is a platform-level failure, and one official
 * caller treats it as fatal on EVERY message: `@deepseek-ai/dsh-agent-instructions`
 * finds the project root by walking UP from the session cwd to `/`, probing
 * `<dir>/.git` at each step, and only `FS_NOT_FOUND` means "no marker here":
 *
 *   lib/index.js:480  async function findProjectRoot(cwd, markers, fileSystem, signal) {
 *   lib/index.js:481    let current = resolve(cwd);
 *   lib/index.js:482    for (;;) {
 *   lib/index.js:483      for (const marker of markers) if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current;
 *   lib/index.js:484      const parent = dirname(current);
 *   lib/index.js:485      if (parent === current) return resolve(cwd);
 *   lib/index.js:486      current = parent;
 *   lib/index.js:487    }
 *   lib/index.js:488  }
 *   lib/index.js:451  async function existsAsMarker(path, fileSystem, signal) {
 *   lib/index.js:452    if (fileSystem !== void 0) try {
 *   lib/index.js:453      const target = await fileSystem.resolve(path, signalOptions(signal));
 *   lib/index.js:454      return await fileSystem.stat(target, signal) !== void 0;
 *   lib/index.js:455    } catch (error) {
 *   lib/index.js:456      signal?.throwIfAborted();
 *   lib/index.js:457      if (isMissingProviderPathError(error)) return false;
 *   lib/index.js:458      throw error;            // <-- the arm the turn dies in
 *   lib/index.js:459    }
 *   lib/index.js:410  function isMissingProviderPathError(error) {
 *   lib/index.js:411    return error instanceof Error && "code" in error && error.code === "FS_NOT_FOUND";
 *   lib/index.js:412  }
 *
 * The walk ALWAYS ends at `/` (`dirname('/') === '/'`), so the last probe of
 * every session that has no `.git` anywhere in its ancestry is `/.git`. On the
 * live cluster that is the operator's own case: `t_sessions.f_cwd` is
 * `/workspaces/agents` (four sessions; no session anywhere has `cwd = '/'`),
 * the pod has no `/workspaces/agents/.git`, and `/workspaces/.git` is answered
 * `FS_NOT_FOUND` by the membership fence (7b536ea). So the walk reaches `/.git`,
 * `resolve` throws `path escapes workspace root: /.git`, and the turn fails —
 * every message, in a perfectly healthy workspace session.
 *
 * The lesson is 7b536ea's, applied to the other fence: a path this platform
 * cannot serve is not a caller error. `/` is not a workspace, no pod or volume
 * exists above the workspace anchors, and the honest answer to "is there a
 * `.git` up there?" is "no" — the same answer `/workspaces/.git` already gives.
 * This spec pins that, and pins that the degradation costs nothing:
 *
 *   1. the walk from a WORKSPACE cwd terminates at the workspace, with every
 *      refusal it saw coded `FS_NOT_FOUND` (the one code the official probe
 *      tolerates), and returns the cwd as the project root;
 *   2. an out-of-root path is still REFUSED — no daemon call, no target, no
 *      bytes — but as a precise one-line "absent" answer, once per path;
 *   3. what 7b536ea fixed stays fixed: `.git` INSIDE a registered workspace is
 *      an ordinary dotfile served by that workspace's pod, and ordinary paths
 *      under the root keep routing to their pod.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FsK8s } from '../src/index.ts'
import { findProjectRoot, isMissingProviderPathError } from './official-walk.ts'

/** The host root AND pod root the shipped profile configures. */
const ROOT = '/workspaces'
/** The static fallback endpoint (what the profile gets when WS_DAEMON_ENDPOINT is unset). */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4390'
/** The workspace of the operator's failing sessions (`t_sessions.f_cwd`). */
const WORKSPACE = 'agents'
/** That session's cwd, read off the live database. */
const SESSION_CWD = `${ROOT}/${WORKSPACE}`

/**
 * The official predicate and the official walk both live in `./official-walk.ts`
 * with their file:line citations, transcribed verbatim from the installed
 * package, so this spec and the real-daemon integration spec drive the SAME
 * caller instead of two paraphrases of it.
 */

interface Call {
  url: string
  body: { path?: string }
}

interface Harness {
  fs: FsK8s
  /** Workspace ids the resolver was asked to WAKE, in order. */
  resolved: string[]
  /** Workspace ids the membership question was asked about, in order. */
  asked: string[]
  /** Every daemon request that actually left the process. */
  calls: Call[]
  /** Lines the provider reported through `ctx.logger.warn`. */
  warnings: string[]
}

/**
 * One provider over a stand-in `workspaceEndpointResolver` service, with the
 * daemon answering `info` for NOTHING (the workspace the operator's session
 * lives in has no `.git`, which is what starts the walk).
 */
function harness(members: readonly string[] = [WORKSPACE]): Harness {
  const ctx = new Context()
  const resolved: string[] = []
  const asked: string[] = []
  const calls: Call[] = []
  const warnings: string[] = []
  ctx.provide('workspaceEndpointResolver', {
    resolve: (workspaceId: string): string => {
      resolved.push(workspaceId)
      return `http://${workspaceId}.pod:4390`
    },
    isWorkspace: async (workspaceId: string): Promise<boolean> => {
      asked.push(workspaceId)
      return members.includes(workspaceId)
    },
  })
  ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)); return undefined }) as never
  vi.stubGlobal('fetch', (url: string, init: { body?: unknown }) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as { path?: string } })
    // `info` answers nothing (a workspace directory with no `.git` in it); the
    // read/list members still answer, so the routing proof can be made.
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, data: { bytes: Buffer.from('served').toString('base64'), entries: [] } }),
    })
  })
  return {
    fs: new FsK8s(ctx, { daemonEndpoint: DEFAULT_ENDPOINT, hostRoot: ROOT, podRoot: ROOT }),
    resolved,
    asked,
    calls,
    warnings,
  }
}

/**
 * `findProjectRoot` + `existsAsMarker` live in `./official-walk.ts`. Faithful on
 * purpose: the acceptance criterion is a real conversation, and this is the
 * smallest thing that can fail the same way.
 */
async function walk(fs: FsK8s, cwd: string, markers: readonly string[]): Promise<string> {
  return findProjectRoot(fs, cwd, markers)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the operator's message-time walk: cwd /workspaces/agents, no .git anywhere", () => {
  it('terminates at the workspace instead of failing the turn on /.git', async () => {
    const { fs } = harness()

    const projectRoot = await walk(fs, SESSION_CWD, [".git"])

    // The walk ends at `/` (dirname is its own parent) and answers "no marker
    // here", so the project root is the workspace the session lives in. Before
    // the fix this REJECTED with `path escapes workspace root: /.git`, which is
    // the platform failure the operator sees on every message.
    expect(projectRoot).toBe(SESSION_CWD)
  })

  it('probes the workspace, then the root .git, then / — and only the first is a pod call', async () => {
    const { fs, asked, resolved, calls } = harness()
    const probes: string[] = []

    await findProjectRoot(fs, SESSION_CWD, ['.git'], probes)

    // The three ancestors the walk visits, in order: the workspace's own `.git`
    // (a real pod question, answered "absent" by the daemon), `.git` beside the
    // workspace anchors (refused by the membership fence), and `/.git` (outside
    // the platform's file world — the probe that used to fail the turn).
    expect(probes).toEqual([`${SESSION_CWD}/.git`, `${ROOT}/.git`, '/.git'])
    expect(asked).toEqual([WORKSPACE, '.git'])
    expect(resolved).toEqual([WORKSPACE])
    expect(calls.map((call) => call.url)).toEqual([`http://${WORKSPACE}.pod:4390/files/info`])
    expect(calls[0]?.body.path).toBe('/.git')
  })

  it('never wakes a workspace for a path above the root', async () => {
    const { fs, resolved } = harness()

    await walk(fs, SESSION_CWD, [".git"])

    expect(resolved).toEqual([WORKSPACE])
  })

  it('codes the /.git refusal FS_NOT_FOUND — the one code the official probe tolerates', async () => {
    const { fs } = harness()

    const error = await fs.resolve('.git', { cwd: '/' }).then(
      () => new FsError('resolve must refuse an out-of-root path', 'FS_IO_ERROR'),
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(FsError)
    expect(isMissingProviderPathError(error), 'the official probe rethrows anything else').toBe(true)
  })
})

describe('an out-of-root path is refused precisely, not served and not fatal', () => {
  it('names the path, the root, and where to look instead, in ONE line', async () => {
    const { fs } = harness()

    const error = await fs.resolve('/.git').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FsError)
    const failure = error as FsError
    expect(failure.code).toBe('FS_NOT_FOUND')
    expect(failure.message).toContain('/.git')
    expect(failure.message).toContain(ROOT)
    expect(failure.message).toMatch(/outside the workspace root|not inside a workspace/)
    expect(failure.message).not.toContain('\n')
    // The internal fence text is NOT the caller's answer any more: it names the
    // host path space, which is not something a session can act on.
    expect(failure.message).not.toContain('path escapes workspace root')
  })

  it('refuses at resolve, so no daemon request is ever made for it', async () => {
    const { fs, calls, resolved } = harness()

    await expect(fs.resolve('/.git')).rejects.toBeInstanceOf(FsError)

    expect(calls).toEqual([])
    expect(resolved).toEqual([])
  })

  it('degrades every PATH-taking member the same way, and hands out no target at all', async () => {
    const { fs, calls, resolved } = harness()

    // A target is the only way into the target-taking members (`stat`,
    // `readText`, `listDir`, `writeText`, …), and `resolve` is the only way to
    // get one — so the refusal has to land here, before any of them can run.
    for (const operation of [
      () => fs.resolve('/.git'),
      () => fs.resolve('.git', { cwd: '/' }),
      () => fs.resolve('/etc/passwd'),
      () => fs.lstat('/.git'),
      () => fs.lstat('../../etc/passwd', { cwd: SESSION_CWD }),
    ]) {
      const error = await operation().catch((e: unknown) => e)
      expect(error, 'every member must degrade the same way').toBeInstanceOf(FsError)
      expect((error as FsError).code).toBe('FS_NOT_FOUND')
      expect((error as FsError).message).not.toContain('\n')
    }
    expect(calls).toEqual([])
    expect(resolved).toEqual([])
  })

  it('reports the condition once per path, not once per operation', async () => {
    const { fs, warnings } = harness()

    for (let i = 0; i < 3; i += 1) await fs.resolve('/.git').catch(() => undefined)
    await fs.resolve('/etc/passwd').catch(() => undefined)

    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('/.git')
    expect(warnings[0]).toContain(ROOT)
    expect(warnings[1]).toContain('/etc/passwd')
  })
})

describe('what 7b536ea fixed stays fixed', () => {
  it('serves a dotfile INSIDE the registered workspace from that workspace pod', async () => {
    const { fs, resolved, asked, calls } = harness()

    const target = await fs.resolve('.git/HEAD', { cwd: SESSION_CWD })
    await fs.readText(target)

    expect(asked).toEqual([WORKSPACE])
    expect(resolved).toEqual([WORKSPACE])
    expect(calls[0]?.url).toBe(`http://${WORKSPACE}.pod:4390/files/read`)
    expect(calls[0]?.body.path).toBe('/.git/HEAD')
  })

  it('keeps ordinary paths under the root routed, and never treats the root itself as an escape', async () => {
    const { fs, resolved, calls } = harness()

    await fs.readText(await fs.resolve(`${ROOT}/${WORKSPACE}/src/a.ts`))
    await fs.readText(await fs.resolve('src/b.ts', { cwd: SESSION_CWD }))
    await fs.listDir(await fs.resolve(ROOT)).catch(() => undefined)

    expect(resolved).toEqual([WORKSPACE, WORKSPACE])
    expect(calls.slice(0, 2).map((call) => call.body.path)).toEqual(['/src/a.ts', '/src/b.ts'])
    // The root itself is not a workspace id either, and keeps the route it had
    // (the static endpoint), never a refusal.
    expect(calls[2]?.url).toBe(`${DEFAULT_ENDPOINT}/files/list`)
  })
})

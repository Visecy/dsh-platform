/**
 * The path contract between the platform's logical workspace path and the
 * sandbox daemon's file API — the layout the DEPLOYMENT actually uses.
 *
 * In a workspace pod the PVC is mounted at `/workspaces/<id>` and the daemon
 * runs with `DAEMON_ROOT=/workspaces/<id>`, i.e. the daemon's file root IS the
 * workspace directory. Its file API is rooted there: `FilesService.confine()`
 * resolves `join(root, path)`, so the daemon's own root is `/` and a child is
 * `/name` — a pod-absolute path such as `/workspaces/<id>/name` lands at
 * `<root>/workspaces/<id>/name`, which is not the file the platform means.
 *
 * The provider therefore has TWO path forms for one target:
 *
 *   - the POD path (`/workspaces/<id>/…`): what `processPath`/`fileUrl` report
 *     and what the subprocess provider uses as a cwd — a real path in the pod;
 *   - the DAEMON path (`/…`): relative to the daemon root, what every files
 *     request must carry.
 *
 * These tests run against a real daemon whose root stands in for the workspace
 * directory, with `hostRoot === podRoot === '/workspaces'` exactly as the
 * shipped profile configures it (docker/profiles/*.cordis.patch.yml).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FsK8s } from '../src/index.ts'
import { findProjectRoot } from './official-walk.ts'

/** The host root AND the pod root the deployment configures. */
const ROOT = '/workspaces'
const WORKSPACE = 'ws-a'
/** The pod-absolute path of the workspace: the PVC mount == the daemon root. */
const WS_ROOT = `${ROOT}/${WORKSPACE}`

let workspaceDir: string
let daemonUrl: string
let server: import('node:http').Server
let fs: FsK8s

beforeAll(async () => {
  // Stands in for the PVC mount at /workspaces/<id>.
  workspaceDir = await mkdtemp(join(process.cwd(), '.tmp-fspaths-'))
  const started = await startDaemon({ root: workspaceDir, port: 0, commandTimeoutMs: 30_000 })
  server = started.server
  daemonUrl = started.baseUrl
  fs = new FsK8s(new Context(), {
    daemonEndpoint: daemonUrl,
    hostRoot: ROOT,
    podRoot: ROOT,
    watchIntervalMs: 20,
    watchMaxIntervalMs: 100,
  })
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('deployment path layout (daemon root == /workspaces/<id>)', () => {
  it('addresses the workspace root as the daemon root', async () => {
    // A file placed directly in the PVC mount is the workspace's own content.
    await writeFile(join(workspaceDir, 'on-disk.txt'), 'written by the pod')
    const target = await fs.resolve(WS_ROOT)
    const names = (await fs.listDir(target)).map((entry) => entry.name)
    expect(names).toContain('on-disk.txt')
  })

  it('stats a file that exists in the daemon root', async () => {
    await writeFile(join(workspaceDir, 'stated.txt'), 'hello')
    const info = await fs.stat(await fs.resolve(`${WS_ROOT}/stated.txt`))
    expect(info).toBeDefined()
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(5)
  })

  it('writes, reads and lists relative to the daemon root', async () => {
    const target = await fs.resolve(`${WS_ROOT}/made/by-the-provider.txt`)
    const outcome = await fs.writeText(target, 'provider bytes')
    expect(outcome.operation).toBe('create')
    // The daemon wrote at <mount>/made/…, i.e. the same tree the pod's shell sees.
    expect(await readFile(join(workspaceDir, 'made', 'by-the-provider.txt'), 'utf8')).toBe('provider bytes')
    expect(await fs.readText(await fs.resolve(`${WS_ROOT}/made/by-the-provider.txt`))).toBe('provider bytes')

    const nested = (await fs.listDir(await fs.resolve(`${WS_ROOT}/made`))).map((entry) => entry.name)
    expect(nested).toContain('by-the-provider.txt')
  })

  it('reports child targets as pod paths, not daemon paths', async () => {
    await mkdir(join(workspaceDir, 'children'), { recursive: true })
    await writeFile(join(workspaceDir, 'children', 'one.txt'), '1')
    const entries = await fs.listDir(await fs.resolve(`${WS_ROOT}/children`))
    const child = entries.find((entry) => entry.name === 'one.txt')
    expect(child?.target.targetKey).toBe(`dsh-k8s:${WS_ROOT}/children/one.txt`)
    expect(child?.target.displayPath).toBe(`${WS_ROOT}/children/one.txt`)
    expect(fs.processPath(child!.target)).toBe(`${WS_ROOT}/children/one.txt`)
  })

  it('watches a file in the daemon root and reports a change', async () => {
    const target = await fs.resolve(`${WS_ROOT}/watched.txt`)
    await fs.writeText(target, 'v1')
    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)
    await writeFile(join(workspaceDir, 'watched.txt'), 'v2 — a different length')
    const deadline = Date.now() + 3000
    while (calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]).toBeUndefined()
    await close()
  })
})

/**
 * The same deployment layout, now with the per-workspace resolver the profile
 * mounts (`workspaceEndpointResolver`) — i.e. the routing a live fs operation
 * actually takes, and the fence that routing has to keep.
 *
 * Two paths sit one directory apart and must be answered in completely
 * different ways:
 *
 *   - `.git/HEAD` resolved from the WORKSPACE (`/workspaces/ws-a`) is inside a
 *     registered workspace: the resolver is asked, the workspace's pod serves
 *     it, and a dotfile in a nested directory is an ordinary file.
 *   - `.git/HEAD` resolved from the ROOT (`/workspaces`) has `.git` as its
 *     first segment, which names no workspace: the resolver must NOT be asked
 *     (that is the call that would create a PVC and a pod), and the operation
 *     answers with one line instead of a platform failure.
 */
describe('deployment routing with the platform resolver mounted', () => {
  let fenced: FsK8s
  const resolved: string[] = []

  beforeAll(() => {
    const ctx = new Context()
    ctx.provide('workspaceEndpointResolver', {
      resolve: (workspaceId: string): string => {
        resolved.push(workspaceId)
        return daemonUrl
      },
      isWorkspace: async (workspaceId: string): Promise<boolean> => workspaceId === WORKSPACE,
    })
    fenced = new FsK8s(ctx, { daemonEndpoint: daemonUrl, hostRoot: ROOT, podRoot: ROOT })
  })

  it('serves a dotfile nested inside the registered workspace', async () => {
    await mkdir(join(workspaceDir, '.git'), { recursive: true })
    await writeFile(join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const target = await fenced.resolve('.git/HEAD', { cwd: WS_ROOT })

    expect(await fenced.readText(target)).toBe('ref: refs/heads/main\n')
    expect((await fenced.stat(target))?.size).toBe(21)
    // Every routing decision went to the workspace that owns the path — never
    // to '.git', which is not a workspace and must not be ensured as one.
    expect(resolved).toEqual([WORKSPACE, WORKSPACE])
  })

  it("degrades '.git' from the workspace root without asking the resolver", async () => {
    const target = await fenced.resolve('.git/HEAD', { cwd: ROOT })

    const error = await fenced.readText(target).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).message).toContain(`${ROOT}/.git/HEAD`)
    expect((error as FsError).message).not.toContain('\n')
    // The resolver was not asked again: resolving the root-relative `.git`
    // would have been the ensure that materializes it.
    expect(resolved).not.toContain('.git')
    expect(resolved).toEqual([WORKSPACE, WORKSPACE])
  })
})

/**
 * The MESSAGE-TIME walk, end to end against a REAL daemon: what
 * `@deepseek-ai/dsh-agent-instructions` does on every turn of every session, on
 * the deployment's own path layout.
 *
 * The workspace here has NO `.git` — which is the operator's case: their
 * sessions run in `/workspaces/agents` (`t_sessions.f_cwd`), the pod has no
 * `/workspaces/agents/.git`, and `/workspaces/.git` names no workspace. So the
 * walk climbs out of the workspace root and probes `/.git`, the last ancestor
 * before `dirname('/') === '/'` ends it.
 *
 * Before the fix that probe was answered `FS_PERMISSION_DENIED` — the one code
 * the official probe does NOT tolerate (`lib/index.js:410`, `:451-459`) — so
 * every message in a healthy workspace session died with
 * `path escapes workspace root: /.git`. This spec drives the whole chain
 * against the real daemon: workspace probe → membership fence → out-of-root.
 */
describe('the message-time project-root walk on a session in a real workspace', () => {
  let quietDir: string
  let quietServer: import('node:http').Server
  let quiet: FsK8s
  const asked: string[] = []
  const woken: string[] = []

  beforeAll(async () => {
    // The PVC mount of a workspace that is NOT a git repository.
    quietDir = await mkdtemp(join(process.cwd(), '.tmp-fswalk-'))
    const started = await startDaemon({ root: quietDir, port: 0, commandTimeoutMs: 30_000 })
    quietServer = started.server
    const ctx = new Context()
    ctx.provide('workspaceEndpointResolver', {
      resolve: (workspaceId: string): string => {
        woken.push(workspaceId)
        return started.baseUrl
      },
      isWorkspace: async (workspaceId: string): Promise<boolean> => {
        asked.push(workspaceId)
        return workspaceId === WORKSPACE
      },
    })
    quiet = new FsK8s(ctx, { daemonEndpoint: started.baseUrl, hostRoot: ROOT, podRoot: ROOT })
  })

  afterAll(async () => {
    await new Promise<void>((res) => quietServer.close(() => res()))
    await rm(quietDir, { recursive: true, force: true })
  })

  it('walks out of the workspace to /, and every refusal it sees is FS_NOT_FOUND', async () => {
    const probes: string[] = []
    const refusals: string[] = []

    const projectRoot = await findProjectRoot(quiet, WS_ROOT, ['.git'], probes).catch((error: unknown) => {
      refusals.push((error as FsError).code)
      throw error
    })

    // Two levels of ancestors, then the root of the host filesystem.
    expect(probes).toEqual([`${WS_ROOT}/.git`, `${ROOT}/.git`, '/.git'])
    expect(refusals).toEqual([])
    expect(projectRoot).toBe(WS_ROOT)
    // The workspace's own probe really was a pod call (the real daemon answered
    // "absent"), and no workspace was ever woken for the two ancestors above it.
    expect(asked).toEqual([WORKSPACE, '.git'])
    expect(woken).toEqual([WORKSPACE])
  })
})

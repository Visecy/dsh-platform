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
import { FsK8s } from '../src/index.ts'

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

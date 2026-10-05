/**
 * FileSystem.watch — the DSH 0.2 seam member the workspace file view calls.
 *
 * The base class default rejects with FS_IO_ERROR and the caller turns that
 * into a hard `workspace-file/watch-unsupported` error, so the provider must
 * implement real observation. The contract these tests pin:
 *
 *   watch(target, changed, signal) resolves once observation is ACTIVE, with
 *   an asynchronous close; `changed()` (no argument) means "the target's
 *   observed state moved", `changed(error)` reports a polling failure; after
 *   close no callback may ever run again; an aborted signal rejects
 *   initialization.
 *
 * The provider polls the sandbox daemon's `files/info` (mtime/size/type), so
 * every assertion here is against a real daemon over HTTP with a short
 * configured interval, using the DEPLOYMENT layout: the daemon's root is the
 * workspace directory `/workspaces/<id>` and its API is addressed relative to
 * it (see tests/paths.spec.ts for the path contract).
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { Context } from '@deepseek-ai/cordis'
import { FsK8s } from '../src/index.ts'
import { DaemonFilesClient } from '../src/client.ts'

const hostRoot = '/workspaces'
const podRoot = '/workspaces'
const WORKSPACE = 'test-ws'
/** Pod-side path of the workspace directory: the PVC mount == the daemon root. */
const wsRoot = `${podRoot}/${WORKSPACE}`
const INTERVAL = 20

let root: string
let daemonUrl: string
let server: import('node:http').Server
let fs: FsK8s

/** A target for a workspace-relative path. */
const t = (rel: string) => ({
  targetKey: `dsh-k8s:${wsRoot}${rel}` as any,
  displayPath: `${hostRoot}/${WORKSPACE}${rel}`,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolve `predicate` within `timeoutMs`, or resolve `false`. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

beforeAll(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-fswatch-'))
  const started = await startDaemon({ root, port: 0, commandTimeoutMs: 30_000 })
  server = started.server
  daemonUrl = started.baseUrl
  fs = new FsK8s(new Context(), {
    daemonEndpoint: daemonUrl,
    hostRoot,
    podRoot,
    watchIntervalMs: INTERVAL,
    watchMaxIntervalMs: 200,
  })
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  await rm(root, { recursive: true, force: true })
})

describe('FsK8s.watch', () => {
  it('resolves once observation is active and reports a file change', async () => {
    const target = t('/watched.txt')
    await fs.writeText(target, 'v1')

    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)
    expect(typeof close).toBe('function')

    await fs.writeText(target, 'v2 — a different length so mtime/size both move')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBeUndefined()

    await close()
  })

  it('reports creation of a path that did not exist when observation started', async () => {
    const target = t('/appears.txt')
    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)

    // The initial sample is "absent"; creating it must be an invalidation.
    await sleep(INTERVAL * 2)
    expect(calls).toHaveLength(0)
    await fs.writeText(target, 'now it exists')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBeUndefined()

    await close()
  })

  it('reports a directory entry appearing (direct entries are the observed set)', async () => {
    const target = t('/watched-dir')
    await fs.writeText(t('/watched-dir/seed.txt'), 'seed')

    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)

    await fs.writeText(t('/watched-dir/new.txt'), 'new')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBeUndefined()

    await close()
  })

  it('stops calling back after close, and stops polling', async () => {
    const target = t('/closed.txt')
    await fs.writeText(target, 'before')

    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)
    await close()
    await close() // idempotent

    const info = vi.spyOn(DaemonFilesClient.prototype, 'info')
    const pollsAtClose = info.mock.calls.length
    await fs.writeText(target, 'after — changed while nobody is observing')
    await sleep(INTERVAL * 10)
    info.mockRestore()

    expect(calls).toHaveLength(0)
    // No timer survived close: the daemon is no longer polled at all.
    expect(info.mock.calls.length - pollsAtClose).toBe(0)
  })

  it('rejects when the signal is already aborted before initialization', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fs.watch(t('/watched.txt'), () => {}, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('resolves with an inert watcher when the daemon cannot answer the poll, and reports it once', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)); return undefined }) as never
    const dead = new FsK8s(ctx, {
      daemonEndpoint: 'http://127.0.0.1:1',
      hostRoot,
      podRoot,
      watchIntervalMs: INTERVAL,
    })
    const calls: Array<Error | undefined> = []
    const close = await dead.watch(t('/watched.txt'), (error) => calls.push(error), new AbortController().signal)
    expect(typeof close).toBe('function')
    // A watcher that cannot observe anything must simply never fire — the
    // promise the seam resolves with is a live observation, not a rejection.
    await sleep(INTERVAL * 5)
    expect(calls).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/live refresh unavailable/i)

    // Re-opening the file view watches the same path again; that is the SAME
    // condition, so the sink must not accumulate a line per attempt.
    const second = await dead.watch(t('/watched.txt'), () => {}, new AbortController().signal)
    await sleep(INTERVAL * 2)
    expect(warnings).toHaveLength(1)

    // A different target is a different condition and gets its own line.
    const third = await dead.watch(t('/other.txt'), () => {}, new AbortController().signal)
    expect(warnings).toHaveLength(2)

    await close()
    await second()
    await third()
  })

  it('resolves (rather than rejects) when the daemon answers the poll with an error', async () => {
    // A daemon that serves the endpoint but refuses the request (an old image
    // with a different payload contract) must degrade the same way.
    const refusing = createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, data: { error: { code: 'IO_ERROR', message: 'nope' } } }))
    })
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve))
    const address = refusing.address() as { port: number }
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)); return undefined }) as never
    const broken = new FsK8s(ctx, {
      daemonEndpoint: `http://127.0.0.1:${address.port}`,
      hostRoot,
      podRoot,
      watchIntervalMs: INTERVAL,
    })
    try {
      const calls: Array<Error | undefined> = []
      const close = await broken.watch(t('/refused.txt'), (error) => calls.push(error), new AbortController().signal)
      await sleep(INTERVAL * 5)
      expect(calls).toHaveLength(0)
      expect(warnings).toHaveLength(1)
      await close()
    } finally {
      await new Promise<void>((resolve) => refusing.close(() => resolve()))
    }
  })

  it('reports later polling failures through changed(error) instead of throwing', async () => {
    const errorRoot = await mkdtemp(join(process.cwd(), '.tmp-fswatch-err-'))
    const started = await startDaemon({ root: errorRoot, port: 0, commandTimeoutMs: 30_000 })
    const watching = new FsK8s(new Context(), {
      daemonEndpoint: started.baseUrl,
      hostRoot,
      podRoot,
      watchIntervalMs: INTERVAL,
      watchMaxIntervalMs: 80,
    })
    try {
      const target = t('/doomed.txt')
      await watching.writeText(target, 'observed')

      const calls: Array<Error | undefined> = []
      const close = await watching.watch(target, (error) => calls.push(error), new AbortController().signal)

      // Kill the daemon under the watcher: the next poll must surface the
      // failure as an error argument, not as an unhandled rejection.
      await new Promise<void>((res) => started.server.close(() => res()))
      started.server.closeAllConnections()

      expect(await until(() => calls.length > 0, 4000)).toBe(true)
      expect(calls[0]).toBeInstanceOf(Error)
      expect((calls[0] as Error).message).toMatch(/daemon|fetch|unreachable|socket/i)
      await close()
    } finally {
      started.server.closeAllConnections()
      await rm(errorRoot, { recursive: true, force: true })
    }
  })

  it('backs off between failed polls instead of busy-looping', async () => {
    const errorRoot = await mkdtemp(join(process.cwd(), '.tmp-fswatch-backoff-'))
    const started = await startDaemon({ root: errorRoot, port: 0, commandTimeoutMs: 30_000 })
    const watching = new FsK8s(new Context(), {
      daemonEndpoint: started.baseUrl,
      hostRoot,
      podRoot,
      watchIntervalMs: INTERVAL,
      watchMaxIntervalMs: 160,
    })
    try {
      const target = t('/backoff.txt')
      await watching.writeText(target, 'observed')

      const failures: number[] = []
      const close = await watching.watch(target, (error) => {
        if (error !== undefined) failures.push(Date.now())
      }, new AbortController().signal)

      await new Promise<void>((res) => started.server.close(() => res()))
      started.server.closeAllConnections()

      expect(await until(() => failures.length >= 3, 5000)).toBe(true)
      const gaps = failures.slice(1).map((at, index) => at - failures[index])
      // 20ms base doubling per failure: the first gap is already the doubled
      // interval, and every later gap is at least as long as the one before.
      expect(gaps[0]).toBeGreaterThanOrEqual(INTERVAL * 1.5)
      expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0])
      await close()
    } finally {
      started.server.closeAllConnections()
      await rm(errorRoot, { recursive: true, force: true })
    }
  })
})

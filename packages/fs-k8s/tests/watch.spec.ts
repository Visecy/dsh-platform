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
 * configured interval.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { Context } from '@deepseek-ai/cordis'
import { FsK8s } from '../src/index.ts'
import { DaemonFilesClient } from '../src/client.ts'

const hostRoot = '/workspaces/test-ws'
const podRoot = '/workspace'
const INTERVAL = 20

let root: string
let daemonUrl: string
let server: import('node:http').Server
let fs: FsK8s

const t = (p: string) => ({ targetKey: `dsh-k8s:${p}` as any, displayPath: hostRoot + p.slice(podRoot.length) })

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
    const target = t(podRoot + '/watched.txt')
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
    const target = t(podRoot + '/appears.txt')
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
    const target = t(podRoot + '/watched-dir')
    await fs.writeText(t(podRoot + '/watched-dir/seed.txt'), 'seed')

    const calls: Array<Error | undefined> = []
    const close = await fs.watch(target, (error) => calls.push(error), new AbortController().signal)

    await fs.writeText(t(podRoot + '/watched-dir/new.txt'), 'new')
    expect(await until(() => calls.length > 0)).toBe(true)
    expect(calls[0]).toBeUndefined()

    await close()
  })

  it('stops calling back after close, and stops polling', async () => {
    const target = t(podRoot + '/closed.txt')
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
    await expect(fs.watch(t(podRoot + '/watched.txt'), () => {}, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when the daemon cannot be reached for the initial observation', async () => {
    const dead = new FsK8s(new Context(), {
      daemonEndpoint: 'http://127.0.0.1:1',
      hostRoot,
      podRoot,
      watchIntervalMs: INTERVAL,
    })
    await expect(dead.watch(t(podRoot + '/watched.txt'), () => {}, new AbortController().signal))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
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
      const target = t(podRoot + '/doomed.txt')
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
      const target = t(podRoot + '/backoff.txt')
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

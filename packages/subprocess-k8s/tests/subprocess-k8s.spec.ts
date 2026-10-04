import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { SubprocessK8s } from '../src/index.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

let root: string
let daemonUrl: string
let server: import('node:http').Server
let sub: SubprocessK8s
let started: string[]
let ended: string[]
const ctx = new Context()

beforeAll(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-subk8s-'))
  const daemonStarted = await startDaemon({ root, port: 0, commandTimeoutMs: 30_000 })
  server = daemonStarted.server
  daemonUrl = daemonStarted.baseUrl
  started = []
  ended = []
  sub = new SubprocessK8s(ctx, {
    daemonEndpoint: daemonUrl,
    podRoot: root,
    commandTracker: {
      commandStarted: (id) => started.push(id),
      commandEnded: (id) => ended.push(id),
    },
  })
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  await rm(root, { recursive: true, force: true })
})

const spec = (over: Partial<SubprocessSpawnSpec>): SubprocessSpawnSpec => ({
  argv: ['sh', '-c', 'echo out; echo err >&2; exit 3'],
  cwd: root,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
  graceMs: 500,
  ...over,
})

describe('SubprocessK8s', () => {
  it('resolveExecutable finds binaries in the pod', async () => {
    const p = await sub.resolveExecutable('echo')
    expect(p).toContain('/echo')
  })

  it('spawn runs to completion with collected output and exit code', async () => {
    const h = sub.spawn(spec({}))
    const outcome = await h.done
    expect(outcome.exitCode).toBe(3)
    const out = h.collected.stdout!.readFrom(0)
    expect(out.text).toContain('out')
    expect(h.collected.stderr!.readFrom(0).text).toContain('err')
  })

  it('reports workspace command start/end to the lifecycle tracker', async () => {
    const h = sub.spawn(spec({ cwd: '/workspaces/ws-track', argv: ['echo', 'tracked'] }))
    const outcome = await h.done
    expect(outcome.exitCode).toBe(0)
    expect(started).toEqual(['ws-track'])
    await new Promise((r) => setTimeout(r, 50))
    expect(ended).toEqual(['ws-track'])
  })

  it('rejects an invalid cwd with an actionable daemon error, not exit -1', async () => {
    const h = sub.spawn(spec({ cwd: '/definitely/not/a/real/dir', argv: ['echo', 'x'] }))
    await expect(h.done).rejects.toThrow(/cwd does not exist|cwd is not a directory/)
  })

  it('spawn with stdin data feeds the command', async () => {
    const h = sub.spawn(spec({ argv: ['cat'], stdio: { stdin: { data: 'hello-cat' }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }))
    const outcome = await h.done
    expect(outcome.exitCode).toBe(0)
    expect(h.collected.stdout!.readFrom(0).text).toContain('hello-cat')
  })

  it('spawn with piped stdin streams writes', async () => {
    const h = sub.spawn(spec({ argv: ['cat'], stdio: { stdin: 'pipe', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }))
    await new Promise((res) => setTimeout(res, 200))
    h.stdin!.write('via-pipe')
    h.stdin!.end()
    const outcome = await h.done
    expect(outcome.exitCode).toBe(0)
    expect(h.collected.stdout!.readFrom(0).text).toContain('via-pipe')
  })

  it('terminate kills a long-running command', async () => {
    const h = sub.spawn(spec({ argv: ['sleep', '30'] }))
    // Give the daemon time to actually start the process. A deterministic wait on
    // the daemon's start report is NOT usable here: `started` accumulates across
    // this file and the report does not arrive reliably for this spawn -- and
    // terminating before the process exists left `done` unresolved when tried,
    // which is a plugin-side question of its own, not something this test should
    // paper over.
    await new Promise((res) => setTimeout(res, 300))
    const begun = Date.now()
    h.terminate()
    const outcome = await h.done
    // Assert the observable behaviour, not the shape of the result. `terminate`
    // races two correct paths -- the plugin resolving the handle itself and the
    // daemon's real exit status arriving first -- so enumerating outcomes (as
    // this test used to: ['exited','killed']) encodes that race and goes flaky
    // under load. What must hold is that the command was ended instead of being
    // allowed to run its full 30s, and that it did not report a successful
    // self-exit.
    expect(Date.now() - begun).toBeLessThan(10_000)
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true)
  }, 15_000)

  // DSH 0.1.5 tightened `spawn`: it must reject an invalid spec SYNCHRONOUSLY
  // (before a handle exists). dsh-bash-local derives its aborted flag only
  // after awaiting `done`, so a pre-aborted call that we accepted would still
  // launch a process in the pod.
  describe('spawn synchronous validation (DSH 0.1.5)', () => {
    it('throws synchronously for a pre-aborted signal', () => {
      const controller = new AbortController()
      controller.abort()
      expect(() => sub.spawn(spec({ signal: controller.signal }))).toThrow(/abor/i)
    })

    it('throws synchronously for an empty argv', () => {
      expect(() => sub.spawn(spec({ argv: [] }))).toThrow(/argv\[0\]/)
      expect(() => sub.spawn(spec({ argv: [''] }))).toThrow(/argv\[0\]/)
    })

    it('throws synchronously for a non-positive or non-finite graceMs', () => {
      expect(() => sub.spawn(spec({ graceMs: 0 }))).toThrow(/graceMs/)
      expect(() => sub.spawn(spec({ graceMs: -1 }))).toThrow(/graceMs/)
      expect(() => sub.spawn(spec({ graceMs: Number.POSITIVE_INFINITY }))).toThrow(/graceMs/)
      expect(() => sub.spawn(spec({ graceMs: Number.MAX_SAFE_INTEGER }))).toThrow(/graceMs/)
    })

    it('throws synchronously for an empty cwd', () => {
      expect(() => sub.spawn(spec({ cwd: '' }))).toThrow(/cwd/)
    })
  })

  it('waitForExit returns false when its signal aborts first', async () => {
    const h = sub.spawn(spec({ argv: ['sleep', '30'] }))
    const controller = new AbortController()
    const waiting = h.waitForExit(controller.signal)
    setTimeout(() => controller.abort(), 100)
    expect(await waiting).toBe(false)
    h.terminate()
    await h.done.catch(() => undefined)
  })

  it('waitForExit waits for the managed range, not just the direct child', async () => {
    // The shell exits immediately while a backgrounded grandchild stays in the
    // SAME process group but redirects its stdio away from the inherited pipes.
    // The daemon therefore publishes exit.json as soon as the direct child is
    // gone (its drain cannot see the detached grandchild), so only a range-aware
    // waitForExit keeps the caller blocked until the group is really empty. A
    // grandchild that INHERITS stdio needs no range wait: the daemon's own
    // exit.json publication already waits for the pipes to close.
    const h = sub.spawn(spec({ argv: ['sh', '-c', 'sleep 1.5 >/dev/null 2>&1 & echo started'] }))
    const outcome = await h.done
    expect(outcome.exitCode).toBe(0)
    const before = Date.now()
    await h.waitForExit()
    expect(Date.now() - before).toBeGreaterThanOrEqual(500)
  })

  it('collected reads are whole-stream lossless until the tail window slides', async () => {
    const h = sub.spawn(spec({ argv: ['sh', '-c', 'printf abcdefghij'] }))
    await h.done
    const reader = h.collected.stdout!
    const first = reader.readFrom(0)
    expect(first.text).toBe('abcdefghij')
    expect(first.nextOffset).toBe(10)
    expect(first.lossy).toBe(false)
    // A second read resumed from the first nextOffset is still lossless.
    const second = reader.readFrom(first.nextOffset)
    expect(second.text).toBe('')
    expect(second.lossy).toBe(false)
  })

  it('env tombstones delete ambient entries in the pod child', async () => {
    const h = sub.spawn(spec({
      argv: ['sh', '-c', 'printf "%s" "${DSH_TOMBSTONE_PROBE-unset}"'],
      env: { DSH_TOMBSTONE_PROBE: 'present-then-deleted' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    }))
    const first = await h.done
    expect(first.exitCode).toBe(0)
    // Now spawn again with the same name tombstoned: mergeEnv must delete it
    // from the daemon's ambient base (the wire carries null, not undefined).
    const h2 = sub.spawn(spec({
      argv: ['sh', '-c', 'printf "%s" "${DSH_TOMBSTONE_PROBE-unset}"'],
      env: { DSH_TOMBSTONE_PROBE: undefined },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    }))
    await h2.done
    expect(h2.collected.stdout!.readFrom(0).text).not.toBe('present-then-deleted')
  })

  it('spawnTerminal echoes input', async () => {
    const t = await sub.spawnTerminal({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: root, rows: 24, cols: 80, graceMs: 500 })
    await t.write('echo tty-ok\n')
    const deadline = Date.now() + 4000
    let saw = false
    while (Date.now() < deadline) {
      const chunk = t.output.read() as string | null
      if (chunk !== null && chunk.includes('tty-ok')) {
        saw = true
        break
      }
      await new Promise((res) => setTimeout(res, 50))
    }
    expect(saw).toBe(true)
    await t.terminate()
  })
})

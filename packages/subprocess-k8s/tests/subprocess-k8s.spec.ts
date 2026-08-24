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
    await new Promise((res) => setTimeout(res, 300))
    h.terminate()
    const outcome = await h.done
    expect(['exited', 'killed']).toContain(outcome.signal ?? 'exited')
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

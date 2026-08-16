import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '../src/index.ts'
import type { Server } from 'node:http'

let root: string
let server: Server
let base: string

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-srv-'))
  const started = await startDaemon({ root, port: 0, commandTimeoutMs: 30_000 })
  server = started.server
  base = started.baseUrl
})

afterEach(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  await rm(root, { recursive: true, force: true })
})

const post = async (path: string, body: unknown): Promise<{ ok: boolean; data: any }> => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ ok: boolean; data: any }>
}
const get = async (path: string): Promise<{ ok: boolean; data: any }> => {
  const res = await fetch(base + path)
  return res.json() as Promise<{ ok: boolean; data: any }>
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8')

describe('daemon server', () => {
  it('healthz responds', async () => {
    const res = await fetch(base + '/healthz')
    expect(res.status).toBe(200)
  })

  it('files API end-to-end', async () => {
    const w = await post('/files/write', { path: '/a.txt', content: b64('hello server') })
    expect(w.ok).toBe(true)
    expect(w.data.outcome.operation).toBe('create')

    const r = await post('/files/read', { path: '/a.txt' })
    expect(unb64(r.data.bytes)).toBe('hello server')

    const list = await post('/files/list', { path: '/' })
    expect(list.data.entries.some((e: { name: string }) => e.name === 'a.txt')).toBe(true)

    const info = await post('/files/info', { path: '/a.txt' })
    expect(info.data.info.type).toBe('file')

    await post('/files/remove', { path: '/a.txt' })
    const gone = await post('/files/read', { path: '/a.txt' })
    expect(gone.ok).toBe(false)
    expect(gone.data.error.code).toBe('NOT_FOUND')
  })

  it('commands API end-to-end with output frames', async () => {
    const run = await post('/commands/run', { spec: { argv: ['sh', '-c', 'echo server-ok'], cwd: '/' } })
    expect(run.ok).toBe(true)
    const cmdId = run.data.cmdId

    // poll status until exited
    let st: any
    const deadline = Date.now() + 6000
    do {
      await new Promise((res) => setTimeout(res, 50))
      st = (await get(`/commands/${cmdId}/status`)).data.status
    } while (Date.now() < deadline && st.phase !== 'exited')
    expect(st.phase).toBe('exited')
    expect(st.exitCode).toBe(0)

    const out = await get(`/commands/${cmdId}/output?stream=stdout&from=0`)
    const decoded = out.data.frames.trim().split('\n').filter(Boolean).map((l: string) => Buffer.from(l, 'base64').toString()).join('')
    expect(decoded).toBe('server-ok\n')
  })

  it('kill API terminates a running command', async () => {
    const run = await post('/commands/run', { spec: { argv: ['sleep', '30'], cwd: '/' } })
    const cmdId = run.data.cmdId
    await new Promise((res) => setTimeout(res, 150))
    const kill = await post(`/commands/${cmdId}/kill`, { graceMs: 300 })
    expect(kill.ok).toBe(true)
    expect(['killed', 'exited']).toContain(kill.data.status.phase)
  })

  it('rejects malformed payloads with ok:false', async () => {
    const bad = await post('/files/read', { path: '../../etc/passwd' })
    expect(bad.ok).toBe(false)
    expect(bad.data.error.code).toBe('OUT_OF_ROOT')
  })
})

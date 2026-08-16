import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '@visecy/dsh-sandbox-daemon'
import { FsK8s } from '../src/index.ts'
import { FsError } from '@deepseek-ai/dsh-fs'

let root: string
let daemonUrl: string
let server: import('node:http').Server
let fs: FsK8s
const hostRoot = '/workspaces/test-ws'
const podRoot = '/workspace'

import { Context } from '@deepseek-ai/cordis'
const mockCtx = new Context()

beforeAll(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-fsk8s-'))
  const started = await startDaemon({ root, port: 0, commandTimeoutMs: 30_000 })
  server = started.server
  daemonUrl = started.baseUrl
  fs = new FsK8s(mockCtx, { daemonEndpoint: daemonUrl, hostRoot, podRoot })
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()))
  await rm(root, { recursive: true, force: true })
})

const t = (p: string) => ({ targetKey: `dsh-k8s:${p}` as any, displayPath: hostRoot + p.slice(podRoot.length) })

describe('FsK8s', () => {
  it('writeText + readText round trip', async () => {
    const out = await fs.writeText(t(podRoot + '/a.txt'), 'hello fs-k8s')
    expect(out.operation).toBe('create')
    const text = await fs.readText(t(podRoot + '/a.txt'))
    expect(text).toBe('hello fs-k8s')
  })

  it('stat reports size and version changes after write', async () => {
    const before = await fs.stat(t(podRoot + '/a.txt'))
    expect(before?.size).toBe('hello fs-k8s'.length)
    const v1 = before?.version
    await fs.writeText(t(podRoot + '/a.txt'), 'longer content here')
    const after = await fs.stat(t(podRoot + '/a.txt'))
    expect(after?.version).not.toBe(v1)
  })

  it('resolve + processPath translate host<->pod', async () => {
    const target = await fs.resolve(hostRoot + '/src/x.ts')
    expect(fs.processPath(target)).toBe(podRoot + '/src/x.ts')
    expect(fs.fileUrl(target)).toBe('file://' + podRoot + '/src/x.ts')
    expect(fs.contains(await fs.resolve(hostRoot), target)).toBe(true)
    expect(fs.contains(target, await fs.resolve(hostRoot))).toBe(false)
  })

  it('resolve rejects escape outside workspace root', async () => {
    await expect(fs.resolve('/etc/passwd')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('readText of missing file maps to FS_NOT_FOUND', async () => {
    await expect(fs.readText(t(podRoot + '/nope.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('listDir returns entries with child targets', async () => {
    await fs.writeText(t(podRoot + '/dir/one.txt'), '1')
    const entries = await fs.listDir(t(podRoot + '/dir'))
    expect(entries.map((e) => e.name)).toContain('one.txt')
    const child = entries.find((e) => e.name === 'one.txt')
    expect(child?.target.targetKey).toBe(`dsh-k8s:${podRoot}/dir/one.txt`)
  })

  it('writeText createIfAbsent conflicts on existing', async () => {
    await fs.writeText(t(podRoot + '/c.txt'), 'first')
    await expect(fs.writeText(t(podRoot + '/c.txt'), 'second', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('editText replaces literal and enforces version', async () => {
    const target = t(podRoot + '/e.txt')
    const out = await fs.writeText(target, 'foo bar foo')
    const edited = await fs.editText(target, { oldString: 'bar', newString: 'BAZ', replaceAll: false }, { version: out.version })
    expect(await fs.readText(target)).toBe('foo BAZ foo')
    await expect(fs.editText(target, { oldString: 'BAZ', newString: 'x', replaceAll: false }, { version: out.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('editText reports ambiguity', async () => {
    const target = t(podRoot + '/amb.txt')
    await fs.writeText(target, 'a a a')
    await expect(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })

  it('rejects binary content on readText', async () => {
    const target = t(podRoot + '/bin.dat')
    await fs.writeText(target, 'text') // placeholder overwrite below via daemon bytes
    const client = new (await import('../src/client.ts')).DaemonFilesClient(daemonUrl)
    await client.write(podRoot + '/bin.dat', new Uint8Array([0, 1, 2, 255]))
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })
})

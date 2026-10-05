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

// The DEPLOYMENT layout: the logical host root is /workspaces, the pod root is
// /workspaces, and one workspace lives at /workspaces/<id>. The daemon's file
// root is that same directory (DAEMON_ROOT=/workspaces/<id>), so its API is
// addressed RELATIVE to it — the provider's translation job.
const hostRoot = '/workspaces'
const podRoot = '/workspaces'
const WORKSPACE = 'test-ws'
/** Pod-side path of the workspace directory: the PVC mount == the daemon root. */
const wsRoot = `${podRoot}/${WORKSPACE}`

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

/**
 * A target for a workspace-relative path (`t('/a.txt')`), the shape the harness
 * resolver produces for `/workspaces/<id>/a.txt`.
 */
const t = (rel: string) => ({
  targetKey: `dsh-k8s:${wsRoot}${rel}` as any,
  displayPath: `${hostRoot}/${WORKSPACE}${rel}`,
})

/** The daemon-side path of the same file: what the file API must be given. */
const d = (rel: string) => rel

describe('FsK8s', () => {
  it('writeText + readText round trip', async () => {
    const out = await fs.writeText(t('/a.txt'), 'hello fs-k8s')
    expect(out.operation).toBe('create')
    const text = await fs.readText(t('/a.txt'))
    expect(text).toBe('hello fs-k8s')
  })

  it('stat reports size and version changes after write', async () => {
    const before = await fs.stat(t('/a.txt'))
    expect(before?.size).toBe('hello fs-k8s'.length)
    const v1 = before?.version
    await fs.writeText(t('/a.txt'), 'longer content here')
    const after = await fs.stat(t('/a.txt'))
    expect(after?.version).not.toBe(v1)
  })

  it('resolve + processPath translate host<->pod', async () => {
    const target = await fs.resolve(`${hostRoot}/${WORKSPACE}/src/x.ts`)
    expect(fs.processPath(target)).toBe(`${wsRoot}/src/x.ts`)
    expect(fs.fileUrl(target)).toBe('file://' + wsRoot + '/src/x.ts')
    expect(fs.contains(await fs.resolve(`${hostRoot}/${WORKSPACE}`), target)).toBe(true)
    expect(fs.contains(target, await fs.resolve(`${hostRoot}/${WORKSPACE}`))).toBe(false)
  })

  it('resolve rejects escape outside workspace root', async () => {
    await expect(fs.resolve('/etc/passwd')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  })

  it('readText of missing file maps to FS_NOT_FOUND', async () => {
    await expect(fs.readText(t('/nope.txt'))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('listDir returns entries with child targets', async () => {
    await fs.writeText(t('/dir/one.txt'), '1')
    const entries = await fs.listDir(t('/dir'))
    expect(entries.map((e) => e.name)).toContain('one.txt')
    const child = entries.find((e) => e.name === 'one.txt')
    expect(child?.target.targetKey).toBe(`dsh-k8s:${wsRoot}/dir/one.txt`)
  })

  it('writeText createIfAbsent conflicts on existing', async () => {
    await fs.writeText(t('/c.txt'), 'first')
    await expect(fs.writeText(t('/c.txt'), 'second', { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })

  it('editText replaces literal and enforces version', async () => {
    const target = t('/e.txt')
    const out = await fs.writeText(target, 'foo bar foo')
    const edited = await fs.editText(target, { oldString: 'bar', newString: 'BAZ', replaceAll: false }, { version: out.version })
    expect(await fs.readText(target)).toBe('foo BAZ foo')
    await expect(fs.editText(target, { oldString: 'BAZ', newString: 'x', replaceAll: false }, { version: out.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('editText reports ambiguity', async () => {
    const target = t('/amb.txt')
    await fs.writeText(target, 'a a a')
    await expect(fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }))
      .rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
  })

  it('rejects binary content on readText', async () => {
    const target = t('/bin.dat')
    await fs.writeText(target, 'text') // placeholder overwrite below via daemon bytes
    const client = new (await import('../src/client.ts')).DaemonFilesClient(daemonUrl)
    await client.write(d('/bin.dat'), new Uint8Array([0, 1, 2, 255]))
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  // DSH 0.1.5 added `readByteRange` to the fs seam; dsh-api-workspace-files
  // calls it for every workspace file window/download, so its exact window
  // semantics (inclusive start, shorter at EOF, empty past EOF) are contract.
  describe('readByteRange (DSH 0.1.5 seam member)', () => {
    const dec = (b: Uint8Array) => new TextDecoder().decode(b)

    it('returns the requested window', async () => {
      const target = t('/range.txt')
      await fs.writeText(target, '0123456789')
      expect(dec(await fs.readByteRange(target, { offset: 2, length: 4 }))).toBe('2345')
    })

    it('returns a short window when the file ends inside it', async () => {
      const target = t('/range-eof.txt')
      await fs.writeText(target, 'abcdef')
      expect(dec(await fs.readByteRange(target, { offset: 4, length: 10 }))).toBe('ef')
    })

    it('returns empty (not an error) when the offset is at or past EOF', async () => {
      const target = t('/range-past.txt')
      await fs.writeText(target, 'abc')
      expect((await fs.readByteRange(target, { offset: 3, length: 5 })).byteLength).toBe(0)
      expect((await fs.readByteRange(target, { offset: 99, length: 5 })).byteLength).toBe(0)
    })

    it('never buffers more than the window for a large file', async () => {
      const target = t('/range-big.bin')
      const client = new (await import('../src/client.ts')).DaemonFilesClient(daemonUrl)
      const big = new Uint8Array(1024 * 1024).map((_, i) => i % 251)
      await client.write(d('/range-big.bin'), big)
      const window = await fs.readByteRange(target, { offset: 1024 * 512, length: 16 })
      expect(window.byteLength).toBe(16)
      expect([...window]).toEqual([...big.subarray(1024 * 512, 1024 * 512 + 16)])
    })
  })

  it('readBytes fails FS_TOO_LARGE on the bytes read, not a prior stat', async () => {
    const target = t('/too-big.txt')
    await fs.writeText(target, 'x'.repeat(64))
    expect((await fs.readBytes(target, undefined, 64)).byteLength).toBe(64)
    await expect(fs.readBytes(target, undefined, 63)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  // The seam documents stat as target-shaped (follows links) and lstat as
  // path-shaped (does not); the two must stay distinguishable.
  it('stat follows a symlink while lstat reports the link itself', async () => {
    const { symlink } = await import('node:fs/promises')
    await fs.writeText(t('/link-target.txt'), 'linked')
    // The daemon's file root is the workspace directory itself, so the link
    // lives directly in it and resolves against a sibling created the same way.
    await symlink('link-target.txt', join(root, 'link.txt'))
    const stat = await fs.stat(t('/link.txt'))
    const lstat = await fs.lstat(`${hostRoot}/${WORKSPACE}/link.txt`)
    expect(stat?.type).toBe('file')
    expect(stat?.size).toBe('linked'.length)
    expect(lstat?.type).toBe('symlink')
    expect(await fs.readText(t('/link.txt'))).toBe('linked')
  })

  it('addresses the daemon root as the workspace root', async () => {
    // The provider must never hand the daemon the pod path: the daemon resolves
    // it under its own root, so `/workspaces/<id>/x` would mean
    // <root>/workspaces/<id>/x. A file written through the provider lands in
    // the workspace directory, next to what the pod's own shell sees.
    await fs.writeText(t('/at-root.txt'), 'root-relative')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(root, 'at-root.txt'), 'utf8')).toBe('root-relative')
    const info = await fs.stat(t('/at-root.txt'))
    expect(info?.size).toBe('root-relative'.length)
  })
})

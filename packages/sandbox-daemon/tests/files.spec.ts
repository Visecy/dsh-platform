import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilesService, FilesError } from '../src/files.ts'

let root: string
let svc: FilesService

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-files-'))
  svc = new FilesService(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('FilesService', () => {
  it('write + read round-trips text and binary', async () => {
    const p = '/hello.txt'
    const out = await svc.write(p, enc('hello world'))
    expect(out.operation).toBe('create')
    expect(dec(await svc.read(p))).toBe('hello world')

    const bin = new Uint8Array([0, 1, 2, 255, 254])
    await svc.write('/bin.dat', bin)
    expect(Array.from(await svc.read('/bin.dat'))).toEqual(Array.from(bin))
  })

  it('createIfAbsent refuses existing paths', async () => {
    await svc.write('/a.txt', enc('x'))
    await expect(svc.write('/a.txt', enc('y'), { kind: 'createIfAbsent' }))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('replaceIfVersion accepts matching version and rejects stale', async () => {
    const first = await svc.write('/v.txt', enc('v1'))
    const stale = first.version
    const second = await svc.write('/v.txt', enc('v2'), { kind: 'replaceIfVersion', version: stale })
    expect(second.operation).toBe('replace')
    expect(second.version).not.toBe(stale)
    expect(dec(await svc.read('/v.txt'))).toBe('v2')

    await expect(svc.write('/v.txt', enc('v3'), { kind: 'replaceIfVersion', version: stale }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('read of missing file reports NOT_FOUND', async () => {
    await expect(svc.read('/nope.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('list/mkdir/info/remove/rename work', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'f.txt'), 'x')
    await svc.mkdir('/sub2', { recursive: true })

    const entries = await svc.list('/')
    expect(entries.some((e) => e.name === 'sub')).toBe(true)
    expect(entries.some((e) => e.name === 'sub2')).toBe(true)

    const info = await svc.info('/sub/f.txt')
    expect(info?.type).toBe('file')
    expect(info?.size).toBe(1)

    await svc.rename('/sub/f.txt', '/sub/g.txt')
    expect(dec(await svc.read('/sub/g.txt'))).toBe('x')
    await expect(svc.read('/sub/f.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await svc.remove('/sub/g.txt')
    await expect(svc.read('/sub/g.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects path traversal outside root', async () => {
    await expect(svc.read('/../etc/passwd')).rejects.toMatchObject({ code: 'OUT_OF_ROOT' })
    await expect(svc.write('/a/../../b', enc('x'))).rejects.toMatchObject({ code: 'OUT_OF_ROOT' })
  })

  it('serializes concurrent writes to the same path (per-target lock)', async () => {
    const results = await Promise.allSettled([
      svc.write('/c.txt', enc('a'), { kind: 'createIfAbsent' }),
      svc.write('/c.txt', enc('b'), { kind: 'createIfAbsent' }),
    ])
    const created = results.filter(
      (r): r is PromiseFulfilledResult<WriteOutcome> => r.status === 'fulfilled' && r.value.operation === 'create',
    )
    expect(created).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ALREADY_EXISTS' })
    const content = dec(await svc.read('/c.txt'))
    expect(['a', 'b']).toContain(content)
  })

  it('version changes after writes and reflects content', async () => {
    const v1 = await svc.write('/s.txt', enc('one'))
    const info1 = await svc.info('/s.txt')
    expect(info1?.size).toBe(3)
    const v2 = await svc.write('/s.txt', enc('two'), { kind: 'replaceIfVersion', version: v1.version })
    expect(v2.version).not.toBe(v1.version)
  })
})

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PtyRegistry } from '../src/pty.js'

let root: string
let reg: PtyRegistry

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-pty-'))
  reg = new PtyRegistry({ runtimeRoot: root })
})

afterEach(async () => {
  await reg.dispose()
  await rm(root, { recursive: true, force: true })
})

const readAll = async (ptyId: string, ms = 1500): Promise<string> => {
  const deadline = Date.now() + ms
  let last = ''
  while (Date.now() < deadline) {
    const out = await reg.readOutput(ptyId, { from: 0 })
    last = out.frames
    if (last.includes('READY')) break
    await new Promise((res) => setTimeout(res, 50))
  }
  // decode frames and concatenate
  const lines = last.trim().split('\n').filter(Boolean)
  return lines.map((l) => Buffer.from(l, 'base64').toString()).join('')
}

describe('PtyRegistry', () => {
  it('spawns a shell and echoes input', async () => {
    const pty = await reg.create({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: root, rows: 24, cols: 80 })
    expect(pty.pid).toBeGreaterThan(0)
    reg.write(pty.ptyId, 'echo pty-echo-ok\n')
    const out = await readAll(pty.ptyId)
    expect(out).toContain('pty-echo-ok')
  })

  it('captures output in frame files readable by offset', async () => {
    const pty = await reg.create({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: root, rows: 24, cols: 80 })
    reg.write(pty.ptyId, 'printf SEG1\n')
    await new Promise((res) => setTimeout(res, 300))
    const first = await reg.readOutput(pty.ptyId, { from: 0 })
    expect(first.nextOffset).toBeGreaterThan(0)
    reg.write(pty.ptyId, 'printf SEG2\n')
    await new Promise((res) => setTimeout(res, 300))
    const second = await reg.readOutput(pty.ptyId, { from: first.nextOffset })
    const decoded = (second.frames.trim().split('\n').filter(Boolean)).map((l) => Buffer.from(l, 'base64').toString()).join('')
    expect(decoded).toContain('SEG2')
  })

  it('resizes the terminal', async () => {
    const pty = await reg.create({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: root, rows: 24, cols: 80 })
    reg.resize(pty.ptyId, 40, 120) // should not throw
    expect(reg.status(pty.ptyId)).toBe('running')
  })

  it('terminates and cleans up the shell process group', async () => {
    const pty = await reg.create({ argv: ['bash', '--noprofile', '--norc', '-i'], cwd: root, rows: 24, cols: 80 })
    await reg.terminate(pty.ptyId, { graceMs: 300 })
    // SIGTERM may let the shell exit gracefully ('exited') or escalate to SIGKILL ('killed')
    expect(['killed', 'exited']).toContain(reg.status(pty.ptyId))
  })
})

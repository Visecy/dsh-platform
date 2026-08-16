import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CommandRegistry } from '../src/commands.ts'
import { scrubEnv } from '../src/env.ts'

let root: string
let reg: CommandRegistry

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-cmd-'))
  reg = new CommandRegistry({ runtimeRoot: root, defaultGraceMs: 500 })
})

afterEach(async () => {
  await reg.dispose()
  await rm(root, { recursive: true, force: true })
})

const waitExit = async (cmdId: string, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await reg.status(cmdId)
    if (st?.phase === 'exited' || st?.phase === 'killed') return
    await new Promise((res) => setTimeout(res, 25))
  }
  throw new Error('command did not exit in time')
}

describe('CommandRegistry', () => {
  it('runs a command to completion with exit code', async () => {
    const info = await reg.run({ argv: ['sh', '-c', 'exit 7'], cwd: root })
    await waitExit(info.cmdId)
    const st = await reg.status(info.cmdId)
    expect(st?.phase).toBe('exited')
    expect(st?.exitCode).toBe(7)
  })

  it('captures stdout frames readable by offset', async () => {
    const info = await reg.run({ argv: ['sh', '-c', 'echo hello; echo world'], cwd: root })
    await waitExit(info.cmdId)
    const out = await reg.readOutput(info.cmdId, { stream: 'stdout', from: 0 })
    // each line is one base64 frame (a data chunk, not a text line); decode and concatenate
    const lines = out.frames.trim().split('\n').filter(Boolean)
    const decoded = lines.map((l) => Buffer.from(l, 'base64').toString()).join('')
    expect(decoded).toBe('hello\nworld\n')
    expect(out.nextOffset).toBe(out.frames.length)
  })

  it('feeds stdin to a command', async () => {
    const info = await reg.run({ argv: ['cat'], cwd: root })
    await new Promise((res) => setTimeout(res, 100))
    await reg.writeStdin(info.cmdId, new TextEncoder().encode('ping'))
    await reg.closeStdin(info.cmdId)
    await waitExit(info.cmdId)
    const out = await reg.readOutput(info.cmdId, { stream: 'stdout', from: 0 })
    const decoded = out.frames.trim().split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64').toString()).join('')
    expect(decoded).toBe('ping')
  })

  it('kills a running command via its process group', async () => {
    const info = await reg.run({ argv: ['sleep', '30'], cwd: root })
    await new Promise((res) => setTimeout(res, 150))
    await reg.kill(info.cmdId, { graceMs: 200 })
    const st = await reg.status(info.cmdId)
    expect(['exited', 'killed']).toContain(st?.phase)
  })

  it('enforces timeoutMs (deadline) by force-killing', async () => {
    const info = await reg.run({ argv: ['sleep', '30'], cwd: root, timeoutMs: 300 })
    const deadline = Date.now() + 6000
    let st = await reg.status(info.cmdId)
    while (Date.now() < deadline && (st?.phase === 'starting' || st?.phase === 'running')) {
      await new Promise((res) => setTimeout(res, 25))
      st = await reg.status(info.cmdId)
    }
    expect(st?.phase).toBe('killed')
    expect(st?.reason).toBe('timeout')
  })

  it('scrubs sensitive env vars from child processes', () => {
    const scrubbed = scrubEnv({
      NPM_TOKEN: 'secret1',
      DB_PASSWORD: 'secret2',
      DSH_HOME: '/tmp/dsh',
      PATH: '/usr/bin',
      SAFE: 'yes',
    })
    expect(scrubbed.NPM_TOKEN).toBeUndefined()
    expect(scrubbed.DB_PASSWORD).toBeUndefined()
    expect(scrubbed.DSH_HOME).toBeUndefined()
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.SAFE).toBe('yes')
  })

  it('only injects explicitly allowed env into the child', async () => {
    const info = await reg.run({
      argv: ['sh', '-c', 'echo \"$PLATFORM_CRED\"'],
      cwd: root,
      env: { PLATFORM_CRED: 'injected', NPM_TOKEN: 'should-not-leak' },
    })
    await waitExit(info.cmdId)
    const out = await reg.readOutput(info.cmdId, { stream: 'stdout', from: 0 })
    const decoded = out.frames.trim().split('\n').filter(Boolean).map((l) => Buffer.from(l, 'base64').toString()).join('')
    expect(decoded).toBe('injected\n')
  })
})

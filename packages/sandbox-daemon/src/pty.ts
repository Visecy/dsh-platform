/**
 * PtyRegistry: persistent PTY shells inside the sandbox.
 * Each PTY is a node-pty session whose output is base64-framed into an
 * append-only frame file (offset-readable, mirroring command output).
 * Termination kills the whole shell session.
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as nodePty from 'node-pty'
import type { PtySpec } from './protocol.ts'
import { encodeFrame } from './framing.ts'

export type PtyPhase = 'running' | 'killed' | 'exited'

export interface PtyInfo {
  ptyId: string
  pid: number
  phase: PtyPhase
  startedAt: number
}

interface Record {
  ptyId: string
  spec: PtySpec
  pid: number
  phase: PtyPhase
  frameFile: string
  stream: WriteStream
  proc: nodePty.IPty
  startedAt: number
}

export class PtyRegistry {
  private records = new Map<string, Record>()
  readonly opts: { runtimeRoot: string }
  constructor(opts: { runtimeRoot: string }) {
    this.opts = opts
  }

  async create(spec: PtySpec): Promise<PtyInfo> {
    const ptyId = randomUUID()
    const dir = join(this.opts.runtimeRoot, 'ptys', ptyId)
    await mkdir(dir, { recursive: true })
    const frameFile = join(dir, 'output.frames')
    const stream = createWriteStream(frameFile)

    const proc = nodePty.spawn(spec.argv[0], spec.argv.slice(1), {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env } as Record<string, string>,
    })
    proc.onData((data) => {
      stream.write(encodeFrame(new TextEncoder().encode(data)))
    })
    proc.onExit(() => {
      stream.end()
      const rec = this.records.get(ptyId)
      if (rec !== undefined && rec.phase === 'running') rec.phase = 'exited'
    })

    const record: Record = {
      ptyId,
      spec,
      pid: proc.pid,
      phase: 'running',
      frameFile,
      stream,
      proc,
      startedAt: Date.now(),
    }
    this.records.set(ptyId, record)
    return { ptyId, pid: proc.pid, phase: 'running', startedAt: record.startedAt }
  }

  write(ptyId: string, data: string): void {
    const rec = this.records.get(ptyId)
    if (rec === undefined) throw new Error('unknown pty')
    rec.proc.write(data)
  }

  resize(ptyId: string, rows: number, cols: number): void {
    const rec = this.records.get(ptyId)
    if (rec === undefined) throw new Error('unknown pty')
    rec.proc.resize(cols, rows)
  }

  signal(ptyId: string, sig: string): void {
    const rec = this.records.get(ptyId)
    if (rec === undefined) throw new Error('unknown pty')
    rec.proc.kill(sig)
  }

  async readOutput(ptyId: string, opts: { from: number }): Promise<{ frames: string; nextOffset: number }> {
    const rec = this.records.get(ptyId)
    if (rec === undefined) throw new Error('unknown pty')
    let buf: Buffer
    try {
      buf = await readFile(rec.frameFile)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { frames: '', nextOffset: 0 }
      throw e
    }
    const from = Math.min(opts.from, buf.length)
    return { frames: buf.subarray(from).toString('utf8'), nextOffset: buf.length }
  }

  status(ptyId: string): PtyPhase | undefined {
    return this.records.get(ptyId)?.phase
  }

  async terminate(ptyId: string, opts?: { graceMs?: number }): Promise<PtyInfo> {
    const rec = this.records.get(ptyId)
    if (rec === undefined) throw new Error('unknown pty')
    if (rec.phase !== 'running') return { ptyId, pid: rec.pid, phase: rec.phase, startedAt: rec.startedAt }
    try {
      rec.proc.kill('SIGTERM')
    } catch {
      // already dead
    }
    const deadline = Date.now() + (opts?.graceMs ?? 500)
    while (Date.now() < deadline && rec.phase === 'running') {
      await new Promise((res) => setTimeout(res, 25))
    }
    if (rec.phase === 'running') {
      try {
        rec.proc.kill('SIGKILL')
      } catch {
        // ignore
      }
      rec.phase = 'killed'
    }
    return { ptyId, pid: rec.pid, phase: rec.phase, startedAt: rec.startedAt }
  }

  list(): PtyInfo[] {
    return [...this.records.values()].map((r) => ({ ptyId: r.ptyId, pid: r.pid, phase: r.phase, startedAt: r.startedAt }))
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.terminate(id, { graceMs: 200 }).catch(() => undefined)))
    for (const rec of this.records.values()) rec.stream.destroy()
    this.records.clear()
  }
}

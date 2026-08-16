/**
 * CommandRegistry: background commands in isolated process groups with
 * framed output files (offset-readable), stdin plumbing, kill ladder,
 * optional deadlines, and per-command status published to disk.
 */
import { mkdir, writeFile, appendFile, readFile, rm, readdir } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CommandSpec, CommandHandleInfo, CommandExit } from './protocol.ts'
import { encodeFrame } from './framing.ts'
import { scrubEnv, mergeEnv } from './env.ts'
import { launchGroup, readGroupExit, terminateGroup, groupAlive } from './process-groups.ts'

export type CommandPhase = 'starting' | 'running' | 'exited' | 'killed'

export interface CommandStatus {
  cmdId: string
  phase: CommandPhase
  pid: number
  pgid: number
  exitCode?: number | null
  signal?: string | null
  reason?: 'timeout' | 'kill'
  startedAt: number
  endedAt?: number
}

interface Record {
  cmdId: string
  sessionId?: string
  spec: CommandSpec
  status: CommandStatus
  dir: string
  groupDir: string
  stdoutFile: string
  stderrFile: string
  stdoutStream: WriteStream
  stderrStream: WriteStream
  stdinStream?: NodeJS.WritableStream
  deadline?: number
  graceMs: number
  killed: boolean
}

export class CommandRegistry {
  private records = new Map<string, Record>()
  private timer?: NodeJS.Timeout
  readonly opts: { runtimeRoot: string; defaultGraceMs: number; pollMs?: number }
  constructor(opts: { runtimeRoot: string; defaultGraceMs: number; pollMs?: number }) {
    this.opts = opts
    this.timer = setInterval(() => this.scan(), opts.pollMs ?? 200)
    this.timer.unref()
  }

  async run(spec: CommandSpec): Promise<CommandHandleInfo> {
    const cmdId = randomUUID()
    const dir = join(this.opts.runtimeRoot, 'commands', cmdId)
    await mkdir(dir, { recursive: true })
    const stdoutFile = join(dir, 'stdout.frames')
    const stderrFile = join(dir, 'stderr.frames')
    const stdoutStream = createWriteStream(stdoutFile)
    const stderrStream = createWriteStream(stderrFile)

    const env = mergeEnv(scrubEnv(process.env as Record<string, string>), spec.env)
    const record: Record = {
      cmdId,
      sessionId: spec.sessionId,
      spec,
      status: { cmdId, phase: 'starting', pid: -1, pgid: -1, startedAt: Date.now() },
      dir,
      stdoutFile,
      stderrFile,
      stdoutStream,
      stderrStream,
      graceMs: this.opts.defaultGraceMs,
      deadline: spec.timeoutMs !== undefined ? Date.now() + spec.timeoutMs : undefined,
      killed: false,
    }
    this.records.set(cmdId, record)

    try {
      const group = await launchGroup({
        cmdId,
        argv: spec.argv,
        cwd: spec.cwd,
        env,
        runtimeRoot: this.opts.runtimeRoot,
        stdout: stdoutStream,
        stderr: stderrStream,
      })
      record.status.pid = group.pid
      record.status.pgid = group.pgid
      record.status.phase = 'running'
      record.groupDir = group.dir
      record.stdinStream = group.stdin
      if (spec.stdin !== undefined) {
        group.stdin.write(Buffer.from(spec.stdin))
        group.stdin.end()
      }
      return { cmdId, pid: group.pid, pgid: group.pgid }
    } catch (e) {
      this.records.delete(cmdId)
      stdoutStream.destroy()
      stderrStream.destroy()
      await rm(dir, { recursive: true, force: true })
      throw e
    }
  }

  async status(cmdId: string): Promise<CommandStatus | undefined> {
    const rec = this.records.get(cmdId)
    if (rec === undefined) return undefined
    const exit = await readGroupExit(rec.groupDir)
    if (exit !== undefined && rec.status.phase !== 'killed') {
      rec.status.phase = 'exited'
      rec.status.exitCode = exit.exitCode
      rec.status.signal = exit.signal
      rec.status.endedAt = exit.at
    }
    return { ...rec.status }
  }

  async readOutput(cmdId: string, opts: { stream: 'stdout' | 'stderr'; from: number }): Promise<{ frames: string; nextOffset: number }> {
    const rec = this.records.get(cmdId)
    if (rec === undefined) throw new Error('unknown command')
    const file = opts.stream === 'stdout' ? rec.stdoutFile : rec.stderrFile
    const buf = await readFile(file)
    const from = Math.min(opts.from, buf.length)
    const slice = buf.subarray(from)
    return { frames: slice.toString('utf8'), nextOffset: buf.length }
  }

  async writeStdin(cmdId: string, data: Uint8Array): Promise<void> {
    const rec = this.records.get(cmdId)
    if (rec === undefined) throw new Error('unknown command')
    rec.stdinStream?.write(Buffer.from(data))
  }

  async closeStdin(cmdId: string): Promise<void> {
    const rec = this.records.get(cmdId)
    if (rec === undefined) return
    rec.stdinStream?.end()
  }

  async kill(cmdId: string, opts?: { graceMs?: number }): Promise<CommandStatus> {
    const rec = this.records.get(cmdId)
    if (rec === undefined) throw new Error('unknown command')
    if (rec.status.phase === 'exited' || rec.status.phase === 'killed') return { ...rec.status }
    rec.killed = true
    rec.status.reason = 'kill'
    const grace = opts?.graceMs ?? rec.graceMs
    await terminateGroup(rec.status.pgid, grace)
    rec.status.phase = 'killed'
    rec.status.endedAt = Date.now()
    return { ...rec.status }
  }

  list(): CommandStatus[] {
    return [...this.records.values()].map((r) => ({ ...r.status }))
  }

  /** Force-terminate every live command (workspace-wide grace expiry). */
  async killAll(graceMs = 2000): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.kill(id, { graceMs }).catch(() => undefined)))
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await Promise.all([...this.records.keys()].map((id) => this.kill(id, { graceMs: 200 }).catch(() => undefined)))
    for (const rec of this.records.values()) {
      rec.stdoutStream.destroy()
      rec.stderrStream.destroy()
    }
    this.records.clear()
  }

  private scan(): void {
    const now = Date.now()
    for (const rec of this.records.values()) {
      if (rec.deadline !== undefined && now > rec.deadline && (rec.status.phase === 'running' || rec.status.phase === 'starting')) {
        rec.status.reason = 'timeout'
        rec.killed = true
        terminateGroup(rec.status.pgid, 200).then((ok) => {
          rec.status.phase = 'killed'
          rec.status.endedAt = Date.now()
        })
      }
    }
  }
}

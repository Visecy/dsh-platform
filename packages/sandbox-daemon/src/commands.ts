/**
 * CommandRegistry: background commands in isolated process groups with
 * framed output files (offset-readable), stdin plumbing, kill ladder,
 * optional deadlines, and per-command status published to disk.
 */
import { mkdir, writeFile, appendFile, readFile, rm, readdir, stat } from 'node:fs/promises'
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

interface CommandRecord {
  cmdId: string
  sessionId?: string
  spec: CommandSpec
  status: CommandStatus
  dir: string
  /**
   * Set once the process group has launched. Optional because the record is
   * registered before `launchGroup` resolves, so a concurrent `status()` /
   * `rangeStatus()` can observe a record without a group directory.
   */
  groupDir?: string
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
  private records = new Map<string, CommandRecord>()
  private timer?: NodeJS.Timeout
  private accepting = true
  readonly opts: { runtimeRoot: string; defaultGraceMs: number; pollMs?: number }
  constructor(opts: { runtimeRoot: string; defaultGraceMs: number; pollMs?: number }) {
    this.opts = opts
    this.timer = setInterval(() => this.scan(), opts.pollMs ?? 200)
    this.timer.unref()
  }

  async run(spec: CommandSpec): Promise<CommandHandleInfo> {
    if (!this.accepting) throw new Error('command acceptance disabled (draining)')
    if (spec.cwd !== '') {
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(spec.cwd)
      } catch {
        throw new Error(`cwd does not exist: ${spec.cwd}`)
      }
      if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${spec.cwd}`)
    }
    const cmdId = randomUUID()
    const dir = join(this.opts.runtimeRoot, 'commands', cmdId)
    await mkdir(dir, { recursive: true })
    const stdoutFile = join(dir, 'stdout.frames')
    const stderrFile = join(dir, 'stderr.frames')
    const stdoutStream = createWriteStream(stdoutFile)
    const stderrStream = createWriteStream(stderrFile)

    const env = mergeEnv(scrubEnv(process.env as Record<string, string>), spec.env)
    const record: CommandRecord = {
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
    // No group dir yet: the command is still in `starting` (or its launch
    // threw) and has no exit record to read.
    if (rec.groupDir === undefined) return { ...rec.status }
    const exit = await readGroupExit(rec.groupDir)
    if (exit !== undefined && rec.status.phase !== 'killed') {
      rec.status.phase = 'exited'
      rec.status.exitCode = exit.exitCode
      rec.status.signal = exit.signal
      rec.status.endedAt = exit.at
    }
    return { ...rec.status }
  }

  /**
   * Managed-range quiescence probe. `groupAlive` deliberately counts zombies
   * as gone, so this reports whether any RUNNING process still belongs to the
   * command's process group — including backgrounded grandchildren that
   * outlive the direct child. Unknown commands report `{ alive: false }` so a
   * provider polling a reaped command converges instead of spinning.
   */
  rangeStatus(cmdId: string): { alive: boolean; pgid?: number } {
    const rec = this.records.get(cmdId)
    if (rec === undefined || rec.groupDir === undefined) return { alive: false }
    return { alive: groupAlive(rec.status.pgid), pgid: rec.status.pgid }
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

  /** Stop accepting new commands, then force-terminate every live command. */
  async drain(graceMs = 2000): Promise<void> {
    this.accepting = false
    await this.killAll(graceMs)
  }

  /** Force-terminate every live command (workspace-wide grace expiry). */
  async killAll(graceMs = 2000): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.kill(id, { graceMs }).catch(() => undefined)))
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.accepting = false
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
        // A record is registered before launchGroup publishes its pgid; a
        // zero/negative group id must NEVER reach terminateGroup, whose
        // `kill(-pgid)` would otherwise address PID 1 (the container's init,
        // usually this very process).
        if (!(rec.status.pgid > 0)) continue
        rec.status.reason = 'timeout'
        rec.killed = true
        // Publish the phase synchronously: the kill decision is what status
        // reports, and a concurrent status() reading exit.json would otherwise
        // race the async termination and publish 'exited' for a killed command.
        rec.status.phase = 'killed'
        rec.status.endedAt = now
        void terminateGroup(rec.status.pgid, 200)
      }
    }
  }
}

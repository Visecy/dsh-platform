/**
 * dsh-subprocess-k8s: ctx.subprocess provider routing command/pty execution
 * to a workspace pod's sandbox daemon.
 */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessCollectedOutputs, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec, type SubprocessTerminalForeground, type SubprocessTerminalHandle, type SubprocessTerminalSignal, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Writable, Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonSubprocessClient } from './client.ts'
import { CollectPoller, CollectReader, makePipe } from './output.ts'

export const name = '@visecy/dsh-subprocess-k8s'

export interface Config {
  daemonEndpoint: string
}

export class SubprocessK8s extends SubprocessRuntime {
  private client: DaemonSubprocessClient
  private spillDir: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.client = new DaemonSubprocessClient(config.daemonEndpoint)
    this.spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-k8s-'))
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.client.resolveExecutable(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = new RemoteHandle(this.client, spec, this.spillDir)
    void handle.start()
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const created = await this.client.createPty({ argv: spec.argv, cwd: spec.cwd, env: spec.env, rows: spec.rows, cols: spec.cols })
    return new RemoteTerminalHandle(this.client, created.ptyId, created.pid, spec)
  }
}

class RemoteHandle implements SubprocessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs = {}
  readonly done: Promise<SubprocessOutcome>
  private cmdId: string
  private resolveDone!: (o: SubprocessOutcome) => void
  private pollers: Array<{ stop(): void }> = []
  private terminated = false

  constructor(
    private client: DaemonSubprocessClient,
    private spec: SubprocessSpawnSpec,
    spillDir: string,
  ) {
    this.pid = -1
    this.cmdId = ''
    this.done = new Promise((res) => {
      this.resolveDone = res
    })

    if (spec.stdio.stdin === 'pipe') {
      this.stdin = new Writable({
        write: (chunk, _enc, cb) => {
          this.client.writeStdin(this.cmdId, new Uint8Array(chunk)).then(() => cb(), (e) => cb(e))
        },
        final: (cb) => {
          this.client.closeStdin(this.cmdId).then(() => cb(), (e) => cb(e))
        },
      })
    }

    const mkCollect = (stream: 'stdout' | 'stderr'): CollectReader | undefined => {
      const mode = stream === 'stdout' ? spec.stdio.stdout : spec.stdio.stderr
      if (typeof mode !== 'object') return undefined
      const reader = new CollectReader(mode, spillDir)
      const poller = new CollectPoller(
        { read: (from) => this.client.readOutput(this.cmdId, stream, from) },
        reader,
        () => undefined,
      )
      poller.start()
      this.pollers.push(poller)
      return reader
    }

    this.collected.stdout = mkCollect('stdout')
    this.collected.stderr = mkCollect('stderr')
  }

  async start(): Promise<void> {
    try {
      const stdinData = this.spec.stdio.stdin !== 'ignore' && this.spec.stdio.stdin !== 'pipe'
        ? new TextEncoder().encode(this.spec.stdio.stdin.data)
        : undefined
      const info = await this.client.run({
        argv: this.spec.argv,
        cwd: this.spec.cwd,
        env: this.spec.env as Record<string, string> | undefined,
        stdin: stdinData,
      })
      ;(this as unknown as { pid: number }).pid = info.pid
      ;(this as unknown as { cmdId: string }).cmdId = info.cmdId

      if (this.spec.stdio.stdout === 'pipe') {
        ;(this as unknown as { stdout: Readable | undefined }).stdout = makePipe(
          { read: (from) => this.client.readOutput(info.cmdId, 'stdout', from) },
          () => undefined,
        )
      }
      if (this.spec.stdio.stderr === 'pipe') {
        ;(this as unknown as { stderr: Readable | undefined }).stderr = makePipe(
          { read: (from) => this.client.readOutput(info.cmdId, 'stderr', from) },
          () => undefined,
        )
      }

      const outcome: SubprocessOutcome = await new Promise((res) => {
        const poll = async (): Promise<void> => {
          const st = await this.client.status(info.cmdId)
          if (st.phase === 'exited' || st.phase === 'killed') {
            res({ exitCode: st.exitCode ?? null, signal: (st.signal as NodeJS.Signals) ?? null })
            return
          }
          setTimeout(() => void poll(), 100)
        }
        void poll()
      })
      for (const p of this.pollers) await p.flush()
      for (const p of this.pollers) p.stop()
      this.resolveDone(outcome)
    } catch {
      for (const p of this.pollers) p.stop()
      this.resolveDone({ exitCode: -1, signal: null })
    }
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    if (this.cmdId !== '') {
      void this.client.kill(this.cmdId, this.spec.graceMs)
    }
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    await this.done
    return true
  }
}

class RemoteTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output: Readable
  readonly done: Promise<SubprocessOutcome>
  private resolveDone!: (o: SubprocessOutcome) => void
  private terminated = false

  constructor(
    private client: DaemonSubprocessClient,
    private ptyId: string,
    pid: number,
    private spec: SubprocessTerminalSpawnSpec,
  ) {
    this.pid = pid
    this.done = new Promise((res) => {
      this.resolveDone = res
    })
    this.output = makePipe({ read: (from) => this.client.ptyOutput(ptyId, from) }, () => undefined)

    const pollExit = async (): Promise<void> => {
      const phase = await this.client.ptyStatus(ptyId)
      if (phase === 'exited' || phase === 'killed' || phase === undefined) {
        this.resolveDone({ exitCode: 0, signal: null })
        return
      }
      setTimeout(() => void pollExit(), 200)
    }
    void pollExit()
  }

  async write(data: string): Promise<void> {
    await this.client.ptyWrite(this.ptyId, data)
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return { processGroupId: this.pid, inputWaiting: false }
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    await this.client.ptySignal(this.ptyId, signal)
    return this.pid
  }

  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    await this.client.ptyTerminate(this.ptyId, this.spec.graceMs)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('subprocess', new SubprocessK8s(ctx, config))
}

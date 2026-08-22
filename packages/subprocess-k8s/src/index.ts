/**
 * dsh-subprocess-k8s: ctx.subprocess provider routing command/pty execution
 * to a workspace pod's sandbox daemon.
 */
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessCollectedOutputs, type SubprocessHandle, type SubprocessOutcome, type SubprocessSpawnSpec, type SubprocessTerminalForeground, type SubprocessTerminalHandle, type SubprocessTerminalSignal, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Writable, Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DaemonSubprocessClient } from './client.ts'
import { CollectPoller, CollectReader, makePipe } from './output.ts'

export const name = '@visecy/dsh-subprocess-k8s'

/** Optional reporter for live workspace command counts (provided by dsh-workspace-k8s). */
export interface CommandActivityTracker {
  commandStarted(workspaceId: string): void
  commandEnded(workspaceId: string): void
}

export interface Config {
  daemonEndpoint: string
  /** Per-call endpoint resolution by workspace id (ensure + getEndpoint). */
  resolveEndpoint?: (workspaceId: string) => Promise<string> | string
  /** Host-side workspace identifier root, e.g. /workspaces/<id>. */
  hostRoot?: string
  /** Pod-side workspace root, default /workspace. */
  podRoot?: string
  /** Live command counter for the workspace lifecycle state machine. */
  commandTracker?: CommandActivityTracker
}

export class SubprocessK8s extends SubprocessRuntime {
  private client: DaemonSubprocessClient
  private spillDir: string
  private resolver: ((workspaceId: string) => Promise<string> | string) | undefined
  private commandTracker: CommandActivityTracker | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.client = new DaemonSubprocessClient(config.daemonEndpoint)
    this.spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-k8s-'))
    this.resolver = config.resolveEndpoint
    this.commandTracker = config.commandTracker
    this.hostRoot = config.hostRoot ?? '/workspaces'
    this.podRoot = config.podRoot ?? '/workspace'
  }

  /** The workspace id from a host path like /workspaces/<id>/... */
  private hostRoot = '/workspaces'
  private podRoot = '/workspace'

  /** The workspace id from a host path like /workspaces/<id>/... */
  private workspaceOf(cwd: string): string | undefined {
    const esc = this.hostRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp('^' + esc + '/([^/]+)').exec(cwd)
    return m?.[1]
  }

  /** Translate a host cwd (/workspaces/<id>/...) to the pod-side path. */
  private toPod(cwd: string): string {
    const hostRoot = this.hostRoot
    if (cwd === hostRoot) return this.podRoot
    if (!cwd.startsWith(hostRoot + '/')) return cwd
    // strip the workspace id segment: /workspaces/<id>/x -> /workspace/x
    const rest = cwd.slice(hostRoot.length + 1)
    const seg = rest.split('/')
    seg.shift()
    const tail = seg.join('/')
    return tail === '' ? this.podRoot : this.podRoot + '/' + tail
  }

  /** Resolve the daemon endpoint for a cwd (per-workspace pod) or the static one. */
  private async endpointFor(cwd: string): Promise<string> {
    const resolver = this.resolver
      ?? (this.ctx.get('workspaceEndpointResolver') as { resolve?: (id: string) => Promise<string> | string } | undefined)?.resolve
    if (resolver === undefined) return this.client.defaultEndpoint
    const ws = this.workspaceOf(cwd)
    if (ws === undefined) return this.client.defaultEndpoint
    return resolver(ws)
  }

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.client.resolveExecutable(command)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // endpoint resolution is async; the handle resolves it before starting.
    // The daemon cwd is the pod-side path; translate the host workspace path.
    const podCwd = this.toPod(spec.cwd)
    const translated: SubprocessSpawnSpec = { ...spec, cwd: podCwd }
    const workspaceId = this.workspaceOf(spec.cwd)
    const handle = new RemoteHandle(
      () => this.endpointFor(spec.cwd).then((ep) => this.client.withEndpoint(ep)),
      translated,
      this.spillDir,
      workspaceId,
      this.commandTracker,
    )
    void handle.start()
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const ep = await this.endpointFor(spec.cwd)
    const bound = this.client.withEndpoint(ep)
    const podCwd = this.toPod(spec.cwd)
    const created = await bound.createPty({ argv: spec.argv, cwd: podCwd, env: spec.env, rows: spec.rows, cols: spec.cols })
    const translated: SubprocessTerminalSpawnSpec = { ...spec, cwd: podCwd }
    return new RemoteTerminalHandle(bound, created.ptyId, created.pid, translated)
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
  private counted = false

  private client: DaemonSubprocessClient

  constructor(
    private clientFactory: () => Promise<DaemonSubprocessClient>,
    private spec: SubprocessSpawnSpec,
    spillDir: string,
    private workspaceId?: string,
    private tracker?: CommandActivityTracker,
  ) {
    this.client = new DaemonSubprocessClient('http://placeholder.invalid:1')
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
      // bind the daemon client to the workspace pod before any call
      this.client = await this.clientFactory()
      const stdinData = this.spec.stdio.stdin !== 'ignore' && this.spec.stdio.stdin !== 'pipe'
        ? new TextEncoder().encode(this.spec.stdio.stdin.data)
        : undefined
      // The fs-search tool passes a control-plane-hosted ripgrep path. That
      // binary is installed in the workspace daemon image at /usr/bin/rg, so
      // translate the absolute host path to the pod-visible executable.
      let argv = this.spec.argv
      const first = argv[0]
      if (typeof first === 'string' && basename(first) === 'rg') {
        const rgPath = await this.client.resolveExecutable('rg')
        argv = [rgPath, ...argv.slice(1)]
      }

      const info = await this.client.run({
        argv,
        cwd: this.spec.cwd,
        env: this.spec.env as Record<string, string> | undefined,
        stdin: stdinData,
      })
      ;(this as unknown as { pid: number }).pid = info.pid
      ;(this as unknown as { cmdId: string }).cmdId = info.cmdId
      if (this.workspaceId !== undefined && this.tracker !== undefined) {
        this.counted = true
        this.tracker.commandStarted(this.workspaceId)
      }

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
      this.finish()
      this.resolveDone(outcome)
    } catch {
      for (const p of this.pollers) p.stop()
      this.finish()
      this.resolveDone({ exitCode: -1, signal: null })
    }
  }

  private finish(): void {
    if (!this.counted) return
    this.counted = false
    if (this.workspaceId !== undefined && this.tracker !== undefined) {
      this.tracker.commandEnded(this.workspaceId)
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
      let phase: string | undefined
      try {
        phase = await this.client.ptyStatus(ptyId)
      } catch {
        // Daemon gone (e.g. workspace sleeping right after teardown). Treat
        // the terminal as closed so no unhandled rejection escapes the poll.
        this.resolveDone({ exitCode: -1, signal: null })
        return
      }
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
  // SubprocessRuntime base constructor already registers under 'subprocess'
  // (super(ctx, "subprocess")); providing again would collide.
  const tracker = ctx.get('workspaceCommandTracker') as CommandActivityTracker | undefined
  new SubprocessK8s(ctx, { ...config, commandTracker: config.commandTracker ?? tracker })
}

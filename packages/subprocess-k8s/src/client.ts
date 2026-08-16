/**
 * HTTP client for the sandbox daemon commands/pty APIs.
 */
export class DaemonError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface DaemonCommandHandle {
  cmdId: string
  pid: number
  pgid: number
}

export interface DaemonCommandStatus {
  cmdId: string
  phase: 'starting' | 'running' | 'exited' | 'killed'
  pid: number
  pgid: number
  exitCode?: number | null
  signal?: string | null
}

export class DaemonSubprocessClient {
  constructor(private baseUrl: string) {}

  async resolveExecutable(command: string): Promise<string> {
    const data = await this.post('/commands/resolve-executable', { command })
    return data.path as string
  }

  async run(spec: {
    argv: readonly string[]
    cwd: string
    env?: Record<string, string>
    stdin?: Uint8Array
    timeoutMs?: number
  }): Promise<DaemonCommandHandle> {
    const data = await this.post('/commands/run', {
      spec: {
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: spec.env,
        stdin: spec.stdin !== undefined ? Buffer.from(spec.stdin).toString('base64') : undefined,
        timeoutMs: spec.timeoutMs,
      },
    })
    return data as DaemonCommandHandle
  }

  async writeStdin(cmdId: string, data: Uint8Array): Promise<void> {
    await this.post(`/commands/${cmdId}/stdin`, { data: Buffer.from(data).toString('base64') })
  }

  async closeStdin(cmdId: string): Promise<void> {
    await this.post(`/commands/${cmdId}/close-stdin`, {})
  }

  async status(cmdId: string): Promise<DaemonCommandStatus> {
    const data = await this.get(`/commands/${cmdId}/status`)
    return data.status as DaemonCommandStatus
  }

  async readOutput(cmdId: string, stream: 'stdout' | 'stderr', from: number): Promise<{ frames: string; nextOffset: number }> {
    const data = await this.get(`/commands/${cmdId}/output?stream=${stream}&from=${from}`)
    return data as { frames: string; nextOffset: number }
  }

  async kill(cmdId: string, graceMs: number): Promise<DaemonCommandStatus> {
    const data = await this.post(`/commands/${cmdId}/kill`, { graceMs })
    return data.status as DaemonCommandStatus
  }

  async createPty(spec: { argv: readonly string[]; cwd: string; env?: Record<string, string>; rows: number; cols: number }): Promise<{ ptyId: string; pid: number }> {
    const data = await this.post('/ptys', { spec: { argv: [...spec.argv], cwd: spec.cwd, env: spec.env, rows: spec.rows, cols: spec.cols } })
    return data as { ptyId: string; pid: number }
  }

  async ptyWrite(ptyId: string, data: string): Promise<void> {
    await this.post(`/ptys/${ptyId}/write`, { data: Buffer.from(data, 'utf8').toString('base64') })
  }

  async ptyResize(ptyId: string, rows: number, cols: number): Promise<void> {
    await this.post(`/ptys/${ptyId}/resize`, { rows, cols })
  }

  async ptySignal(ptyId: string, sig: string): Promise<void> {
    await this.post(`/ptys/${ptyId}/signal`, { sig })
  }

  async ptyStatus(ptyId: string): Promise<string | undefined> {
    const data = await this.get(`/ptys/${ptyId}/status`)
    return data.phase as string | undefined
  }

  async ptyOutput(ptyId: string, from: number): Promise<{ frames: string; nextOffset: number }> {
    const data = await this.get(`/ptys/${ptyId}/output?from=${from}`)
    return data as { frames: string; nextOffset: number }
  }

  async ptyTerminate(ptyId: string, graceMs: number): Promise<void> {
    await this.post(`/ptys/${ptyId}/terminate`, { graceMs })
  }

  private async post(path: string, body: unknown): Promise<any> {
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch (e) {
      throw new DaemonError('DAEMON_UNREACHABLE', `sandbox daemon unreachable: ${(e as Error).message}`)
    }
    const payload = (await res.json()) as { ok: boolean; data: any }
    if (!payload.ok) throw new DaemonError(payload.data?.error?.code ?? 'ERROR', payload.data?.error?.message ?? 'daemon error')
    return payload.data
  }

  private async get(path: string): Promise<any> {
    let res: Response
    try {
      res = await fetch(this.baseUrl + path)
    } catch (e) {
      throw new DaemonError('DAEMON_UNREACHABLE', `sandbox daemon unreachable: ${(e as Error).message}`)
    }
    const payload = (await res.json()) as { ok: boolean; data: any }
    if (!payload.ok) throw new DaemonError(payload.data?.error?.code ?? 'ERROR', payload.data?.error?.message ?? 'daemon error')
    return payload.data
  }
}

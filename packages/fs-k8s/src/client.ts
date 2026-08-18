/**
 * HTTP client for the sandbox daemon files API.
 */
export interface DaemonFilesError {
  code: string
  message: string
}

export class DaemonError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Files client. Every method accepts an optional per-call daemon endpoint so a
 * provider can route to per-workspace pods; the configured baseUrl is used when
 * none is passed.
 */
export class DaemonFilesClient {
  constructor(private baseUrl: string) {}

  get defaultEndpoint(): string {
    return this.baseUrl
  }

  async read(path: string, opts?: { offset?: number; maxBytes?: number }, endpoint?: string): Promise<Uint8Array> {
    const data = await this.post('/files/read', { path, offset: opts?.offset, maxBytes: opts?.maxBytes }, endpoint)
    return Buffer.from(data.bytes as string, 'base64')
  }

  async write(path: string, content: Uint8Array, intent?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }, endpoint?: string): Promise<{ operation: 'create' | 'replace'; version: string }> {
    const data = await this.post('/files/write', { path, content: Buffer.from(content).toString('base64'), intent }, endpoint)
    return data.outcome as { operation: 'create' | 'replace'; version: string }
  }

  async list(path: string, endpoint?: string): Promise<Array<{ name: string; type: string; path: string; size?: number }>> {
    const data = await this.post('/files/list', { path }, endpoint)
    return data.entries as Array<{ name: string; type: string; path: string; size?: number }>
  }

  async info(path: string, endpoint?: string): Promise<{ path: string; name: string; type: string; size?: number; mode?: number; modifiedTime?: number; version?: string } | undefined> {
    const data = await this.post('/files/info', { path }, endpoint)
    return data.info as { path: string; name: string; type: string; size?: number; mode?: number; modifiedTime?: number; version?: string } | undefined
  }

  async remove(path: string, endpoint?: string): Promise<void> {
    await this.post('/files/remove', { path }, endpoint)
  }

  async rename(src: string, dst: string, endpoint?: string): Promise<void> {
    await this.post('/files/rename', { src, dst }, endpoint)
  }

  private async post(path: string, body: unknown, endpoint?: string): Promise<any> {
    const base = endpoint ?? this.baseUrl
    let res: Response
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new DaemonError('DAEMON_UNREACHABLE', `sandbox daemon unreachable: ${(e as Error).message}`)
    }
    const payload = (await res.json()) as { ok: boolean; data: any }
    if (!payload.ok) {
      const err = payload.data?.error as DaemonFilesError | undefined
      throw new DaemonError(err?.code ?? 'ERROR', err?.message ?? String(payload.data))
    }
    return payload.data
  }
}

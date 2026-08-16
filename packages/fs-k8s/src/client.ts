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

export class DaemonFilesClient {
  constructor(private baseUrl: string) {}

  async read(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<Uint8Array> {
    const data = await this.post('/files/read', { path, offset: opts?.offset, maxBytes: opts?.maxBytes })
    return Buffer.from(data.bytes as string, 'base64')
  }

  async write(path: string, content: Uint8Array, intent?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string }): Promise<{ operation: 'create' | 'replace'; version: string }> {
    const data = await this.post('/files/write', { path, content: Buffer.from(content).toString('base64'), intent })
    return data.outcome as { operation: 'create' | 'replace'; version: string }
  }

  async list(path: string): Promise<Array<{ name: string; type: string; path: string; size?: number }>> {
    const data = await this.post('/files/list', { path })
    return data.entries as Array<{ name: string; type: string; path: string; size?: number }>
  }

  async info(path: string): Promise<{ path: string; name: string; type: string; size?: number; mode?: number; modifiedTime?: number } | undefined> {
    const data = await this.post('/files/info', { path })
    return data.info as { path: string; name: string; type: string; size?: number; mode?: number; modifiedTime?: number } | undefined
  }

  async remove(path: string): Promise<void> {
    await this.post('/files/remove', { path })
  }

  async rename(src: string, dst: string): Promise<void> {
    await this.post('/files/rename', { src, dst })
  }

  private async post(path: string, body: unknown): Promise<any> {
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new DaemonError('DAEMON_UNREACHABLE', `sandbox daemon unreachable: ${(e as Error).message}`)
    }
    const payload = (await res.json()) as { ok: boolean; data: any }
    if (!payload.ok) {
      throw new DaemonError(payload.data?.error?.code ?? 'ERROR', payload.data?.error?.message ?? 'daemon error')
    }
    return payload.data
  }
}

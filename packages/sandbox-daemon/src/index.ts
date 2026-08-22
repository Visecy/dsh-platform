/**
 * Sandbox daemon entry: HTTP server exposing files / commands / pty APIs,
 * a readiness probe, and graceful shutdown. Runs inside the workspace pod.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { FilesService, FilesError } from './files.ts'
import { CommandRegistry } from './commands.ts'
import { PtyRegistry } from './pty.ts'
import type { CommandSpec, PtySpec, WriteIntent } from './protocol.ts'

export interface DaemonOptions {
  root: string
  port: number
  commandTimeoutMs: number
}

export interface StartedDaemon {
  server: Server
  baseUrl: string
}

const MAX_BODY = 64 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function ok(res: ServerResponse, data: unknown): void {
  json(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, err: unknown): void {
  const e = err as { code?: string; message?: string }
  json(res, 400, { ok: false, data: { error: { code: e.code ?? 'ERROR', message: e.message ?? String(err) } } })
}

export async function startDaemon(opts: DaemonOptions): Promise<StartedDaemon> {
  // root MUST be absolute: child shells run with their own cwd and would
  // resolve a relative runtime root against it (writing status files into /).
  const root = resolve(opts.root)
  const files = new FilesService(root)
  const commands = new CommandRegistry({ runtimeRoot: root, defaultGraceMs: 2000 })
  const ptys = new PtyRegistry({ runtimeRoot: root })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://sandbox.local')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === '/healthz') {
        json(res, 200, { ok: true, data: { status: 'ready' } })
        return
      }

      // ── files ────────────────────────────────────────────────────────────
      if (path === '/files/write' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        const intent = b.intent === undefined ? undefined : (b.intent as WriteIntent)
        const outcome = await files.write(b.path, Buffer.from(b.content, 'base64'), intent)
        ok(res, { outcome })
        return
      }
      if (path === '/files/read' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        const opts2 = b.offset !== undefined || b.maxBytes !== undefined ? { offset: b.offset, maxBytes: b.maxBytes } : undefined
        const bytes = await files.read(b.path, opts2)
        ok(res, { bytes: Buffer.from(bytes).toString('base64') })
        return
      }
      if (path === '/files/list' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, { entries: await files.list(b.path, b.depth !== undefined ? { depth: b.depth } : undefined) })
        return
      }
      if (path === '/files/mkdir' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, { created: await files.mkdir(b.path, { recursive: b.recursive }) })
        return
      }
      if (path === '/files/info' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, { info: await files.info(b.path) })
        return
      }
      if (path === '/files/remove' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        await files.remove(b.path)
        ok(res, {})
        return
      }
      if (path === '/files/rename' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        await files.rename(b.src, b.dst)
        ok(res, {})
        return
      }

      // ── commands ─────────────────────────────────────────────────────────
      if (path === '/commands/resolve-executable' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        const { execFileSync } = await import('node:child_process')
        const cmd = b.command as string
        let resolved: string
        if (cmd.includes('/')) {
          try {
            execFileSync('test', ['-f', cmd, '-a', '-x', cmd])
            resolved = cmd
          } catch {
            json(res, 400, { ok: false, data: { error: { code: 'NOT_FOUND', message: `executable not found: ${cmd}` } } })
            return
          }
        } else {
          // type -P resolves only PATH executables (command -v would return
          // shell builtins like 'echo', which cannot be exec'd).
          try {
            resolved = execFileSync('bash', ['-c', `type -P -- ${JSON.stringify(cmd)}`], { encoding: 'utf8' }).trim()
          } catch {
            json(res, 400, { ok: false, data: { error: { code: 'NOT_FOUND', message: `executable not found in PATH: ${cmd}` } } })
            return
          }
        }
        ok(res, { path: resolved })
        return
      }
      if (path === '/commands/run' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        const spec = b.spec as CommandSpec
        if (typeof spec.stdin === 'string') {
          spec.stdin = Buffer.from(spec.stdin, 'base64')
        }
        const info = await commands.run(spec)
        ok(res, info)
        return
      }
      let m = path.match(/^\/commands\/([^/]+)\/stdin$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        await commands.writeStdin(m[1], Buffer.from(b.data, 'base64'))
        ok(res, {})
        return
      }
      m = path.match(/^\/commands\/([^/]+)\/close-stdin$/)
      if (m !== null && method === 'POST') {
        await commands.closeStdin(m[1])
        ok(res, {})
        return
      }
      m = path.match(/^\/commands\/([^/]+)\/output$/)
      if (m !== null && method === 'GET') {
        const stream = url.searchParams.get('stream') === 'stderr' ? 'stderr' : 'stdout'
        const from = Number(url.searchParams.get('from') ?? '0')
        ok(res, await commands.readOutput(m[1], { stream, from }))
        return
      }
      m = path.match(/^\/commands\/([^/]+)\/status$/)
      if (m !== null && method === 'GET') {
        ok(res, { status: await commands.status(m[1]) })
        return
      }
      m = path.match(/^\/commands\/([^/]+)\/kill$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, { status: await commands.kill(m[1], { graceMs: b.graceMs }) })
        return
      }
      if (path === '/commands' && method === 'GET') {
        ok(res, { commands: commands.list() })
        return
      }
      if (path === '/commands/terminate-all' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        await commands.drain(b.graceMs ?? 2000)
        ok(res, { commands: commands.list() })
        return
      }

      // ── ptys ─────────────────────────────────────────────────────────────
      if (path === '/ptys' && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, await ptys.create(b.spec as PtySpec))
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/write$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ptys.write(m[1], Buffer.from(b.data, 'base64').toString('utf8'))
        ok(res, {})
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/resize$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ptys.resize(m[1], b.rows, b.cols)
        ok(res, {})
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/signal$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ptys.signal(m[1], b.sig)
        ok(res, {})
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/status$/)
      if (m !== null && method === 'GET') {
        ok(res, { phase: ptys.status(m[1]) })
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/output$/)
      if (m !== null && method === 'GET') {
        const from = Number(url.searchParams.get('from') ?? '0')
        ok(res, await ptys.readOutput(m[1], { from }))
        return
      }
      m = path.match(/^\/ptys\/([^/]+)\/terminate$/)
      if (m !== null && method === 'POST') {
        const b = JSON.parse(await readBody(req))
        ok(res, await ptys.terminate(m[1], { graceMs: b.graceMs }))
        return
      }
      if (path === '/ptys' && method === 'GET') {
        ok(res, { ptys: ptys.list() })
        return
      }

      json(res, 404, { ok: false, data: { error: { code: 'NOT_FOUND', message: 'no route' } } })
    } catch (err) {
      fail(res, err)
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(opts.port, '0.0.0.0', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port

  server.on('close', () => {
    void commands.dispose()
    void ptys.dispose()
  })

  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

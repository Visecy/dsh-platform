/**
 * registerGate webserver: a minimal HTTP server carrying the same route
 * surface as dsh-host-webserver (exact/prefix routes, upgrades, SPA fallback)
 * plus an authentication GATE that runs before route matching and before
 * upgrade dispatch. Based on the dsh-web-auth pattern (fork + registerGate).
 *
 * v1 scope: HTTP + upgrade; TLS termination stays at the edge.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'

export interface HttpRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Socket, head: Buffer) => void
}

/** Gate verdict: allow the request, or produce an HTTP response. */
export type Gate = (req: IncomingMessage, res: ServerResponse) => Promise<GateVerdict>
export type GateVerdict = 'allow' | 'responded'

export interface WebServerOptions {
  host?: string
  port?: number
  gate?: Gate
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export class GateWebServer {
  private exact = new Map<string, HttpRoute>()
  private prefixes: HttpRoute[] = []
  private upgrades = new Map<string, UpgradeRoute>()
  private fallbackHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  private upgradeFallbackHandler?: UpgradeRoute['handler']
  private server?: Server

  constructor(private options: WebServerOptions = {}) {}

  register(route: HttpRoute): () => void {
    if (route.kind === 'exact') {
      if (this.exact.has(route.path)) throw new Error(`duplicate exact route: ${route.path}`)
      this.exact.set(route.path, route)
    } else {
      if (this.prefixes.some((r) => r.path === route.path)) throw new Error(`duplicate prefix route: ${route.path}`)
      this.prefixes.push(route)
    }
    return () => {
      if (route.kind === 'exact') this.exact.delete(route.path)
      else this.prefixes = this.prefixes.filter((r) => r !== route)
    }
  }

  registerUpgrade(route: UpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`duplicate upgrade route: ${route.path}`)
    this.upgrades.set(route.path, route)
    return () => {
      this.upgrades.delete(route.path)
    }
  }

  /** Upgrade fallback (proxy path) for upgrades matching no registered route. */
  registerUpgradeFallback(handler: UpgradeRoute['handler']): () => void {
    this.upgradeFallbackHandler = handler
    return () => {
      this.upgradeFallbackHandler = undefined
    }
  }

  registerFallback(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): () => void {
    if (this.fallbackHandler !== undefined) throw new Error('fallback already registered')
    this.fallbackHandler = handler
    return () => {
      this.fallbackHandler = undefined
    }
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head)
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(port, host, () => resolve()))
    const addr = server.address()
    return typeof addr === 'object' && addr !== null ? addr.port : port
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server === undefined) return resolve()
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.options.gate !== undefined) {
        const verdict = await this.options.gate(req, res)
        if (verdict === 'responded') return
      }
      const pathname = pathOf(req)
      const exact = this.exact.get(pathname)
      if (exact !== undefined) return await exact.handler(req, res)
      const prefix = this.prefixes.find((r) => pathname.startsWith(r.path))
      if (prefix !== undefined) return await prefix.handler(req, res)
      if (this.fallbackHandler !== undefined) return await this.fallbackHandler(req, res)
      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      res.writeHead(400)
      res.end(String(err))
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    void (async () => {
      try {
        if (this.options.gate !== undefined) {
          const fakeRes = new ServerResponse(req)
          const verdict = await this.options.gate(req, fakeRes)
          if (verdict === 'responded') {
            fakeRes.end()
            socket.destroy()
            return
          }
        }
        const pathname = pathOf(req)
        const route = this.upgrades.get(pathname)
        if (route === undefined) {
          if (this.upgradeFallbackHandler !== undefined) {
            this.upgradeFallbackHandler(req, socket, head)
            return
          }
          socket.destroy()
          return
        }
        route.handler(req, socket, head)
      } catch {
        socket.destroy()
      }
    })()
  }
}

function pathOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://dsh.internal').pathname
}

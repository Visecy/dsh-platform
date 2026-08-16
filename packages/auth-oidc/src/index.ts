/**
 * dsh-auth-oidc: OIDC login (authentik) for the dsh platform.
 *
 * Composes:
 *  - OidcClient (discovery / authorize+PKCE / token / JWKS verify / userinfo)
 *  - SessionCodec (HMAC cookie)
 *  - GateWebServer with an authentication gate in front of routes + upgrades
 *
 * Routes:
 *  GET /auth/login      -> redirect to IdP (PKCE, state in cookie)
 *  GET /auth/callback   -> exchange code, verify id_token, set session cookie
 *  GET /auth/logout     -> clear session cookie
 *  Everything else      -> gate: valid session cookie required (public paths configurable)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { OidcClient, type OidcConfig } from './oidc-client.ts'
import { SessionCodec, type SessionClaims } from './session.ts'
import { GateWebServer, type GateVerdict } from './webserver.ts'

export interface AuthConfig {
  oidc: OidcConfig
  sessionSecret: string
  cookieName?: string
  /** Paths exempt from the gate (default: /auth/*, /healthz). */
  publicPaths?: string[]
  /** Groups mapped to the platform 'admin' role. */
  adminGroups?: string[]
  port?: number
  host?: string
}

export interface AuthService {
  baseUrl: string
  currentUser(req: IncomingMessage): SessionClaims | undefined
  logout(req: IncomingMessage, res: ServerResponse): void
  close(): Promise<void>
}

export class AuthPlugin {
  readonly oidc: OidcClient
  readonly sessions: SessionCodec
  readonly server: GateWebServer
  private pending = new Map<string, { verifier: string }>()
  baseUrl = ''
  private cookieName: string
  private publicPaths: string[]
  private adminGroups: string[]
  private port: number
  private host: string

  constructor(private config: AuthConfig) {
    this.oidc = new OidcClient(config.oidc)
    this.sessions = new SessionCodec(config.sessionSecret)
    this.cookieName = config.cookieName ?? 'dsh_session'
    this.publicPaths = config.publicPaths ?? ['/healthz']
    this.adminGroups = config.adminGroups ?? ['dsh-admins']
    this.port = config.port ?? 0
    this.host = config.host ?? '127.0.0.1'
    this.server = new GateWebServer({ gate: (req, res) => this.gate(req, res) })
    this.registerAuthRoutes()
  }

  async start(): Promise<string> {
    const port = await this.server.listen(this.port, this.host)
    this.baseUrl = `http://127.0.0.1:${port}`
    return this.baseUrl
  }

  currentUser(req: IncomingMessage): SessionClaims | undefined {
    const cookie = readCookie(req, this.cookieName)
    if (cookie === undefined) return undefined
    return this.sessions.decode(cookie)
  }

  async loginUrl(): Promise<string> {
    const p = await this.oidc.buildAuthorizeUrl()
    this.pending.set(p.state, { verifier: p.verifier })
    if (this.pending.size > 1000) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    return p.url
  }

  async handleCallback(code: string, state: string): Promise<SessionClaims> {
    const pending = this.pending.get(state)
    if (pending === undefined) throw new Error('unknown or expired login state')
    this.pending.delete(state)
    const tokens = await this.oidc.exchangeCode(code, pending.verifier)
    if (tokens.id_token === undefined) throw new Error('no id_token in token response')
    const claims = await this.oidc.verifyIdToken(tokens.id_token)
    const sub = String(claims.sub ?? '')
    if (sub === '') throw new Error('id_token missing sub')
    const groups = asGroups(claims)
    return {
      sub,
      email: claims.email as string | undefined,
      name: claims.name as string | undefined,
      groups,
      roles: groups.some((g) => this.adminGroups.includes(g)) ? ['user', 'admin'] : ['user'],
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    }
  }

  logout(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('set-cookie', `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    res.writeHead(302, { location: '/' })
    res.end()
  }

  // ── gate ────────────────────────────────────────────────────────────────

  private async gate(req: IncomingMessage, res: ServerResponse): Promise<GateVerdict> {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    if (pathname === '/auth/login' || pathname === '/auth/callback' || pathname === '/auth/logout') return 'allow'
    if (this.publicPaths.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'allow'
    const user = this.currentUser(req)
    if (user !== undefined) {
      res.setHeader('x-dsh-user', user.sub)
      return 'allow'
    }
    if (req.headers.accept?.includes('text/html') === true || pathname === '/') {
      const url = await this.loginUrl()
      res.writeHead(302, { location: url })
      return 'responded'
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'login required' } }))
    return 'responded'
  }

  private registerAuthRoutes(): void {
    this.server.register({
      kind: 'exact',
      path: '/auth/login',
      handler: async (_req, res) => {
        const url = await this.loginUrl()
        res.writeHead(302, { location: url })
        res.end()
      },
    })
    this.server.register({
      kind: 'exact',
      path: '/auth/callback',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (code === null || state === null) {
          res.writeHead(400)
          res.end('missing code or state')
          return
        }
        try {
          const session = await this.handleCallback(code, state)
          const token = this.sessions.encode(session)
          res.setHeader('set-cookie', `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`)
          res.writeHead(302, { location: '/' })
          res.end()
        } catch (e) {
          res.writeHead(400)
          res.end(`login failed: ${(e as Error).message}`)
        }
      },
    })
    this.server.register({
      kind: 'exact',
      path: '/auth/logout',
      handler: (req, res) => {
        this.logout(req, res)
      },
    })
  }

  async close(): Promise<void> {
    await this.server.close()
  }
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}

export function asGroups(claims: Record<string, unknown>): string[] {
  const g = claims.groups
  if (Array.isArray(g)) return g.map(String)
  if (typeof g === 'string') return g.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/**
 * dsh-auth-oidc cordis plugin entry: mounts the OIDC gate on the webserver's
 * request-gate seat (dsh-web-auth fork extension) so authentication happens
 * inside the dsh process — no reverse proxy, no trusted headers.
 *
 * The gate runs before route matching and before WebSocket upgrade dispatch
 * (kind: 'request' | 'upgrade'); a denial owns the response (401 for API /
 * upgrade, 302 to the IdP for browser navigation). Login routes are registered
 * as exact webserver routes.
 *
 * Reuses the standalone AuthPlugin core (OidcClient + SessionCodec + gate
 * logic) so the sidecar form (src/main.ts) and the in-process form share one
 * implementation.
 */
import { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
      registerGate(gate: (req: any, res: any, kind: 'request' | 'upgrade') => boolean | Promise<boolean>): () => void
    }
  }
}
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthPlugin, type AuthConfig } from './index.ts'
import { readCookie } from './index.ts'

export const name = '@visecy/dsh-auth-oidc'

export const Config = z.object({
  oidc: z.object({
    issuer: z.string().required(),
    clientId: z.string().required(),
    clientSecret: z.string(),
    redirectUri: z.string().required(),
    discoveryUrl: z.string(),
    scopes: z.array(z.string()),
  }).required(),
  sessionSecret: z.string().required(),
  cookieName: z.string(),
  publicPaths: z.array(z.string()),
  adminGroups: z.array(z.string()),
})

export function apply(ctx: Context, config: AuthConfig): void {
  // cordis loader passes the flat patch config; assemble the nested AuthConfig
  // the AuthPlugin core expects (oidc client settings + session + gate options).
  const auth = new AuthPlugin(config)

  ctx.inject(['webServer'], (serverCtx) => {
    // Register login routes on the in-process webserver.
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: '/auth/login',
      handler: async (_req, res) => {
        const url = await auth.loginUrl()
        res.writeHead(302, { location: url })
        res.end()
      },
    }), 'dsh-auth-oidc: /auth/login')

    serverCtx.effect(() => serverCtx.webServer.register({
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
          const session = await auth.handleCallback(code, state)
          const token = auth.sessions.encode(session)
          const cookieName = auth.config.cookieName ?? 'dsh_session'
          res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`)
          res.writeHead(302, { location: '/' })
          res.end()
        } catch (e) {
          res.writeHead(400)
          res.end(`login failed: ${(e as Error).message}`)
        }
      },
    }), 'dsh-auth-oidc: /auth/callback')

    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: '/auth/logout',
      handler: (req, res) => {
        auth.logout(req, res)
      },
    }), 'dsh-auth-oidc: /auth/logout')

    // The gate itself: allow whitelisted paths, allow valid sessions,
    // otherwise deny (401 for API/upgrade, 302 to IdP for browser).
    const gate = async (req: IncomingMessage, res: ServerResponse, kind: 'request' | 'upgrade'): Promise<boolean> => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (pathname === '/auth/login' || pathname === '/auth/callback' || pathname === '/auth/logout') return true
      // PWA agents fetch /manifest.webmanifest and favicons without a session
      // cookie; redirecting them to the IdP surfaces a cross-origin CORS error
      // in the console. Keep those static assets public even when the operator
      // supplies an explicit publicPaths list.
      const defaultPublicPaths = ['/healthz', '/manifest.webmanifest', '/manifest.json', '/favicon.svg', '/sw.js', '/service-worker.js']
      const configuredPublicPaths = auth.config.publicPaths ?? []
      const publicPaths = Array.from(new Set([...defaultPublicPaths, ...configuredPublicPaths]))
      if (publicPaths.some((p) => pathname === p || pathname.startsWith(p + '/'))) return true
      const user = auth.currentUser(req)
      if (user !== undefined) {
        res.setHeader('x-dsh-user', user.sub)
        return true
      }
      if (kind === 'upgrade' || pathname === '/api' || pathname.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'login required' } }))
        return false
      }
      const url = await auth.loginUrl()
      res.writeHead(302, { location: url })
      res.end()
      return false
    }

    serverCtx.effect(() => serverCtx.webServer.registerGate(gate), 'dsh-auth-oidc: request gate')
  })

  // Expose currentUser for other platform plugins (user-domain) via ctx.
  ctx.provide('dshAuth', {
    currentUser: (req: IncomingMessage) => auth.currentUser(req),
  })
}
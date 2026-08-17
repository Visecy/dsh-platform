/**
 * Gate process entry: runs the OIDC gate in front of the dsh web server
 * (127.0.0.1:<upstreamPort>). Authenticated requests are reverse-proxied to
 * dsh web with Host/Origin preserved (the dsh trust fence requires the public
 * authority); unauthenticated requests get the login flow.
 *
 * Env:
 *   GATE_PORT (default 3080), GATE_UPSTREAM (default http://127.0.0.1:3000),
 *   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI,
 *   OIDC_DISCOVERY_URL (optional), SESSION_SECRET, ADMIN_GROUPS (comma list)
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { AuthPlugin, type AuthConfig } from './index.ts'

const env = process.env
const upstream = env.GATE_UPSTREAM ?? 'http://127.0.0.1:3000'

const config: AuthConfig = {
  oidc: {
    issuer: env.OIDC_ISSUER ?? '',
    clientId: env.OIDC_CLIENT_ID ?? '',
    clientSecret: env.OIDC_CLIENT_SECRET,
    redirectUri: env.OIDC_REDIRECT_URI ?? '',
    discoveryUrl: env.OIDC_DISCOVERY_URL,
    scopes: ['openid', 'profile', 'email', 'groups'],
  },
  sessionSecret: env.SESSION_SECRET ?? 'insecure-dev-secret-change-me',
  adminGroups: (env.ADMIN_GROUPS ?? 'dsh-admins').split(',').map((s) => s.trim()).filter(Boolean),
  port: Number(env.GATE_PORT ?? '3080'),
  host: '0.0.0.0',
}

// GATE_PASSTHROUGH=1: no auth (authentication happens inside dsh web via the
// in-process registerGate plugin); this process only reverse-proxies.
const passthrough = env.GATE_PASSTHROUGH === '1'

let server: ReturnType<typeof createServer>
if (passthrough) {
  server = createServer((req, res) => {
    proxy(req, res)
  })
  server.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(env.GATE_PORT ?? '3080'), '0.0.0.0', () => resolve())
  })
  console.log(`passthrough gate ready on :${env.GATE_PORT ?? '3080'} -> upstream ${upstream}`)
} else {
  if (config.oidc.issuer === '' || config.oidc.clientId === '') {
    console.error('OIDC_ISSUER and OIDC_CLIENT_ID are required')
    process.exit(1)
  }
  const auth = new AuthPlugin(config)
  await auth.start()
  console.log(`auth gate ready at ${auth.baseUrl} -> upstream ${upstream}`)

  // Proxy: everything the gate allows through is forwarded to dsh web,
  // preserving Host (public authority) and Origin; upgrades (WebSocket) pass
  // through the same channel.
  auth.server.registerFallback((req, res) => proxy(req, res))
  auth.server.registerUpgradeFallback?.((req, socket, head) => proxyUpgrade(req, socket, head))
}

function proxy(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', upstream)
  const out = httpRequest(
    {
      host: u.hostname,
      port: u.port === '' ? undefined : Number(u.port),
      path: u.pathname + u.search,
      method: req.method,
      headers: { ...req.headers, host: u.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    },
  )
  out.on('error', (e) => {
    res.writeHead(502)
    res.end(String(e))
  })
  req.pipe(out)
}

function proxyUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
  const u = new URL(upstream)
  const out = httpRequest({
    host: u.hostname,
    port: u.port === '' ? undefined : Number(u.port),
    path: req.url ?? '/',
    method: req.method,
    headers: { ...req.headers, host: u.host, connection: 'Upgrade', upgrade: 'websocket' },
  })
  out.on('upgrade', (up, upSocket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(up.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  out.on('error', () => socket.destroy())
  socket.on('error', () => out.destroy())
  out.end()
}
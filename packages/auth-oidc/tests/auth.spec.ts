import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { AuthPlugin, type AuthConfig } from '../src/index.ts'
import { SessionCodec } from '../src/session.ts'
import { OidcClient } from '../src/oidc-client.ts'
import { GateWebServer } from '../src/webserver.ts'
import { createServer, type Server } from 'node:http'

// ── mock IdP ──────────────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' })

let discovery = {
  issuer: 'https://idp.test',
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/token',
  userinfo_endpoint: 'https://idp.test/userinfo',
  jwks_uri: 'https://idp.test/jwks',
}

function makeIdToken(claims: Record<string, unknown>, aud: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: 'https://idp.test', aud, exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url')
  const sign = createSign('RSA-SHA256')
  sign.update(header + '.' + payload)
  const sig = sign.sign(privateKey).toString('base64url')
  return header + '.' + payload + '.' + sig
}

let idp: Server
let codes: Record<string, { verifier: string; user: Record<string, unknown> }> = {}

beforeAll(async () => {
  idp = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://idp')
    if (url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(discovery))
      return
    }
    if (url.pathname === '/jwks') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }))
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req))
      const code = body.get('code') ?? ''
      const entry = codes[code]
      if (entry === undefined) {
        res.writeHead(400)
        res.end('bad code')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        access_token: 'at-1',
        id_token: makeIdToken(entry.user, 'dsh-client'),
        refresh_token: 'rt-1',
        token_type: 'Bearer',
      }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()))
  const addr = idp.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  mockIdpBase = `http://127.0.0.1:${port}`
  discovery = {
    issuer: 'https://idp.test',
    authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
    token_endpoint: `http://127.0.0.1:${port}/token`,
    userinfo_endpoint: `http://127.0.0.1:${port}/userinfo`,
    jwks_uri: `http://127.0.0.1:${port}/jwks`,
  }
})

afterAll(async () => {
  await new Promise<void>((r) => idp.close(() => r()))
})

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

let mockIdpBase = 'http://127.0.0.1:0'
const baseConfig = (): AuthConfig => ({
  oidc: {
    issuer: 'https://idp.test',
    clientId: 'dsh-client',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:0/auth/callback',
    discoveryUrl: mockIdpBase + '/.well-known/openid-configuration',
  },
  sessionSecret: 'test-secret-123',
})

// ── OIDC client unit tests ────────────────────────────────────────────────
describe('OidcClient', () => {
  it('builds an authorize URL with PKCE and exchanges the code', async () => {
    const client = new OidcClient(baseConfig().oidc)
    const { url, verifier, state } = await client.buildAuthorizeUrl()
    expect(url).toContain(discovery.authorization_endpoint)
    expect(url).toContain('code_challenge=')
    expect(url).toContain('code_challenge_method=S256')
    expect(state.length).toBeGreaterThan(0)
    codes['code-1'] = { verifier, user: { sub: 'u-1', email: 'a@test', groups: ['dsh-admins'] } }
    const tokens = await client.exchangeCode('code-1', verifier)
    expect(tokens.id_token).toBeDefined()
    const claims = await client.verifyIdToken(tokens.id_token!)
    expect(claims.sub).toBe('u-1')
    expect(claims.groups).toEqual(['dsh-admins'])
  })

  it('rejects a tampered id_token', async () => {
    const client = new OidcClient(baseConfig().oidc)
    const { verifier } = await client.buildAuthorizeUrl()
    codes['code-2'] = { verifier, user: { sub: 'u-2' } }
    const tokens = await client.exchangeCode('code-2', verifier)
    const tampered = tokens.id_token!.slice(0, -4) + 'AAAA'
    await expect(client.verifyIdToken(tampered)).rejects.toThrow()
  })

  it('rejects wrong audience', async () => {
    const client = new OidcClient(baseConfig().oidc)
    const { verifier } = await client.buildAuthorizeUrl()
    codes['code-3'] = { verifier, user: { sub: 'u-3' } }
    const tokens = await client.exchangeCode('code-3', verifier)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ iss: 'https://idp.test', aud: 'wrong-aud', sub: 'u-3', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
    const sign = createSign('RSA-SHA256')
    sign.update(header + '.' + payload)
    const bad = header + '.' + payload + '.' + sign.sign(privateKey).toString('base64url')
    await expect(client.verifyIdToken(bad)).rejects.toThrow(/audience/)
  })
})

// ── session codec ─────────────────────────────────────────────────────────
describe('SessionCodec', () => {
  it('round-trips claims and rejects tampering', () => {
    const c = new SessionCodec('secret')
    const token = c.encode({ sub: 'u', roles: ['user'], exp: Math.floor(Date.now() / 1000) + 60 })
    const claims = c.decode(token)
    expect(claims?.sub).toBe('u')
    expect(claims?.roles).toEqual(['user'])
    const tampered = token.slice(0, -2) + 'xx'
    expect(c.decode(tampered)).toBeUndefined()
  })

  it('rejects expired sessions', () => {
    const c = new SessionCodec('secret')
    const token = c.encode({ sub: 'u', roles: ['user'], exp: Math.floor(Date.now() / 1000) - 10 })
    expect(c.decode(token)).toBeUndefined()
  })
})

// ── gate webserver ────────────────────────────────────────────────────────
describe('GateWebServer', () => {
  it('runs the gate before routes and upgrades', async () => {
    const gated: string[] = []
    const server = new GateWebServer({
      gate: async (req) => {
        gated.push(req.url ?? '')
        return 'allow'
      },
    })
    server.register({ kind: 'exact', path: '/hello', handler: (_req, res) => { res.end('hi') } })
    server.registerUpgrade({ path: '/ws', handler: (_req, socket) => { socket.destroy() } })
    const port = await server.listen(0)
    const res = await fetch(`http://127.0.0.1:${port}/hello`)
    expect(await res.text()).toBe('hi')
    expect(gated).toContain('/hello')
    await server.close()
  })

  it('gate can respond and block the route', async () => {
    const server = new GateWebServer({
      gate: async (_req, res) => {
        res.writeHead(401)
        res.end('no')
        return 'responded'
      },
    })
    server.register({ kind: 'exact', path: '/hello', handler: (_req, res) => { res.end('hi') } })
    const port = await server.listen(0)
    const res = await fetch(`http://127.0.0.1:${port}/hello`)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('no')
    await server.close()
  })
})

// ── end-to-end login flow ─────────────────────────────────────────────────
describe('AuthPlugin end-to-end', () => {
  it('login -> callback -> gated access -> logout', async () => {
    const auth = new AuthPlugin(baseConfig())
    await auth.start()

    // 1. unauthenticated API call is rejected
    let res = await fetch(auth.baseUrl + '/api/session')
    expect(res.status).toBe(401)

    // 2. /auth/login redirects to the IdP with PKCE
    res = await fetch(auth.baseUrl + '/auth/login', { redirect: 'manual' })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location') ?? '')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('client_id')).toBe('dsh-client')
    const code = location.searchParams.get('code') ?? 'code-1'
    const state = location.searchParams.get('state') ?? ''
    codes[code] = codes[code] ?? { verifier: '', user: { sub: 'u-1', email: 'a@test', groups: ['dsh-admins'] } }
    // need the verifier stored by the plugin's pending map: simulate via callback with real state
    // (verifier was set during loginUrl; exchange uses it)

    // 3. callback exchanges and sets the session cookie
    const cb = await fetch(auth.baseUrl + '/auth/callback?code=' + code + '&state=' + state, { redirect: 'manual' })
    expect(cb.status).toBe(302)
    const setCookie = cb.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('dsh_session=')

    // 4. gated access now allowed
    res = await fetch(auth.baseUrl + '/api/session', { headers: { cookie: setCookie.split(';')[0] } })
    expect(res.status).toBe(404) // route not registered but gate passed -> falls through

    // 5. currentUser resolves from the cookie
    const req = { headers: { cookie: setCookie.split(';')[0] } } as import('node:http').IncomingMessage
    const user = auth.currentUser(req)
    expect(user?.sub).toBe('u-1')
    expect(user?.roles).toContain('admin') // dsh-admins group

    // 6. logout clears the cookie
    const out = await fetch(auth.baseUrl + '/auth/logout', { redirect: 'manual' })
    expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0')

    await auth.close()
  })

  it('admin vs user roles from groups', async () => {
    const auth = new AuthPlugin(baseConfig())
    await auth.start()
    const session = await auth.handleCallback('code-1', await realState(auth))
    expect(session.roles).toContain('admin')
    await auth.close()
  })
})

async function realState(auth: AuthPlugin): Promise<string> {
  const res = await fetch(auth.baseUrl + '/auth/login', { redirect: 'manual' })
  const url = new URL(res.headers.get('location') ?? '')
  return url.searchParams.get('state') ?? ''
}

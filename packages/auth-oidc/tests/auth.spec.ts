/**
 * `@visecy/dsh-auth-oidc` is DEPRECATED and no longer a DSH plugin.
 *
 * Authentication moved out of this process to the oauth2-proxy sidecar, and the
 * identity seam is `@visecy/dsh-identity-bridge`. Two plugins registering the
 * same `dshAuth` service name break the cordis loader, so this package keeps
 * only its reusable library code — the OIDC client and the session codec — and
 * exposes no plugin entry, no request gate and no webserver.
 *
 * The first block is the regression guard for that downgrade: a gate entry that
 * creeps back in (or a dependency on the deleted `@visecy/dsh-web-auth` fork)
 * fails here instead of failing at profile load.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { OidcClient, SessionCodec, type OidcConfig } from '../src/index.ts'

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
const baseConfig = (): { oidc: OidcConfig } => ({
  oidc: {
    issuer: 'https://idp.test',
    clientId: 'dsh-client',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:0/auth/callback',
    discoveryUrl: mockIdpBase + '/.well-known/openid-configuration',
  },
})

// ── the downgrade to a library ────────────────────────────────────────────
describe('package surface', () => {
  it('exports the library and nothing that can register a gate', async () => {
    const mod = await import('../src/index.ts')
    expect(Object.keys(mod).sort()).toEqual(['OidcClient', 'SessionCodec'])
  })

  it('has no source file depending on the deleted webserver fork', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(src).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    // Match module references and calls, not prose: the package must never
    // import the fork (by any import form) nor call its request-gate seat.
    const forkImport = /['"]@visecy\/dsh-web-auth['"]/
    const gateUsage = /registerGate\s*\(/
    for (const name of files) {
      const source = readFileSync(join(src, name), 'utf8')
      expect(forkImport.test(source), `${name} must not reference @visecy/dsh-web-auth as a module`).toBe(false)
      expect(gateUsage.test(source), `${name} must not call registerGate()`).toBe(false)
    }
  })
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
    await client.exchangeCode('code-3', verifier)
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

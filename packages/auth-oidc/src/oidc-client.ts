/**
 * Minimal OIDC client: discovery, authorization code + PKCE, token exchange,
 * JWKS ID-token signature verification, userinfo. Pure fetch-based, no deps.
 */
import { createHash, randomBytes, createPublicKey } from 'node:crypto'
import type { JsonWebKey } from 'node:crypto'

export interface OidcConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /** Extra params for the authorize request (e.g. audience for kube). */
  authorizeParams?: Record<string, string>
  /** Override the discovery well-known URL (tests/proxies). */
  discoveryUrl?: string
}

export interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  issuer: string
}

export interface TokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type: string
  expires_in?: number
}

export interface OidcUser {
  sub: string
  email?: string
  name?: string
  preferred_username?: string
  groups?: string[]
  [key: string]: unknown
}

export class OidcClient {
  private discovery?: OidcDiscovery
  private jwks?: { keys: JsonWebKey[] }
  private jwksFetchedAt = 0

  readonly config: OidcConfig
  constructor(config: OidcConfig) {
    this.config = config
  }

  async getDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery !== undefined) return this.discovery
    const res = await fetch(this.config.discoveryUrl ?? this.config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration')
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`)
    this.discovery = (await res.json()) as OidcDiscovery
    return this.discovery
  }

  /** JWKS cache TTL: providers (dex) rotate signing keys, so the set is
   *  re-fetched periodically and once more when an unknown kid is seen. */
  private static readonly JWKS_TTL_MS = 5 * 60 * 1000

  private async loadJwks(d: OidcDiscovery, force = false): Promise<{ keys: JsonWebKey[] }> {
    const fresh = Date.now() - this.jwksFetchedAt > OidcClient.JWKS_TTL_MS
    if (this.jwks !== undefined && !fresh && !force) return this.jwks
    const res = await fetch(d.jwks_uri)
    if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`)
    this.jwks = (await res.json()) as { keys: JsonWebKey[] }
    this.jwksFetchedAt = Date.now()
    return this.jwks
  }

  /** Build the authorize URL with PKCE; returns { url, verifier, state }. */
  async buildAuthorizeUrl(): Promise<{ url: string; verifier: string; state: string }> {
    const d = await this.getDiscovery()
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(16))
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: (this.config.scopes ?? ['openid', 'profile', 'email']).join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce: base64url(randomBytes(16)),
    })
    for (const [k, v] of Object.entries(this.config.authorizeParams ?? {})) params.set(k, v)
    return { url: d.authorization_endpoint + '?' + params.toString(), verifier, state }
  }

  /** Exchange the authorization code (PKCE verifier) for tokens. */
  async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    const d = await this.getDiscovery()
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    })
    if (this.config.clientSecret !== undefined) body.set('client_secret', this.config.clientSecret)
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as TokenResponse
  }

  /** Verify the ID token signature via JWKS and decode claims. */
  async verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    const [headerB64, payloadB64, sigB64] = idToken.split('.')
    if (headerB64 === undefined || payloadB64 === undefined || sigB64 === undefined) {
      throw new Error('malformed id_token')
    }
    const header = JSON.parse(base64urlDecode(headerB64)) as { alg: string; kid?: string }
    const d = await this.getDiscovery()
    const jwks = await this.loadJwks(d)
    let key = jwks.keys.find((k) => k.kid === header.kid)
    if (key === undefined) {
      // Key rotation: the cached set may predate the signing key. Refetch
      // once before giving up.
      const freshJwks = await this.loadJwks(d, true)
      key = freshJwks.keys.find((k) => k.kid === header.kid)
    }
    if (key === undefined) throw new Error('no matching jwk for id_token')
    const publicKey = createPublicKey({ key: key, format: 'jwk' })
    const { verify } = await import('node:crypto')
    const valid = verify(null, Buffer.from(headerB64 + '.' + payloadB64), publicKey, Buffer.from(sigB64, 'base64url'))
    if (!valid) throw new Error('id_token signature verification failed')
    const claims = JSON.parse(base64urlDecode(payloadB64)) as Record<string, unknown>
    if (claims.iss !== undefined && claims.iss !== d.issuer && claims.iss !== this.config.issuer) {
      throw new Error('id_token issuer mismatch')
    }
    if (claims.aud !== undefined && claims.aud !== this.config.clientId) {
      throw new Error('id_token audience mismatch')
    }
    return claims
  }

  /** Fetch userinfo (fallback claims source). */
  async userinfo(accessToken: string): Promise<OidcUser> {
    const d = await this.getDiscovery()
    const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`userinfo failed: ${res.status}`)
    return (await res.json()) as OidcUser
  }

  /** Refresh an access token. */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const d = await this.getDiscovery()
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    })
    if (this.config.clientSecret !== undefined) body.set('client_secret', this.config.clientSecret)
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
    return (await res.json()) as TokenResponse
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function base64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8')
}

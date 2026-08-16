/**
 * Auth session cookie: HMAC-signed, constant-time verified, expiry-checked.
 * Payload: { sub, email, name, groups, roles, exp }.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionClaims {
  sub: string
  email?: string
  name?: string
  groups?: string[]
  roles: string[]
  exp: number
}

export class SessionCodec {
  private secret: Buffer
  constructor(secret: string) {
    this.secret = Buffer.from(secret, 'utf8')
  }

  encode(claims: Omit<SessionClaims, 'exp'> & { exp?: number }): string {
    const payload: SessionClaims = {
      ...claims,
      exp: claims.exp ?? Math.floor(Date.now() / 1000) + 12 * 60 * 60, // 12h default
    }
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = this.sign(body)
    return body + '.' + sig
  }

  decode(token: string): SessionClaims | undefined {
    const dot = token.indexOf('.')
    if (dot === -1) return undefined
    const body = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = this.sign(body)
    if (!safeEqual(sig, expected)) return undefined
    let claims: SessionClaims
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims
    } catch {
      return undefined
    }
    if (claims.exp < Math.floor(Date.now() / 1000)) return undefined
    return claims
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url')
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

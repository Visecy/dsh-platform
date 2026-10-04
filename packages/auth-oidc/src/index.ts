/**
 * DEPRECATED — `@visecy/dsh-auth-oidc` is no longer a DSH plugin.
 *
 * Authentication moved out of the control-plane process to the same-pod
 * oauth2-proxy sidecar, and the identity seam the platform uses is
 * `@visecy/dsh-identity-bridge` (`ctx.dshAuth.currentUser(req)`, reading the
 * proxy's `X-Forwarded-User` / `X-Forwarded-Groups` headers). The in-process
 * gate this package used to mount is gone: it depended on a `registerGate` seat
 * that only ever existed in a since-deleted webserver fork, and its `dshAuth`
 * provider
 * would collide with `identity-bridge` (two providers of one service name fail
 * the cordis loader).
 *
 * What remains is the reusable library half — the dependency-free OIDC client
 * (discovery, code+PKCE, token exchange, JWKS verification, userinfo) and the
 * HMAC session codec. It is published only so a future user/authorization
 * layer can build on it; no profile loads it.
 *
 * There is deliberately no `apply()`, no `webServer` usage and no dependency on
 * `@deepseek-ai/cordis` here: importing this package must never have the side
 * effect of registering a plugin.
 * @module @visecy/dsh-auth-oidc
 */
export {
  OidcClient,
  type OidcConfig,
  type OidcDiscovery,
  type OidcUser,
  type TokenResponse,
} from './oidc-client.ts'
export { SessionCodec, type SessionClaims } from './session.ts'

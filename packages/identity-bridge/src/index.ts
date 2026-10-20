/**
 * @visecy/dsh-identity-bridge — the platform's identity seam over the official
 * Web composition. It replaces two compiled-artifact patches with official
 * extension points:
 *
 * 1. **Transport hook (P1).** The browser half of
 *    `@deepseek-ai/dsh-client-connection` reads `globalThis.__DSH_TRANSPORT__`
 *    and treats `transport.ownsHost === true` as "this page owns the Host",
 *    which is what makes `ctx.connection.isLoopback` true behind a reverse
 *    proxy (host-backed settings persistence, document store, produced-file
 *    affordances). A host plugin publishes that global by pushing a
 *    `{ kind: 'global', name, value }` row onto the table emitted by
 *    `webserver/index-inject` — the same mechanism upstream uses for
 *    `__DSH_CONNECTION_RECOVERY__`.
 *
 * 2. **Launch-token handoff (P2).** The official cookie layer requires a
 *    browser cookie minted from this process's launch token, and the token
 *    changes whenever the (ephemeral) Harness home is recreated. This plugin
 *    owns the exact `/` route — exact routes win over the frontend-static
 *    fallback seat — and asks Connection to classify each request through
 *    `authorizeIndex()`. It never bypasses that check: the patch this replaces
 *    did (`isAuthenticated: () => true`).
 *
 * 3. **Principal exposure.** The oauth2-proxy sidecar passes the verified
 *    principal to its UPSTREAM as `X-Forwarded-User` / `X-Forwarded-Groups`
 *    (`--pass-user-headers`, the default). `--set-xauthrequest` is a RESPONSE
 *    header feature for the nginx `auth_request` pattern: it puts
 *    `X-Auth-Request-*` on the browser response, NOT on the upstream request.
 *    Measured against the real v7.15.5 binary, so the defaults below are the
 *    upstream-facing names. Both names are configurable for other proxies.
 *    TRUST REQUIREMENT: these headers are only evidence when the ONLY path to
 *    this process is the authenticating proxy — the deployment binds DSH to
 *    loopback inside the proxy's own pod, publishes no Service port for it and
 *    fences it with a NetworkPolicy. Never expose the app port directly: a
 *    direct client could then simply assert the header.
 *    Authorization and per-user state are deliberately NOT part of this
 *    package.
 *
 * The control plane stays stateless: nothing here writes to disk, keeps
 * per-user state, or touches workspace paths.
 * @module @visecy/dsh-identity-bridge
 */
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionIndexResponse } from '@deepseek-ai/dsh-client-connection'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = '@visecy/dsh-identity-bridge'

/** The transport hook needs the webserver event seat to exist. */
export const inject = ['webServer', 'connection']

/** Plugin config. */
export interface Config {
  /**
   * Absolute path of the `index.html` the root route serves. Defaults to the
   * dist index of the `@deepseek-ai/dsh-web-frontend` package installed for
   * this composition.
   */
  distIndex?: string
  /**
   * Explicit public root browsers use: `scheme://host[:port][/prefix/]`.
   * Overrides every derived value and is validated/normalized at load.
   *
   * When omitted, the handoff root is the official advertised URL
   * (`ctx.webApp.getAdvertisedUrl()`, i.e. the deployment's `--public-url`)
   * when it differs from the listener's own origin; otherwise the origin of the
   * request being handed off. A configured prefix is preserved, so a
   * prefix-stripping reverse proxy is sent back under its prefix.
   *
   * Deployment contracts for a prefix (0.2.1 subpath publishing):
   * - the prefix is valid ONLY behind a prefix-STRIPPING reverse proxy: this
   *   app must receive the path with the prefix already removed, because the
   *   token exchange and every document-relative route are evaluated at `/`;
   * - the canonical browser entry is `<root>/` WITH the trailing slash — that
   *   is what makes the frontend's relative asset references resolve under the
   *   prefix; the proxy should 301 `/` and the bare `/<prefix>` to it.
   * A prefix that does not match the proxy's mount point only produces a 302
   * to the wrong path; the Host fence still protects the launch token.
   */
  publicOrigin?: string
  /**
   * Request headers carrying the proxy-verified principal. Defaults to the
   * oauth2-proxy upstream names (`x-forwarded-user` / `x-forwarded-groups`).
   */
  userHeader?: string
  groupsHeader?: string
}

/** The `globalThis` property the official browser client reads at boot. */
const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/**
 * Upstream-facing identity headers oauth2-proxy actually injects
 * (node:http lower-cases them). NOT `x-auth-request-*`: that family is set on
 * the browser RESPONSE (`--set-xauthrequest`) and is not stripped from a
 * client's request, so a client can assert it.
 */
const DEFAULT_HEADERS: HeaderNames = { user: 'x-forwarded-user', groups: 'x-forwarded-groups' }

/**
 * Reject a configured principal header that belongs to the client-controllable
 * `X-Auth-Request-*` family. oauth2-proxy never strips that family -- it only
 * injects it into the BROWSER RESPONSE for the nginx `auth_request` pattern --
 * so a client can send it to the upstream verbatim. Reading it as identity is a
 * silent impersonation hole, which is exactly the mistake this plugin was
 * originally written with; fail the load instead of letting it back in.
 * @param name - the configured header name.
 * @param which - config field name, for the error message.
 * @throws when the name is part of the untrusted family.
 */
function assertTrustworthyHeader(name: string, which: string): void {
  if (/^x-auth-request-/i.test(name)) {
    throw new Error(
      `identity-bridge: ${which} "${name}" is client-controllable in this topology ` +
        `(oauth2-proxy only puts X-Auth-Request-* on the browser response; it never strips a ` +
        `client-supplied one). Use the upstream pair instead: x-forwarded-user / x-forwarded-groups.`,
    )
  }
}

/**
 * Parse a public HTTP(S) root: `scheme://host[:port][/prefix/]`.
 *
 * This mirrors the official `--public-url` grammar (0.2.1 `parsePublicUrl`)
 * because the root is the base of the launch-token handoff redirect: a
 * prefix-stripping reverse proxy may mount the app under `/dsh/`, and the
 * browser has to be sent back there after the exchange.
 * @param value - the candidate root.
 * @param field - config/service name used in diagnostics.
 * @returns the parsed URL, with the path normalized to end in `/`.
 * @throws when the value is not an absolute http(s) URL, carries credentials, a
 *         query or fragment, ASCII whitespace/control characters, or no host.
 */
function parsePublicRoot(value: string, field = 'publicOrigin'): URL {
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} must not contain ASCII whitespace or control characters`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} is not an absolute URL of the form scheme://host[:port][/prefix/]`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} must be an absolute http(s) URL`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} must not include credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} must not include a query or fragment`)
  }
  if (url.host === '') {
    throw new Error(`identity-bridge: ${field} ${JSON.stringify(value)} must name a host`)
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

/**
 * Assert that a pinned public root names an authority this deployment serves.
 * The per-request fence only checks the REQUEST's authority, so without this a
 * pinned root the deployment does not serve would still receive a redirect
 * carrying the launch token.
 * @param ctx - plugin context carrying the connection service.
 * @param value - the configured `publicOrigin`.
 * @throws when the value is malformed or the Host fence rejects its authority.
 */
function assertServedOrigin(ctx: Context, value: string): void {
  const root = parsePublicRoot(value)
  if (ctx.connection.requestRejection({ headers: { host: root.host } }) === 403) {
    throw new Error(
      `identity-bridge: publicOrigin ${JSON.stringify(value)} is not an authority this deployment serves ` +
        `(the Host fence rejects it), so the handoff would hand the launch token to it. ` +
        `Add the authority to the connection row's trustedHosts / the CLI's --trusted-host.`,
    )
  }
}

/** The official `webApp` service provided by `dsh-web-app` (0.2.1). */
interface WebAppService {
  /** The root browsers are told to use: `--public-url`, or the listener's origin. */
  getAdvertisedUrl(): string
}

/** One warning per plugin context, so a bad `--public-url` cannot flood the pod log. */
const ADVERTISED_WARNING_EMITTED = new WeakSet<Context>()

/**
 * The officially advertised root, when it is a usable handoff base for THIS
 * process.
 *
 * `webApp.getAdvertisedUrl()` is `--public-url` when the deployment set it and
 * the listener's own origin otherwise. The latter is the loopback address
 * behind the authenticating proxy — never what a remote browser reached — so it
 * is ignored and the request origin stays in charge. The advertised root also
 * carries the process launch token, so an authority outside the Host fence is
 * refused: one warning is logged and the request origin is used instead.
 * @param ctx - context carrying webServer and connection.
 * @returns the normalized root, or `undefined` when this process has no usable
 *          advertised root.
 */
function advertisedPublicRoot(ctx: Context): string | undefined {
  const webApp = ctx.get('webApp', false) as Partial<WebAppService> | undefined
  if (webApp === undefined || typeof webApp.getAdvertisedUrl !== 'function') return undefined
  let root: URL
  try {
    root = parsePublicRoot(webApp.getAdvertisedUrl(), 'webApp.getAdvertisedUrl()')
  } catch {
    // The official service validated its own input; a value this plugin cannot
    // use means "announce nothing" rather than a request-time throw.
    return undefined
  }
  let listenerOrigin: string | undefined
  try {
    listenerOrigin = new URL(ctx.webServer.getOrigin()).origin
  } catch {
    listenerOrigin = undefined
  }
  // The official fallback: no --public-url, so the advertised root is the
  // loopback listener. That is not reachable from the browser side.
  if (listenerOrigin !== undefined && listenerOrigin === root.origin) return undefined
  if (ctx.connection.requestRejection({ headers: { host: root.host } }) === 403) {
    if (!ADVERTISED_WARNING_EMITTED.has(ctx)) {
      ADVERTISED_WARNING_EMITTED.add(ctx)
      ctx.logger.warn(
        `identity-bridge: advertised URL ${JSON.stringify(root.href)} is not an authority this deployment serves ` +
          `(the Host fence rejects it), so the launch-token handoff falls back to the request origin. ` +
          `Add the authority to the connection row's trustedHosts / the CLI's --trusted-host.`,
      )
    }
    return undefined
  }
  return root.href
}

/** Which request headers carry the proxy-verified principal. */
export interface HeaderNames {
  /** Header carrying the authenticated user id. */
  user: string
  /** Header carrying the comma-separated group list. */
  groups: string
}

/** The authenticated principal one request carries. */
export interface DshAuthUser {
  /** Stable user id the sidecar vouched for. */
  id: string
  /** Groups the sidecar reported; empty when the header is absent. */
  groups: string[]
}

/** Read-only identity seam over the sidecar's request headers. */
export interface DshAuth {
  /**
   * The principal this request was authenticated as.
   * @param req - any request-shaped object carrying the sidecar's headers.
   * @returns the principal, or `undefined` when no user header is present.
   */
  currentUser(req: { headers: IncomingHttpHeaders }): DshAuthUser | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Identity seam provided by this plugin. */
    dshAuth: DshAuth
  }
}

/** Request-time facts the root route needs. */
interface IndexRouteOptions {
  distIndex: string
  distRoot: string
  /** Explicit public root from config, already validated and normalized. */
  publicOrigin: string | undefined
  /** The official advertised root, read lazily: `webApp` may mount after this plugin. */
  advertisedRoot: () => string | undefined
}

/**
 * Publish the browser transport hook, provide the identity seam, and claim the
 * exact `/` route once Connection is available (the transport hook itself does
 * not depend on Connection).
 * `config` is optional: a profile row may omit `config:` entirely, and cordis
 * then calls this body with `undefined` (this package exports no runtime
 * `Config` schema, so nothing normalizes the value first). Every read below
 * must tolerate that — a throw here fails the whole plugin tree, not just this
 * plugin.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - resolved plugin config, or `undefined` for a config-less row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const distIndex = resolveDistIndex(config)
  const configuredOrigin = config.publicOrigin === '' ? undefined : config.publicOrigin
  // A pinned root is what the handoff redirect points at, and that URL carries
  // the process launch token, so it is validated BEFORE anything is provided:
  // a malformed value or an authority this deployment does not serve must fail
  // the load, not be discovered per request. The advertised root needs no
  // load-time check because `webApp` may mount later; it is re-validated per
  // request in `advertisedPublicRoot`, which fails closed to the request origin.
  let publicOrigin: string | undefined
  if (configuredOrigin !== undefined) {
    assertServedOrigin(ctx, configuredOrigin)
    publicOrigin = parsePublicRoot(configuredOrigin).href
  }
  const options: IndexRouteOptions = {
    distIndex,
    distRoot: dirname(distIndex),
    publicOrigin,
    advertisedRoot: () => advertisedPublicRoot(ctx),
  }

  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } })
  })

  const headers: HeaderNames = {
    user: config.userHeader ?? DEFAULT_HEADERS.user,
    groups: config.groupsHeader ?? DEFAULT_HEADERS.groups,
  }
  assertTrustworthyHeader(headers.user, 'userHeader')
  assertTrustworthyHeader(headers.groups, 'groupsHeader')
  ctx.provide('dshAuth', { currentUser: (req) => currentUser(req, headers) })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/',
      handler: (req, res) => handleIndex(ctx, req, res, options),
    }),
    'dsh-identity-bridge: root index route',
  )
}

/**
 * Serve one root request through the official browser-session layer.
 *
 * Connection owns the response whenever `authorizeIndex()` refuses a request,
 * so the verdict is collected from a stand-in response first: a `true` verdict
 * means a valid browser cookie and the index is rendered; a `303` verdict is
 * the official token exchange and is replayed verbatim (it carries the signed
 * cookie); anything else means no usable session, and the browser is sent
 * through `authenticatedUrl()` so it completes the exchange once.
 * @param ctx - context carrying the connection service.
 * @param req - the root request.
 * @param res - the response to write.
 * @param options - dist anchors, the explicit public root and the lazy
 *                  advertised root.
 */
export async function handleIndex(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  options: IndexRouteOptions,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }

  const verdict = new IndexVerdict()
  if (ctx.connection.authorizeIndex(req, verdict)) {
    await serveStatic('/', res, options.distRoot, options.distIndex, () => true, () => renderIndex(ctx, options.distIndex))
    return
  }
  const { status, headers, body } = verdict
  if (status === 303) {
    res.writeHead(status, headers)
    res.end(body)
    return
  }
  if (ctx.connection.requestRejection({ headers: req.headers }) === 403) {
    // The launch token is a process secret: an authority this deployment does
    // not serve never receives a URL carrying it. This is the same Host/Origin
    // fence every /api request already passes.
    res.writeHead(403, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  // The handoff root, first hit wins: the explicit config/row pin, then the
  // official advertised URL (`--public-url`), then the origin the browser
  // actually reached (reverse-proxy aware). The request itself already passed
  // the Host fence above; the advertised arm re-checks its own authority and
  // falls back here when the fence would reject it.
  const handoffRoot = options.publicOrigin ?? options.advertisedRoot() ?? requestOrigin(req)
  res.writeHead(302, {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    location: ctx.connection.authenticatedUrl(handoffRoot),
  })
  res.end()
}

/**
 * Connection's index verdict, recorded instead of written to the wire so the
 * caller can decide between serving, replaying the token exchange, and the
 * handoff redirect. `ConnectionIndexResponse` is the official structural
 * interface Connection documents for exactly these two operations.
 */
class IndexVerdict implements ConnectionIndexResponse {
  status: number | undefined
  headers: Readonly<Record<string, string>> | undefined
  body: string | undefined

  writeHead(status: number, headers?: Readonly<Record<string, string>>): void {
    this.status = status
    this.headers = headers
  }

  end(body?: string): void {
    this.body = body
  }
}

/**
 * Read the index through the webserver's official renderer, so structured
 * injection rows (the transport hook among them) and the boot-readiness tail
 * land in the document exactly as the official fallback would place them.
 * @param ctx - context carrying the webServer service.
 * @param distIndex - absolute path of index.html.
 * @returns the rendered document body.
 */
async function renderIndex(ctx: Context, distIndex: string): Promise<string> {
  return ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
}

/**
 * The origin the browser reached this request on, honouring a TLS-terminating
 * reverse proxy. Only reached for requests that already passed Connection's
 * authority fence.
 * @param req - the root request.
 * @returns `scheme://authority`.
 */
function requestOrigin(req: IncomingMessage): string {
  const forwarded = headerValue(req.headers, 'x-forwarded-proto')?.split(',')[0]?.trim()
  const scheme = forwarded === undefined || forwarded === '' ? 'http' : forwarded
  return `${scheme}://${req.headers.host ?? 'localhost'}`
}

/**
 * Resolve the index this composition serves.
 * @param config - resolved plugin config, or `undefined` for a config-less row.
 * @returns the absolute path of index.html.
 * @throws when no distIndex is configured and no official Web frontend is
 * resolvable from this composition.
 */
function resolveDistIndex(config: Config | undefined): string {
  const configured = config?.distIndex
  if (configured !== undefined && configured !== '') return configured
  const fallback = resolveFrontendDistIndex()
  if (fallback === undefined) {
    throw new Error('identity-bridge: distIndex is required; @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
  return fallback
}

/** The official Web frontend package the served index comes from. */
const FRONTEND_MANIFEST = '@deepseek-ai/dsh-web-frontend/package.json'

/**
 * Resolution anchors for the shipped Web frontend, in order: this package, then
 * the DSH CLI running this process. The official image installs the frontend
 * inside the CLI's own `node_modules`, which nothing under a profile can reach
 * by plain Node resolution — the CLI anchor is what makes the default work
 * there. A deployment that keeps the frontend somewhere else passes `distIndex`.
 * @returns absolute file anchors, best effort.
 */
export function frontendAnchors(): string[] {
  const anchors = [import.meta.url]
  const cli = process.argv[1]
  if (cli !== undefined && cli !== '') {
    try {
      anchors.push(realpathSync(cli))
    } catch {
      // argv[1] need not exist (embedded or ephemeral launchers): no CLI anchor.
    }
  }
  return anchors
}

/**
 * The shipped Web frontend's dist index, resolved the way the official Web
 * bundle resolves it (`@deepseek-ai/dsh-web-frontend`'s dist, never
 * configured), from the first anchor that has the package.
 * @param anchors - module anchors to resolve from; defaults to {@link frontendAnchors}.
 * @returns the absolute path of index.html, or `undefined` when no anchor has it.
 */
export function resolveFrontendDistIndex(anchors: readonly string[] = frontendAnchors()): string | undefined {
  for (const anchor of anchors) {
    try {
      return join(dirname(createRequire(anchor).resolve(FRONTEND_MANIFEST)), 'dist', 'index.html')
    } catch {
      // An anchor without the frontend: try the next one.
    }
  }
  return undefined
}

/** One header value, joining the array form node:http uses for repeated headers. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name]
  return Array.isArray(raw) ? raw.join(',') : raw
}

/**
 * Parse the sidecar's identity headers.
 * @param req - any request-shaped object carrying the sidecar's headers.
 * @returns the principal, or `undefined` when no user header is present.
 */
export function currentUser(
  req: { headers: IncomingHttpHeaders },
  headers: HeaderNames = DEFAULT_HEADERS,
): DshAuthUser | undefined {
  const id = headerValue(req.headers, headers.user)?.trim()
  if (id === undefined || id === '') return undefined
  const groups = (headerValue(req.headers, headers.groups) ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group !== '')
  return { id, groups }
}

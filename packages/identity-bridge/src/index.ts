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
export const inject = ['webServer']

/** Plugin config. */
export interface Config {
  /**
   * Absolute path of the `index.html` the root route serves. Defaults to the
   * dist index of the `@deepseek-ai/dsh-web-frontend` package installed for
   * this composition.
   */
  distIndex?: string
  /**
   * Public origin browsers use, `scheme://authority` with no trailing slash.
   * Defaults to the origin of the request being handed off.
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
  publicOrigin: string | undefined
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
  const options: IndexRouteOptions = {
    distIndex,
    distRoot: dirname(distIndex),
    publicOrigin: config.publicOrigin === '' ? undefined : config.publicOrigin,
  }

  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push({ kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } })
  })

  const headers: HeaderNames = {
    user: config.userHeader ?? DEFAULT_HEADERS.user,
    groups: config.groupsHeader ?? DEFAULT_HEADERS.groups,
  }
  ctx.provide('dshAuth', { currentUser: (req) => currentUser(req, headers) })

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.webServer.register({
        kind: 'exact',
        path: '/',
        handler: (req, res) => handleIndex(connectionCtx, req, res, options),
      }),
      'dsh-identity-bridge: root index route',
    )
  })
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
 * @param options - dist anchors and the configured public origin.
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
  res.writeHead(302, {
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    location: ctx.connection.authenticatedUrl(options.publicOrigin ?? requestOrigin(req)),
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

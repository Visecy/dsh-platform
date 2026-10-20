/**
 * The official browser-session layer mints a signed cookie from this process's
 * launch token and refuses every browser request until that exchange happened.
 * A deployment inside a sidecar therefore has to SATISFY that layer, not bypass
 * it: `identity-bridge` owns the exact `/` route (exact routes win over the
 * frontend-static fallback seat) and sends a cookieless browser through the
 * OFFICIAL exchange — `ctx.connection.authenticatedUrl()` — while serving the
 * index only when `authorizeIndex()` says the caller may have it.
 *
 * These tests boot the real pieces: the official webserver, the official
 * connection plugin over an in-memory credentials record, and the official
 * frontend-static fallback, so "our route wins and the official layer still
 * works" is asserted against actual behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as frontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import * as connection from '@deepseek-ai/dsh-client-connection'
import * as identityBridge from '../src/index.ts'

const PUBLIC_ORIGIN_AUTHORITY = 'public.example.test'
const AUTHORITY = 'harness.example.test'
const PUBLIC_ORIGIN = 'https://public.example.test'
const HTML = '<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>'

interface Response {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

interface Bench {
  ctx: Context
  request(method: string, path: string, headers?: Record<string, string>): Promise<Response>
  /** Complete the official token exchange and return the browser cookie header. */
  authenticate(): Promise<string>
  close(): Promise<void>
}

/**
 * Boot one composition: official webserver + official connection + the official
 * frontend-static fallback + this plugin, exactly as the profile mounts them.
 * @param config - this plugin's config (publicOrigin varies per bench) plus an
 *   optional `advertisedUrl` that stands in for the official `webApp` service
 *   (`'listener'` models a deployment that configured no `--public-url`, where
 *   the service reports the loopback listener origin).
 * @returns the running bench with an HTTP client and a teardown.
 */
async function boot(
  config: { publicOrigin?: string; advertisedUrl?: string; userHeader?: string; groupsHeader?: string } = {},
): Promise<Bench> {
  const root = await mkdtemp(join(process.cwd(), '.tmp-identity-bridge-'))
  const distIndex = join(root, 'index.html')
  await writeFile(distIndex, HTML)

  const ctx = new Context()
  // In-memory stand-in for the credentials provider the official connection
  // plugin loads its cookie signing secret from (the deployment persists it in
  // Postgres; anything durable here would break the stateless control plane).
  const records = new Map<string, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: string, update: (current: unknown) => Promise<unknown>) {
      const next = await update(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  })

  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // A deployment that PINS a public origin must also serve that authority -- the
  // handoff redirect carries the launch token to it, so a pin outside trustedHosts
  // is a contradiction the plugin now refuses to load with.
  await ctx.plugin(connection, { trustedHosts: [AUTHORITY, PUBLIC_ORIGIN_AUTHORITY] })
  await ctx.plugin(frontendStatic, { distIndex })
  await ctx.plugin(identityBridge, { distIndex, ...config })
  // Stand in for the official `webApp` service after this plugin mounts: the
  // real web-runtime row may mount later too, which is exactly why the plugin
  // reads the advertised root lazily through `ctx.get('webApp')`.
  if (config.advertisedUrl !== undefined) {
    ctx.provide('webApp', {
      getAdvertisedUrl: () => config.advertisedUrl === 'listener'
        ? ctx.webServer.getOrigin()
        : (config.advertisedUrl as string),
    })
  }

  const server = ctx.webServer
  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  if (server.port === undefined) throw new Error('webserver did not start listening')

  const request = (method: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method, headers }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })

  const authenticate = async (): Promise<string> => {
    const redirect = await request('GET', '/', { host: AUTHORITY })
    const token = new URL(redirect.headers.location ?? '', PUBLIC_ORIGIN)
    const exchange = await request('GET', token.pathname + token.search, { host: AUTHORITY })
    const cookie = exchange.headers['set-cookie']?.[0]?.split(';')[0]
    if (cookie === undefined) throw new Error(`token exchange did not mint a cookie (status ${String(exchange.status)})`)
    return cookie
  }

  return {
    ctx,
    request,
    authenticate,
    close: async () => {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

let bench: Bench

beforeAll(async () => { bench = await boot({ publicOrigin: PUBLIC_ORIGIN }) })
afterAll(async () => { await bench.close() })

describe('identity-bridge launch-token handoff', () => {
  it('redirects a cookieless index request through the official token exchange', async () => {
    const res = await bench.request('GET', '/', { host: AUTHORITY })
    expect(res.status).toBe(302)
    const location = new URL(res.headers.location ?? '')
    expect(location.origin).toBe(PUBLIC_ORIGIN)
    expect(location.pathname).toBe('/')
    expect(location.searchParams.get('token')).toBeTruthy()
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('completes the official exchange: the token mints the browser cookie and 303s to clean /', async () => {
    const redirect = await bench.request('GET', '/', { host: AUTHORITY })
    const token = new URL(redirect.headers.location ?? '')
    const exchange = await bench.request('GET', token.pathname + token.search, { host: AUTHORITY })
    expect(exchange.status).toBe(303)
    // 0.2.x answers `location: "./"` where 0.1.5 answered `"/"` (0.2.1-rc.2
    // verified); both resolve to the clean root. Assert the resolved target and
    // that the launch token is not replayed, which is what "303s to clean /"
    // means.
    const clean = new URL(String(exchange.headers.location ?? ''), `http://${AUTHORITY}/`)
    expect(clean.pathname).toBe('/')
    expect(clean.searchParams.has('token')).toBe(false)
    expect(exchange.headers['set-cookie']?.[0]).toMatch(/^dsh-auth-/)
  })

  it('serves the rendered index to a cookie holder, transport hook ahead of the boot tail', async () => {
    const res = await bench.request('GET', '/', { host: AUTHORITY, cookie: await bench.authenticate() })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    const transportAt = res.body.indexOf('globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}')
    const readyAt = res.body.indexOf('__DSH_BOOT_READY__')
    expect(transportAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(-1)
    expect(transportAt).toBeLessThan(readyAt)
  })

  it('sends a stale browser cookie back through the handoff instead of a dead 401', async () => {
    const [name] = (await bench.authenticate()).split('=')
    const res = await bench.request('GET', '/', { host: AUTHORITY, cookie: `${name ?? ''}=stale-and-unsigned` })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(bench.ctx.connection.authenticatedUrl(PUBLIC_ORIGIN))
  })

  it('sends a wrong launch token to the current process token instead of a dead 401', async () => {
    const res = await bench.request('GET', '/?token=not-the-process-token', { host: AUTHORITY })
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(bench.ctx.connection.authenticatedUrl(PUBLIC_ORIGIN))
  })

  it('never hands the launch token to an authority this deployment does not serve', async () => {
    const res = await bench.request('GET', '/', { host: 'evil.example.test' })
    expect(res.status).toBe(403)
    expect(res.headers.location).toBeUndefined()
  })

  it('refuses non-GET root requests', async () => {
    const res = await bench.request('POST', '/', { host: AUTHORITY })
    expect(res.status).toBe(405)
  })

  it('leaves the official frontend-static fallback seat working', async () => {
    const res = await bench.request('GET', '/index.html', { host: AUTHORITY, cookie: await bench.authenticate() })
    expect(res.status).toBe(200)
    expect(res.body).toContain('<div id="root"></div>')
  })

  it('provides ctx.dshAuth over the sidecar identity headers', async () => {
    expect(bench.ctx.dshAuth.currentUser({
      headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'dsh-admins, devs' },
    })).toEqual({ id: 'alice', groups: ['dsh-admins', 'devs'] })
  })
})

describe('identity-bridge handoff origin', () => {
  it('falls back to the request origin and honours the reverse proxy scheme', async () => {
    const plain = await boot()
    try {
      const direct = await plain.request('GET', '/', { host: AUTHORITY })
      expect(direct.headers.location).toBe(plain.ctx.connection.authenticatedUrl(`http://${AUTHORITY}`))
      const proxied = await plain.request('GET', '/', { host: AUTHORITY, 'x-forwarded-proto': 'https' })
      expect(proxied.headers.location).toBe(plain.ctx.connection.authenticatedUrl(`https://${AUTHORITY}`))
    } finally {
      await plain.close()
    }
  })
})

describe('identity-bridge handoff root sources', () => {
  it('prefers an explicitly configured root over the advertised one', async () => {
    const both = await boot({ publicOrigin: PUBLIC_ORIGIN, advertisedUrl: 'https://evil.example.test' })
    try {
      const res = await both.request('GET', '/', { host: AUTHORITY })
      expect(res.status).toBe(302)
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.origin).toBe(PUBLIC_ORIGIN)
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await both.close()
    }
  })

  it('uses the officially advertised root when no explicit root is configured', async () => {
    const advertised = await boot({ advertisedUrl: PUBLIC_ORIGIN })
    try {
      const res = await advertised.request('GET', '/', { host: AUTHORITY })
      expect(res.status).toBe(302)
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.origin).toBe(PUBLIC_ORIGIN)
      expect(location.pathname).toBe('/')
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await advertised.close()
    }
  })

  it('preserves a path prefix from the advertised root', async () => {
    const prefixed = await boot({ advertisedUrl: `${PUBLIC_ORIGIN}/dsh` })
    try {
      const res = await prefixed.request('GET', '/', { host: AUTHORITY })
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.origin).toBe(PUBLIC_ORIGIN)
      // 0.2.1 normalizes the missing trailing slash before the token is added.
      expect(location.pathname).toBe('/dsh/')
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await prefixed.close()
    }
  })

  it('preserves a path prefix in an explicitly configured root', async () => {
    const configured = await boot({ publicOrigin: `${PUBLIC_ORIGIN}/dsh` })
    try {
      const res = await configured.request('GET', '/', { host: AUTHORITY })
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.origin).toBe(PUBLIC_ORIGIN)
      expect(location.pathname).toBe('/dsh/')
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await configured.close()
    }
  })

  it('serves the prefix-stripped proxy view: handoff and token exchange stay under the mount', async () => {
    // What a prefix-stripping proxy does to a browser's GET /dsh/: it forwards
    // GET / with the same Host. The app must answer with a handoff under the
    // mount, and the exchange leg must work when the proxy strips the prefix
    // from the returned Location before replaying it.
    const mounted = await boot({ publicOrigin: `${PUBLIC_ORIGIN}/dsh` })
    try {
      const handoff = await mounted.request('GET', '/', { host: AUTHORITY })
      expect(handoff.status).toBe(302)
      const tokenUrl = new URL(String(handoff.headers.location ?? ''))
      expect(tokenUrl.origin).toBe(PUBLIC_ORIGIN)
      expect(tokenUrl.pathname).toBe('/dsh/')
      expect(tokenUrl.searchParams.getAll('token')).toHaveLength(1)

      // Strip the mount prefix, keep the query — the proxy's view of the
      // Location. The official exchange mints the cookie and answers `./`,
      // which the browser resolves back to /dsh/.
      const stripped = `${tokenUrl.pathname.replace('/dsh', '')}${tokenUrl.search}`
      expect(stripped.startsWith('/?token=')).toBe(true)
      const exchange = await mounted.request('GET', stripped, { host: AUTHORITY })
      expect(exchange.status).toBe(303)
      expect(exchange.headers['set-cookie']?.[0] ?? '').toMatch(/^dsh-auth-/)
      expect(exchange.headers.location).toBe('./')
    } finally {
      await mounted.close()
    }
  })

  it('keeps the root-mode handoff target at / (no subpath regression)', async () => {
    const root = await boot({ publicOrigin: PUBLIC_ORIGIN })
    try {
      const res = await root.request('GET', '/', { host: AUTHORITY })
      expect(res.status).toBe(302)
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.pathname).toBe('/')
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await root.close()
    }
  })

  it('ignores the listener-origin fallback and keeps the request origin', async () => {
    // With no --public-url the official service reports the loopback listener;
    // handing a remote browser that URL would be useless, so the request origin
    // (already fence-checked above) stays in charge.
    const fallback = await boot({ advertisedUrl: 'listener' })
    try {
      const res = await fallback.request('GET', '/', { host: AUTHORITY })
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.origin).toBe(`http://${AUTHORITY}`)
      expect(location.pathname).toBe('/')
      expect(location.searchParams.get('token')).toBeTruthy()
      expect(location.hostname).not.toBe('127.0.0.1')
    } finally {
      await fallback.close()
    }
  })

  it('never hands the token to an advertised authority outside the Host fence', async () => {
    const untrusted = await boot({ advertisedUrl: 'https://evil.example.test' })
    try {
      const res = await untrusted.request('GET', '/', { host: AUTHORITY })
      expect(res.status).toBe(302)
      const location = new URL(String(res.headers.location ?? ''))
      expect(location.hostname).not.toBe('evil.example.test')
      expect(location.origin).toBe(`http://${AUTHORITY}`)
      // The warning path is exercised; the request still completes safely.
      expect(location.searchParams.get('token')).toBeTruthy()
    } finally {
      await untrusted.close()
    }
  })
})

describe('identity-bridge load-time guards', () => {
  it('refuses a pinned origin that is not an absolute URL', async () => {
    await expect(boot({ publicOrigin: 'not-a-url' })).rejects.toThrow(/is not an absolute URL/)
  })

  it('refuses a pinned root that is not http(s) or carries credentials/query/whitespace', async () => {
    await expect(boot({ publicOrigin: 'ftp://public.example.test' })).rejects.toThrow(/absolute http\(s\) URL/)
    await expect(boot({ publicOrigin: 'https://user:pass@public.example.test' })).rejects.toThrow(/credentials/)
    await expect(boot({ publicOrigin: 'https://public.example.test/dsh?x=1' })).rejects.toThrow(/query or fragment/)
    await expect(boot({ publicOrigin: 'https://public.example.test/dsh ' })).rejects.toThrow(/whitespace/)
  })

  it('refuses a pinned origin this deployment does not serve, instead of mailing it a launch token', async () => {
    await expect(boot({ publicOrigin: 'https://evil.example.test' }))
      .rejects.toThrow(/not an authority this deployment serves/)
  })

  it('refuses a configured principal header from the client-controllable family', async () => {
    await expect(boot({ userHeader: 'x-auth-request-user' })).rejects.toThrow(/client-controllable/)
    await expect(boot({ groupsHeader: 'X-Auth-Request-Groups' })).rejects.toThrow(/client-controllable/)
  })

  it('still accepts the upstream pair when configured explicitly', async () => {
    const explicit = await boot({ userHeader: 'x-forwarded-user', groupsHeader: 'x-forwarded-groups' })
    await explicit.close()
  })
})

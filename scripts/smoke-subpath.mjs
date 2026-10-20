#!/usr/bin/env node
/**
 * Local end-to-end proof for subpath publishing (`https://host/<prefix>/`).
 *
 * The identity-bridge unit tests prove the 302 target and the exchange in one
 * process. This smoke proves the DEPLOYMENT contract around it, which no unit
 * test can: a real prefix-stripping reverse proxy in front of the shipped
 * composition, and a browser-like client that follows the chain by hand.
 *
 * Booted pieces, all resolved from the target profile (never patched):
 *   official webserver + official Connection + official frontend-static +
 *   @visecy/dsh-identity-bridge, with a `webApp` stand-in whose
 *   getAdvertisedUrl() returns `--public-url` (here `http://<authority><prefix>/`).
 *
 * The proxy mimics the deploy chart's contract:
 *   /            → 301 <prefix>/
 *   <prefix>     → 301 <prefix>/
 *   <prefix>/…   → strip the prefix, forward to the app (query and Host kept)
 *   anything else→ 404
 *
 * Assertion matrix (plan §4.2):
 *   1  handoff 302 under the mount, exactly one token
 *   2  exchange 303 + dsh-auth cookie Path=/
 *   3  authenticated index 200, transport global before boot-ready tail
 *   4  relative asset resolves under the prefix (200 javascript)
 *   5  second relative asset (manifest) resolves under the prefix (200)
 *   6  /<prefix>/api/… without cookie → 401
 *   7  same /api with cookie → not 401 (router answer)
 *   8  bare /<prefix> → 301 /<prefix>/
 *   9  / → 301 /<prefix>/
 *   10 NEGATIVE: proxy WITHOUT prefix stripping → token exchange 401 (B2)
 *   11 NEGATIVE: untrusted advertised authority → 302 falls back to the
 *      request authority and NEVER contains the untrusted host (no token leak)
 *   12 root-mode regression is covered by smoke-zero-patch.mjs (skipped here)
 *   13 WebSocket upgrade: composition has no /api mux → skipped
 *
 * Usage: node scripts/smoke-subpath.mjs --target <profile>/node_modules \
 *          [--prefix /dsh] [--keep]
 * Exits non-zero when any assertion fails.
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer as createHttpServer } from 'node:http'
import { join, resolve } from 'node:path'

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const target = resolve(argOf('--target', process.cwd()))
const keep = process.argv.includes('--keep')
const rawPrefix = argOf('--prefix', '/dsh')
const prefix = `/${rawPrefix.split('/').filter(Boolean).join('/')}`
if (prefix === '/') throw new Error('smoke-subpath: --prefix must be a non-empty path such as /dsh')

const AUTHORITY = 'public.example.test'
const UNTRUSTED_AUTHORITY = 'evil.example.test'
const ADVERTISED_ROOT = `http://${AUTHORITY}${prefix}/`

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const profileRequire = createRequire(join(target, 'package.json'))
const connectionEntry = profileRequire.resolve('@deepseek-ai/dsh-client-connection')
const webserverEntry = profileRequire.resolve('@deepseek-ai/dsh-host-webserver')

const work = mkdtempSync(join(target, '.dsh-subpath-smoke-'))
const distDir = join(work, 'dist')
mkdirSync(join(distDir, 'assets'), { recursive: true })
const INDEX_HTML = '<!doctype html><html><head><title>dsh</title>'
  + '<link rel="manifest" href="./manifest.webmanifest">'
  + '</head><body><div id="root"></div>'
  + '<script type="module" src="./assets/app.js"></script></body></html>'
writeFileSync(join(distDir, 'index.html'), INDEX_HTML)
writeFileSync(join(distDir, 'manifest.webmanifest'), '{"start_url":"./","scope":"./"}')
writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("subpath smoke")\n')
const distIndex = join(distDir, 'index.html')

const closers = []
const closeAll = async () => {
  for (const close of closers.splice(0).reverse()) {
    try { await close() } catch { /* best effort */ }
  }
}

/** A minimal reverse proxy that mimics the chart's prefix contract. */
const startProxy = async ({ strip }) => {
  const proxy = createHttpServer((req, res) => {
    const incoming = new URL(req.url ?? '/', 'http://proxy.invalid')
    const pathname = incoming.pathname
    if (strip) {
      if (pathname === '/' || pathname === prefix) {
        res.writeHead(301, { location: `${prefix}/`, 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (!pathname.startsWith(`${prefix}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not part of this deployment')
        return
      }
    }
    const forwardedPath = strip ? (pathname.slice(prefix.length) || '/') + incoming.search : pathname + incoming.search
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: appPort,
      method: req.method,
      path: forwardedPath,
      headers: { ...req.headers, host: req.headers.host ?? AUTHORITY },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(`proxy upstream failed: ${String(error)}`)
    })
    req.pipe(upstream)
  })
  await new Promise((resolvePromise) => proxy.listen(0, '127.0.0.1', resolvePromise))
  const port = proxy.address().port
  closers.push(() => new Promise((resolvePromise) => proxy.close(resolvePromise)))
  return port
}

/** Browser-like raw request: manual redirects, caller-supplied Host. */
const request = (proxyPort, path, { method = 'GET', cookie, headers = {} } = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: proxyPort,
      path,
      method,
      headers: { host: AUTHORITY, ...(cookie === undefined ? {} : { cookie }), ...headers },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    req.on('error', rejectPromise)
    req.end()
  })

let ctx
let appPort
try {
  const { Context } = await import(profileRequire.resolve('@deepseek-ai/cordis'))
  const { WebServer } = await import(webserverEntry)
  const connection = await import(connectionEntry)
  const frontendStatic = await import(profileRequire.resolve('@deepseek-ai/dsh-host-frontend-static'))
  const identityBridge = await import(profileRequire.resolve('@visecy/dsh-identity-bridge'))

  ctx = new Context()
  // In-memory stand-in for the credential provider Connection signs its cookie
  // with (the deployment persists that record in Postgres).
  const records = new Map()
  ctx.provide('credentials', {
    async modifyRecord(key, update) {
      const next = await update(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  })

  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  await ctx.plugin(connection, { trustedHosts: [AUTHORITY] })
  await ctx.plugin(frontendStatic, { distIndex })
  await ctx.plugin(identityBridge, { distIndex })
  // The advertised URL is read lazily per request, exactly like the real
  // `webApp` service, so tests can observe the untrusted-authority fallback by
  // mutating this variable.
  let advertised = ADVERTISED_ROOT
  ctx.provide('webApp', { getAdvertisedUrl: () => advertised })

  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  if (server.port === undefined) throw new Error('official webserver did not start listening')
  appPort = server.port

  const proxyPort = await startProxy({ strip: true })
  const noStripPort = await startProxy({ strip: false })

  // ── 1. handoff under the mount ────────────────────────────────────────────
  const handoff = await request(proxyPort, `${prefix}/`)
  const tokenUrl = new URL(String(handoff.headers.location ?? ''))
  check('1. cookieless GET <prefix>/ is a 302 handoff under the mount', handoff.status === 302, `status=${handoff.status}`)
  check('1. the handoff Location is the advertised root', tokenUrl.origin === `http://${AUTHORITY}`, `origin=${tokenUrl.origin}`)
  check('1. the handoff path keeps the prefix and trailing slash', tokenUrl.pathname === `${prefix}/`, `pathname=${tokenUrl.pathname}`)
  check('1. the handoff carries exactly one launch token',
    tokenUrl.searchParams.getAll('token').length === 1, `location=${tokenUrl.href}`)

  // ── 2. token exchange (the proxy strips the prefix) ───────────────────────
  const exchange = await request(proxyPort, tokenUrl.pathname + tokenUrl.search)
  const setCookie = exchange.headers['set-cookie']?.[0] ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  check('2. the launch token exchanges with 303', exchange.status === 303, `status=${exchange.status}`)
  check('2. the exchange redirects to the directory-relative clean ./', exchange.headers.location === './',
    `location=${String(exchange.headers.location)}`)
  check('2. the exchange mints the official dsh-auth cookie', /^dsh-auth-/.test(cookie), `set-cookie=${setCookie || '(none)'}`)
  check('2. the dsh-auth cookie keeps Path=/', /Path=\//.test(setCookie), `set-cookie=${setCookie || '(none)'}`)

  // ── 3. authenticated index ────────────────────────────────────────────────
  const index = await request(proxyPort, `${prefix}/`, { cookie })
  const transportAt = index.body.indexOf('globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}')
  const readyAt = index.body.indexOf('__DSH_BOOT_READY__')
  check('3. authenticated GET <prefix>/ renders the index (200)', index.status === 200, `status=${index.status}`)
  check('3. the transport hook is rendered before the boot-ready tail',
    transportAt > -1 && readyAt > -1 && transportAt < readyAt, `transport@${transportAt} ready@${readyAt}`)

  // ── 4./5. document-relative assets resolve under the prefix ───────────────
  const asset = await request(proxyPort, `${prefix}/assets/app.js`, { cookie })
  check('4. a ./assets/… reference resolves under the prefix (200 javascript)',
    asset.status === 200 && String(asset.headers['content-type'] ?? '').includes('javascript'),
    `status=${asset.status} type=${String(asset.headers['content-type'])}`)
  const manifest = await request(proxyPort, `${prefix}/manifest.webmanifest`, { cookie })
  check('5. a second relative reference resolves under the prefix (200)', manifest.status === 200,
    `status=${manifest.status}`)

  // ── 6./7. the official API fence is reachable under the prefix ────────────
  const apiAnonymous = await request(proxyPort, `${prefix}/api/smoke`)
  check('6. /<prefix>/api/… without the cookie is refused 401', apiAnonymous.status === 401,
    `status=${apiAnonymous.status}`)
  const apiAuthed = await request(proxyPort, `${prefix}/api/smoke`, { cookie })
  check('7. the same API with the cookie passes the fence (not 401)', apiAuthed.status !== 401,
    `status=${apiAuthed.status}`)

  // ── 8./9. canonical entry: root and bare prefix 301 to <prefix>/ ──────────
  const bare = await request(proxyPort, prefix)
  check('8. bare <prefix> 301s to <prefix>/', bare.status === 301 && bare.headers.location === `${prefix}/`,
    `status=${bare.status} location=${String(bare.headers.location)}`)
  const root = await request(proxyPort, '/')
  check('9. / 301s to <prefix>/', root.status === 301 && root.headers.location === `${prefix}/`,
    `status=${root.status} location=${String(root.headers.location)}`)

  // ── 10. NEGATIVE: without prefix stripping the exchange is refused ────────
  // (B2: the official exchange only answers on pathname "/". The exact refusal
  // status depends on which layer owns the unstripped path — the connection API
  // answers 401, while this minimal composition's frontend-static fallback
  // answers 404. What matters for B2 is that no cookie is minted and no 303
  // exchange happens, so assert that and record the status.)
  const noStripHandoff = await request(noStripPort, '/')
  const noStripToken = new URL(String(noStripHandoff.headers.location ?? ''), ADVERTISED_ROOT)
  const noStripExchange = await request(noStripPort, noStripToken.pathname + noStripToken.search)
  const noStripCookie = String(noStripExchange.headers['set-cookie']?.[0] ?? '')
  check('10. NEGATIVE: a proxy that does not strip the prefix cannot exchange the token',
    noStripExchange.status !== 303 && noStripExchange.status !== 200 && !noStripCookie.includes('dsh-auth-'),
    `status=${noStripExchange.status} set-cookie=${noStripCookie || '(none)'} (want no 303/cookie; B2)`)

  // ── 11. NEGATIVE: untrusted advertised authority never receives the token ─
  advertised = `http://${UNTRUSTED_AUTHORITY}${prefix}/`
  const untrustedHandoff = await request(proxyPort, `${prefix}/`)
  const untrustedLocation = String(untrustedHandoff.headers.location ?? '')
  const untrustedUrl = new URL(untrustedLocation)
  check('11. NEGATIVE: untrusted advertised authority falls back to the request authority',
    untrustedHandoff.status === 302 && untrustedUrl.hostname === AUTHORITY,
    `status=${untrustedHandoff.status} location=${untrustedLocation}`)
  check('11. NEGATIVE: the untrusted authority never receives the launch token',
    !untrustedLocation.includes(UNTRUSTED_AUTHORITY), `location=${untrustedLocation}`)
  check('11. NEGATIVE: the fallback still carries the launch token',
    untrustedUrl.searchParams.getAll('token').length === 1, `location=${untrustedLocation}`)

  console.log('sk  SKIP 12. root-mode regression: covered by scripts/smoke-zero-patch.mjs')
  console.log('sk  SKIP 13. WebSocket upgrade: this composition has no /api mux')
} catch (error) {
  failures.push(`uncaught: ${String(error)}`)
  console.error('FAIL uncaught:', error)
} finally {
  await closeAll()
  try { if (ctx !== undefined) await ctx.fiber.dispose() } catch { /* best effort */ }
  if (!keep) rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`SUBPATH SMOKE FAILED (${failures.length} failure(s))`)
  process.exitCode = 1
} else {
  console.log(`SUBPATH SMOKE OK: prefix ${prefix} works end to end behind a prefix-stripping proxy`)
}

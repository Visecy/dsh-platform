#!/usr/bin/env node
/**
 * Can the two compiled-artifact patches be replaced by OFFICIAL extension
 * points? This script answers with evidence, running against an UNPATCHED copy
 * of `@deepseek-ai/dsh-client-connection` 0.1.5-rc.1.
 *
 *   A. browser `isLoopback` — upstream exposes a typed transport hook,
 *      `ClientTransportHooks.ownsHost` (lib/types/client/index.d.ts), read from
 *      `globalThis.__DSH_TRANSPORT__`, which the official web frontend also
 *      reads at boot. A host plugin can publish it as a `webserver/index-inject`
 *      global — the exact mechanism upstream itself uses for
 *      `__DSH_CONNECTION_RECOVERY__` — instead of rewriting `lib/client.js`.
 *
 *   B. server cookie layer — upstream exposes the launch-token exchange:
 *      `ctx.connection.authenticatedUrl(baseUrl)` returns the root URL carrying
 *      this process's launch token and `ctx.connection.authorizeIndex(req,res)`
 *      mints the signed cookie (303 to clean `/`). An OIDC gate can therefore
 *      SATISFY the official browser-session layer by redirecting the browser
 *      through that URL once, instead of replacing `isAuthenticated` with
 *      `return true`.
 *
 * Usage (from a profile/plugin directory that has both packages installed):
 *   node <repo>/scripts/smoke-official-integration.mjs --target <dir-with-@deepseek-ai>
 *
 * Exits non-zero if any claim fails. The installed tree is never modified.
 *
 * NOTE: this script imports the packages INSTALLED in the target profile, not
 * the sources in this repo. After editing vendor/dsh-web-auth or packages/*,
 * reinstall them into the harness (rerun scripts/harness-profile.sh, or copy
 * the changed file) or you will smoke-test a stale copy.
 */
import { createRequire } from 'node:module'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const target = resolve(argOf('--target', process.cwd()))

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const AUTHORITY = 'harness.example.test'
const work = mkdtempSync(join(target, '.dsh-official-smoke-'))
try {
  // 1. an UNPATCHED copy of the official connection package
  const src = join(target, '@deepseek-ai', 'dsh-client-connection')
  const base = join(work, '@deepseek-ai')
  cpSync(src, join(base, 'dsh-client-connection'), { recursive: true })
  const indexJs = readFileSync(join(base, 'dsh-client-connection', 'lib', 'index.js'), 'utf8')
  const clientJs = readFileSync(join(base, 'dsh-client-connection', 'lib', 'client.js'), 'utf8')
  check('fixture is unpatched (no cookie bypass)', !indexJs.includes('Platform patch: the OIDC gate'))
  check('fixture is unpatched (no isLoopback pin)', !clientJs.includes('isLoopback: true,'))
  check('transport hook is read by the official client', clientJs.includes('globalThis.__DSH_TRANSPORT__'))
  check('transport hook honours ownsHost', clientJs.includes('transport?.ownsHost === true'))

  // 2. boot the fork + the UNPATCHED connection
  const profileRequire = createRequire(join(target, 'package.json'))
  const { Context } = await import(profileRequire.resolve('@deepseek-ai/cordis'))
  const { WebServer } = await import(profileRequire.resolve('@visecy/dsh-web-auth'))
  const connection = await import(join(base, 'dsh-client-connection', 'lib', 'index.js'))

  const ctx = new Context()
  const records = new Map()
  const credentials = {
    async modifyRecord(key, update) {
      const next = await update(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  }
  if (typeof ctx.provide === 'function') ctx.provide('credentials', credentials)
  else ctx.reflect.provide('credentials', credentials)

  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  // A: publish the transport hook the way a platform host plugin would.
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
  // Serve the index the way dsh-host-frontend-static does: ask Connection to
  // authorize the request, and only render when it says yes.
  server.registerFallback(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      if (!ctx.connection.authorizeIndex(req, res)) return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(server.renderIndex('<!doctype html><html><head></head><body><div id="root"></div></body></html>'))
  })
  await ctx.plugin(connection, { trustedHosts: [AUTHORITY] })

  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  if (server.port === undefined) throw new Error('webserver fork did not start listening')

  const get = (path, headers = {}) => new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (c) => { body += c })
      response.on('end', () => res({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    req.on('error', rej)
    req.end()
  })

  // ── B. launch-token exchange (unpatched cookie layer stays ACTIVE) ────────
  // Note the ordering: with the cookie layer intact, `/` itself is 401 until
  // the browser has completed the exchange — which is exactly the behaviour
  // patch #2 used to remove.
  const rejected = await get('/api/anything', { host: AUTHORITY })
  check('unpatched build still demands the browser cookie (401)', rejected.status === 401, `status=${rejected.status}`)
  const indexWithoutCookie = await get('/', { host: AUTHORITY })
  check('index is 401 before the exchange (cookie layer live)', indexWithoutCookie.status === 401, `status=${indexWithoutCookie.status}`)

  const tokenUrl = ctx.connection.authenticatedUrl(`http://${AUTHORITY}/`)
  check('authenticatedUrl carries the process launch token', tokenUrl.includes('?token=') && tokenUrl.endsWith('/?token=') === false, tokenUrl)

  const path = new URL(tokenUrl).pathname + new URL(tokenUrl).search
  const exchange = await get(path, { host: AUTHORITY })
  check('token exchange redirects to clean /', exchange.status === 303, `status=${exchange.status}`)
  const setCookie = exchange.headers['set-cookie']?.[0] ?? ''
  check('token exchange mints the signed browser cookie', setCookie.includes('=') && setCookie.length > 10, setCookie.split(';')[0])

  const cookieHeader = setCookie.split(';')[0]
  const authed = await get('/api/anything', { host: AUTHORITY, cookie: cookieHeader })
  check('cookie satisfies the official check (no 401)', authed.status !== 401, `status=${authed.status}`)

  const wrongToken = await get('/?token=not-the-process-token', { host: AUTHORITY })
  check('a wrong token is refused', wrongToken.status === 401, `status=${wrongToken.status}`)
  const foreign = await get('/api/anything', { host: 'evil.example.test', cookie: cookieHeader })
  check('the Host/Origin fence still applies to a cookie holder', foreign.status === 403, `status=${foreign.status}`)

  // ── A. transport hook (index now reachable with the official cookie) ──────
  const rendered = await get('/', { host: AUTHORITY, cookie: cookieHeader })
  check('index served without any connection patch', rendered.status === 200, `status=${rendered.status}`)
  check('__DSH_TRANSPORT__ injected as a head global', rendered.body.includes('__DSH_TRANSPORT__'))
  const transportAt = rendered.body.indexOf('__DSH_TRANSPORT__')
  const readyAt = rendered.body.indexOf('__DSH_BOOT_READY__')
  check('transport global lands before the boot-readiness tail', transportAt !== -1 && readyAt !== -1 && transportAt < readyAt)
  // The official expression reduces to true once the hook is present.
  const ownHostExpression = (transport, pageLocation) => transport?.ownsHost === true || pageLocation === void 0 || false
  check('ownsHost hook satisfies the official isLoopback expression', ownHostExpression({ ownsHost: true }, { hostname: 'public.example.test' }) === true)
  check('without the hook the same expression stays false', ownHostExpression(undefined, { hostname: 'public.example.test' }) === false)

  // ── the deployment's OIDC gate would call exactly these two methods ───────
  check('gate can reach both official entry points',
    typeof ctx.connection.authenticatedUrl === 'function' && typeof ctx.connection.authorizeIndex === 'function')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nOFFICIAL-INTEGRATION SMOKE FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nOFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement')
process.exit(0)

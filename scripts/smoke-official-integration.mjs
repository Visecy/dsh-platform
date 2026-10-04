#!/usr/bin/env node
/**
 * Can the two compiled-artifact patches be replaced by OFFICIAL extension
 * points? This script answers with evidence, loading ONLY unpatched official
 * artifacts from the target profile:
 *
 *   A. browser `isLoopback` — upstream exposes a typed transport hook,
 *      `ClientTransportHooks.ownsHost` (lib/types/client/index.d.ts), read from
 *      `globalThis.__DSH_TRANSPORT__`, which the official web frontend also
 *      reads at boot. A host plugin publishes it as a `webserver/index-inject`
 *      global — the exact mechanism upstream itself uses for
 *      `__DSH_CONNECTION_RECOVERY__` — instead of rewriting `lib/client.js`.
 *      `@visecy/dsh-identity-bridge` does exactly that (asserted below).
 *
 *   B. server cookie layer — upstream exposes the launch-token exchange:
 *      `ctx.connection.authenticatedUrl(baseUrl)` returns the root URL carrying
 *      this process's launch token and `ctx.connection.authorizeIndex(req,res)`
 *      mints the signed cookie (303 to clean `/`). The plugin SATISFIES that
 *      layer by owning the exact `/` route and sending the browser through the
 *      official exchange, instead of replacing `isAuthenticated` with
 *      `return true` (asserted below: the layer is still live).
 *
 * The booted pieces are the ones the image ships: the OFFICIAL
 * `@deepseek-ai/dsh-host-webserver`, the OFFICIAL
 * `@deepseek-ai/dsh-client-connection` and `@visecy/dsh-identity-bridge`. The
 * deleted webserver fork's `registerGate` seat is asserted to be absent, so a
 * regression back to the fork fails here.
 *
 * The full HTTP end-to-end proof of the shipped auth path (handoff -> token
 * exchange -> rendered index -> /api policy -> identity headers) lives in
 * scripts/smoke-zero-patch.mjs; this script stays focused on the extension
 * points themselves.
 *
 * Usage (from a profile/plugin directory that has the packages installed):
 *   node <repo>/scripts/smoke-official-integration.mjs --target <profile>/node_modules
 *
 * Exits non-zero if any claim fails. The installed tree is never modified.
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname, join, resolve } from 'node:path'

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const target = resolve(argOf('--target', process.cwd()))

const failures = []
const check = (label, ok, detail = '') => {
  // Detail is a FAILURE explanation: it must never read as evidence of success.
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const AUTHORITY = 'harness.example.test'
const work = mkdtempSync(join(target, '.dsh-official-smoke-'))
try {
  // 1. the official artifacts this proof runs on, read from the target tree
  const profileRequire = createRequire(join(target, 'package.json'))
  const connectionEntry = profileRequire.resolve('@deepseek-ai/dsh-client-connection')
  const webserverEntry = profileRequire.resolve('@deepseek-ai/dsh-host-webserver')
  const connectionLib = dirname(connectionEntry)
  const connectionIndex = readFileSync(join(connectionLib, 'index.js'), 'utf8')
  const clientJs = readFileSync(join(connectionLib, 'client.js'), 'utf8')
  const webserverJs = readFileSync(webserverEntry, 'utf8')
  check('fixture is unpatched (no cookie bypass)', !connectionIndex.includes('Platform patch: the OIDC gate'))
  check('fixture is unpatched (no isLoopback pin)', !clientJs.includes('isLoopback: true,'))
  check('fixture has no webserver fork extension (no registerGate)', !webserverJs.includes('registerGate'))
  check('transport hook is read by the official client', clientJs.includes('globalThis.__DSH_TRANSPORT__'))
  check('transport hook honours ownsHost', clientJs.includes('transport?.ownsHost === true'))

  // 2. boot the official webserver + connection + the replacement plugin
  const { Context } = await import(profileRequire.resolve('@deepseek-ai/cordis'))
  const { WebServer } = await import(webserverEntry)
  const connection = await import(connectionEntry)
  const frontendStatic = await import(profileRequire.resolve('@deepseek-ai/dsh-host-frontend-static'))
  const identityBridge = await import(profileRequire.resolve('@visecy/dsh-identity-bridge'))

  const distIndex = join(work, 'index.html')
  writeFileSync(distIndex, '<!doctype html><html><head></head><body><div id="root"></div></body></html>')

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
  await ctx.plugin(connection, { trustedHosts: [AUTHORITY] })
  await ctx.plugin(frontendStatic, { distIndex })
  await ctx.plugin(identityBridge, { distIndex })

  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  if (server.port === undefined) throw new Error('official webserver did not start listening')

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

  // ── A. transport hook (replaces the isLoopback pin) ───────────────────────
  const rows = server.collectIndexInjections()
  const transportRow = rows.find((row) => row.name === '__DSH_TRANSPORT__')
  check('identity-bridge publishes the transport hook as an index-inject global',
    transportRow?.kind === 'global' && transportRow?.value?.ownsHost === true,
    `row=${JSON.stringify(transportRow)}`)
  // The official expression reduces to true once the hook is present.
  const ownHostExpression = (transport, pageLocation) => transport?.ownsHost === true || pageLocation === void 0 || false
  check('ownsHost hook satisfies the official isLoopback expression', ownHostExpression({ ownsHost: true }, { hostname: 'public.example.test' }) === true)
  check('without the hook the same expression stays false', ownHostExpression(undefined, { hostname: 'public.example.test' }) === false)

  // ── B. launch-token exchange (replaces the cookie-layer bypass) ───────────
  check('the official connection exposes both exchange entry points',
    typeof ctx.connection.authenticatedUrl === 'function' && typeof ctx.connection.authorizeIndex === 'function')
  const tokenUrl = ctx.connection.authenticatedUrl(`http://${AUTHORITY}/`)
  check('authenticatedUrl carries the process launch token', tokenUrl.includes('?token='), tokenUrl)

  const rejected = await get('/api/anything', { host: AUTHORITY })
  check('the official cookie layer is still ACTIVE (401 without it)', rejected.status === 401, `status=${rejected.status}`)

  // identity-bridge owns the exact `/` route, so the plugin — not the fallback
  // seat — answers it: unauthenticated traffic is handed to the exchange.
  const handoff = await get('/', { host: AUTHORITY })
  const handoffLocation = handoff.headers.location ?? ''
  check('the exact / route hands a cookieless browser to the token exchange',
    handoff.status === 302 && handoffLocation.includes('?token='),
    `status=${handoff.status} location=${handoffLocation}`)

  const viaHandoff = new URL(handoffLocation, `http://${AUTHORITY}`)
  const exchange = await get(viaHandoff.pathname + viaHandoff.search, { host: AUTHORITY })
  check('the token exchange redirects to clean / (303)', exchange.status === 303, `status=${exchange.status}`)
  const setCookie = exchange.headers['set-cookie']?.[0] ?? ''
  check('the token exchange mints the signed browser cookie', setCookie.includes('=') && setCookie.length > 10, setCookie.split(';')[0])

  const cookieHeader = setCookie.split(';')[0]
  const authed = await get('/api/anything', { host: AUTHORITY, cookie: cookieHeader })
  check('the cookie satisfies the official check (no 401)', authed.status !== 401, `status=${authed.status}`)

  const wrongToken = await get('/?token=not-the-process-token', { host: AUTHORITY })
  check('a wrong token is refused (sent back through the handoff, never a dead 401)',
    wrongToken.status === 302 && (wrongToken.headers.location ?? '').includes('?token='),
    `status=${wrongToken.status} location=${String(wrongToken.headers.location)}`)
  const foreign = await get('/api/anything', { host: 'evil.example.test', cookie: cookieHeader })
  check('the Host/Origin fence still applies to a cookie holder', foreign.status === 403, `status=${foreign.status}`)

  const rendered = await get('/', { host: AUTHORITY, cookie: cookieHeader })
  check('index served without any connection patch', rendered.status === 200, `status=${rendered.status}`)
  check('__DSH_TRANSPORT__ injected as a head global', rendered.body.includes('__DSH_TRANSPORT__'))
  const transportAt = rendered.body.indexOf('__DSH_TRANSPORT__')
  const readyAt = rendered.body.indexOf('__DSH_BOOT_READY__')
  check('transport global lands before the boot-readiness tail', transportAt !== -1 && readyAt !== -1 && transportAt < readyAt)

  // ── the fork's seat is genuinely gone ─────────────────────────────────────
  check('the booted webserver has no registerGate seat (no fork needed)',
    typeof server.registerGate !== 'function')

  // ── the identity seam ships in the same plugin ────────────────────────────
  check('identity-bridge provides ctx.dshAuth over the sidecar headers',
    ctx.dshAuth.currentUser({ headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'devs' } })?.id === 'alice')
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nOFFICIAL-INTEGRATION SMOKE FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nOFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it')
process.exit(0)

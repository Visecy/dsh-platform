#!/usr/bin/env node
/**
 * ZERO-PATCH end-to-end smoke.
 *
 * THIS IS THE CORE PROOF OF THE ZERO-PATCH AUTH PATH: the composition booted
 * below is the one the image ships, loaded from a profile whose node_modules
 * hold UNPATCHED official artifacts. Nothing here copies, patches or forks an
 * official file — if any assertion needed a patch to pass, the test could not
 * even be written, because there is no patch step left to run.
 *
 * Booted pieces, all resolved from the target profile:
 *   - @deepseek-ai/dsh-host-webserver   (official webserver, unpatched)
 *   - @deepseek-ai/dsh-client-connection(official cookie layer + Host/Origin
 *                                        fence, unpatched: no `isLoopback: true`
 *                                        pin, no `isAuthenticated` bypass)
 *   - @deepseek-ai/dsh-host-frontend-static (official index/static fallback)
 *   - @visecy/dsh-identity-bridge       (the plugin that replaced the two
 *                                        patches and the webserver fork)
 *
 * Asserted behaviours (the ones the deleted P1/P2 patches + registerGate fork
 * used to provide):
 *   1. `__DSH_TRANSPORT__` is injected as `{ ownsHost: true }`, so a remote
 *      browser classifies as the host (replaces the compiled `isLoopback` pin);
 *   2. a cookieless `GET /` answers 302 with `?token=` in Location (the
 *      identity-bridge handoff into the OFFICIAL launch-token exchange);
 *   3. that token answers 303 + Set-Cookie; a clean `GET /` with the cookie
 *      answers 200 and renders the transport global BEFORE `__DSH_BOOT_READY__`
 *      (replaces the cookie-layer bypass: the official layer stays ACTIVE and
 *      is satisfied, never skipped);
 *   4. `/api` without the cookie is 401, with the cookie is not 401;
 *   5. `ctx.dshAuth.currentUser` resolves the principal from the sidecar's
 *      `x-forwarded-user` / `x-forwarded-groups` headers, on a live request too.
 * Plus the defence-in-depth check the patches preserved: a foreign Host is 403.
 *
 * Usage (from a profile that has the packages above installed):
 *   node <repo>/scripts/smoke-zero-patch.mjs --target <profile>/node_modules
 *
 * The target tree is never modified (only a temp dist fixture is written into
 * it and removed afterwards). Exits non-zero if any assertion fails.
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
const keep = process.argv.includes('--keep')

const failures = []
const check = (label, ok, detail = '') => {
  // Detail is a FAILURE explanation: it must never read as evidence of success.
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const AUTHORITY = 'harness.example.test'
const FOREIGN_AUTHORITY = 'evil.example.test'

const work = mkdtempSync(join(target, '.dsh-zero-patch-smoke-'))
try {
  // ── the artifacts must be the UNPATCHED official ones ─────────────────────
  const profileRequire = createRequire(join(target, 'package.json'))
  const connectionEntry = profileRequire.resolve('@deepseek-ai/dsh-client-connection')
  const webserverEntry = profileRequire.resolve('@deepseek-ai/dsh-host-webserver')
  const connectionLib = dirname(connectionEntry)
  const connectionIndex = readFileSync(join(connectionLib, 'index.js'), 'utf8')
  const connectionClient = readFileSync(join(connectionLib, 'client.js'), 'utf8')
  const webserverSource = readFileSync(webserverEntry, 'utf8')

  check('official connection has no cookie-layer bypass (deleted patch P2)',
    !connectionIndex.includes('Platform patch: the OIDC gate'),
    'found the deleted cookie-bypass marker in lib/index.js')
  check('official connection has no isLoopback pin (deleted patch P1)',
    !connectionClient.includes('isLoopback: true,'),
    'found the deleted isLoopback pin in lib/client.js')
  check('official webserver carries no registerGate fork extension',
    !webserverSource.includes('registerGate'),
    `found registerGate in ${webserverEntry}`)
  check('official client still reads the transport hook the plugin publishes',
    connectionClient.includes('globalThis.__DSH_TRANSPORT__') && connectionClient.includes('transport?.ownsHost === true'))

  // ── boot the shipped composition from those artifacts ─────────────────────
  const { Context } = await import(profileRequire.resolve('@deepseek-ai/cordis'))
  const { WebServer } = await import(webserverEntry)
  const connection = await import(connectionEntry)
  const frontendStatic = await import(profileRequire.resolve('@deepseek-ai/dsh-host-frontend-static'))
  const identityBridge = await import(profileRequire.resolve('@visecy/dsh-identity-bridge'))

  const distIndex = join(work, 'index.html')
  writeFileSync(distIndex, '<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>')

  const ctx = new Context()
  // dsh-client-connection derives its cookie signing secret from the credential
  // provider (the deployment persists it in Postgres). The smoke only exercises
  // request policy, so an in-memory record stands in for dsh-credentials-local.
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
  // The profile passes `publicOrigin: process.env.DSH_PUBLIC_ORIGIN`; unset here,
  // so the plugin falls back to the request's own origin (the documented default).
  await ctx.plugin(identityBridge, { distIndex })
  // A probe route is the only way to observe ctx.dshAuth on a live request;
  // registering a route is composition, not patching.
  server.register({ kind: 'prefix', path: '/whoami', handler: (req, res) => {
    const user = ctx.dshAuth.currentUser(req)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(user ?? null))
  } })

  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  if (server.port === undefined) throw new Error('official webserver did not start listening')

  // Raw HTTP: `fetch` silently drops a caller-supplied Host header, and the
  // Host/Origin fence must be spoken to as a remote browser would.
  const get = (path, headers = {}) => new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    req.on('error', rejectPromise)
    req.end()
  })

  // ── 1. the transport hook ─────────────────────────────────────────────────
  const rows = server.collectIndexInjections()
  const transportRow = rows.find((row) => row.name === '__DSH_TRANSPORT__')
  check('1a. __DSH_TRANSPORT__ is injected through webserver/index-inject',
    transportRow !== undefined,
    `rows: ${rows.map((row) => row.name).join(', ') || '(none)'}`)
  check('1b. the injected transport hook says ownsHost === true',
    transportRow?.value?.ownsHost === true,
    `value=${JSON.stringify(transportRow?.value)}`)

  // ── 2. the cookieless handoff ─────────────────────────────────────────────
  const handoff = await get('/', { host: AUTHORITY })
  const location = handoff.headers.location ?? ''
  check('2. cookieless GET / is a 302 handoff', handoff.status === 302, `status=${handoff.status}`)
  check('2. the handoff Location carries the launch token', location.includes('?token='), `location=${location}`)

  // ── 3. the official token exchange, then the rendered index ───────────────
  const tokenUrl = new URL(location, `http://${AUTHORITY}`)
  const exchange = await get(tokenUrl.pathname + tokenUrl.search, { host: AUTHORITY })
  const setCookie = exchange.headers['set-cookie']?.[0] ?? ''
  const cookie = setCookie.split(';')[0]
  check('3a. the launch token is exchanged with a 303', exchange.status === 303, `status=${exchange.status}`)
  check('3b. the exchange mints the official browser cookie',
    cookie !== '' && cookie.includes('='), `set-cookie=${setCookie || '(none)'}`)
  check('3c. the exchange redirects to clean /', exchange.headers.location === '/',
    `location=${String(exchange.headers.location)}`)

  const index = await get('/', { host: AUTHORITY, cookie })
  check('3d. clean GET / with the cookie renders the index (200)', index.status === 200, `status=${index.status}`)
  const transportAt = index.body.indexOf('globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}')
  const readyAt = index.body.indexOf('__DSH_BOOT_READY__')
  check('3e. the transport global is rendered into the served HTML', transportAt > -1)
  check('3f. the transport global lands before the boot-readiness tail',
    transportAt > -1 && readyAt > -1 && transportAt < readyAt,
    `transport@${transportAt} ready@${readyAt}`)

  // ── 4. the official cookie layer stays ACTIVE and is satisfied ────────────
  const apiAnonymous = await get('/api/anything', { host: AUTHORITY })
  check('4a. /api without the cookie is refused 401', apiAnonymous.status === 401, `status=${apiAnonymous.status}`)
  const apiAuthed = await get('/api/anything', { host: AUTHORITY, cookie })
  check('4b. the same /api request with the cookie is not 401', apiAuthed.status !== 401, `status=${apiAuthed.status}`)

  // ── 5. the identity seam over the sidecar's headers ───────────────────────
  const user = ctx.dshAuth.currentUser({ headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'dsh-admins, devs' } })
  check('5a. ctx.dshAuth.currentUser reads x-forwarded-user / x-forwarded-groups',
    user?.id === 'alice' && JSON.stringify(user?.groups) === JSON.stringify(['dsh-admins', 'devs']),
    `principal=${JSON.stringify(user)}`)
  check('5b. ctx.dshAuth.currentUser reports no principal without the user header',
    ctx.dshAuth.currentUser({ headers: { 'x-forwarded-groups': 'devs' } }) === undefined)
  const whoami = await get('/whoami', { host: AUTHORITY, 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'dsh-admins,devs' })
  check('5c. the principal is readable on a live request',
    whoami.status === 200 && whoami.body === '{"id":"alice","groups":["dsh-admins","devs"]}',
    `status=${whoami.status} body=${whoami.body}`)

  // ── defence in depth the patches had to keep working ─────────────────────
  const foreign = await get('/', { host: FOREIGN_AUTHORITY })
  check('fence: a foreign Host never receives the launch token (403)',
    foreign.status === 403 && foreign.headers.location === undefined,
    `status=${foreign.status} location=${String(foreign.headers.location)}`)

  // cordis 4 tears down through fiber disposal; the process exits below.
} finally {
  if (keep) console.log(`kept fixture dir: ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nZERO-PATCH SMOKE FAILED (${failures.length}): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path')
process.exit(0)

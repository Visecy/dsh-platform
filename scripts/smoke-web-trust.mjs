#!/usr/bin/env node
/**
 * Deployment trust-model smoke test for the platform web surface.
 *
 * Boots the REAL composition the image ships — the vendored
 * @visecy/dsh-web-auth webserver fork plus an OFFICIAL dsh-client-connection
 * that scripts/patch-dsh.mjs has patched — and asserts the resulting request
 * policy end to end:
 *
 *   1. the fork still serves the index and renders the index-injection rows
 *      (script-preload + the boot-readiness tail), including 0.1.5's new
 *      `__DSH_CONNECTION_RECOVERY__` global;
 *   2. the official Host/Origin fence is STILL ACTIVE (a foreign Host without
 *      a trustedHosts entry is rejected 403);
 *   3. the per-process launch-token cookie layer is BYPASSED (a request that
 *      passes the fence is not answered 401 by the cookie check) — the OIDC
 *      gate upstream of the webserver is the deployment's session layer;
 *   4. the browser `isLoopback` pin is applied in the client bundle.
 *
 * Usage (run from a profile/plugin directory that has both packages installed):
 *   node <repo>/scripts/smoke-web-trust.mjs --target <dir-with-@deepseek-ai>
 *
 * The target directory is copied to a temp dir before patching, so the
 * installed tree is never modified.
 *
 * NOTE: this script imports the packages INSTALLED in the target profile, not
 * the sources in this repo. After editing vendor/dsh-web-auth or packages/*,
 * reinstall them into the harness (rerun scripts/harness-profile.sh, or copy
 * the changed file) or you will smoke-test a stale copy.
 */
import { createRequire } from 'node:module'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const target = resolve(argOf('--target', process.cwd()))
const keep = process.argv.includes('--keep')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const work = mkdtempSync(join(target, '.dsh-trust-smoke-'))
try {
  // 1. copy the official connection package and patch the copy. The copy lives
  //    INSIDE the target's node_modules tree so its own imports
  //    (@deepseek-ai/schemastery, cordis, …) resolve through the profile.
  const src = join(target, '@deepseek-ai', 'dsh-client-connection')
  const base = join(work, '@deepseek-ai')
  cpSync(src, join(base, 'dsh-client-connection'), { recursive: true })
  const patched = spawnSync(process.execPath, [join(here, 'patch-dsh.mjs'), base], { encoding: 'utf8' })
  process.stdout.write(patched.stdout)
  process.stderr.write(patched.stderr)
  check('patch-dsh.mjs applies to the 0.1.5 artifacts', patched.status === 0)

  const clientBundle = readFileSync(join(base, 'dsh-client-connection', 'lib', 'client.js'), 'utf8')
  check('browser isLoopback pinned to true', clientBundle.includes('isLoopback: true,'))

  // 2. boot the fork + the patched connection
  const profileRequire = createRequire(join(target, 'package.json'))
  const { Context } = await import(profileRequire.resolve('@deepseek-ai/cordis'))
  const { WebServer } = await import(profileRequire.resolve('@visecy/dsh-web-auth'))
  const connection = await import(join(base, 'dsh-client-connection', 'lib', 'index.js'))

  const ctx = new Context()
  // dsh-client-connection statically injects `credentials` (it derives the
  // browser-cookie signing secret from the credential provider). The smoke
  // only exercises request policy, so a minimal in-memory provider stands in
  // for dsh-credentials-local.
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
  // cordis 4 has no ctx.start(): plugins are applied by ctx.plugin(), and a
  // Service subclass runs its lifecycle hooks as its fiber starts.
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  // The deployment's OIDC gate, reduced to its essential shape: authenticate
  // every request BEFORE route matching, whitelist the login routes, deny
  // everything else. `x-smoke-auth` stands in for the OIDC session cookie.
  server.registerGate((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/auth/login') return true
    if (req.headers['x-smoke-auth'] === 'ok') return true
    res.writeHead(401)
    res.end('unauthorized')
    return false
  })
  // Two named routes standing in for the two shipped routes that upstream
  // leaves WITHOUT any trust check: the client-modules bundle route and the
  // client-hmr SSE route. A gate that only covered the fallback would let
  // these through.
  server.register({ kind: 'prefix', path: '/plugins', handler: (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('/* bundle */')
  } })
  server.registerFallback(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(server.renderIndex('<!doctype html><html><head></head><body><div id="root"></div></body></html>'))
  })
  await ctx.plugin(connection, { trustedHosts: ['harness.example.test'] })

  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (server.port === undefined) throw new Error('webserver fork did not start listening')

  // `fetch` silently drops a caller-supplied Host header (forbidden header
  // name), which would make every fence probe look like a loopback request.
  // Raw HTTP lets us speak as an arbitrary authority, exactly like a remote
  // browser reaching the deployment through its ingress.
  const get = (path, headers = {}) => new Promise((resolvePromise, rejectPromise) => {
    // Every probe below is an ALREADY OIDC-authenticated operator unless it
    // explicitly opts out with `auth: false`.
    const finalHeaders = { 'x-smoke-auth': 'ok', ...headers }
    const request = httpRequest({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers: finalHeaders }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', rejectPromise)
    request.end()
  })
  /** One probe as an unauthenticated stranger (no OIDC session). */
  const anonymous = (path, headers = {}) => new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', rejectPromise)
    request.end()
  })

  // dsh-client-connection mounts its /api route and its index-injection
  // listener inside ctx.inject(["webServer"], …), so registration lands a tick
  // after the service appears. Wait for the injection rather than racing it.
  const ready = Date.now() + 10_000
  let rendered = ''
  for (;;) {
    rendered = (await get('/')).body
    if (rendered.includes('__DSH_CONNECTION_RECOVERY__')) break
    if (Date.now() > ready) throw new Error('connection plugin never registered its index injection')
    await new Promise((r) => setTimeout(r, 20))
  }

  const index = await get('/')
  check('index served by the fork (loopback)', index.status === 200)
  check('boot-readiness tail present', index.body.includes('__DSH_BOOT_READY__'))
  check('0.1.5 recovery global injected', index.body.includes('__DSH_CONNECTION_RECOVERY__'))

  // ── the OIDC gate must cover NAMED routes, not just the fallback ─────────
  // Upstream ships `/plugins` (client bundles) and `/plugins/events` (SSE) with
  // NO trust check at all, so a gate that only wrapped the fallback would leave
  // them open. The gate runs before route matching, so a named route must be
  // unreachable without a session.
  const pluginsAuthed = await get('/plugins/index.js')
  check('a named /plugins route is reachable when authenticated', pluginsAuthed.status === 200, `status=${pluginsAuthed.status}`)
  const pluginsAnon = await anonymous('/plugins/index.js')
  check('the SAME named route is denied without a session', pluginsAnon.status === 401, `status=${pluginsAnon.status}`)
  const indexAnon = await anonymous('/')
  check('the index fallback is denied without a session', indexAnon.status === 401, `status=${indexAnon.status}`)
  const loginAnon = await anonymous('/auth/login')
  check('the login route stays reachable without a session', loginAnon.status !== 401, `status=${loginAnon.status}`)

  // Host/Origin fence: still enforced (defense in depth behind the OIDC gate)
  const foreign = await get('/api/anything', { host: 'evil.example.test' })
  check('foreign Host rejected by the fence', foreign.status === 403, `status=${foreign.status}`)

  // A trusted authority passes the fence; the cookie layer must NOT 401 it
  const trusted = await get('/api/anything', { host: 'harness.example.test' })
  check('trusted Host passes the cookie layer (no 401)', trusted.status !== 401, `status=${trusted.status}`)

  // cross-site fetch metadata is still refused
  const crossSite = await get('/api/anything', { host: 'harness.example.test', 'sec-fetch-site': 'cross-site' })
  check('cross-site request refused', crossSite.status === 403, `status=${crossSite.status}`)

  // ── the fork must FAIL CLOSED: no gate means no service ──────────────────
  // The fork exists only to carry the authentication gate. An un-gated fork
  // would serve the whole Harness (upstream leaves /plugins and /plugins/events
  // unchecked, and the cookie layer is bypassed by the platform patch), so the
  // seat is deny-by-default until its owner registers.
  const bareCtx = new Context()
  await bareCtx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const bare = bareCtx.webServer
  bare.registerFallback(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('unauthenticated harness')
  })
  const bareDeadline = Date.now() + 10_000
  while (bare.port === undefined && Date.now() < bareDeadline) await new Promise((r) => setTimeout(r, 20))
  const probe = (port) => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    })
    rq.on('error', reject)
    rq.end()
  })
  const ungated = await probe(bare.port)
  check('an un-gated fork refuses to serve (fail closed)', ungated === 503, `status=${ungated}`)
  bare.registerGate(() => true)
  const gated = await probe(bare.port)
  check('registering a gate is what opens the seat', gated === 200, `status=${gated}`)

  // cordis 4 tears down through fiber disposal; the process exits below.
} finally {
  if (keep) console.log(`kept workspace: ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nSMOKE OK: patched connection + webserver fork enforce the platform trust model')
// The webserver keeps the event loop alive by design; the smoke is complete.
process.exit(0)

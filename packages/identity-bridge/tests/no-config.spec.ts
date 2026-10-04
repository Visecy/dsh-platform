/**
 * A profile row may legitimately insert this plugin with NO `config:` key, and
 * cordis then hands `apply` an `undefined` config: the loader calls the plugin
 * body with the raw row config, and this package exports no runtime `Config`
 * schema, so nothing normalizes the value on the way in. These tests load the
 * plugin through that exact entry shape — `ctx.plugin(<module>)`, no config
 * argument — and assert the DEFAULT path still resolves: the frontend dist
 * index (resolved from the running CLI anchor, which is what the shipped image
 * relies on, since nothing under a profile can reach the frontend by plain Node
 * resolution) and the oauth2-proxy header names.
 *
 * Regression guarded here: an unguarded `config.distIndex` read made this shape
 * throw `TypeError: Cannot read properties of undefined (reading 'distIndex')`,
 * and cordis fails the WHOLE plugin tree when one entry does — a deployment
 * that adds the row without a config would lose its entire control plane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as connection from '@deepseek-ai/dsh-client-connection'
import * as identityBridge from '../src/index.ts'

const AUTHORITY = 'harness.example.test'
const FRONTEND_MANIFEST = '{"name":"@deepseek-ai/dsh-web-frontend","version":"0.0.0"}'
/** Only this fixture's index carries the marker, so it proves WHICH dist resolved. */
const FIXTURE_MARKER = 'no-config-fixture-marker'
const FIXTURE_HTML = `<!doctype html><html><head><title>${FIXTURE_MARKER}</title></head><body><div id="root"></div></body></html>`

interface Response {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

let root: string
let ctx: Context
let port: number

/** GET helper: raw HTTP, because the official layer classifies Host itself. */
const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })

/** Complete the official launch-token exchange and return the browser cookie. */
async function authenticate(): Promise<string> {
  const redirect = await get('/', { host: AUTHORITY })
  const token = new URL(redirect.headers.location ?? '', `http://${AUTHORITY}`)
  const exchange = await get(token.pathname + token.search, { host: AUTHORITY })
  const cookie = exchange.headers['set-cookie']?.[0]?.split(';')[0]
  if (cookie === undefined) throw new Error(`token exchange did not mint a cookie (status ${String(exchange.status)})`)
  return cookie
}

beforeAll(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-identity-bridge-'))
  // The image resolves the Web frontend from the CLI that runs the process
  // (`process.argv[1]`). Point that anchor at a fixture tree shaped like an
  // installed CLI, so the default resolution has something to find.
  const cli = join(root, 'image/lib/bin.js')
  const frontend = join(root, 'image/node_modules/@deepseek-ai/dsh-web-frontend')
  await mkdir(join(frontend, 'dist'), { recursive: true })
  await mkdir(join(root, 'image/lib'), { recursive: true })
  await writeFile(join(frontend, 'package.json'), FRONTEND_MANIFEST)
  await writeFile(join(frontend, 'dist/index.html'), FIXTURE_HTML)
  await writeFile(cli, '#!/usr/bin/env node\n')

  ctx = new Context()
  // In-memory stand-in for the credentials provider the official connection
  // plugin loads its cookie signing secret from (the control plane stays
  // stateless; the deployment persists it in Postgres).
  const records = new Map<string, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: string, update: (current: unknown) => Promise<unknown>) {
      const next = await update(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  })

  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(connection, { trustedHosts: [AUTHORITY] })
  const previousArgv1 = process.argv[1]
  process.argv[1] = cli
  try {
    // THE shape under test: no config argument at all, exactly like a profile
    // row that omits `config:`.
    await ctx.plugin(identityBridge)
  } finally {
    if (previousArgv1 === undefined) process.argv.splice(1, 1)
    else process.argv[1] = previousArgv1
  }

  const server = ctx.webServer
  const deadline = Date.now() + 10_000
  while (server.port === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  if (server.port === undefined) throw new Error('webserver did not start listening')
  port = server.port
})

afterAll(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('identity-bridge without a config row', () => {
  it('activates and publishes the transport hook through the default path', () => {
    expect(ctx.webServer.collectIndexInjections()).toContainEqual({
      kind: 'global',
      name: '__DSH_TRANSPORT__',
      value: { ownsHost: true },
    })
  })

  it('resolves the default distIndex from the running CLI anchor', async () => {
    const res = await get('/', { host: AUTHORITY, cookie: await authenticate() })
    expect(res.status).toBe(200)
    expect(res.body).toContain(FIXTURE_MARKER)
  })

  it('falls back to the oauth2-proxy upstream header names', () => {
    expect(ctx.dshAuth.currentUser({
      headers: { 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'dsh-admins, devs' },
    })).toEqual({ id: 'alice', groups: ['dsh-admins', 'devs'] })
  })
})

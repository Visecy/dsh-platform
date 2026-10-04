/**
 * The browser half of `@deepseek-ai/dsh-client-connection` reads
 * `globalThis.__DSH_TRANSPORT__` and treats `transport.ownsHost === true` as
 * "this page owns the Host" (it drives `ctx.connection.isLoopback`, host-backed
 * settings persistence, the document store, and produced-file affordances).
 *
 * Upstream publishes its own boot globals exactly this way: a host plugin
 * pushes a `{ kind: 'global', name, value }` row onto the table emitted by
 * `webserver/index-inject`, and the webserver renders head rows into every
 * served index. These tests boot the OFFICIAL webserver so the row is asserted
 * where it matters: in the rendered index.html, ahead of the boot-readiness
 * tail the client entry waits on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as identityBridge from '../src/index.ts'

const HTML = '<!doctype html><html><head><title>dsh</title></head><body><div id="root"></div></body></html>'

let root: string
let ctx: Context

beforeAll(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-identity-bridge-'))
  const distIndex = join(root, 'index.html')
  await writeFile(distIndex, HTML)
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // The plugin declares `inject = ['webServer', 'connection']`: it claims the
  // exact `/` route and performs the launch-token handoff, so a composition
  // without Connection is not one it can serve. This stand-in is only here to
  // satisfy the seat -- this suite never configures a pinned origin, so the
  // fence is not consulted.
  ctx.provide('connection', { requestRejection: () => undefined })
  await ctx.plugin(identityBridge, { distIndex })
})

afterAll(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('identity-bridge transport hook', () => {
  it('publishes the __DSH_TRANSPORT__ global through webserver/index-inject', () => {
    const rows = ctx.webServer.collectIndexInjections()
    expect(rows).toContainEqual({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })

  it('renders the transport hook into the index head, before the boot-readiness tail', () => {
    const html = ctx.webServer.renderIndex(HTML)
    const transportAt = html.indexOf('globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}')
    const readyAt = html.indexOf('__DSH_BOOT_READY__')
    expect(transportAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(-1)
    expect(transportAt).toBeLessThan(readyAt)
  })
})

/**
 * The credential provider's LIFECYCLE over the real composition.
 *
 * The other two credential specs hand the store a table (unit spec) or build it
 * by hand next to an open domain (storage spec). Neither crosses the boundary
 * the v0.1.83 outage crossed: what `apply()` itself does to the domains and to
 * the service it registers, and what an OFFICIAL consumer sees when it reaches
 * `ctx.credentials` during composition.
 *
 * The consumer modelled here is not invented: `@deepseek-ai/dsh-client-connection`
 * declares `inject: ["credentials"]` and, in its own `apply`, calls
 * `credentials.modifyRecord("client-connection/browser-session", …)` to load or
 * mint its browser-cookie signing secret. That write is the one that failed in
 * production, so the same call is made here against the real plugin body over
 * the real storage stack.
 *
 * The four cases pin the whole lifecycle contract:
 *   1. a consumer can write a credential after `apply` resolved (the outage);
 *   2. the domains a consumer reaches stay open for the plugin's lifetime;
 *   3. they close ONLY when the plugin unloads, and the captured store then
 *      refuses cleanly instead of handing out a closed domain;
 *   4. a legitimate close (the storage backend is replaced) is followed by a
 *      re-open, and a credential stored before the transition survives it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as storageDb from '../../storage-db/src/index.ts'
import * as platformDomain from '../src/index.ts'

const BACKEND = 'sqlite'

/** The official consumer's boot write, verbatim in shape. */
const BROWSER_SESSION_KEY = 'client-connection/browser-session'
const BROWSER_SESSION_RECORD = { kind: 'grant', payload: { version: 1, secret: 'c2VjcmV0' } } as const

/** What this composition's consumers reach through `ctx`. */
interface Credentials {
  modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown>
  readRecord(key: string): Promise<unknown>
  set(ref: string, value: string): Promise<void>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

interface CredentialDomains {
  credentials: { table(name: string): { get(key: string): unknown } }
}

interface Booted {
  ctx: Context
  backend: Awaited<ReturnType<Context['plugin']>>
  plugin: Awaited<ReturnType<Context['plugin']>>
  store: Credentials
}

const credentialsOf = (ctx: Context): Credentials => ctx.get('credentials') as Credentials
const domainsOf = (ctx: Context): CredentialDomains => ctx.get('platformDomains') as CredentialDomains

/** Wait for a condition the framework reaches on its own schedule. */
const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Mount the backend, then the plugin body under test — the profile's order. */
const boot = async (path: string): Promise<Booted> => {
  const ctx = new Context()
  const backend = await ctx.plugin(storageDb as never, { type: BACKEND, path })
  const plugin = await ctx.plugin(platformDomain as never, { backend: BACKEND })
  return { ctx, backend, plugin, store: credentialsOf(ctx) }
}

describe('the credential provider over the composed lifecycle', () => {
  let dir: string
  let dbPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-credential-lifecycle-'))
    dbPath = join(dir, 'platform.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('serves the official consumer write that runs after apply resolved', async () => {
    const { ctx } = await boot(dbPath)

    const written = await credentialsOf(ctx).modifyRecord(BROWSER_SESSION_KEY, async (current) =>
      current === undefined ? { ...BROWSER_SESSION_RECORD } : undefined)

    expect(written).toEqual(BROWSER_SESSION_RECORD)
    expect(await credentialsOf(ctx).readRecord(BROWSER_SESSION_KEY)).toEqual(BROWSER_SESSION_RECORD)
  })

  it('keeps every platform domain readable for the plugin lifetime', async () => {
    const { ctx } = await boot(dbPath)

    // A read through the handle consumers hold: the credential table is empty,
    // which is an answer — not the "domain is closed" failure this pins.
    expect(domainsOf(ctx).credentials.table('credentials').get('ref:DEEPSEEK_API_KEY')).toBeUndefined()

    await credentialsOf(ctx).set('DEEPSEEK_API_KEY', 'sk-live')
    expect(await credentialsOf(ctx).resolve('DEEPSEEK_API_KEY')).toEqual({ value: 'sk-live', source: 'postgres' })
    expect(domainsOf(ctx).credentials.table('credentials').get('ref:DEEPSEEK_API_KEY')).toMatchObject({
      id: 'DEEPSEEK_API_KEY',
      payload: { value: 'sk-live' },
    })
  })

  it('closes the store and its domains only when the plugin unloads', async () => {
    const { ctx, plugin } = await boot(dbPath)
    const captured = credentialsOf(ctx)
    await captured.set('DEEPSEEK_API_KEY', 'sk-alive')

    await plugin.dispose()

    // Unloading removed the services rather than leaving a store whose domain is
    // gone: a caller can no longer reach a closed domain through ctx at all.
    expect(ctx.get('credentials', false)).toBeUndefined()
    expect(ctx.get('platformDomains', false)).toBeUndefined()
    // A caller that captured the store earlier gets a clean refusal from the
    // provider itself — never a DomainError escaping from a closed domain.
    await expect(captured.set('DEEPSEEK_API_KEY', 'sk-late')).rejects.toThrow(/disposed/)
  })

  it('re-opens the domains, keeping stored credentials, when the backend is replaced', async () => {
    const { ctx, backend } = await boot(dbPath)
    await credentialsOf(ctx).modifyRecord(BROWSER_SESSION_KEY, async () => ({ ...BROWSER_SESSION_RECORD }))

    // A legitimate framework transition: the service that owns the medium goes
    // away and comes back, so the provider is unloaded and re-run.
    await backend.dispose()
    await waitFor(() => ctx.get('credentials', false) === undefined, 'the provider to unload')

    await ctx.plugin(storageDb as never, { type: BACKEND, path: dbPath })
    await waitFor(() => ctx.get('credentials', false) !== undefined, 'the provider to re-open')

    // Re-opened, not stale: the medium still holds the earlier credential.
    expect(await credentialsOf(ctx).readRecord(BROWSER_SESSION_KEY)).toEqual(BROWSER_SESSION_RECORD)
    await credentialsOf(ctx).set('DEEPSEEK_API_KEY', 'sk-after-reopen')
    expect(await credentialsOf(ctx).resolve('DEEPSEEK_API_KEY')).toEqual({ value: 'sk-after-reopen', source: 'postgres' })
  })

  it('logs a store that cannot serve once, and fails the request instead of the process', async () => {
    const { ctx, plugin } = await boot(dbPath)
    const logged: Array<{ type: string; name: string; args: unknown[] }> = []
    // The same exporter shape `@visecy/dsh-logging-stdout` mounts in the image.
    ctx.logger.exporter({ levels: { default: 3 }, export: (message) => { logged.push(message) } })

    const captured = credentialsOf(ctx)
    await plugin.dispose()
    await waitFor(() => ctx.get('credentials', false) === undefined, 'the provider to unload')

    // The request fails cleanly: the provider's own refusal, naming the
    // operation — never `DomainError: domain 'platform_credentials' is closed`.
    const first = await captured.set('DEEPSEEK_API_KEY', 'sk-late').catch((error: Error) => error)
    expect(first).toBeInstanceOf(Error)
    expect((first as Error).message).toMatch(/credential store is disposed; cannot serve "DEEPSEEK_API_KEY"/)
    expect((first as Error).name).not.toBe('DomainError')
    // A caller that keeps retrying cannot flood the pod log: one report, and the
    // failed state stays visible for an operator without becoming a crash loop.
    await expect(captured.set('DEEPSEEK_API_KEY', 'sk-later')).rejects.toThrow(/disposed/)
    await expect(captured.modifyRecord(BROWSER_SESSION_KEY, async () => undefined)).rejects.toThrow(/disposed/)

    const reported = logged.filter((message) => message.type === 'error'
      && String(message.args[0]).includes('platform credential store could not serve'))
    expect(reported).toHaveLength(1)
    // The line names the operation that failed and why, which is what an
    // operator greps for in `kubectl logs`.
    expect(String(reported[0].args[0])).toContain('could not serve "DEEPSEEK_API_KEY"')
    expect(String(reported[0].args[0])).toContain('this request fails')
    // Nothing about the failure tears the composition down: the services are
    // simply gone until the medium is back (see the re-open case above).
    expect(ctx.get('platformDomains', false)).toBeUndefined()
  })
})

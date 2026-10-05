/**
 * @visecy/dsh-platform-domain
 *
 * Declares the platform's storage-domain layouts and opens them through
 * `ctx.storageDomain`. Consumers read `ctx.platformDomains` to reach typed
 * tables for workspaces, users, settings, and credential records.
 *
 * It also PUBLISHES the durable credentials provider over the credential-records
 * table (`ctx.credentials`, the 0.2 credential seam): the store and the table
 * that holds it belong together, and the provider needs exactly the domains this
 * row has already opened. `credentials.ts` documents the seam it implements and
 * the official behaviours it reproduces. The profiles disable the official
 * file-backed `credentials` row, because the service must have one provider —
 * two would fail activation rather than share a store.
 */
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility, defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { z } from 'zod'
import { CredentialStore } from './credentials.ts'

export const inject = ['storage'] as const

export type WorkspacePhase = 'provision' | 'running' | 'sleep' | 'deleted'

export const workspacesDomain = defineDomain({
  name: 'platform_workspaces',
  version: 1,
  tables: {
    workspaces: domainTable<string, {
      workspaceId: string
      name: string
      owner?: string
      phase: WorkspacePhase
      pod?: string
      pvc?: string
      lastSleepAt?: number
    }>(z.object({
      workspaceId: z.string().min(1),
      name: z.string().default(''),
      owner: z.string().optional(),
      phase: z.enum(['provision', 'running', 'sleep', 'deleted']),
      pod: z.string().optional(),
      pvc: z.string().optional(),
      lastSleepAt: z.number().optional(),
    })),
  },
})

export const usersDomain = defineDomain({
  name: 'platform_users',
  version: 1,
  tables: {
    users: domainTable<string, {
      sub: string
      email?: string
      name?: string
      groups?: string[]
      roles: string[]
    }>(z.object({
      sub: z.string().min(1),
      email: z.string().optional(),
      name: z.string().optional(),
      groups: z.array(z.string()).optional(),
      roles: z.array(z.string()),
    })),
  },
})

export const settingsDomain = defineDomain({
  name: 'platform_settings',
  version: 1,
  tables: {
    settings: domainTable<string, {
      userId: string
      namespace: string
      section: Record<string, unknown>
      revision: number
    }>(z.object({
      userId: z.string().min(1),
      namespace: z.string().min(1),
      section: z.record(z.unknown()),
      revision: z.number().int().nonnegative(),
    })),
  },
})

export const credentialsDomain = defineDomain({
  name: 'platform_credentials',
  version: 1,
  tables: {
    credentials: domainTable<string, {
      userId: string
      scope: string
      id: string
      kind: 'api-key' | 'grant'
      payload: Record<string, unknown>
    }>(z.object({
      userId: z.string().min(1),
      scope: z.string().min(1),
      id: z.string().min(1),
      kind: z.enum(['api-key', 'grant']),
      payload: z.record(z.unknown()),
    })),
  },
})

export interface PlatformDomains {
  workspaces: Domain<typeof workspacesDomain>
  users: Domain<typeof usersDomain>
  settings: Domain<typeof settingsDomain>
  credentials: Domain<typeof credentialsDomain>
}

export async function apply(ctx: Context, config: { backend?: string } = {}): Promise<void> {
  const backendName = config.backend ?? 'sqlite'
  // On a cold boot the backend service does not exist yet, so the domains are
  // opened inside `ctx.inject`. Two things about that are load-bearing:
  //
  //  - the callback receives its OWN context (`ready`), and every resource this
  //    run creates — the domains, the `platformDomains` provide, the credential
  //    store and its disposer — is registered on THAT fiber, not on this
  //    plugin's. `ctx.inject` unloads and re-runs its callback whenever the
  //    backend service changes, so resources owned by the outer fiber would be
  //    left behind on a re-run and collide with the next one (`service
  //    "platformDomains" has been registered at …`). Owned this way, a close is
  //    followed by a clean re-open of the same medium.
  //  - the disposer is RETURNED by the effect body. An effect body's return
  //    value IS its disposer, so `ctx.effect(async () => {…})` runs the close at
  //    apply time — disposing the store and closing all four domains right after
  //    opening them, while the services stay registered for the process
  //    lifetime — and registers nothing for unload. That is the defect v0.1.83
  //    shipped: `client-connection`'s boot write reached a disposed store over a
  //    closed `platform_credentials` domain, the readiness probe never passed,
  //    and the pod restarted.
  await ctx.inject([storageBackendServiceKey(backendName)], async (ready: Context) => {
    const facility = new DomainFacility(ready, { backend: backendName })
    const workspaces = await facility.open(workspacesDomain)
    const users = await facility.open(usersDomain)
    const settings = await facility.open(settingsDomain)
    const credentials = await facility.open(credentialsDomain)
    const domains: PlatformDomains = { workspaces, users, settings, credentials }

    ready.provide('platformDomains', domains)
    // The durable credentials provider (see credentials.ts). Constructed here,
    // from the domains this run opened, so the credential-records table and the
    // service that owns it share one lifetime and cannot drift apart.
    const credentialStore = new CredentialStore(ready, domains)
    ready.effect(() => async () => {
      // Disposal first: from here the store refuses with its own error, so the
      // close below can never be observed as a closed domain by a caller that
      // still holds the store.
      await credentialStore.dispose()
      await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()])
    }, '@visecy/dsh-platform-domain')
  })
}

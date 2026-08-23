/**
 * @visecy/dsh-platform-domain
 *
 * Declares the platform's storage-domain layouts and opens them through
 * `ctx.storageDomain`. Consumers read `ctx.platformDomains` to reach typed
 * tables for workspaces, users, settings, and credential records.
 */
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility, defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { z } from 'zod'

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
  // Wait for our DB backend to register before opening domain units.
  await ctx.inject([storageBackendServiceKey(backendName)], async () => {
    // Use our own DomainFacility over the DB backend instead of the base
    // storage-domain plugin (which is routed to json by the default profile).
    const facility = new DomainFacility(ctx, { backend: backendName })
    const workspaces = await facility.open(workspacesDomain)
    const users = await facility.open(usersDomain)
    const settings = await facility.open(settingsDomain)
    const credentials = await facility.open(credentialsDomain)
    const domains: PlatformDomains = { workspaces, users, settings, credentials }

    ctx.provide('platformDomains', domains)
    ctx.effect(async () => {
      await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()])
    }, '@visecy/dsh-platform-domain')
  })
}

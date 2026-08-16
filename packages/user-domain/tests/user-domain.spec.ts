import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { UserStore } from '../src/store.ts'
import { UserSettingsProvider, UserCredentialsProvider, credentialRef } from '../src/providers.ts'
import { EnvPolicy } from '../src/env-policy.ts'
import { provideUserContext, type PlatformUser } from '../src/user-context.ts'

let root: string
let store: UserStore
let current: PlatformUser | undefined

const userA: PlatformUser = { sub: 'user-a', email: 'a@x', roles: ['user'] }
const userB: PlatformUser = { sub: 'user-b', email: 'b@x', roles: ['user'] }

beforeEach(async () => {
  root = await mkdtemp(join(process.cwd(), '.tmp-userdomain-'))
  store = new UserStore(root)
  current = undefined
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('per-user settings', () => {
  it('isolates settings between users', async () => {
    const ctx = new Context()
    const s = new UserSettingsProvider(ctx, store, () => current)
    current = userA
    await s.persist('models' as never, { provider: 'deepseek' })
    current = userB
    await s.persist('models' as never, { provider: 'openai' })
    current = userA
    const docA = await s.load()
    expect((docA.models as { provider: string }).provider).toBe('deepseek')
    current = userB
    const docB = await s.load()
    expect((docB.models as { provider: string }).provider).toBe('openai')
  })

  it('anonymous sessions get no user document', async () => {
    const ctx = new Context()
    const s = new UserSettingsProvider(ctx, store, () => current)
    expect(await s.load()).toEqual({})
    await expect(s.persist('x' as never, { a: 1 })).rejects.toThrow(/no authenticated user/)
  })
})

describe('per-user credentials', () => {
  it('isolates credentials and resolves per call', async () => {
    const ctx = new Context()
    const c = new UserCredentialsProvider(ctx, store, () => current)
    current = userA
    await c.set(credentialRef('DEEPSEEK_API_KEY'), 'key-a')
    current = userB
    await c.set(credentialRef('DEEPSEEK_API_KEY'), 'key-b')

    current = userA
    const ra = await c.resolve(credentialRef('DEEPSEEK_API_KEY'))
    expect(ra?.value).toBe('key-a')
    expect(ra?.source).toContain('user-a')

    current = userB
    const rb = await c.resolve(credentialRef('DEEPSEEK_API_KEY'))
    expect(rb?.value).toBe('key-b')

    // user A does not see user B's other keys
    current = userA
    const info = await c.describe(credentialRef('NOPE'))
    expect(info.configured).toBe(false)
  })

  it('unset removes only own credential', async () => {
    const ctx = new Context()
    const c = new UserCredentialsProvider(ctx, store, () => current)
    current = userA
    await c.set(credentialRef('TOKEN'), 'a')
    await c.unset(credentialRef('TOKEN'))
    expect(await c.resolve(credentialRef('TOKEN'))).toBeUndefined()
  })

  it('anonymous cannot resolve or write', async () => {
    const ctx = new Context()
    const c = new UserCredentialsProvider(ctx, store, () => current)
    expect(await c.resolve(credentialRef('K'))).toBeUndefined()
    await expect(c.set(credentialRef('K'), 'v')).rejects.toThrow(/no authenticated user/)
  })
})

describe('env policy allowlist', () => {
  it('only injects allowlisted names', () => {
    const p = new EnvPolicy({
      globalAllowlist: ['NPM_TOKEN'],
      perGroup: { 'k8s-admins': ['KUBE_TOKEN'] },
      perUser: { 'user-b': ['GIT_TOKEN'] },
    })
    const admin: PlatformUser = { sub: 'user-a', groups: ['k8s-admins'], roles: ['admin'] }
    const env = { NPM_TOKEN: '1', KUBE_TOKEN: '2', GIT_TOKEN: '3', DEEPSEEK_API_KEY: '4' }
    expect(p.filter(admin, env)).toEqual({ NPM_TOKEN: '1', KUBE_TOKEN: '2' })
    const b: PlatformUser = { sub: 'user-b', roles: ['user'] }
    expect(p.filter(b, env)).toEqual({ NPM_TOKEN: '1', GIT_TOKEN: '3' })
    expect(p.filter(undefined, env)).toEqual({ NPM_TOKEN: '1' })
  })

  it('default policy injects nothing', () => {
    const p = new EnvPolicy({})
    expect(p.filter({ sub: 'u', roles: ['user'] }, { ANY: 'v' })).toEqual({})
  })
})

describe('user context service', () => {
  it('exposes the resolved user', () => {
    const ctx = new Context()
    const svc = provideUserContext(ctx, () => current)
    expect(svc.user).toBeUndefined()
    current = userA
    expect(svc.user?.sub).toBe('user-a')
  })
})

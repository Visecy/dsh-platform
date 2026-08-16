/**
 * Current-user resolution for the platform. The auth plugin (auth-oidc)
 * supplies the session; this service exposes a stable ctx.currentUser with
 * an injectable source so tests can run without an IdP.
 */
import { Context, Service } from '@deepseek-ai/cordis'

export interface PlatformUser {
  sub: string
  email?: string
  name?: string
  groups?: string[]
  roles: string[]
}

export type CurrentUserSource = () => PlatformUser | undefined

export class UserContextService extends Service {
  private source: CurrentUserSource

  constructor(ctx: Context, source: CurrentUserSource) {
    super(ctx)
    this.source = source
  }

  get user(): PlatformUser | undefined {
    return this.source()
  }
}

export function provideUserContext(ctx: Context, source: CurrentUserSource): UserContextService {
  const svc = new UserContextService(ctx, source)
  ctx.provide('currentUser', svc)
  return svc
}

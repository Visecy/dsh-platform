/**
 * Execution env policy: which user credentials may be injected into the
 * workspace pod execution environment. Explicit allowlist only.
 */
import type { PlatformUser } from './user-context.ts'

export interface EnvPolicyConfig {
  /** Global allowlist of credential names injectable for any user. */
  globalAllowlist?: string[]
  /** Per-user allowlists (overrides global for those users). */
  perUser?: Record<string, string[]>
  /** Per-group allowlists. */
  perGroup?: Record<string, string[]>
}

export class EnvPolicy {
  constructor(private config: EnvPolicyConfig) {}

  /** Names allowed for a user (union of matching scopes). */
  allowedNames(user: PlatformUser | undefined): Set<string> {
    const out = new Set<string>()
    if (this.config.globalAllowlist !== undefined) {
      for (const n of this.config.globalAllowlist) out.add(n)
    }
    if (user !== undefined) {
      for (const n of this.config.perUser?.[user.sub] ?? []) out.add(n)
      for (const g of user.groups ?? []) {
        for (const n of this.config.perGroup?.[g] ?? []) out.add(n)
      }
    }
    return out
  }

  /**
   * Filter a candidate env map (credential name -> value) down to the
   * allowlist. Names not allowed are dropped (never injected).
   */
  filter(user: PlatformUser | undefined, env: Record<string, string>): Record<string, string> {
    const allowed = this.allowedNames(user)
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (allowed.has(k)) out[k] = v
    }
    return out
  }
}

/**
 * Per-user settings and credentials providers (official seam shapes).
 * Each user's document lives in <root>/users/<id>/{settings.json,credentials.json}.
 */
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CredentialProvider, credentialRef, parseCredentialKey, type CredentialInfo, type CredentialKey, type CredentialRecord, type CredentialRecordEntry, type CredentialRecordInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { UserStore } from './store.ts'
import type { PlatformUser } from './user-context.ts'

export type UserResolver = () => PlatformUser | undefined

export class UserSettingsProvider extends SettingsProvider {
  readonly writable = true
  private docPath: string | undefined

  constructor(
    ctx: Context,
    private store: UserStore,
    private resolveUser: UserResolver,
    documentPath: string | undefined = undefined,
  ) {
    super(ctx)
    this.docPath = documentPath
  }

  override get documentPath(): string | undefined {
    return this.docPath
  }

  protected async load(): Promise<Record<string, unknown>> {
    const user = this.resolveUser()
    if (user === undefined) return {}
    return this.store.read(user.sub, 'settings.json')
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const user = this.resolveUser()
    if (user === undefined) throw new Error('no authenticated user for settings write')
    const doc = await this.store.read(user.sub, 'settings.json')
    doc[ns] = section
    await this.store.write(user.sub, 'settings.json', doc)
  }
}

export class UserCredentialsProvider extends CredentialProvider {
  constructor(
    ctx: Context,
    private store: UserStore,
    private resolveUser: UserResolver,
  ) {
    super(ctx)
  }

  private async doc(userId: string): Promise<Record<string, unknown>> {
    return this.store.read(userId, 'credentials.json')
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const user = this.resolveUser()
    if (user === undefined) return undefined
    const doc = await this.doc(user.sub)
    const value = doc[ref]
    if (typeof value !== 'string') return undefined
    return { value, source: `user:${user.sub}` }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const user = this.resolveUser()
    const value = user === undefined ? undefined : await this.resolve(ref)
    return {
      configured: value !== undefined,
      source: value?.source,
      writable: user !== undefined,
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    const user = this.resolveUser()
    if (user === undefined) throw new Error('no authenticated user for credential write')
    if (value === '') throw new Error('empty credential value')
    const doc = await this.doc(user.sub)
    doc[ref] = value
    await this.store.write(user.sub, 'credentials.json', doc)
  }

  async unset(ref: CredentialRef): Promise<void> {
    const user = this.resolveUser()
    if (user === undefined) return
    const doc = await this.doc(user.sub)
    if (ref in doc) {
      delete doc[ref]
      await this.store.write(user.sub, 'credentials.json', doc)
    }
  }

  // ── credential records (DSH >= 0.1.1) ─────────────────────────────────────

  private async recordsDoc(userId: string): Promise<Record<string, unknown>> {
    return this.store.read(userId, 'credential-records.json')
  }

  private currentUserId(): string | undefined {
    return this.resolveUser()?.sub
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const userId = this.currentUserId()
    if (userId === undefined) return undefined
    const doc = await this.recordsDoc(userId)
    return doc[String(key)] as CredentialRecord | undefined
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const userId = this.currentUserId()
    const record = userId === undefined ? undefined : await this.readRecord(key)
    return {
      configured: record !== undefined,
      kind: record?.kind,
      writable: userId !== undefined,
    }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const userId = this.currentUserId()
    if (userId === undefined) return []
    const doc = await this.recordsDoc(userId)
    const entries: CredentialRecordEntry[] = []
    for (const [key, value] of Object.entries(doc)) {
      const record = value as { kind?: CredentialRecord['kind'] }
      if (record?.kind === undefined) continue
      try {
        entries.push({ key: parseCredentialKey(key), kind: record.kind })
      } catch {
        // Ignore malformed keys left by older/other writers.
      }
    }
    return entries
  }

  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    const userId = this.currentUserId()
    if (userId === undefined) throw new Error('no authenticated user for credential write')
    const doc = await this.recordsDoc(userId)
    const current = doc[String(key)] as CredentialRecord | undefined
    const next = await mutate(current)
    if (next === undefined) return current
    doc[String(key)] = next
    await this.store.write(userId, 'credential-records.json', doc)
    return next
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    const userId = this.currentUserId()
    if (userId === undefined) return
    const doc = await this.recordsDoc(userId)
    if (String(key) in doc) {
      delete doc[String(key)]
      await this.store.write(userId, 'credential-records.json', doc)
    }
  }
}

export { credentialRef }

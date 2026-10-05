/**
 * Durable credentials provider: `ctx.credentials` over the platform's own
 * PostgreSQL-backed storage.
 *
 * ## Why this exists
 *
 * The Harness's default provider (`@deepseek-ai/dsh-credentials-local`) keeps
 * its store in `$DSH_HOME/.credentials.yaml`. This deployment mounts `DSH_HOME`
 * as an emptyDir — it is restored from the image on every boot — so every pod
 * replacement wiped the file and the operator had to type the model API key in
 * again after every upgrade. A stored credential is control-plane state, not
 * user content, and it must outlive the pod. Here it lives in the
 * `platform_credentials` domain (see `index.ts`), which `storage-db` serves from
 * PostgreSQL and which already declares this exact table.
 *
 * ## The seam (0.2)
 *
 * 0.2's credential seam is `CredentialProvider` in
 * `@deepseek-ai/dsh-credentials`: an abstract cordis `Service` whose
 * constructor registers the name `credentials`, with a reference half
 * (`resolve`/`describe`/`set`/`unset`, keyed by an environment-variable name)
 * and a record half (`readRecord`/`describeRecord`/`listRecords`/
 * `modifyRecord`/`deleteRecord`, keyed by `<scope>/<id>`). The old
 * `SettingsProvider` class the settings surface once used does not exist in
 * 0.2, and neither does a settings *provider* seam; the model API key the
 * operator re-typed is a credential (`llm-deepseek-api-key` resolves
 * `DEEPSEEK_API_KEY` through this service, and the web Models page writes it
 * through `dsh-api-settings-controller`'s credentials namespace, which calls
 * `set(ref, value)`).
 *
 * This class implements that surface STRUCTURALLY — the service name and the
 * method contracts are the seam, and every consumer reaches it through
 * `ctx.credentials` / `inject: ['credentials']`. That is the same posture the
 * rest of this repo takes at official seams (see `HostWorkspaceRegistry`), and
 * it is what lets the provider live in the package that already owns the
 * credential-records table instead of adding a dependency on the official
 * library for an abstract base class. The behaviours that are NOT negotiable
 * are reproduced from the official provider deliberately, and each is pinned by
 * a case in `tests/credentials.spec.ts`:
 *
 *  - the launching environment is layered OVER the store and is read-only: a
 *    `DEEPSEEK_API_KEY=…` in the pod's environment is this run's explicit
 *    intent, so a write that it would shadow is REFUSED rather than silently
 *    ineffective;
 *  - an empty stored value is absent everywhere (`set` refuses it, `unset` is
 *    what removes a credential);
 *  - a write is validated at the durable boundary, because a row that cannot be
 *    read back is a credential that silently stopped working;
 *  - `modifyRecord` is a serialized read-decide-write, which is what makes a
 *    token refresh safe, and returning `undefined` writes nothing;
 *  - committed changes emit `credentials/reference-updated` /
 *    `credentials/record-updated`, which is how a changed credential reaches
 *    the next operation without a restart.
 *
 * ## What is deliberately narrower than the official provider
 *
 * The `.env` fallback layers are read from the launcher's environment snapshot
 * when the product CLI provides one, exactly as the official provider reads
 * them, but they are never loaded from disk here: on this control plane they
 * would point into the same ephemeral `DSH_HOME` this provider exists to stop
 * depending on. Writes go to PostgreSQL only.
 *
 * ## Single provider
 *
 * Exactly one provider may register `credentials`, so the profiles disable the
 * official `credentials` row (see `docker/profiles/*.cordis.patch.yml`). Two
 * live providers would fail activation loudly rather than split the store.
 *
 * @module @visecy/dsh-platform-domain/credentials
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** The launcher's environment snapshot slot (`@deepseek-ai/dsh-launch-environment`). */
interface LaunchEnvironmentEntry {
  value: string
  source: 'process' | 'project-env' | 'user-env'
}
interface LaunchEnvironmentSnapshot {
  get(name: string): LaunchEnvironmentEntry | undefined
  getFrom(name: string, sources: readonly ('process' | 'project-env' | 'user-env')[]): LaunchEnvironmentEntry | undefined
}

/** One stored row, as `platform_credentials.credentials` declares it. */
export interface CredentialRow {
  userId: string
  scope: string
  id: string
  kind: 'api-key' | 'grant'
  payload: Record<string, unknown>
}

/** The declared table handle this provider consumes (structural, like the seam). */
export interface CredentialTable {
  get(key: string): CredentialRow | undefined
  entries(): IterableIterator<[string, CredentialRow]>
  readonly size: number
  put(key: string, value: CredentialRow): Promise<void>
  delete(key: string): Promise<boolean>
}

/** The slice of `ctx.platformDomains` this provider needs. */
export interface CredentialDomains {
  credentials: { table(name: 'credentials'): CredentialTable }
}

/**
 * The store's owner column value.
 *
 * The seam has no user concept — a model API key belongs to the deployment, and
 * the LLM provider resolving it does not know which human is asking — so the
 * platform stores one owner's credentials, not one set per user. The column
 * exists because the domain declares it (the table was written for a future
 * per-user surface), and naming the owner explicitly is what keeps that choice
 * visible instead of implied.
 */
export const PLATFORM_CREDENTIAL_OWNER = 'platform'

/** Reserved scope marking a REFERENCE row (as opposed to a `<scope>/<id>` record). */
const REFERENCE_SCOPE = 'ref'
/** Key prefix for reference rows, so the two key spaces cannot collide. */
const REFERENCE_PREFIX = 'ref:'
/** Provider-defined source layer id, mirroring the official provider's `file`. */
const SOURCE = 'postgres'

/** A reference name: the seam's `CredentialRef` grammar. */
const REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** One `CredentialKey` segment: a lowercase hyphenated identifier. */
const KEY_SEGMENT = /^[a-z0-9][a-z0-9-]*$/

/** One record, as the seam defines the union. */
export type CredentialRecord =
  | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
  | { readonly kind: 'grant'; readonly payload: unknown }

/** Presence and writability of one reference, never the value. */
export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** Presence and discriminant of one record, never the value. */
export interface CredentialRecordInfo {
  configured: boolean
  kind?: CredentialRecord['kind']
  writable: boolean
}

/** One enumerated record address. */
export interface CredentialRecordEntry {
  key: string
  kind: CredentialRecord['kind']
}

/**
 * Refuse a value that cannot survive the round trip through the table.
 *
 * The seam promises an owner its payload comes back exactly as written, and
 * JSON is what the medium round-trips: `NaN`, a class instance or a cycle would
 * come back as `null`, a plain object or a stack overflow instead. Validated on
 * the way IN, because a durable write that cannot be read back is worse than a
 * rejected one.
 * @param where - subject named in the diagnostic (never the value).
 * @param value - the candidate.
 * @param seen - objects on the current path, for cycle detection.
 */
function assertJsonValue(where: string, value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new TypeError(`credentials: ${where} holds a non-finite number`)
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`credentials: ${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`credentials: ${where} holds a value JSON cannot represent`)
}

/** Assert one reference name is addressable. */
function assertReferenceName(name: string): void {
  if (!REFERENCE_NAME.test(name)) throw new TypeError(`credentials: '${name}' is not a valid credential reference`)
}

/** Split a `<scope>/<id>` record address, rejecting anything else. */
function splitKey(key: string): { scope: string; id: string } {
  const parts = key.split('/')
  if (parts.length !== 2 || !KEY_SEGMENT.test(parts[0]) || !KEY_SEGMENT.test(parts[1])) {
    throw new TypeError(`credentials: '${key}' is not a '<scope>/<id>' credential key`)
  }
  return { scope: parts[0], id: parts[1] }
}

/**
 * The reference from a table key, or `undefined` for a record row.
 * @param key - stored key.
 * @returns the reference name when this row is a reference.
 */
function referenceOf(key: string): string | undefined {
  return key.startsWith(REFERENCE_PREFIX) ? key.slice(REFERENCE_PREFIX.length) : undefined
}

/**
 * Durable credential provider over one `platform_credentials` table.
 *
 * Writes are serialized on {@link tail} so a read-decide-write cannot interleave
 * with another writer in this process — which is what makes `modifyRecord`'s
 * rotation safe. (The deployment runs one control-plane replica; the row itself
 * is written through the domain's own durable write chain.)
 */
export class CredentialStore extends Service {
  /** Tail of the write queue; see the class doc. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Set at disposal: refuse new writes instead of writing into a closed domain. */
  private closed = false

  constructor(ctx: Context, private readonly domains: CredentialDomains) {
    super(ctx, 'credentials')
  }

  private table(): CredentialTable {
    return this.domains.credentials.table('credentials')
  }

  /** Queue one exclusive write behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }

  private assertWritable(what: string): void {
    if (this.closed) throw new Error(`credentials: the platform credential store is disposed; cannot write ${what}`)
  }

  /** The launcher's environment snapshot, when this composition has one. */
  private environment(): LaunchEnvironmentSnapshot | undefined {
    return this.ctx.get('launchEnvironment', false) as LaunchEnvironmentSnapshot | undefined
  }

  /**
   * The inherited-environment value for a reference: the most trusted layer and
   * the only one that can shadow a write.
   */
  private inherited(ref: string): { value: string; source: string } | undefined {
    const entry = this.environment()?.getFrom(ref, ['process'])
    if (entry !== undefined && entry.value.length > 0) return { value: entry.value, source: 'env' }
    // The launcher fills the slot before any config entry mounts; a bare
    // composition (a test, a library embed) has none, and then the inherited
    // environment IS the process environment.
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? { value: ambient, source: 'env' } : undefined
  }

  /** The `.env` layers, read from the launcher's snapshot only (never from disk here). */
  private dotenv(ref: string): { value: string; source: string } | undefined {
    const entry = this.environment()?.getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? { value: entry.value, source: entry.source } : undefined
  }

  /** The stored value of one reference, or undefined while absent. */
  private stored(ref: string): string | undefined {
    const row = this.table().get(REFERENCE_PREFIX + ref)
    const value = row?.payload.value
    // An empty stored value is absent everywhere: a blank must never read as a
    // configured secret (the seam's one rule for this half).
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /** Resolve one reference: environment, then the store, then `.env`. */
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    return this.inherited(ref)
      ?? (this.stored(ref) !== undefined ? { value: this.stored(ref) as string, source: SOURCE } : undefined)
      ?? this.dotenv(ref)
  }

  /** Describe one reference without exposing its value. */
  async describe(ref: string): Promise<CredentialInfo> {
    if (this.inherited(ref) !== undefined) return { configured: true, source: 'env', writable: false }
    if (this.stored(ref) !== undefined) return { configured: true, source: SOURCE, writable: true }
    const fallback = this.dotenv(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  /** Store one reference value durably. */
  async set(ref: string, value: string): Promise<void> {
    assertReferenceName(ref)
    if (value.length === 0) throw new Error(`credentials: an empty value cannot be stored for "${ref}"; use unset`)
    this.assertWritable(`"${ref}"`)
    // A write the inherited environment would shadow must refuse, not appear to
    // succeed while resolution keeps returning the environment's value.
    if (this.inherited(ref) !== undefined) {
      throw new Error(`credentials: "${ref}" is supplied read-only by the launching environment, so a write would be shadowed; unset it in the environment this process was started with instead`)
    }
    await this.enqueue(async () => {
      await this.table().put(REFERENCE_PREFIX + ref, {
        userId: PLATFORM_CREDENTIAL_OWNER,
        scope: REFERENCE_SCOPE,
        id: ref,
        kind: 'api-key',
        payload: { value },
      })
      this.notifyUpdated(ref)
    })
  }

  /** Remove one reference from the store; removing an absent one writes nothing. */
  async unset(ref: string): Promise<void> {
    assertReferenceName(ref)
    this.assertWritable(`"${ref}"`)
    if (this.inherited(ref) !== undefined) {
      throw new Error(`credentials: "${ref}" is supplied read-only by the launching environment, so removing the stored value would be shadowed; unset it in the environment this process was started with instead`)
    }
    await this.enqueue(async () => {
      // Absence is checked before the write so an unset of something never
      // stored costs no durable operation and emits nothing at all.
      if (this.table().get(REFERENCE_PREFIX + ref) === undefined) return
      await this.table().delete(REFERENCE_PREFIX + ref)
      this.notifyUpdated(ref)
    })
  }

  /** Read one stored record. */
  async readRecord(key: string): Promise<CredentialRecord | undefined> {
    const row = this.recordRow(key)
    if (row === undefined) return undefined
    return row.payload.record as CredentialRecord
  }

  /** Describe one record without exposing its value. */
  async describeRecord(key: string): Promise<CredentialRecordInfo> {
    const row = this.recordRow(key)
    if (row === undefined) return { configured: false, writable: true }
    return { configured: true, kind: row.kind, writable: true }
  }

  /** Every stored record's address and tag. */
  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries: CredentialRecordEntry[] = []
    for (const [key, row] of this.table().entries()) {
      if (referenceOf(key) !== undefined) continue
      entries.push({ key, kind: row.kind })
    }
    return entries
  }

  /**
   * Serialized read-decide-write over one record: `mutate` sees the record as it
   * stands at the moment the write is exclusive, and returning `undefined`
   * leaves the row untouched.
   */
  async modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    splitKey(key)
    this.assertWritable(`record "${key}"`)
    return this.enqueue(async () => {
      const current = this.recordRow(key)?.payload.record as CredentialRecord | undefined
      const next = await mutate(current)
      if (next === undefined) return current
      this.assertStorable(key, next)
      await this.table().put(key, {
        userId: PLATFORM_CREDENTIAL_OWNER,
        scope: splitKey(key).scope,
        id: splitKey(key).id,
        kind: next.kind,
        payload: { record: next },
      })
      this.notifyRecordUpdated(key)
      return next
    })
  }

  /** Remove one record; removing an absent one is a no-op. */
  async deleteRecord(key: string): Promise<void> {
    splitKey(key)
    this.assertWritable(`record "${key}"`)
    await this.enqueue(async () => {
      const removed = await this.table().delete(key)
      if (removed) this.notifyRecordUpdated(key)
    })
  }

  /** The stored row of one record, or undefined. */
  private recordRow(key: string): CredentialRow | undefined {
    splitKey(key)
    return this.table().get(key)
  }

  /**
   * Refuse a record the read path could not admit, before it is written: an
   * empty key, an env name outside the reference grammar, an empty env value,
   * or a payload that cannot survive the round trip.
   */
  private assertStorable(key: string, record: CredentialRecord): void {
    if (record.kind === 'grant') {
      assertJsonValue(`record "${key}" payload`, record.payload, new Set())
      return
    }
    if (record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) {
      throw new TypeError(`credentials: record "${key}" has an empty key; omit the field instead`)
    }
    for (const [name, value] of Object.entries(record.env ?? {})) {
      assertReferenceName(name)
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`credentials: record "${key}" env "${name}" must be a non-empty string`)
      }
    }
  }

  /** Announce one committed reference change (the seam's documented event). */
  private notifyUpdated(ref: string): void {
    this.ctx.emit('credentials/reference-updated', ref)
  }

  /** Announce one committed record change. */
  private notifyRecordUpdated(key: string): void {
    this.ctx.emit('credentials/record-updated', key)
  }

  /** Stop accepting writes and let the in-flight ones finish. */
  async dispose(): Promise<void> {
    this.closed = true
    await this.tail
  }
}

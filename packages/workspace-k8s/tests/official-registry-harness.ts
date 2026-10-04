/**
 * Real-official-registry test harness.
 *
 * The rebind defect turned on a semantic a hand-written fake registry got
 * wrong, so this harness runs the REAL `@deepseek-ai/dsh-workspace`
 * `WorkspaceRegistry` (vendored under `tests/vendor/`, see its README) with only
 * its two declared seams stubbed:
 *
 * - `storageDomain`: an in-memory implementation of the domain data form with
 *   the same observable contract (zod validation at the durability boundary,
 *   every write awaited before memory changes, synchronous reads, one
 *   `domain/changed` event per committed write).
 * - `sessionPersistence`: a listable set of stored session headers.
 *
 * Everything that decides the outcome — the one-shot startup header index, the
 * `sessionIds` getter's cwd filter, `attachSession`'s short-circuit order, and
 * `mutate`'s prune-on-write — is the shipped official code.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  WorkspaceRegistry,
  workspaceDomainSpec,
} from './vendor/dsh-workspace/lib/index.js'

/** One stored session header, as `sessionPersistence.list()` projects it. */
export interface StoredHeader {
  id: string
  cwd?: string
  createdAt: number
}

/** The durable medium: what a pod replacement must survive. */
export interface DurableState {
  /** Raw workspace records by id, exactly as the domain stores them. */
  records: Map<string, Record<string, unknown>>
  /** The domain's global singleton; `undefined` means "never written". */
  global: Record<string, unknown> | undefined
}

export interface HarnessOptions {
  /** Workspace records to seed, in durable registry order. */
  records?: readonly { path: string; title?: string; sessionIds?: readonly string[] }[]
  /** Stored session headers the registry indexes and validates at init. */
  storedSessions?: readonly StoredHeader[]
  /** A seeded domain global (e.g. an already-`initialized` registry). */
  global?: Record<string, unknown>
}

export interface Harness {
  ctx: Context
  registry: WorkspaceRegistry
  /** The durable medium, for asserting what a write actually committed. */
  durable: DurableState
  /** Every committed write, in order — the idempotency oracle. */
  writes: string[]
  /** The warnings the official registry emitted during init. */
  warnings: string[]
  /**
   * The same `sessionPersistence` seam the registry indexes from, in the shape
   * the reconciler's `SessionHeaderSource` consumes. Point it at different
   * headers to model a different stored history.
   */
  sessions: { list(): Promise<readonly { readonly header: StoredHeader }[]> }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * In-memory stand-in for the `storageDomain.open(spec)` handle.
 *
 * The official `DomainFacility` parses every stored record with the spec's zod
 * schema and commits each write to the medium before mutating memory; this
 * reproduces exactly that, because the entity's `mutate` depends on it (a write
 * that throws must leave the in-memory record untouched).
 */
class MemoryDomain {
  private chain: Promise<unknown> = Promise.resolve()
  private globalValue: Record<string, unknown> | undefined
  private closed = false

  constructor(
    private ctx: Context,
    private durable: DurableState,
    private writes: string[],
  ) {
    this.globalValue = durable.global
  }

  get global() {
    return {
      get: (): Record<string, unknown> => {
        this.assertReadable()
        return this.globalValue
          ?? (workspaceDomainSpec.global?.initial as Record<string, unknown>)
      },
      set: (value: Record<string, unknown>) => this.enqueue(async () => {
        this.durable.global = value
        this.writes.push('global')
        this.globalValue = value
        this.emit('', 'put', value)
      }),
    }
  }

  table(name: string) {
    assert(name === 'workspaces', `harness: unexpected domain table '${name}'`)
    const records = this.durable.records
    return {
      get size(): number {
        return records.size
      },
      get: (key: string): Record<string, unknown> | undefined => records.get(key),
      entries: (): IterableIterator<[string, Record<string, unknown>]> =>
        [...records.entries()][Symbol.iterator](),
      keys: (): IterableIterator<string> => [...records.keys()][Symbol.iterator](),
      put: (key: string, value: Record<string, unknown>) => this.enqueue(async () => {
        const parsed = this.parseRecord(value)
        records.set(key, parsed)
        this.writes.push(`put:${key}`)
        this.emit(key, 'put', parsed)
      }),
      delete: (key: string) => this.enqueue(async () => {
        if (!records.has(key)) return false
        records.delete(key)
        this.writes.push(`delete:${key}`)
        this.emit(key, 'deleted', undefined)
        return true
      }),
      update: (
        key: string,
        fn: (current: Record<string, unknown>) => Record<string, unknown>,
      ) => this.enqueue(async () => {
        const current = records.get(key)
        assert(current !== undefined, `harness: no record '${key}' to update`)
        const next = this.parseRecord(fn(current))
        records.set(key, next)
        this.writes.push(`update:${key}`)
        this.emit(key, 'put', next)
        return next
      }),
    }
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }

  private parseRecord(value: Record<string, unknown>): Record<string, unknown> {
    return workspaceDomainSpec.tables.workspaces.valueSchema.parse(value) as Record<string, unknown>
  }

  private emit(key: string, operation: string, value: unknown): void {
    this.ctx.emit('domain/changed', {
      domain: 'workspace',
      table: 'workspaces',
      key,
      operation,
      value,
    })
  }

  private assertReadable(): void {
    assert(!this.closed, 'harness: domain is closed')
  }

  /** One write chain, like the official domain: writes commit in call order. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

/** The medium + seams every harness composition starts from, before it is mounted. */
interface Composition {
  durable: DurableState
  writes: string[]
  warnings: string[]
  sessions: Harness['sessions']
}

/** Seed the durable medium and the session seam, shared by both composition shapes. */
function prepare(options: HarnessOptions): Composition {
  const durable: DurableState = { records: new Map(), global: options.global }
  const writes: string[] = []
  const warnings: string[] = []
  const storedSessions = options.storedSessions ?? []

  for (const record of options.records ?? []) {
    const now = new Date(1791000000000).toISOString()
    durable.records.set(`ws-${record.path}`, {
      path: record.path,
      title: record.title ?? record.path.split('/').filter(Boolean).at(-1) ?? record.path,
      sessionIds: [...(record.sessionIds ?? [])],
      createdAt: now,
      updatedAt: now,
    })
  }

  return {
    durable,
    writes,
    warnings,
    sessions: {
      list: async (): Promise<readonly { readonly header: StoredHeader }[]> =>
        storedSessions.map((header) => ({ header })),
    },
  }
}

/** Keep the official registry's own diagnostics visible to the test. */
function recordWarnings(ctx: Context, warnings: string[]): void {
  // The "filtered session" warning the registry emits at init is part of the
  // bug's evidence; it must not be swallowed by the fixture.
  ctx.logger.warn = ((message: unknown, ...rest: unknown[]) => {
    warnings.push(String(message))
    return undefined
  }) as never
}

/**
 * Boot a real official `WorkspaceRegistry` over an in-memory medium.
 *
 * `[Service.init]()` is awaited explicitly — that call IS the registry's
 * lifecycle (open the domain, run the one-shot `replaceHeaderIndex`, history
 * bootstrap, live-session index, entity rebuild). cordis would invoke it from
 * `ctx.plugin`; calling it directly keeps the fixture free of fiber scheduling
 * without skipping a single official line.
 */
export async function startRegistry(options: HarnessOptions = {}): Promise<Harness> {
  const { durable, writes, warnings, sessions } = prepare(options)
  const ctx = new Context()
  recordWarnings(ctx, warnings)

  const domain = new MemoryDomain(ctx, durable, writes)
  // The two seams `WorkspaceRegistry.inject` declares. The registry reads them
  // through `this.ctx`, so a plain provision is exactly what it sees.
  ctx.provide('storageDomain' as never, { open: async () => domain } as never)
  ctx.provide('sessionPersistence' as never, sessions as never)

  const registry = new WorkspaceRegistry(ctx) as unknown as WorkspaceRegistry & {
    [Service.init]?: () => Promise<void>
  }
  await registry[Service.init]?.()

  return { ctx, registry, durable, writes, warnings, sessions }
}

/**
 * Boot the same real official `WorkspaceRegistry`, but as a PLUGIN ROW — the
 * shape the profile loader actually mounts.
 *
 * The difference is not cosmetic. `startRegistry` provisions both seams on the
 * ROOT context, so cordis's service proxy resolves them from any child by
 * walking up to the root fiber. A profile mounts every seam as its own row, so
 * `sessionPersistence` lives on a SIBLING fiber, and a plugin that reads
 * `ctx.sessionPersistence` without declaring it in `inject` gets
 * `cannot get property "sessionPersistence" without inject` — the defect that
 * silently disabled the session<->workspace rebind for its whole life. Tests
 * about a plugin's own wiring must therefore mount the plugin here, not on
 * `startRegistry`.
 */
export async function startPluginComposition(options: HarnessOptions = {}): Promise<Harness> {
  const { durable, writes, warnings, sessions } = prepare(options)
  const ctx = new Context()
  recordWarnings(ctx, warnings)

  const domain = new MemoryDomain(ctx, durable, writes)
  await ctx.plugin({
    name: 'harness-storage-domain',
    apply: (row: Context) => { row.provide('storageDomain' as never, { open: async () => domain } as never) },
  })
  await ctx.plugin({
    name: 'harness-session-persistence',
    apply: (row: Context) => { row.provide('sessionPersistence' as never, sessions as never) },
  })
  // The official registry is a plugin like any other: its `static inject` is
  // what makes cordis hold it back until both seams above are active.
  await ctx.plugin(WorkspaceRegistry as never)
  const registry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistry
  assert(registry !== undefined, 'harness: the official registry did not activate')

  return { ctx, registry, durable, writes, warnings, sessions }
}

/**
 * @visecy/dsh-storage-db
 *
 * Concrete `ctx.storage` backend exposing the `kv` facet over SQLite or
 * PostgreSQL. Intended for platform domain data (workspace registry, lifecycle
 * state, user settings, credential records, authorization flows) so the
 * control plane can move off local JSON/shared files.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
import { Storage, storageBackendServiceKey, type StorageBackend, type KvFacet, type KvUnitDescriptor, type KvUnit } from '@deepseek-ai/dsh-storage'

export const inject = ['storage'] as const

export const name = '@visecy/dsh-storage-db'

export type Config =
  | { type: 'sqlite'; path: string }
  | { type: 'postgres'; connectionString: string }

interface DbDriver {
  run(sql: string, ...params: unknown[]): Promise<void>
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

class SqliteDriver implements DbDriver {
  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dsh_storage_units (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        has_global INTEGER NOT NULL,
        tables_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dsh_storage_records (
        unit TEXT NOT NULL,
        table_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        PRIMARY KEY (unit, table_name, key)
      );
      CREATE TABLE IF NOT EXISTS dsh_storage_global (
        unit TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `)
  }

  async run(sql: string, ...params: unknown[]): Promise<void> {
    this.db.prepare(sql).run(...params)
  }
  async get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined
  }
  async all<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[]
  }
  async close(): Promise<void> {
    this.db.close()
  }
}

class PostgresDriver implements DbDriver {
  private pool: import('pg').Pool
  constructor(connectionString: string) {
    // Loaded lazily so SQLite-only deployments don't require pg.
    const { Pool } = require('pg')
    this.pool = new Pool({ connectionString })
  }
  async run(sql: string, ...params: unknown[]): Promise<void> {
    await this.pool.query(sql, params)
  }
  async get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const res = await this.pool.query(sql, params)
    return res.rows[0] as T | undefined
  }
  async all<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    const res = await this.pool.query(sql, params)
    return res.rows as T[]
  }
  async close(): Promise<void> {
    await this.pool.end()
  }
}

export class DbStorageBackend implements StorageBackend {
  readonly kv: KvFacet
  private closed = false

  constructor(private driver: DbDriver) {
    this.kv = {
      open: (descriptor) => this.openUnit(descriptor),
    }
  }

  private async ensureUnit(descriptor: KvUnitDescriptor): Promise<void> {
    const existing = await this.driver.get<{ version: number }>(
      'SELECT version FROM dsh_storage_units WHERE name = ?',
      descriptor.name,
    )
    if (existing !== undefined) {
      if (existing.version !== descriptor.version) {
        throw new Error(`version-mismatch: unit ${descriptor.name} expected ${descriptor.version}, found ${existing.version}`)
      }
      return
    }
    await this.driver.run(
      'INSERT INTO dsh_storage_units (name, version, has_global, tables_json) VALUES (?, ?, ?, ?)',
      descriptor.name,
      descriptor.version,
      descriptor.hasGlobal ? 1 : 0,
      JSON.stringify(descriptor.tables),
    )
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await this.ensureUnit(descriptor)
    return {
      loadAll: async () => {
        const records = await this.driver.all<{ table_name: string; key: string; value_json: string }>(
          'SELECT table_name, key, value_json FROM dsh_storage_records WHERE unit = ?',
          descriptor.name,
        )
        const tables: Record<string, Record<string, unknown>> = {}
        for (const table of descriptor.tables) tables[table] = {}
        for (const row of records) {
          tables[row.table_name] ??= {}
          tables[row.table_name][row.key] = JSON.parse(row.value_json)
        }
        let global: unknown = null
        if (descriptor.hasGlobal) {
          const g = await this.driver.get<{ value_json: string }>(
            'SELECT value_json FROM dsh_storage_global WHERE unit = ?',
            descriptor.name,
          )
          if (g !== undefined) global = JSON.parse(g.value_json)
        }
        return { tables, global }
      },
      putRecord: async (table, key, value) => {
        if (!descriptor.tables.includes(table)) throw new Error(`unknown table: ${table}`)
        await this.driver.run(
          `INSERT INTO dsh_storage_records (unit, table_name, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(unit, table_name, key) DO UPDATE SET value_json = excluded.value_json`,
          descriptor.name,
          table,
          key,
          JSON.stringify(value),
        )
      },
      deleteRecord: async (table, key) => {
        await this.driver.run(
          'DELETE FROM dsh_storage_records WHERE unit = ? AND table_name = ? AND key = ?',
          descriptor.name,
          table,
          key,
        )
      },
      setGlobal: async (value) => {
        if (!descriptor.hasGlobal) throw new Error('unit has no global slot')
        await this.driver.run(
          `INSERT INTO dsh_storage_global (unit, value_json) VALUES (?, ?)
           ON CONFLICT(unit) DO UPDATE SET value_json = excluded.value_json`,
          descriptor.name,
          JSON.stringify(value),
        )
      },
      close: async () => {},
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.driver.close()
  }
}

export function createDriver(config: Config): DbDriver {
  if (config.type === 'sqlite') {
    if (config.path !== ':memory:') mkdirSync(dirname(config.path), { recursive: true })
    return new SqliteDriver(new DatabaseSync(config.path))
  }
  return new PostgresDriver(config.connectionString)
}

export function apply(ctx: Context, config: Config): void {
  const backend = new DbStorageBackend(createDriver(config))
  // The base profile already provides the storage hub; registering on it
  // makes the backend visible to every consumer of ctx.storage.
  const storage = ctx.get('storage')
  const disposer = storage.backend.register(config.type, backend)
  ctx.provide(storageBackendServiceKey(config.type), backend)
  ctx.effect(async () => {
    disposer()
    await backend.close()
  }, '@visecy/dsh-storage-db')
}

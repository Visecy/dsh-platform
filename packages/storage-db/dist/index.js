// packages/storage-db/src/index.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { Storage, storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
var require2 = createRequire(import.meta.url);
var { DatabaseSync } = require2("node:sqlite");
var name = "@visecy/dsh-storage-db";
var SqliteDriver = class {
  constructor(db) {
    this.db = db;
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
    `);
  }
  db;
  async ensureSchema() {
  }
  async run(sql, ...params) {
    this.db.prepare(sql).run(...params);
  }
  async get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
  async all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  async close() {
    this.db.close();
  }
};
var PostgresDriver = class {
  pool;
  constructor(connectionString) {
    const { Pool } = require2("pg");
    this.pool = new Pool({ connectionString });
  }
  async ensureSchema() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS dsh_storage_units (
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      has_global INTEGER NOT NULL,
      tables_json TEXT NOT NULL
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS dsh_storage_records (
      unit TEXT NOT NULL,
      table_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY (unit, table_name, key)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS dsh_storage_global (
      unit TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )`);
  }
  async run(sql, ...params) {
    await this.pool.query(sql, params);
  }
  async get(sql, ...params) {
    const res = await this.pool.query(sql, params);
    return res.rows[0];
  }
  async all(sql, ...params) {
    const res = await this.pool.query(sql, params);
    return res.rows;
  }
  async close() {
    await this.pool.end();
  }
};
var DbStorageBackend = class {
  constructor(driver) {
    this.driver = driver;
    this.kv = {
      open: (descriptor) => this.openUnit(descriptor)
    };
  }
  driver;
  kv;
  closed = false;
  async ensureUnit(descriptor) {
    await this.driver.ensureSchema?.();
    const existing = await this.driver.get(
      "SELECT version FROM dsh_storage_units WHERE name = ?",
      descriptor.name
    );
    if (existing !== void 0) {
      if (existing.version !== descriptor.version) {
        throw new Error(`version-mismatch: unit ${descriptor.name} expected ${descriptor.version}, found ${existing.version}`);
      }
      return;
    }
    await this.driver.run(
      "INSERT INTO dsh_storage_units (name, version, has_global, tables_json) VALUES (?, ?, ?, ?)",
      descriptor.name,
      descriptor.version,
      descriptor.hasGlobal ? 1 : 0,
      JSON.stringify(descriptor.tables)
    );
  }
  async openUnit(descriptor) {
    await this.ensureUnit(descriptor);
    return {
      loadAll: async () => {
        const records = await this.driver.all(
          "SELECT table_name, key, value_json FROM dsh_storage_records WHERE unit = ?",
          descriptor.name
        );
        const tables = {};
        for (const table of descriptor.tables) tables[table] = {};
        for (const row of records) {
          tables[row.table_name] ??= {};
          tables[row.table_name][row.key] = JSON.parse(row.value_json);
        }
        let global = null;
        if (descriptor.hasGlobal) {
          const g = await this.driver.get(
            "SELECT value_json FROM dsh_storage_global WHERE unit = ?",
            descriptor.name
          );
          if (g !== void 0) global = JSON.parse(g.value_json);
        }
        return { tables, global };
      },
      putRecord: async (table, key, value) => {
        if (!descriptor.tables.includes(table)) throw new Error(`unknown table: ${table}`);
        await this.driver.run(
          `INSERT INTO dsh_storage_records (unit, table_name, key, value_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(unit, table_name, key) DO UPDATE SET value_json = excluded.value_json`,
          descriptor.name,
          table,
          key,
          JSON.stringify(value)
        );
      },
      deleteRecord: async (table, key) => {
        await this.driver.run(
          "DELETE FROM dsh_storage_records WHERE unit = ? AND table_name = ? AND key = ?",
          descriptor.name,
          table,
          key
        );
      },
      setGlobal: async (value) => {
        if (!descriptor.hasGlobal) throw new Error("unit has no global slot");
        await this.driver.run(
          `INSERT INTO dsh_storage_global (unit, value_json) VALUES (?, ?)
           ON CONFLICT(unit) DO UPDATE SET value_json = excluded.value_json`,
          descriptor.name,
          JSON.stringify(value)
        );
      },
      close: async () => {
      }
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.driver.close();
  }
};
function createDriver(config) {
  if (config.type === "sqlite") {
    if (config.path !== ":memory:") mkdirSync(dirname(config.path), { recursive: true });
    return new SqliteDriver(new DatabaseSync(config.path));
  }
  return new PostgresDriver(config.connectionString);
}
function apply(ctx, config) {
  let storage = ctx.get("storage", false);
  if (storage === void 0) {
    new Storage(ctx);
    storage = ctx.get("storage", false);
    if (storage === void 0) throw new Error("storage hub did not register");
  }
  let backend;
  if (storage.backend.names().includes(config.type)) {
    backend = storage.backend.get(config.type);
  } else {
    backend = new DbStorageBackend(createDriver(config));
    storage.backend.register(config.type, backend);
  }
  ctx.provide(storageBackendServiceKey(config.type), backend);
}
export {
  DbStorageBackend,
  apply,
  createDriver,
  name
};

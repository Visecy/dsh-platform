// src/index.ts
import z from "@deepseek-ai/schemastery";
import { randomUUID as randomUUID3 } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  PersistenceCoordinator
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset
} from "@deepseek-ai/dsh-session";

// src/write-guard.ts
var WriteGuard = class {
  /**
   * Last CONFIRMED head per session — the head this instance itself wrote or
   * observed via `loadStored`. `-1` records a confirmed absence (no row).
   * `undefined` (absent from the map) means this instance never read or wrote
   * the session.
   */
  headSeqs = /* @__PURE__ */ new Map();
  /**
   * Record a head this instance actually observed or wrote.
   * @param id - the session id.
   * @param head - the confirmed head, or `-1` for a confirmed absence
   *   (a fresh session this instance has read about — a later append to a
   *   session that meanwhile got a row must reject).
   */
  confirmHead(id, head) {
    this.headSeqs.set(id, head);
  }
  /**
   * Fail loud when the on-disk head no longer matches this instance's last
   * confirmed head for the session. `undefined` (never read/written here) is
   * only acceptable for a session with NO row: a row written by someone else
   * means this instance's coordinator cursor is not the log's authority.
   * @param id - the session id.
   * @param storedHead - the on-disk head cursor, read inside the append
   *   transaction before any row is inserted.
   */
  assertNoConcurrentWriter(id, storedHead) {
    const known = this.headSeqs.get(id);
    if (known === void 0) {
      if (storedHead !== -1) {
        throw new Error(
          `session "${id}" has a persisted log this instance has not read; another writer may own it \u2014 load the session first`
        );
      }
      return;
    }
    if (known !== storedHead) {
      throw new Error(
        `session "${id}" was modified by another writer (stored head ${storedHead}, this instance last confirmed head ${known}); concurrent writers on one session are not supported`
      );
    }
  }
};

// src/adapters/to-sqlite.ts
import { sql } from "drizzle-orm";
import {
  check as sqliteCheck,
  index,
  integer,
  sqliteTable,
  text,
  unique
} from "drizzle-orm/sqlite-core";

// src/entities/types.ts
function toProperty(name) {
  return name.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
}

// src/adapters/to-sqlite.ts
function buildColumn(c, tables) {
  let col;
  switch (c.type) {
    case "text":
      col = text(c.name);
      break;
    case "serial":
      col = integer(c.name).primaryKey({ autoIncrement: true });
      break;
    case "integer":
    case "bigint": {
      const built = integer(c.name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
  }
  if (c.notNull) col = col.notNull();
  if (c.default !== void 0) col = col.default(c.default);
  if (c.unique) col = col.unique();
  if (c.references) {
    const { table, column, onDelete } = c.references;
    col = col.references(
      () => tables[table][toProperty(column)],
      { onDelete }
    );
  }
  return col;
}
function toSqliteSchema(defs) {
  const tables = {};
  for (const def of defs) {
    const columns = {};
    for (const c of def.columns) columns[toProperty(c.name)] = buildColumn(c, tables);
    const extra = (self) => [
      ...(def.checks ?? []).map((c) => sqliteCheck(c.name, sql.raw(c.expression))),
      ...(def.uniques ?? []).map(
        (u) => unique(u.name).on(
          ...u.columns.map((name) => self[toProperty(name)])
        )
      ),
      ...(def.indexes ?? []).map(
        (i) => index(i.name).on(
          ...i.columns.map((name) => self[toProperty(name)])
        )
      )
    ];
    tables[def.name] = sqliteTable(
      def.name,
      columns,
      extra
    );
  }
  return tables;
}

// src/adapters/to-postgres.ts
import { sql as sql2 } from "drizzle-orm";
import {
  bigint,
  check as pgCheck,
  index as index2,
  integer as integer2,
  pgTable,
  serial,
  text as text2,
  unique as unique2
} from "drizzle-orm/pg-core";
function buildColumn2(c, tables) {
  let col;
  switch (c.type) {
    case "text":
      col = text2(c.name);
      break;
    case "serial":
      col = serial(c.name).primaryKey();
      break;
    case "integer": {
      const built = integer2(c.name);
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
    case "bigint": {
      const built = bigint(c.name, { mode: "number" });
      col = c.primaryKey ? built.primaryKey() : built;
      break;
    }
  }
  if (c.notNull) col = col.notNull();
  if (c.default !== void 0) col = col.default(c.default);
  if (c.unique) col = col.unique();
  if (c.references) {
    const { table, column, onDelete } = c.references;
    col = col.references(
      () => tables[table][toProperty(column)],
      { onDelete }
    );
  }
  return col;
}
function toPostgresSchema(defs) {
  const tables = {};
  for (const def of defs) {
    const columns = {};
    for (const c of def.columns) columns[toProperty(c.name)] = buildColumn2(c, tables);
    const extra = (self) => [
      ...(def.checks ?? []).map((c) => pgCheck(c.name, sql2.raw(c.expression))),
      ...(def.uniques ?? []).map(
        (u) => unique2(u.name).on(
          ...u.columns.map((name) => self[toProperty(name)])
        )
      ),
      ...(def.indexes ?? []).map(
        (i) => index2(i.name).on(
          ...i.columns.map((name) => self[toProperty(name)])
        )
      )
    ];
    tables[def.name] = pgTable(
      def.name,
      columns,
      extra
    );
  }
  return tables;
}

// src/adapters/ddl.ts
function sqlType(dialect, type) {
  switch (type) {
    case "serial":
      return dialect === "sqlite" ? "INTEGER" : "SERIAL";
    case "integer":
      return "INTEGER";
    case "bigint":
      return dialect === "sqlite" ? "INTEGER" : "BIGINT";
    case "text":
      return "TEXT";
  }
}
function literal(value) {
  return typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
}
function quote(name) {
  return `"${name}"`;
}
function columnSql(dialect, c) {
  let sql5 = `${quote(c.name)} ${sqlType(dialect, c.type)}`;
  if (c.primaryKey) sql5 += " PRIMARY KEY";
  if (c.type === "serial" && dialect === "sqlite") sql5 += " AUTOINCREMENT";
  if (c.notNull) sql5 += " NOT NULL";
  if (c.default !== void 0) sql5 += ` DEFAULT ${literal(c.default)}`;
  if (c.unique) sql5 += " UNIQUE";
  if (c.references) {
    sql5 += ` REFERENCES ${quote(c.references.table)}(${quote(c.references.column)})`;
    if (c.references.onDelete) sql5 += ` ON DELETE ${c.references.onDelete.toUpperCase()}`;
  }
  return sql5;
}
function createTableSql(dialect, def) {
  const parts = def.columns.map((c) => columnSql(dialect, c));
  for (const ck of def.checks ?? []) parts.push(`CHECK (${ck.expression})`);
  for (const u of def.uniques ?? []) {
    parts.push(`UNIQUE (${u.columns.map(quote).join(", ")})`);
  }
  const strict = dialect === "sqlite" ? " STRICT" : "";
  return `CREATE TABLE IF NOT EXISTS ${quote(def.name)} (
  ${parts.join(",\n  ")}
)${strict}`;
}
function createIndexSql(def, name) {
  const idx = def.indexes?.find((i) => i.name === name);
  if (idx === void 0) throw new Error(`unknown index "${name}" on table "${def.name}"`);
  return `CREATE INDEX IF NOT EXISTS ${quote(idx.name)} ON ${quote(def.name)}(${idx.columns.map(quote).join(", ")})`;
}
function createTablesSql(dialect, defs) {
  const statements = [];
  for (const def of defs) {
    statements.push(createTableSql(dialect, def));
    for (const idx of def.indexes ?? []) statements.push(createIndexSql(def, idx.name));
  }
  return statements;
}

// src/entities/persistence-state.ts
var persistenceState = {
  name: "t_persistence_state",
  columns: [
    { name: "f_singleton", type: "integer", primaryKey: true },
    { name: "f_store_id", type: "text", notNull: true }
  ],
  checks: [{ name: "ck_persistence_state_singleton", expression: "f_singleton = 1" }]
};

// src/entities/schema-meta.ts
var schemaMeta = {
  name: "t_schema_meta",
  columns: [
    { name: "f_key", type: "text", primaryKey: true },
    { name: "f_value", type: "text", notNull: true }
  ]
};

// src/entities/sessions.ts
var sessions = {
  name: "t_sessions",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    { name: "f_session_id", type: "text", notNull: true, unique: true },
    { name: "f_head_event_id", type: "text", notNull: true, default: "" },
    { name: "f_head_sequence", type: "integer", notNull: true, default: -1 },
    { name: "f_version", type: "integer", notNull: true },
    { name: "f_created_at", type: "bigint", notNull: true },
    { name: "f_cwd", type: "text" },
    { name: "f_parent_session", type: "text" },
    // 0.1.2：out-of-log 的继承前缀 cut。存在性 = 头部 isSeeded（镜像 JSONL
    // header 行的 seedLength 字段）；无该列的 rc.2 时代行仍按旧语义读取（见
    // log.ts 的 storedInheritedCount）。写路径在 INSERT 时写入 cut、CONFLICT
    // 时保留原值（sessionConflictRow 不含此列）。
    { name: "f_seed_length", type: "integer" },
    { name: "f_origin", type: "text" },
    { name: "f_delegation_depth", type: "integer" },
    { name: "f_incarnation", type: "text", notNull: true },
    { name: "f_revision", type: "integer", notNull: true }
  ]
};

// src/entities/events.ts
var events = {
  name: "t_events",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    { name: "f_event_id", type: "text", notNull: true, unique: true },
    { name: "f_parent_id", type: "text", notNull: true, default: "" },
    { name: "f_kind", type: "text", notNull: true, default: "" },
    { name: "f_role", type: "text", notNull: true, default: "" },
    { name: "f_name", type: "text", notNull: true, default: "" },
    { name: "f_action_id", type: "text", notNull: true, default: "" },
    { name: "f_encoding", type: "text", notNull: true, default: "" },
    { name: "f_data", type: "text", notNull: true },
    { name: "f_created_at", type: "bigint", notNull: true, default: 0 },
    { name: "f_original_seq", type: "integer", notNull: true },
    { name: "f_source_event_seqs", type: "text" },
    { name: "f_surface_op", type: "text" }
  ]
  // 无独立索引：查询只经 `f_event_id`（列级 UNIQUE 自动建唯一索引，join 查找侧）
  // 与 `t_session_events` 的复合索引（按 session 过滤后回表取本表列）。事件链
  // `f_parent_id` 仅在写路径构造（读时不回读该列），无按 kind/role/created_at
  // 的查询——不再为不可达查询维护索引（写放大）。
};

// src/entities/session-events.ts
var sessionEvents = {
  name: "t_session_events",
  columns: [
    { name: "f_id", type: "serial", primaryKey: true },
    {
      name: "f_session_id",
      type: "text",
      notNull: true,
      references: { table: "t_sessions", column: "f_session_id", onDelete: "cascade" }
    },
    {
      name: "f_event_id",
      type: "text",
      notNull: true,
      references: { table: "t_events", column: "f_event_id", onDelete: "cascade" }
    },
    { name: "f_sequence", type: "integer", notNull: true }
  ],
  uniques: [
    { name: "uq_session_events_session_sequence", columns: ["f_session_id", "f_sequence"] }
  ]
  // 不另建普通索引：`UNIQUE(f_session_id, f_sequence)` 约束自动创建的唯一索引
  // 已覆盖本表的全部访问模式（按 session 过滤 + 按 seq 范围/排序/取尾）。
};

// src/entities/index.ts
var sqliteTableDefs = [persistenceState, sessions, events, sessionEvents];
var postgresTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents
];

// src/schema.ts
var SCHEMA_VERSION = 1;
var SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 1146308688;
var EVENT_ENCODING = "json";
var IGNORABLE_EVENT_ENCODING = "json-ignorable";
var sqliteTables = toSqliteSchema(sqliteTableDefs);
var tPersistenceState = sqliteTables["t_persistence_state"];
var tSessions = sqliteTables["t_sessions"];
var tEvents = sqliteTables["t_events"];
var tSessionEvents = sqliteTables["t_session_events"];
var DEFAULT_BUSY_TIMEOUT_MS = 5e3;
function eventDimensions(event) {
  switch (event.type) {
    case "turn/start":
    case "turn/end":
    case "step/start":
    case "step/end":
    case "session/end-seed":
      return { role: "turn", name: "", actionId: "" };
    case "user/message":
    case "request/header":
    case "request/context":
      return { role: "user", name: "", actionId: "" };
    case "assistant/message":
    case "assistant/chunk":
      return { role: "model", name: "", actionId: "" };
    case "tool/call":
      return { role: "function", name: event.data.name, actionId: event.data.callId };
    case "tool/result": {
      const block = event.data.message?.content[0];
      return { role: "function", name: "", actionId: block?.toolCallId ?? "" };
    }
    case "todo/write":
      return { role: "state", name: "todos", actionId: "" };
    default:
      return { role: "", name: "", actionId: "" };
  }
}

// src/log.ts
function rowToMeta(row) {
  if (!Number.isSafeInteger(row.fCreatedAt) || row.fCreatedAt < 0) {
    throw new Error("stored session createdAt must be a non-negative safe integer");
  }
  return {
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    ...row.fCwd !== null ? { cwd: row.fCwd } : {},
    ...row.fParentSession !== null ? { parentSession: row.fParentSession } : {},
    isSeeded: row.fSeedLength !== null,
    ...row.fOrigin !== null ? { origin: row.fOrigin } : {},
    ...row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }
  };
}
function sessionInsertRow(meta, inheritedEventCount, incarnation) {
  return {
    fSessionId: meta.id,
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.isSeeded ? inheritedEventCount : null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
    fIncarnation: incarnation,
    fRevision: 0
  };
}
function sessionConflictRow(meta) {
  return {
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null
  };
}
function hasLegacyRenumbering(rows) {
  return rows.some((row) => row.fOriginalSeq !== row.fSequence);
}
function storedInheritedCount(storedCut, seqRows, legacy) {
  if (storedCut === null) return 0;
  if (!legacy) return storedCut;
  let count = 0;
  for (const row of seqRows) {
    if (row.fOriginalSeq < storedCut) count += 1;
  }
  return count;
}
function remapSurfaceOp(op, remap) {
  if (op === "append") return op;
  return { op: "replace", start: remap(op.start), end: remap(op.end) };
}
function remapShadowedRange(range, remap) {
  return { start: remap(range.start), end: remap(range.end) };
}
function rowToEvent(row, seqMap) {
  const remap = (seq) => seqMap?.get(seq) ?? seq;
  const surfaceFields = {
    ...row.fSourceEventSeqs !== null ? {
      sourceEventSeqs: JSON.parse(row.fSourceEventSeqs).map(remap)
    } : {},
    ...row.fSurfaceOp !== null ? {
      surfaceOp: remapSurfaceOp(JSON.parse(row.fSurfaceOp), remap)
    } : {}
  };
  const data = JSON.parse(row.fData);
  if (row.fKind === "compaction/summary" || row.fKind === "compaction/prune") {
    const metering = data;
    if (metering.shadowedRange !== void 0) {
      metering.shadowedRange = remapShadowedRange(metering.shadowedRange, remap);
    }
  }
  return {
    type: row.fKind,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data,
    ...row.fEncoding === IGNORABLE_EVENT_ENCODING ? { ignorable: true } : {},
    ...surfaceFields
  };
}
function buildSeqMap(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}
function scanRows(rows, base = 0, seqMap) {
  const parsed = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row, seqMap) };
    } catch {
      return { ok: false };
    }
  });
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fKind === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }
  const preserved = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === void 0) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`
        );
      break;
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`
        );
      break;
    }
    preserved.push(p.event);
  }
  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved };
}

// src/sqlite.ts
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { and, desc, eq, gte, sql as sql3 } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
var sqliteTxQueues = /* @__PURE__ */ new Map();
function enqueueSqliteTx(path, fn) {
  const tail = sqliteTxQueues.get(path) ?? Promise.resolve();
  const run = tail.then(fn);
  sqliteTxQueues.set(
    path,
    run.then(
      () => void 0,
      () => void 0
    )
  );
  return run;
}
async function createDatabaseFile(path) {
  try {
    const handle = await open(path, "wx", 384);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
function openDatabase(path, journalMode, busyTimeout = DEFAULT_BUSY_TIMEOUT_MS) {
  const db = new DatabaseSync(path);
  try {
    configureDatabase(db, path, journalMode, busyTimeout);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function configureDatabase(db, path, journalMode, busyTimeout) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  const dbx = drizzle({ client: db });
  dbx.transaction(
    (tx) => {
      const { user_version: onDisk } = tx.get(sql3`PRAGMA user_version`);
      const { application_id: applicationId } = tx.get(sql3`PRAGMA application_id`);
      const { count: userObjectCount } = tx.get(
        sql3`SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'`
      );
      if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
        throw new Error(
          `session database at "${path}" has an unversioned schema or application identity`
        );
      }
      if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {
        throw new Error(
          `session database at "${path}" has schema version ${onDisk}, incompatible with this build (${SCHEMA_VERSION})`
        );
      }
      if (onDisk === SCHEMA_VERSION && applicationId !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
        throw new Error(
          `session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`
        );
      }
      for (const statement of createTablesSql("sqlite", sqliteTableDefs)) {
        tx.run(sql3.raw(statement));
      }
      tx.insert(tPersistenceState).values({ fSingleton: 1, fStoreId: randomUUID() }).onConflictDoNothing().run();
      if (onDisk === 0) {
        tx.run(sql3.raw(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`));
        tx.run(sql3.raw(`PRAGMA user_version = ${SCHEMA_VERSION}`));
      }
    },
    { behavior: "immediate" }
  );
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
}
var SqliteBackend = class {
  constructor(options) {
    this.options = options;
  }
  options;
  kind = "sqlite";
  storeIdentity;
  /** The resolved database path (queue key); set by {@link open}. */
  dbPath = "";
  db;
  async open() {
    const actual = this.options.path === ":memory:" ? this.options.path : resolve(this.options.path);
    this.dbPath = actual;
    if (actual !== ":memory:") {
      await mkdir(dirname(actual), { recursive: true, mode: 448 });
      await createDatabaseFile(actual);
    }
    await enqueueSqliteTx(actual, async () => {
      this.db = drizzle({
        client: openDatabase(actual, this.options.journalMode, this.options.busyTimeout)
      });
    });
    try {
      const row = this.db.select({ fStoreId: tPersistenceState.fStoreId }).from(tPersistenceState).where(eq(tPersistenceState.fSingleton, 1)).get();
      if (row === void 0) {
        throw new Error(`session database at "${actual}" has no store identity`);
      }
      if (row.fStoreId.length === 0) {
        throw new Error(`session database at "${actual}" has no valid store identity`);
      }
      if (actual !== ":memory:") {
        const identity = statSync(actual, { bigint: true });
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${row.fStoreId}`;
      } else {
        this.storeIdentity = `memory:store:${row.fStoreId}`;
      }
    } catch (error) {
      this.db.$client.close();
      throw error;
    }
  }
  async close() {
    if (this.db === void 0) return;
    this.db.$client.close();
  }
  async getSession(id) {
    return this.db.select().from(tSessions).where(eq(tSessions.fSessionId, id)).get();
  }
  async getSeqMapRows(id) {
    return this.eventRows().where(eq(tSessionEvents.fSessionId, id)).all();
  }
  async getEventRows(id, fromSequence) {
    const scoped = fromSequence === void 0 ? this.eventRows().where(eq(tSessionEvents.fSessionId, id)) : this.eventRows().where(
      and(eq(tSessionEvents.fSessionId, id), gte(tSessionEvents.fSequence, fromSequence))
    );
    return scoped.orderBy(tSessionEvents.fSequence).all();
  }
  async listSessions() {
    return this.db.select().from(tSessions).all();
  }
  async transaction(fn) {
    return enqueueSqliteTx(this.dbPath, async () => {
      this.db.$client.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.tx);
        this.db.$client.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.$client.exec("ROLLBACK");
        } catch {
        }
        throw error;
      }
    });
  }
  /**
   * SQLite is a single connection: after `BEGIN IMMEDIATE` every query on the
   * same handle is inside the transaction, so the tx primitives are the same
   * row primitives used by the non-transactional reads.
   */
  tx = {
    upsertSession: (meta, inheritedEventCount, incarnation) => this.upsertSession(meta, inheritedEventCount, incarnation),
    getHead: (id) => this.getHead(id),
    insertEvents: (events2) => this.insertEvents(events2),
    insertBridges: (rows) => this.insertBridges(rows),
    updateHead: (id, headEventId, headSequence) => this.updateHead(id, headEventId, headSequence),
    bumpRevision: (id) => this.bumpRevision(id),
    deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(id, fromSequence),
    getPrevBridge: (id, sequence) => this.getPrevBridge(id, sequence),
    getLastBridge: (id) => this.getLastBridge(id)
  };
  // --- row primitives (transaction-internal or standalone) ---
  async upsertSession(meta, inheritedEventCount, incarnation) {
    this.db.insert(tSessions).values(sessionInsertRow(meta, inheritedEventCount, incarnation)).onConflictDoUpdate({
      target: tSessions.fSessionId,
      set: sessionConflictRow(meta)
    }).run();
  }
  async getHead(id) {
    const head = this.db.select({ fHeadEventId: tSessions.fHeadEventId, fHeadSequence: tSessions.fHeadSequence }).from(tSessions).where(eq(tSessions.fSessionId, id)).get();
    if (head === void 0) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }
  async insertEvents(events2) {
    if (events2.length === 0) return;
    this.db.insert(tEvents).values(events2.map((event) => ({ ...event }))).run();
  }
  async insertBridges(rows) {
    if (rows.length === 0) return;
    this.db.insert(tSessionEvents).values(rows.map((row) => ({ ...row }))).run();
  }
  async updateHead(id, headEventId, headSequence) {
    this.db.update(tSessions).set({ fHeadEventId: headEventId, fHeadSequence: headSequence }).where(eq(tSessions.fSessionId, id)).run();
  }
  async bumpRevision(id) {
    this.db.update(tSessions).set({ fRevision: sql3`${tSessions.fRevision} + 1` }).where(eq(tSessions.fSessionId, id)).run();
  }
  async deleteBridgeTail(id, fromSequence) {
    this.db.delete(tSessionEvents).where(and(eq(tSessionEvents.fSessionId, id), gte(tSessionEvents.fSequence, fromSequence))).run();
  }
  async getPrevBridge(id, sequence) {
    return this.db.select({ fEventId: tSessionEvents.fEventId, fSequence: tSessionEvents.fSequence }).from(tSessionEvents).where(and(eq(tSessionEvents.fSessionId, id), eq(tSessionEvents.fSequence, sequence))).get();
  }
  async getLastBridge(id) {
    return this.db.select({ fEventId: tSessionEvents.fEventId, fSequence: tSessionEvents.fSequence }).from(tSessionEvents).where(eq(tSessionEvents.fSessionId, id)).orderBy(desc(tSessionEvents.fSequence)).limit(1).get();
  }
  /** The joined event-row projection shared by whole-log and suffix reads. */
  eventRows() {
    return this.db.select({
      fSequence: tSessionEvents.fSequence,
      fOriginalSeq: tEvents.fOriginalSeq,
      fKind: tEvents.fKind,
      fCreatedAt: tEvents.fCreatedAt,
      fData: tEvents.fData,
      fEncoding: tEvents.fEncoding,
      fSourceEventSeqs: tEvents.fSourceEventSeqs,
      fSurfaceOp: tEvents.fSurfaceOp
    }).from(tSessionEvents).innerJoin(tEvents, eq(tSessionEvents.fEventId, tEvents.fEventId));
  }
};

// src/postgres.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { and as and2, desc as desc2, eq as eq2, gte as gte2, sql as sql4 } from "drizzle-orm";
var pgTables = toPostgresSchema(postgresTableDefs);
var pgPersistenceState = pgTables["t_persistence_state"];
var pgSchemaMeta = pgTables["t_schema_meta"];
var pgSessions = pgTables["t_sessions"];
var pgEvents = pgTables["t_events"];
var pgSessionEvents = pgTables["t_session_events"];
var PostgresBackend = class {
  constructor(db, options) {
    this.db = db;
    this.options = options;
  }
  db;
  options;
  kind = "postgres";
  storeIdentity;
  async open() {
    const storeId = await this.db.transaction(async (tx) => {
      const probe = await tx.execute(
        sql4`SELECT to_regclass('t_schema_meta') IS NOT NULL AS exists`
      );
      const metaExists = probe.rows[0]?.exists === true;
      for (const statement of createTablesSql("postgres", postgresTableDefs)) {
        await tx.execute(sql4.raw(statement));
      }
      if (!metaExists) {
        await tx.insert(pgSchemaMeta).values([
          { fKey: "schema_version", fValue: String(SCHEMA_VERSION) },
          { fKey: "application_id", fValue: String(SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) }
        ]).execute();
      }
      const version = await this.readMeta(tx, "schema_version");
      const applicationId = await this.readMeta(tx, "application_id");
      if (version === void 0 || applicationId === void 0) {
        throw new Error("session database has an unversioned schema or application identity");
      }
      if (Number(version) !== SCHEMA_VERSION) {
        throw new Error(
          `session database has schema version ${version}, incompatible with this build (${SCHEMA_VERSION})`
        );
      }
      if (Number(applicationId) !== SESSION_PERSISTENCE_SQLITE_APPLICATION_ID) {
        throw new Error(
          `session database has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`
        );
      }
      await tx.insert(pgPersistenceState).values({ fSingleton: 1, fStoreId: randomUUID2() }).onConflictDoNothing().execute();
      const store = await tx.select({ fStoreId: pgPersistenceState.fStoreId }).from(pgPersistenceState).where(eq2(pgPersistenceState.fSingleton, 1)).execute();
      const storeId2 = store[0]?.fStoreId;
      if (storeId2 === void 0 || storeId2.length === 0) {
        throw new Error("session database has no valid store identity");
      }
      return storeId2;
    });
    this.storeIdentity = `${this.options.identityBase}:store:${storeId}`;
  }
  async close() {
    await this.options.close();
  }
  async getSession(id) {
    return (await this.db.select().from(pgSessions).where(eq2(pgSessions.fSessionId, id)).execute())[0];
  }
  async getSeqMapRows(id) {
    return this.eventRows(this.db).where(eq2(pgSessionEvents.fSessionId, id)).execute();
  }
  async getEventRows(id, fromSequence) {
    const scoped = fromSequence === void 0 ? this.eventRows(this.db).where(eq2(pgSessionEvents.fSessionId, id)) : this.eventRows(this.db).where(
      and2(eq2(pgSessionEvents.fSessionId, id), gte2(pgSessionEvents.fSequence, fromSequence))
    );
    return scoped.orderBy(pgSessionEvents.fSequence).execute();
  }
  async listSessions() {
    return this.db.select().from(pgSessions).execute();
  }
  async transaction(fn) {
    return this.db.transaction(async (tx) => fn(this.txFor(tx)));
  }
  /** Bind the {@link BackendTx} primitives to one drizzle PG transaction handle. */
  txFor(tx) {
    return {
      upsertSession: (meta, inheritedEventCount, incarnation) => this.upsertSession(tx, meta, inheritedEventCount, incarnation),
      getHead: (id) => this.getHead(tx, id),
      insertEvents: (events2) => this.insertEvents(tx, events2),
      insertBridges: (rows) => this.insertBridges(tx, rows),
      updateHead: (id, headEventId, headSequence) => this.updateHead(tx, id, headEventId, headSequence),
      bumpRevision: (id) => this.bumpRevision(tx, id),
      deleteBridgeTail: (id, fromSequence) => this.deleteBridgeTail(tx, id, fromSequence),
      getPrevBridge: (id, sequence) => this.getPrevBridge(tx, id, sequence),
      getLastBridge: (id) => this.getLastBridge(tx, id)
    };
  }
  // --- meta helpers ---
  async readMeta(exec, key) {
    const rows = await exec.select({ fValue: pgSchemaMeta.fValue }).from(pgSchemaMeta).where(eq2(pgSchemaMeta.fKey, key)).execute();
    return rows[0]?.fValue;
  }
  // --- row primitives (transaction-internal) ---
  async upsertSession(exec, meta, inheritedEventCount, incarnation) {
    await exec.insert(pgSessions).values(sessionInsertRow(meta, inheritedEventCount, incarnation)).onConflictDoUpdate({
      target: pgSessions.fSessionId,
      set: sessionConflictRow(meta)
    }).execute();
  }
  async getHead(exec, id) {
    const head = (await exec.select({ fHeadEventId: pgSessions.fHeadEventId, fHeadSequence: pgSessions.fHeadSequence }).from(pgSessions).where(eq2(pgSessions.fSessionId, id)).execute())[0];
    if (head === void 0) throw new Error(`session "${id}" has no materialized row`);
    return head;
  }
  async insertEvents(exec, events2) {
    if (events2.length === 0) return;
    await exec.insert(pgEvents).values(events2.map((event) => ({ ...event }))).execute();
  }
  async insertBridges(exec, rows) {
    if (rows.length === 0) return;
    await exec.insert(pgSessionEvents).values(rows.map((row) => ({ ...row }))).execute();
  }
  async updateHead(exec, id, headEventId, headSequence) {
    await exec.update(pgSessions).set({ fHeadEventId: headEventId, fHeadSequence: headSequence }).where(eq2(pgSessions.fSessionId, id)).execute();
  }
  async bumpRevision(exec, id) {
    await exec.update(pgSessions).set({ fRevision: sql4`${pgSessions.fRevision} + 1` }).where(eq2(pgSessions.fSessionId, id)).execute();
  }
  async deleteBridgeTail(exec, id, fromSequence) {
    await exec.delete(pgSessionEvents).where(and2(eq2(pgSessionEvents.fSessionId, id), gte2(pgSessionEvents.fSequence, fromSequence))).execute();
  }
  async getPrevBridge(exec, id, sequence) {
    return (await exec.select({ fEventId: pgSessionEvents.fEventId, fSequence: pgSessionEvents.fSequence }).from(pgSessionEvents).where(and2(eq2(pgSessionEvents.fSessionId, id), eq2(pgSessionEvents.fSequence, sequence))).execute())[0];
  }
  async getLastBridge(exec, id) {
    return (await exec.select({ fEventId: pgSessionEvents.fEventId, fSequence: pgSessionEvents.fSequence }).from(pgSessionEvents).where(eq2(pgSessionEvents.fSessionId, id)).orderBy(desc2(pgSessionEvents.fSequence)).limit(1).execute())[0];
  }
  /** The joined event-row projection shared by whole-log and suffix reads. */
  eventRows(exec) {
    return exec.select({
      fSequence: pgSessionEvents.fSequence,
      fOriginalSeq: pgEvents.fOriginalSeq,
      fKind: pgEvents.fKind,
      fCreatedAt: pgEvents.fCreatedAt,
      fData: pgEvents.fData,
      fEncoding: pgEvents.fEncoding,
      fSourceEventSeqs: pgEvents.fSourceEventSeqs,
      fSurfaceOp: pgEvents.fSurfaceOp
    }).from(pgSessionEvents).innerJoin(pgEvents, eq2(pgSessionEvents.fEventId, pgEvents.fEventId));
  }
};

// src/index.ts
var SessionPersistenceRdb = class _SessionPersistenceRdb extends SessionPersistence {
  constructor(ctx, config, injectedBackend) {
    let resolved = config;
    const settings = ctx.reflect.get("settings");
    if (settings !== void 0) {
      const scope = settings.register(
        _SessionPersistenceRdb.settingsNs,
        _SessionPersistenceRdb.Config,
        { base: config }
      );
      resolved = scope.get();
      scope.watch(() => {
        ctx.logger.warn(
          "session-persistence-rdb: settings changed; restart to apply the new configuration"
        );
      });
    }
    super(ctx);
    this.config = config;
    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    this.coordinator = new PersistenceCoordinator(this.ctx, this);
  }
  config;
  static inject = ["sessions", "settings"];
  static Config = z.union([
    z.object({
      type: z.const("sqlite"),
      path: z.string().required(),
      journalMode: z.union(["wal", "delete", "truncate", "persist"]).default("wal"),
      busyTimeout: z.number().step(1).min(0).default(DEFAULT_BUSY_TIMEOUT_MS)
    }),
    z.object({
      type: z.const("postgres"),
      connectionString: z.string().required()
    })
  ]);
  /**
   * settings namespace：`$DSH_HOME/settings.yaml` 的 `session-persistence-rdb`
   * section。0.1.2 的 dsh-settings 移除了 `settingsNamespace()` 帮助函数 —
   * 字面量本身即合法 namespace（小写连字符标识符）。
   */
  static settingsNs = "session-persistence-rdb";
  /**
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  name = "session-persistence-rdb";
  /** One RDB database holds every session; there is no per-session raw artifact. */
  supportsRawArtifacts = false;
  backend;
  storeIdentity;
  ready;
  coordinator;
  /**
   * Write-authority state: the confirmed head per session (concurrent-writer
   * detection). See {@link WriteGuard} for the timing contract.
   */
  writeGuard = new WriteGuard();
  async init() {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }
  // --- SessionPersistence service surface (delegated to the coordinator) ---
  /** The backend has one database, not an independent local artifact per session. */
  locate(_meta) {
    return void 0;
  }
  create(meta, inheritedEventCount) {
    return this.coordinator.create(meta, inheritedEventCount);
  }
  ensureMaterialized(session) {
    return this.coordinator.ensureMaterialized(session);
  }
  append(id, events2) {
    return this.coordinator.append(id, events2);
  }
  prepare(id, signal) {
    return this.coordinator.prepare(id, signal);
  }
  load(id) {
    return this.coordinator.load(id);
  }
  inspect(id, signal) {
    return this.coordinator.inspect(id, signal);
  }
  borrowSession(id, signal) {
    return this.coordinator.borrowSession(id, signal);
  }
  readFrom(id, fromSeq, signal) {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }
  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.
  // --- PersistenceBackend hooks (the storage primitives) ---
  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id, signal) {
    return this.readPrefix(id, signal);
  }
  /**
   * Seek-capable suffix read: the backend selects `f_sequence >= fromSeq`
   * directly, so the read scales with the suffix, not the log. A legacy
   * (rc.2-era, dense-renumbered) log still needs every row's upstream seq for
   * provenance remapping, so a lightweight two-column map is read alongside.
   * The read is non-mutating: torn rows past the preserved region are dropped,
   * never repaired. The returned metadata carries the session's inherited cut
   * exactly like {@link loadStored}.
   */
  async loadStoredFrom(id, fromSeq, signal) {
    const log = await this.readLog(id, { fromSeq }, signal);
    if (log === void 0) return void 0;
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events
    };
  }
  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the persisted seq from which a never-committed tail
   * must be deleted (`scanRows` already returns it as `number | undefined`).
   * Records the confirmed head (or confirmed absence) so a later
   * `appendBatch` can detect a second writer that advanced the log.
   */
  async readPrefix(id, signal) {
    const log = await this.readLog(id, {}, signal);
    if (log === void 0) {
      this.writeGuard.confirmHead(id, -1);
      return void 0;
    }
    this.writeGuard.confirmHead(id, log.events.at(-1)?.seq ?? -1);
    return {
      meta: log.meta,
      // The inherited cut travels OUT of band: the 0.1.2 header forbids
      // `seedLength`, so every body-bearing read carries it alongside the
      // header (mirrors the JSONL backend's fromHeaderLine pairing).
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events,
      // The revision must identify exactly these values and match
      // readStoredRevision's representation (see listSnapshots).
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${log.incarnation}:revision:${log.revision}`
      ),
      ...log.tornFrom !== void 0 ? { tornMarker: log.tornFrom } : {}
    };
  }
  /**
   * Read the current source-qualified revision for one stored session without
   * loading its event log. Returns `undefined` when the identity is absent.
   * The representation matches {@link loadStored}'s `revision` and
   * {@link listSnapshots} — the coordinator compares them with `===`.
   */
  async readStoredRevision(id, signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === void 0) return void 0;
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`
    );
  }
  /**
   * Shared read pipeline: session row → meta + inherited cut, event rows →
   * preserved prefix. A whole-log read (`fromSeq` absent) builds the legacy
   * seq map from the same rows; a suffix read keeps the backend's lightweight
   * two-column seq-map source so the query still scales with the suffix, not
   * the log. The session is LEGACY when any of its rows carries
   * `f_original_seq != f_sequence` (written by the rc.2-era delta-filtering
   * backend): such logs are read through the upstream→persisted remap path
   * and their stored cut is translated from upstream space to row space.
   * Logs written by this build (`f_original_seq == f_sequence` everywhere)
   * pass through as identity and use the stored cut verbatim.
   */
  async readLog(id, options = {}, signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === void 0) return void 0;
    const meta = rowToMeta(row);
    let eventRows;
    let seqRows;
    let fromSeq = 0;
    if (options.fromSeq === void 0) {
      eventRows = await this.backend.getEventRows(id);
      seqRows = eventRows;
    } else {
      fromSeq = options.fromSeq;
      eventRows = await this.backend.getEventRows(id, fromSeq);
      seqRows = await this.backend.getSeqMapRows(id);
    }
    signal?.throwIfAborted();
    const legacy = hasLegacyRenumbering(seqRows);
    const seqMap = legacy ? buildSeqMap(seqRows) : void 0;
    const inheritedEventCount = storedInheritedCount(row.fSeedLength, seqRows, legacy);
    const { preserved, tornFrom } = scanRows(eventRows, fromSeq, seqMap);
    return {
      meta,
      inheritedEventCount,
      events: preserved,
      incarnation: row.fIncarnation,
      revision: row.fRevision,
      ...tornFrom !== void 0 ? { tornFrom } : {}
    };
  }
  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every event (plus its bridge row), or roll back entirely.
   * Since 0.1.2 NOTHING is dropped or renumbered: every event the coordinator
   * delivers — deltas and ignorable events included — is persisted verbatim
   * with its exact seq, so a batch that is only delta/ignorable events is a
   * normal append (and a seeded session's first materializing batch includes
   * its complete inherited prefix — the coordinator only invokes this hook
   * once a batch reaches the declared cut).
   * The transaction is the atomicity + durability boundary, so a mid-batch
   * failure (a UNIQUE violation on a duplicated seq) leaves the stored log
   * untouched.
   *
   * SQLite acquires the write lock up front (`BEGIN IMMEDIATE`, queued behind
   * `busy_timeout`); PostgreSQL relies on the transaction's row locks and the
   * `UNIQUE (f_session_id, f_sequence)` constraint to reject a colliding batch.
   * Either way {@link WriteGuard.assertNoConcurrentWriter} rejects a second
   * writer before any row lands — a session has exactly one writer per log,
   * and a second writer fails loud instead of corrupting the log.
   *
   * The row upsert runs UNCONDITIONALLY, not only when `!isMaterialized`:
   * the materialized flag is coordinator memory and cannot be trusted as the
   * row's existence signal. On conflict only the header columns refresh —
   * the head cursor, identity, revision, and the stored inherited cut are
   * preserved (the cut deliberately survives: a legacy row's cut lives in its
   * first generation's upstream space, and rewriting it would corrupt every
   * later translation — see `sessionConflictRow` in `log.ts`).
   * @param storage - the session's header plus its exact inherited cut.
   * @param events - the contiguous batch to persist, in seq order.
   * @param _isMaterialized - whether a sessions row already exists (lazy
   *   materialization is handled by the unconditional upsert).
   */
  async appendBatch(storage, events2, _isMaterialized) {
    await this.ready;
    const { meta } = storage;
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, storage.inheritedEventCount, randomUUID3());
      const head = await tx.getHead(meta.id);
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(tx, storage, events2, {
        parentId: head.fHeadEventId,
        nextSeq: head.fHeadSequence + 1
      });
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });
    this.writeGuard.confirmHead(meta.id, confirmedHead);
  }
  /**
   * Durably materialize a header-only session: create the `t_sessions` row (in
   * one transaction) WITHOUT any event row. This is the backend half of the
   * service's `ensureMaterialized` — an explicitly durable EMPTY session, so
   * unlike {@link appendBatch} there is no head-cursor advance and no revision
   * bump (a fresh row already starts at revision 0; row existence IS the
   * materialization signal). The inherited cut is stored exactly like a
   * materializing append's.
   */
  async materializeHeader(storage) {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(storage.meta, storage.inheritedEventCount, randomUUID3());
    });
  }
  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`), rewind the head cursor to the last surviving event, INSERT
   * the synthetic `closers`, and bump the revision once. After COMMIT the
   * stored rows == the balanced log. Closers are persisted verbatim like any
   * other event (they never carry dropped content).
   */
  async commitRepair(storage, tornMarker, closers) {
    await this.ready;
    const { meta } = storage;
    if (tornMarker === void 0 && closers.length === 0) return;
    await this.backend.transaction(async (tx) => {
      if (tornMarker !== void 0) {
        await tx.deleteBridgeTail(meta.id, tornMarker);
        const prev = await tx.getPrevBridge(meta.id, tornMarker - 1);
        if (prev === void 0) {
          await tx.updateHead(meta.id, "", -1);
        } else {
          await tx.updateHead(meta.id, prev.fEventId, prev.fSequence);
        }
      }
      if (closers.length > 0) {
        const last = await tx.getLastBridge(meta.id);
        const { headEventId, headSequence } = await appendEventTail(tx, storage, closers, {
          parentId: last?.fEventId ?? "",
          nextSeq: (last?.fSequence ?? -1) + 1
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      }
      await tx.bumpRevision(meta.id);
    });
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }
  /** List all materialized sessions' metadata (every row is a materialized session). */
  async list(signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map(rowToMeta);
  }
  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map((row) => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`
      )
    }));
  }
  /** Close the database connection (awaited by the coordinator's dispose, post-drain). */
  async close() {
    await this.ready;
    await this.backend.close();
  }
};
function createBackend(config) {
  if (config.type === "sqlite") {
    return new SqliteBackend({
      path: config.path,
      journalMode: config.journalMode ?? "wal",
      busyTimeout: config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS
    });
  }
  const pool = new Pool({ connectionString: config.connectionString });
  pool.on("error", () => {
  });
  const db = drizzlePg({ client: pool });
  const identityBase = [
    "postgres",
    pool.options.host ?? "localhost",
    String(pool.options.port ?? 5432),
    pool.options.database ?? ""
  ].join(":");
  return new PostgresBackend(db, { identityBase, close: () => pool.end() });
}
function surfaceBindings(event) {
  const se = event;
  const sourceSeqs = se.sourceEventSeqs;
  return [
    sourceSeqs !== void 0 && sourceSeqs.length > 0 ? JSON.stringify(sourceSeqs) : null,
    se.surfaceOp !== void 0 ? JSON.stringify(se.surfaceOp) : null
  ];
}
async function appendEventTail(tx, storage, events2, anchor) {
  const { meta } = storage;
  let parentId = anchor.parentId;
  let nextSeq = anchor.nextSeq;
  const eventRows = [];
  const bridgeRows = [];
  for (const event of events2) {
    if (event.seq !== nextSeq) {
      throw new Error(
        `append seq mismatch for "${meta.id}": physical tail is at ${nextSeq - 1}, batch event carries seq ${event.seq} \u2014 refusing to renumber`
      );
    }
    const eventId = randomUUID3();
    const { role, name, actionId } = eventDimensions(event);
    const [surfaceSeqs, surfaceOp] = surfaceBindings(event);
    eventRows.push({
      fEventId: eventId,
      fParentId: parentId,
      fKind: event.type,
      fRole: role,
      fName: name,
      fActionId: actionId,
      fEncoding: event.ignorable === true ? IGNORABLE_EVENT_ENCODING : EVENT_ENCODING,
      fData: JSON.stringify(event.data),
      fCreatedAt: event.time,
      fOriginalSeq: event.seq,
      fSourceEventSeqs: surfaceSeqs,
      fSurfaceOp: surfaceOp
    });
    bridgeRows.push({ fSessionId: meta.id, fEventId: eventId, fSequence: nextSeq });
    parentId = eventId;
    nextSeq++;
  }
  await tx.insertEvents(eventRows);
  await tx.insertBridges(bridgeRows);
  return { headEventId: parentId, headSequence: nextSeq - 1 };
}
var index_default = SessionPersistenceRdb;
export {
  SCHEMA_VERSION,
  SessionPersistenceRdb,
  index_default as default
};

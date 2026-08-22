// packages/session-persistence-rdb/src/index.ts
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { randomUUID as randomUUID3 } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  PersistenceCoordinator
} from "@deepseek-ai/dsh-session-persistence";

// packages/session-persistence-rdb/src/log.ts
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
    ...row.fSeedLength !== null ? { seedLength: row.fSeedLength } : {},
    ...row.fOrigin !== null ? { origin: row.fOrigin } : {},
    ...row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }
  };
}
function sessionInsertRow(meta, incarnation) {
  return {
    fSessionId: meta.id,
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.seedLength ?? null,
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
    fSeedLength: meta.seedLength ?? null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null
  };
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
function pruneSourceEventSeqs(refs, keep) {
  return refs.filter(keep);
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

// packages/session-persistence-rdb/src/write-guard.ts
var WriteGuard = class {
  /**
   * Last CONFIRMED dense head per session — the head this instance itself
   * wrote or observed via `loadStored`. `-1` records a confirmed absence (no
   * row). `undefined` (absent from the map) means this instance never read or
   * wrote the session.
   */
  headSeqs = /* @__PURE__ */ new Map();
  /**
   * Upstream seqs of delta events dropped per session. Mirrors `headSeqs` in
   * shape: the concurrent-writer guarantee limits each session to one writer,
   * so this instance is the only authority for its dropped seqs.
   */
  filteredSeqs = /* @__PURE__ */ new Map();
  /**
   * Record a head this instance actually observed or wrote.
   * @param id - the session id.
   * @param head - the confirmed dense head, or `-1` for a confirmed absence
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
   *   transaction before any re-numbering happens.
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
  /**
   * Record the upstream seqs of events dropped for a session (delta events and
   * ignorable events), so a later batch's `assistant/message` can prune
   * `sourceEventSeqs` references to events that never got a persisted row.
   * @param id - the session id.
   * @param seqs - the dropped events' upstream seqs (pure-delta batches included).
   */
  noteDropped(id, seqs) {
    const known = this.filteredSeqs.get(id) ?? /* @__PURE__ */ new Set();
    for (const seq of seqs) known.add(seq);
    this.filteredSeqs.set(id, known);
  }
  /**
   * Prune `sourceEventSeqs` references that hit this session's dropped-delta
   * seq set. `undefined`-like state (no dropped seqs recorded for the session)
   * leaves the list untouched, matching the write path's "no known drops →
   * keep verbatim" semantics (repair closers, which never carry provenance,
   * call through the identity path).
   *
   * The predicate is THIS INSTANCE's view (see
   * {@link pruneSourceEventSeqs}): only seqs it knows were dropped are
   * pruned — references to rows persisted by another instance (e.g. a resume
   * seed segment) must survive, so the disk-wide view used by the one-shot
   * repair script is not applicable here.
   * @param id - the session id.
   * @param refs - the event's `sourceEventSeqs` (upstream seqs).
   * @returns the pruned list; identical content when nothing was dropped.
   */
  pruneRefs(id, refs) {
    const dropped = this.filteredSeqs.get(id);
    if (dropped === void 0 || dropped.size === 0) return [...refs];
    return pruneSourceEventSeqs(refs, (seq) => !dropped.has(seq));
  }
};

// packages/session-persistence-rdb/src/adapters/to-sqlite.ts
import { sql } from "drizzle-orm";
import {
  check as sqliteCheck,
  index,
  integer,
  sqliteTable,
  text,
  unique
} from "drizzle-orm/sqlite-core";

// packages/session-persistence-rdb/src/entities/types.ts
function toProperty(name) {
  return name.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
}

// packages/session-persistence-rdb/src/adapters/to-sqlite.ts
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

// packages/session-persistence-rdb/src/adapters/to-postgres.ts
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

// packages/session-persistence-rdb/src/adapters/ddl.ts
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

// packages/session-persistence-rdb/src/entities/persistence-state.ts
var persistenceState = {
  name: "t_persistence_state",
  columns: [
    { name: "f_singleton", type: "integer", primaryKey: true },
    { name: "f_store_id", type: "text", notNull: true }
  ],
  checks: [{ name: "ck_persistence_state_singleton", expression: "f_singleton = 1" }]
};

// packages/session-persistence-rdb/src/entities/schema-meta.ts
var schemaMeta = {
  name: "t_schema_meta",
  columns: [
    { name: "f_key", type: "text", primaryKey: true },
    { name: "f_value", type: "text", notNull: true }
  ]
};

// packages/session-persistence-rdb/src/entities/sessions.ts
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
    { name: "f_seed_length", type: "integer" },
    { name: "f_origin", type: "text" },
    { name: "f_delegation_depth", type: "integer" },
    { name: "f_incarnation", type: "text", notNull: true },
    { name: "f_revision", type: "integer", notNull: true }
  ]
};

// packages/session-persistence-rdb/src/entities/events.ts
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

// packages/session-persistence-rdb/src/entities/session-events.ts
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

// packages/session-persistence-rdb/src/entities/index.ts
var sqliteTableDefs = [persistenceState, sessions, events, sessionEvents];
var postgresTableDefs = [
  persistenceState,
  schemaMeta,
  sessions,
  events,
  sessionEvents
];

// packages/session-persistence-rdb/src/schema.ts
var SCHEMA_VERSION = 1;
var SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 1146308688;
var EPHEMERAL_EVENT_TYPES = ["assistant/chunk"];
var EVENT_ENCODING = "json";
var sqliteTables = toSqliteSchema(sqliteTableDefs);
var tPersistenceState = sqliteTables["t_persistence_state"];
var tSessions = sqliteTables["t_sessions"];
var tEvents = sqliteTables["t_events"];
var tSessionEvents = sqliteTables["t_session_events"];
var DEFAULT_BUSY_TIMEOUT_MS = 5e3;
function isEphemeralType(type) {
  return EPHEMERAL_EVENT_TYPES.includes(type);
}
function isPersistedEvent(event) {
  return !isEphemeralType(event.type) && event.ignorable !== true;
}
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

// packages/session-persistence-rdb/src/sqlite.ts
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
    upsertSession: (meta, incarnation) => this.upsertSession(meta, incarnation),
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
  async upsertSession(meta, incarnation) {
    this.db.insert(tSessions).values(sessionInsertRow(meta, incarnation)).onConflictDoUpdate({
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
      fSourceEventSeqs: tEvents.fSourceEventSeqs,
      fSurfaceOp: tEvents.fSurfaceOp
    }).from(tSessionEvents).innerJoin(tEvents, eq(tSessionEvents.fEventId, tEvents.fEventId));
  }
};

// packages/session-persistence-rdb/src/postgres.ts
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
      upsertSession: (meta, incarnation) => this.upsertSession(tx, meta, incarnation),
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
  async upsertSession(exec, meta, incarnation) {
    await exec.insert(pgSessions).values(sessionInsertRow(meta, incarnation)).onConflictDoUpdate({
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
      fSourceEventSeqs: pgEvents.fSourceEventSeqs,
      fSurfaceOp: pgEvents.fSurfaceOp
    }).from(pgSessionEvents).innerJoin(pgEvents, eq2(pgSessionEvents.fEventId, pgEvents.fEventId));
  }
};

// packages/session-persistence-rdb/src/index.ts
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
  /** settings namespace：`$DSH_HOME/settings.yaml` 的 `session-persistence-rdb` section。 */
  static settingsNs = settingsNamespace("session-persistence-rdb");
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
   * Write-authority state: the confirmed dense head per session (concurrent-
   * writer detection) and the dropped delta seqs per session (provenance
   * pruning). See {@link WriteGuard} for the timing contract.
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
  create(meta) {
    return this.coordinator.create(meta);
  }
  append(id, events2) {
    return this.coordinator.append(id, events2);
  }
  load(id) {
    return this.coordinator.load(id);
  }
  inspect(id, signal) {
    return this.coordinator.inspect(id, signal);
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
   * directly, so the read scales with the suffix, not the log. Provenance
   * remapping still needs every row's upstream seq, so a lightweight
   * two-column map is read alongside. Torn rows past the preserved region are
   * dropped, never repaired (non-mutating read).
   */
  async loadStoredFrom(id, fromSeq, signal) {
    const log = await this.readLog(id, { fromSeq }, signal);
    if (log === void 0) return void 0;
    return { meta: log.meta, events: log.events };
  }
  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the persisted seq from which a never-committed tail
   * must be deleted (`scanRows` already returns it as `number | undefined`).
   * Records the confirmed dense head (or confirmed absence) so a later
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
   * Shared read pipeline: session row → meta, event rows → preserved prefix.
   * A whole-log read (`fromSeq` absent) builds the seq map from the same rows;
   * a suffix read keeps the backend's lightweight two-column seq-map source so
   * the query still scales with the suffix, not the log.
   */
  async readLog(id, options = {}, signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === void 0) return void 0;
    const meta = rowToMeta(row);
    let eventRows;
    let seqMap;
    if (options.fromSeq === void 0) {
      eventRows = await this.backend.getEventRows(id);
      seqMap = buildSeqMap(eventRows);
    } else {
      eventRows = await this.backend.getEventRows(id, options.fromSeq);
      seqMap = buildSeqMap(await this.backend.getSeqMapRows(id));
    }
    signal?.throwIfAborted();
    const { preserved, tornFrom } = scanRows(eventRows, options.fromSeq ?? 0, seqMap);
    return {
      meta,
      events: preserved,
      incarnation: row.fIncarnation,
      revision: row.fRevision,
      ...tornFrom !== void 0 ? { tornFrom } : {}
    };
  }
  /**
   * Durably append a batch in ONE transaction: materialize the sessions row (if
   * lazy) and INSERT every persisted event (plus its bridge row), or roll back
   * entirely. Delta events and events the writer marked `ignorable` are dropped
   * and the surviving events are re-numbered densely from the session's head
   * cursor; a batch that contains only dropped events is a no-op (no row
   * materialization, no revision bump). Dropped events' upstream seqs are
   * recorded per session so a later batch's surface provenance can prune
   * references to them (see {@link surfaceBindings}).
   * The transaction is the atomicity + durability boundary, so a mid-batch
   * failure (a UNIQUE violation on a duplicated seq) leaves the stored log
   * untouched.
   *
   * SQLite acquires the write lock up front (`BEGIN IMMEDIATE`, queued behind
   * `busy_timeout`); PostgreSQL relies on the transaction's row locks and the
   * `UNIQUE (f_session_id, f_sequence)` constraint to reject a colliding batch.
   * Either way {@link assertNoConcurrentWriter} rejects a second writer before
   * re-numbering — a session has exactly one writer per log, and a second
   * writer fails loud instead of corrupting the log.
   *
   * The row upsert runs UNCONDITIONALLY, not only when `!isMaterialized`: a
   * delta-only batch leaves the coordinator's materialized flag true while no
   * row exists, so the flag cannot be trusted as the row's existence signal.
   * The upsert keeps an existing row's head cursor (only header columns are
   * refreshed on conflict), so a fresh row still starts at the initial head.
   */
  async appendBatch(meta, events2, _isMaterialized) {
    await this.ready;
    const droppedSeqs = /* @__PURE__ */ new Set();
    for (const event of events2) {
      if (!isPersistedEvent(event)) droppedSeqs.add(event.seq);
    }
    if (droppedSeqs.size > 0) this.writeGuard.noteDropped(meta.id, droppedSeqs);
    const persisted = events2.filter(isPersistedEvent);
    if (persisted.length === 0) return;
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, randomUUID3());
      const head = await tx.getHead(meta.id);
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(
        tx,
        meta,
        persisted,
        { parentId: head.fHeadEventId, nextSeq: head.fHeadSequence + 1 },
        (refs) => this.writeGuard.pruneRefs(meta.id, refs)
      );
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });
    this.writeGuard.confirmHead(meta.id, confirmedHead);
  }
  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`), rewind the head cursor to the last surviving event, INSERT
   * the synthetic `closers`, and bump the revision once. After COMMIT the
   * stored rows == the balanced log.
   */
  async commitRepair(meta, tornMarker, closers) {
    await this.ready;
    const persistedClosers = closers.filter(isPersistedEvent);
    if (tornMarker === void 0 && persistedClosers.length === 0) return;
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
      if (persistedClosers.length > 0) {
        const last = await tx.getLastBridge(meta.id);
        const { headEventId, headSequence } = await appendEventTail(tx, meta, persistedClosers, {
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
function surfaceBindings(event, prune = (refs) => refs) {
  const se = event;
  const sourceSeqs = se.sourceEventSeqs === void 0 ? void 0 : prune(se.sourceEventSeqs);
  return [
    sourceSeqs !== void 0 && sourceSeqs.length > 0 ? JSON.stringify(sourceSeqs) : null,
    se.surfaceOp !== void 0 ? JSON.stringify(se.surfaceOp) : null
  ];
}
async function appendEventTail(tx, meta, events2, anchor, prune = (refs) => refs) {
  let parentId = anchor.parentId;
  let nextSeq = anchor.nextSeq;
  const eventRows = [];
  const bridgeRows = [];
  for (const event of events2) {
    const eventId = randomUUID3();
    const { role, name, actionId } = eventDimensions(event);
    const [surfaceSeqs, surfaceOp] = surfaceBindings(event, prune);
    eventRows.push({
      fEventId: eventId,
      fParentId: parentId,
      fKind: event.type,
      fRole: role,
      fName: name,
      fActionId: actionId,
      fEncoding: EVENT_ENCODING,
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
  EPHEMERAL_EVENT_TYPES,
  SCHEMA_VERSION,
  SessionPersistenceRdb,
  index_default as default
};

// src/index.ts
import z from "@deepseek-ai/schemastery";
import { randomUUID as randomUUID3 } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionAlreadyExistsError as SessionAlreadyExistsError2,
  SessionPersistence,
  SessionPersistenceNotFoundError as SessionPersistenceNotFoundError2,
  SessionPersistenceRevision as SessionPersistenceRevision2,
  assertVersion as assertVersion2,
  materializeCreateHeader
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset as SessionLogOffset2
} from "@deepseek-ai/dsh-session";

// src/write-guard.ts
import { SessionOwnershipLostError } from "@deepseek-ai/dsh-session-persistence";
var WriterDivergenceError = class extends SessionOwnershipLostError {
  /** @param id - the session whose durable head diverged. */
  constructor(id, detail) {
    super(id);
    this.message = `${this.message} (${detail})`;
  }
};
var WriteGuard = class {
  /**
   * Last CONFIRMED head per session — the head this instance itself wrote or
   * observed when it loaded the stored log. `-1` records a confirmed absence.
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
   * means this instance's handle cursor is not the log's authority.
   * @param id - the session id.
   * @param storedHead - the on-disk head cursor, read inside the append
   *   transaction before any row is inserted.
   */
  assertNoConcurrentWriter(id, storedHead) {
    const known = this.headSeqs.get(id);
    if (known === void 0) {
      if (storedHead !== -1) {
        throw new WriterDivergenceError(
          id,
          "a persisted log exists that this instance has not read; another writer may own it \u2014 open the session for write first"
        );
      }
      return;
    }
    if (known !== storedHead) {
      throw new WriterDivergenceError(
        id,
        `modified by another writer: stored head ${storedHead}, this instance last confirmed head ${known}; concurrent writers on one session are not supported`
      );
    }
  }
};

// src/migrate.ts
import {
  sessionFormatCatalog,
  SessionFormatUnsupportedMigrationError
} from "@deepseek-ai/dsh-session-format-catalog";
import { SESSION_FORMAT_VERSION, SessionLogOffset } from "@deepseek-ai/dsh-session";
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  assertStoredId,
  assertVersion,
  validateStoredEvents
} from "@deepseek-ai/dsh-session-persistence";

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
  if (event.type === "todo/write") return { role: "state", name: "todos", actionId: "" };
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
    case "system/message":
      return { role: "system", name: "", actionId: "" };
    case "assistant/message":
    case "assistant/attempt":
      return { role: "model", name: "", actionId: "" };
    case "tool/call":
      return { role: "function", name: event.data.name, actionId: event.data.callId };
    case "tool/result": {
      const block = event.data.message?.content[0];
      return { role: "function", name: "", actionId: block?.toolCallId ?? "" };
    }
    default:
      return { role: "", name: "", actionId: "" };
  }
}

// src/log.ts
function replaceRange(op) {
  const start = op.start ?? op.startSeq;
  const end = op.end ?? op.endSeq;
  if (typeof start !== "number" || typeof end !== "number") return void 0;
  return { start, end };
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
function sessionRewriteRow(meta, inheritedEventCount) {
  return {
    ...sessionConflictRow(meta),
    fSeedLength: meta.isSeeded ? inheritedEventCount : null
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
function buildSeqMap(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}
function releasedSurfaceOp(op, remap) {
  if (op === "append") return "append";
  if (op === null || typeof op !== "object") return op;
  const range = replaceRange(op);
  if (range === void 0) return op;
  return { op: "replace", start: remap(range.start), end: remap(range.end) };
}
function currentSurfaceOp(op) {
  if (op === "append") return "append";
  if (op === null || typeof op !== "object") return op;
  const range = replaceRange(op);
  if (range === void 0) return op;
  return { op: "replace", startSeq: range.start, endSeq: range.end };
}
function remapReleasedData(type, data, remap) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return;
  const record = data;
  const remapArray = (value) => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => typeof entry === "number" ? remap(entry) : entry);
  };
  switch (type) {
    case "compaction/summary":
    case "compaction/prune": {
      const range = record["shadowedRange"];
      if (range !== null && typeof range === "object" && !Array.isArray(range)) {
        const { start, end } = range;
        if (typeof start === "number" && typeof end === "number") {
          record["shadowedRange"] = { start: remap(start), end: remap(end) };
        }
      }
      if (record["shadowedSeqs"] !== void 0) {
        record["shadowedSeqs"] = remapArray(record["shadowedSeqs"]);
      }
      break;
    }
    case "session/title":
    case "session/title-llm-request": {
      if (record["messageSeqs"] !== void 0) {
        record["messageSeqs"] = remapArray(record["messageSeqs"]);
      }
      break;
    }
    case "command/done": {
      const source = record["sourceEventSeq"];
      if (typeof source === "number") record["sourceEventSeq"] = remap(source);
      break;
    }
    default:
      break;
  }
}
function rowToReleasedRow(row, remap = (seq) => seq, projectSurface = releasedSurfaceOp) {
  const data = JSON.parse(row.fData);
  remapReleasedData(row.fKind, data, remap);
  const released = {
    type: row.fKind,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data
  };
  if (row.fEncoding === IGNORABLE_EVENT_ENCODING) released.ignorable = true;
  if (row.fSourceEventSeqs !== null) {
    const sources = JSON.parse(row.fSourceEventSeqs).map(remap);
    if (sources.length > 0) released.sourceEventSeqs = sources;
  }
  if (row.fSurfaceOp !== null) {
    released.surfaceOp = projectSurface(JSON.parse(row.fSurfaceOp), remap);
  }
  return released;
}
function scanRows(rows, base = 0) {
  const parsed = rows.map((row) => {
    try {
      JSON.parse(row.fData);
      return true;
    } catch {
      return false;
    }
  });
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i] === true && rows[i]?.fKind === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }
  const preserved = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (parsed[i] !== true) {
      if (i <= lastTurnEnd)
        throw new Error(`corrupt session log: unparsable committed event at seq ${row.fSequence}`);
      break;
    }
    if (row.fSequence !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${row.fSequence})`
        );
      break;
    }
    preserved.push(row);
  }
  return preserved.length < rows.length ? { preserved, tornFrom: base + preserved.length } : { preserved };
}

// src/migrate.ts
if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
  throw new Error(
    `session-persistence-rdb: format catalog v${sessionFormatCatalog.currentVersion} does not match Session v${SESSION_FORMAT_VERSION}`
  );
}
function physicalHeader(row, inheritedEventCount) {
  const seeded = row.fSeedLength !== null;
  const base = {
    type: "session",
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    delegationDepth: row.fDelegationDepth ?? 0,
    ...row.fCwd !== null ? { cwd: row.fCwd } : {},
    ...row.fParentSession !== null ? { parentSession: row.fParentSession } : {},
    ...row.fOrigin !== null ? { origin: row.fOrigin } : {}
  };
  return row.fVersion >= 2 ? { ...base, isSeeded: seeded } : { ...base, ...seeded ? { seedLength: inheritedEventCount } : {} };
}
function migrationFailure(error, id, location) {
  if (error instanceof SessionFormatUnsupportedMigrationError) {
    return new SessionFormatUnsupportedError(
      location === void 0 ? `${error.message} (session "${id}")` : `${error.message} (session "${id}"; raw store: ${location.path})`,
      location
    );
  }
  if (error instanceof SessionPersistenceCorruptionError) return error;
  if (error instanceof SessionFormatUnsupportedError) return error;
  return new SessionPersistenceCorruptionError(
    `session "${id}": stored log is corrupt: ${error instanceof Error ? error.message : String(error)}${location === void 0 ? "" : ` (raw store: ${location.path})`}`,
    { cause: error }
  );
}
function storedHeader(row, location) {
  const headerValue = physicalHeader(row, row.fSeedLength ?? 0);
  let header;
  try {
    const classification = sessionFormatCatalog.readHeader(headerValue);
    if (classification.status === "unsupported") {
      throw new SessionFormatUnsupportedError(
        `${classification.reason} (session "${row.fSessionId}")${location === void 0 ? "" : `; raw store: ${location.path}`}`,
        location
      );
    }
    if (classification.status === "malformed") {
      const reason = new Error(classification.reason);
      throw new SessionPersistenceCorruptionError(
        `session "${row.fSessionId}": stored header is malformed: ${classification.reason}`,
        { cause: reason }
      );
    }
    header = classification.header;
  } catch (error) {
    if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) {
      throw error;
    }
    throw migrationFailure(error, row.fSessionId, location);
  }
  const meta = header;
  assertVersion(meta, location);
  assertStoredId(row.fSessionId, meta);
  return meta;
}
function decodeStoredLog(row, rows, location) {
  const id = row.fSessionId;
  let preserved;
  let tornFrom;
  try {
    ({ preserved, tornFrom } = scanRows(rows));
  } catch (error) {
    throw new SessionPersistenceCorruptionError(
      `session "${id}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const legacy = hasLegacyRenumbering(rows);
  const inheritedEventCount = storedInheritedCount(row.fSeedLength, rows, legacy);
  const headerValue = physicalHeader(row, inheritedEventCount);
  let restore;
  try {
    restore = sessionFormatCatalog.createRestore(headerValue, {
      recovery: "strict",
      validation: "transformed"
    });
  } catch (error) {
    throw migrationFailure(error, id, location);
  }
  const remap = legacy ? buildSeqMap(rows) : void 0;
  const remapSeq = (seq) => remap?.get(seq) ?? seq;
  const dropPrunedChunkProvenance = legacy && !preserved.some((candidate) => candidate.fKind === "assistant/chunk");
  const projectSurface = row.fVersion === SESSION_FORMAT_VERSION ? currentSurfaceOp : void 0;
  for (const candidate of preserved) {
    let releasedRow;
    try {
      releasedRow = rowToReleasedRow(candidate, remapSeq, projectSurface);
      if (dropPrunedChunkProvenance && releasedRow.type === "assistant/message" && releasedRow.sourceEventSeqs !== void 0) {
        delete releasedRow.sourceEventSeqs;
      }
    } catch (error) {
      throw migrationFailure(error, id, location);
    }
    try {
      restore.decodeRow(releasedRow);
    } catch (error) {
      throw migrationFailure(error, id, location);
    }
  }
  let artifact;
  try {
    artifact = restore.finish();
  } catch (error) {
    throw migrationFailure(error, id, location);
  }
  const meta = artifact.header;
  assertVersion(meta, location);
  assertStoredId(row.fSessionId, meta);
  const events2 = validateStoredEvents(
    meta,
    artifact.events.map((event) => event),
    location
  );
  return {
    meta,
    inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
    events: events2,
    eventState: "detached",
    ...tornFrom !== void 0 ? { tornFrom } : {},
    legacy,
    current: !legacy && row.fVersion === SESSION_FORMAT_VERSION
  };
}

// src/handle.ts
import {
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch
} from "@deepseek-ai/dsh-session-persistence";
var LIVE_WRITE_BATCH_MAX_DELAY_MS = 200;
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
var RdbSessionHandle = class {
  constructor(storage, id, header, access, state) {
    this.storage = storage;
    this.id = id;
    this.header = header;
    this.access = access;
    this.state = state;
    this.observedLength = state.primed?.events.length ?? 0;
  }
  storage;
  id;
  header;
  access;
  state;
  /** Per-handle mutation chain; the stored promise never rejects. */
  chain = Promise.resolve();
  closing;
  /** Highest event count this handle has observed (monotonic-read guard). */
  observedLength = 0;
  /** Routed live events awaiting their batching deadline (persistence-owned copies). */
  buffered = [];
  batchTimer;
  /** Set when a drain failed; the automatic timer stays quiet until the next drain. */
  drainPaused = false;
  draining;
  /** Exact fork-inherited prefix length stored with this session's log. */
  get inheritedEventCount() {
    return this.state.inheritedEventCount;
  }
  /**
   * Read a slice of the valid contiguous logical log; see the seam contract.
   * @param offset - first logical seq to include (default 0).
   * @param length - maximum events returned (default: the rest).
   * @param options - optional cancellation.
   * @returns a caller-owned outer slice carrying its values' ownership state.
   */
  async read(offset = 0, length, options) {
    this.assertOpen("read");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
    }
    if (length !== void 0 && (!Number.isSafeInteger(length) || length < 0)) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
    }
    options?.signal?.throwIfAborted();
    const events2 = await this.sourceEvents(options?.signal);
    const end = length === void 0 ? void 0 : offset + length;
    return { eventState: "detached", events: events2.slice(offset, end) };
  }
  /**
   * Durably append a contiguous batch; see the seam contract.
   * @param events - the contiguous batch in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  async append(events2, options) {
    this.assertOpen("append");
    const batch = materializeAppendBatch(events2);
    return this.run("append", async () => {
      options?.signal?.throwIfAborted();
      await this.flushBuffered();
      await this.persistContiguous(batch);
    });
  }
  /**
   * The durability barrier: routed live events drain durably and the session is
   * materialized, so an explicitly flushed empty session survives this process.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options) {
    return this.run("flush", async () => {
      options?.signal?.throwIfAborted();
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
      await this.flushBuffered();
      options?.signal?.throwIfAborted();
      if (this.state.materialized) return;
      await this.storage.materializeHeader(this.header, this.state.inheritedEventCount);
      this.state.materialized = true;
      this.storage.markMaterialized(this.id);
    });
  }
  /**
   * Release the handle; see the seam contract. Idempotent and uncancellable: a
   * write handle first drains its routed live buffer, so teardown loses nothing
   * regardless of which fiber unwinds first.
   * @returns settlement of the release.
   */
  close() {
    return this.closing ??= (async () => {
      let drainFailure;
      for (; ; ) {
        try {
          await this.drainLive();
        } catch (error) {
          drainFailure = error;
          break;
        }
        await this.chain;
        if (this.buffered.length === 0) break;
      }
      await this.chain;
      if (this.batchTimer !== void 0) {
        clearTimeout(this.batchTimer);
        this.batchTimer = void 0;
      }
      this.storage.releaseHandle(this, this.state.materialized);
      if (drainFailure !== void 0) throw toError(drainFailure);
    })();
  }
  /** `await using` support: delegates to {@link close}. */
  [Symbol.asyncDispose]() {
    return this.close();
  }
  /**
   * Buffer one published live session event and arm the bounded batching
   * window when it is idle. The routing installer is the only caller.
   * @param event - the live event, retained as a persistence-owned copy.
   * @param reportBackgroundFailure - observes a deadline-driven drain failure
   *   (the events stay buffered; the next {@link drainLive} retries loudly).
   */
  enqueueLive(event, reportBackgroundFailure) {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== void 0 || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = void 0;
      this.drainLive().catch(reportBackgroundFailure);
    }, LIVE_WRITE_BATCH_MAX_DELAY_MS);
    this.batchTimer.unref?.();
  }
  /**
   * Durably drain the routed live buffer through the mutation chain; concurrent
   * callers join one drain, and a failure retains the batch in order so
   * `session/flush` can retry and reject loudly.
   */
  drainLive() {
    this.draining ??= this.enqueueChain(() => this.flushBuffered()).finally(() => {
      this.draining = void 0;
    });
    return this.draining;
  }
  /** The events this handle can currently serve, honoring this handle's view. */
  async sourceEvents(signal) {
    const primed = this.state.primed;
    if (primed !== void 0 && this.access === "write") return primed.events;
    if (!this.state.materialized && this.storage.hasPending(this.id)) return [];
    const log = await this.storage.loadStored(this.id, signal);
    if (log === void 0) {
      if (this.storage.hasPending(this.id)) return [];
      throw new SessionPersistenceNotFoundError(this.id);
    }
    if (log.events.length < this.observedLength) {
      throw new Error(
        `session "${this.id}": stored log shrank below a previously observed prefix (${log.events.length} < ${this.observedLength})`
      );
    }
    this.observedLength = log.events.length;
    return log.events;
  }
  /** The shared durable-append body: contiguity, torn-tail repair, storage write, state advance. */
  async persistContiguous(batch) {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append");
    if (batch.length === 0) return;
    assertContiguous(this.id, batch, this.state.cursor);
    if (this.state.tornFrom !== void 0) {
      await this.storage.truncateTornTail(this.header, this.state.tornFrom);
      this.state.tornFrom = void 0;
    }
    await this.storage.appendBatch(this.header, this.state.inheritedEventCount, batch);
    this.state.materialized = true;
    this.state.cursor += batch.length;
    this.state.primed = void 0;
    this.observedLength = this.state.cursor;
    this.storage.markMaterialized(this.id);
  }
  /** Drain the routed live buffer; assumes the caller holds the mutation chain. */
  async flushBuffered() {
    if (this.batchTimer !== void 0) {
      clearTimeout(this.batchTimer);
      this.batchTimer = void 0;
    }
    this.drainPaused = false;
    while (this.buffered.length > 0) {
      const batch = this.buffered.splice(0);
      try {
        await this.persistContiguous(materializeAppendBatch(batch));
      } catch (error) {
        this.buffered = batch.concat(this.buffered);
        this.drainPaused = true;
        throw error;
      }
    }
  }
  /** Serialize one operation onto the chain without the closed-handle refusal. */
  enqueueChain(op) {
    const next = this.chain.then(op);
    this.chain = next.then(
      () => void 0,
      () => void 0
    );
    return next;
  }
  /** Serialize one public mutating operation onto this handle's chain. */
  async run(operation, op) {
    this.assertOpen(operation);
    return this.enqueueChain(async () => {
      this.assertOpen(operation);
      return op();
    });
  }
  assertOpen(operation) {
    if (this.closing !== void 0) throw new SessionHandleClosedError(this.id, operation);
  }
};

// src/tracker.ts
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError as SessionHandleClosedError2,
  SessionPersistenceRevision
} from "@deepseek-ai/dsh-session-persistence";
var RdbTracker = class {
  /** @param name - backend label used in in-memory revision tokens and teardown errors. */
  constructor(name) {
    this.name = name;
  }
  name;
  /** Every open handle; teardown closes what remains. */
  openHandles = /* @__PURE__ */ new Set();
  /** `null` marks a claim whose handle is still being constructed. */
  writers = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  counter = 0;
  /**
   * Claim write ownership and record the created session as pending, making it
   * observable to this process before it materializes.
   * @param header - the validated detached header.
   * @param inheritedEventCount - the exact fork-inherited prefix length.
   * @throws {SessionAlreadyExistsError} when a concurrent create or an open
   *   write handle holds the id — for create, the duplicate is the fact.
   */
  registerCreated(header, inheritedEventCount) {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    this.writers.set(header.id, null);
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount
    });
  }
  /**
   * Claim write ownership for an existing session.
   * @param id - the session to claim.
   * @throws {SessionAlreadyOwnedError} when an active write handle exists.
   */
  claimWrite(id) {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    this.writers.set(id, null);
  }
  /**
   * Roll a failed write open back.
   * @param id - the session whose claim is dropped.
   */
  releaseClaim(id) {
    this.writers.delete(id);
  }
  /**
   * The pending entry for a created-but-unmaterialized session, if any.
   * @param id - the session to look up.
   * @returns the pending header and in-memory revision.
   */
  pendingOf(id) {
    return this.pending.get(id);
  }
  /**
   * Whether this process still tracks a created-but-unmaterialized session.
   * @param id - the session to test.
   * @returns true while the pending entry exists.
   */
  hasPending(id) {
    return this.pending.has(id);
  }
  /**
   * Iterate the pending sessions for listing.
   * @returns the pending entries, keyed by session id.
   */
  pendingEntries() {
    return this.pending.entries();
  }
  /**
   * Drop a pending entry once the session materialized durably.
   * @param id - the session that reached durable storage.
   */
  materialized(id) {
    this.pending.delete(id);
  }
  /**
   * Track one open handle for teardown and, for a write handle, bind it as the
   * session's live event route.
   * @param handle - the just-constructed handle.
   * @returns the same handle, for construction-site chaining.
   */
  adopt(handle) {
    this.openHandles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }
  /**
   * Release one handle's bookkeeping on close. A write handle drops its
   * ownership claim; a creator that never materialized leaves nothing behind —
   * the session never existed.
   * @param handle - the closing handle.
   * @param materialized - whether the session reached durable storage.
   */
  release(handle, materialized) {
    this.openHandles.delete(handle);
    if (handle.access !== "write") return;
    this.writers.delete(handle.id);
    if (!materialized) this.pending.delete(handle.id);
  }
  /**
   * Drain and flush every active write handle — the service-wide durability
   * barrier behind `SessionPersistence.flush`.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  async flushAll() {
    const errors = [];
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue;
      try {
        await writer.drainLive();
        await writer.flush();
      } catch (error) {
        if (error instanceof SessionHandleClosedError2) continue;
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`);
  }
  /**
   * Install the backend's live session routing and teardown. Persistence
   * enforces one active write handle per id, so the listeners route published
   * sessions' events by id; the teardown effect closes every open handle —
   * close drains the routed buffer — and then runs the backend's own teardown
   * (closing the database connection). Registrations are effects of the current
   * fiber.
   * @param ctx - the backend's context.
   * @param closeStorage - backend teardown, run after every handle is closed.
   */
  install(ctx, closeStorage) {
    ctx.on("session/event", (session, event) => {
      this.writers.get(session.id)?.enqueueLive(event, (error) => {
        ctx.logger.warn(
          `session-persistence-rdb: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`
        );
      });
    });
    ctx.on("session/flush", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === void 0) return void 0;
      return (async () => {
        await writer.drainLive();
        await writer.flush();
      })();
    });
    ctx.on("session/disposed", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === void 0) return;
      writer.close().catch((error) => {
        ctx.logger.warn(
          `session-persistence-rdb: final drain for session "${session.id}" failed: ${String(error)}`
        );
      });
    });
    ctx.effect(
      () => async () => {
        const errors = [];
        for (const handle of [...this.openHandles]) {
          try {
            await handle.close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await closeStorage();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `${this.name} dispose failed`);
        }
      },
      `${this.name} open handles`
    );
  }
};

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
  location;
  /** The resolved database path (queue key); set by {@link open}. */
  dbPath = "";
  db;
  async open() {
    const actual = this.options.path === ":memory:" ? this.options.path : resolve(this.options.path);
    this.dbPath = actual;
    this.location = { kind: "sqlite", path: actual };
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
  async getEventRows(id) {
    return this.eventRows().where(eq(tSessionEvents.fSessionId, id)).orderBy(tSessionEvents.fSequence).all();
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
    rewriteSessionHeader: (meta, inheritedEventCount) => this.rewriteSessionHeader(meta, inheritedEventCount),
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
  async rewriteSessionHeader(meta, inheritedEventCount) {
    this.db.update(tSessions).set(sessionRewriteRow(meta, inheritedEventCount)).where(eq(tSessions.fSessionId, meta.id)).run();
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
  location;
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
    this.location = { kind: "postgres", path: this.options.identityBase };
  }
  async close() {
    await this.options.close();
  }
  async getSession(id) {
    return (await this.db.select().from(pgSessions).where(eq2(pgSessions.fSessionId, id)).execute())[0];
  }
  async getEventRows(id) {
    return this.eventRows(this.db).where(eq2(pgSessionEvents.fSessionId, id)).orderBy(pgSessionEvents.fSequence).execute();
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
      rewriteSessionHeader: (meta, inheritedEventCount) => this.rewriteSessionHeader(tx, meta, inheritedEventCount),
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
  async rewriteSessionHeader(exec, meta, inheritedEventCount) {
    await exec.update(pgSessions).set(sessionRewriteRow(meta, inheritedEventCount)).where(eq2(pgSessions.fSessionId, meta.id)).execute();
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
    this.tracker.install(ctx, async () => {
      await this.ready;
      await this.backend.close();
    });
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
   * Backend label for teardown diagnostics and live-routing warnings.
   * Intentionally shadows cordis `Service.name` (set to `'sessionPersistence'`
   * by the base); see the JSONL backend for why this does not affect service
   * resolution.
   */
  name = "session-persistence-rdb";
  backend;
  storeIdentity;
  ready;
  /**
   * Write-authority state: the confirmed head per session (CROSS-process
   * concurrent-writer detection). See {@link WriteGuard} for the timing
   * contract; the in-process single-writer registry lives in the tracker.
   */
  writeGuard = new WriteGuard();
  /** In-process write ownership, live event routing, and open-handle teardown. */
  tracker = new RdbTracker("session-persistence-rdb");
  async init() {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }
  /**
   * Refusal diagnostics: this backend has ONE database, not an independent
   * artifact per session, so a format refusal points at the database the
   * instance serves rather than at a per-session file.
   */
  locate() {
    return this.backend.location;
  }
  // --- SessionPersistence service surface ---
  /**
   * Create a new stored session and take its write ownership. The session is
   * visible to this process through `stat`/`list`/`open` immediately; its
   * database row appears on the first append or on `flush`/`close`.
   * @param header - the immutable header to store.
   * @param options - optional cancellation and the exact fork-inherited prefix.
   * @returns the owned write handle.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  async create(header, options) {
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    assertVersion2(snapshot, this.locate());
    if (snapshot.isSeeded && options?.inheritedEventCount === void 0) {
      throw new Error("seeded session header requires an inherited event count");
    }
    const inheritedEventCount = SessionLogOffset2(options?.inheritedEventCount ?? 0);
    if (!snapshot.isSeeded && inheritedEventCount !== 0) {
      throw new Error("unseeded session header inherited event count must be 0");
    }
    await this.ready;
    options?.signal?.throwIfAborted();
    if (this.tracker.hasPending(snapshot.id)) throw new SessionAlreadyExistsError2(snapshot.id);
    if (await this.backend.getSession(snapshot.id) !== void 0) {
      throw new SessionAlreadyExistsError2(snapshot.id);
    }
    options?.signal?.throwIfAborted();
    this.tracker.registerCreated(snapshot, inheritedEventCount);
    return this.tracker.adopt(
      new RdbSessionHandle(this, snapshot.id, snapshot, "write", {
        cursor: 0,
        materialized: false,
        inheritedEventCount,
        // A created session has an empty log until its first append; serving
        // that from memory keeps the resume handoff read from touching the
        // database before anything was written.
        primed: {
          meta: snapshot,
          inheritedEventCount,
          events: [],
          eventState: "detached",
          legacy: false,
          current: true
        }
      })
    );
  }
  /**
   * Open an existing stored session for `read` or single-writer `write`.
   *
   * A `write` open of a released-format log rewrites it into the current format
   * (in one transaction) BEFORE ownership is granted, so every later append
   * lands next to current-format rows.
   * @param id - the stored session to open.
   * @param access - `read` (no ownership) or `write` (atomic in-process claim).
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  async open(id, access, options) {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    if (access === "read") {
      const pending = this.tracker.pendingOf(id);
      if (pending !== void 0) {
        return this.tracker.adopt(
          new RdbSessionHandle(this, id, pending.header, "read", {
            cursor: 0,
            materialized: false,
            inheritedEventCount: pending.inheritedEventCount
          })
        );
      }
      const stored = await this.loadStored(id, options?.signal);
      if (stored === void 0) throw new SessionPersistenceNotFoundError2(id);
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, stored.meta, "read", {
          cursor: 0,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          ...stored.tornFrom !== void 0 ? { tornFrom: stored.tornFrom } : {}
        })
      );
    }
    this.tracker.claimWrite(id);
    try {
      const loaded = await this.loadStored(id, options?.signal);
      if (loaded === void 0) throw new SessionPersistenceNotFoundError2(id);
      const stored = loaded.current ? loaded : await this.rewriteStored(loaded);
      options?.signal?.throwIfAborted();
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, stored.meta, "write", {
          cursor: stored.events.length,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          ...stored.tornFrom !== void 0 ? { tornFrom: stored.tornFrom } : {},
          primed: stored
        })
      );
    } catch (error) {
      this.tracker.releaseClaim(id);
      throw error;
    }
  }
  /**
   * Flush every active write handle in one durability barrier; see the seam
   * contract.
   * @returns resolution once every write handle active at the call has flushed.
   */
  async flush() {
    await this.ready;
    await this.tracker.flushAll();
  }
  /**
   * Observe one stored session without reading its event log.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  async stat(id, options) {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    const pending = this.tracker.pendingOf(id);
    if (pending !== void 0) {
      return { header: pending.header, revision: pending.revision };
    }
    const row = await this.backend.getSession(id);
    if (row === void 0) return void 0;
    options?.signal?.throwIfAborted();
    return { header: storedHeader(row, this.locate()), revision: this.revisionOf(row) };
  }
  /**
   * List every stored session visible to this process: materialized rows plus
   * this process's created-but-unmaterialized sessions.
   * @param options - optional cancellation.
   * @returns one snapshot per session, in no promised order.
   */
  async list(options) {
    const signal = options?.signal;
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    const snapshots = rows.map((row) => ({
      header: storedHeader(row, this.locate()),
      revision: this.revisionOf(row)
    }));
    const listed = new Set(rows.map((row) => row.fSessionId));
    for (const [id, pending] of this.tracker.pendingEntries()) {
      if (listed.has(id)) continue;
      snapshots.push({ header: pending.header, revision: pending.revision });
    }
    return snapshots;
  }
  // --- RdbHandleStorage: the storage primitives the handles drive ---
  /**
   * Read one stored session's row + ordered events and decode them into the
   * current format. Records the confirmed head (or confirmed absence) so a
   * later append can detect another PROCESS that advanced the log.
   * @param id - the stored session.
   * @param signal - optional cancellation for the two reads and the decode.
   * @returns the migrated log, or `undefined` when no row exists.
   */
  async loadStored(id, signal) {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === void 0) {
      this.writeGuard.confirmHead(id, -1);
      return void 0;
    }
    const rows = await this.backend.getEventRows(id);
    signal?.throwIfAborted();
    const log = decodeStoredLog(row, rows, this.locate());
    signal?.throwIfAborted();
    this.writeGuard.confirmHead(id, log.events.length - 1);
    return log;
  }
  /**
   * Rewrite a released-format session log into the current format in ONE
   * transaction: replace the header columns (including the inherited cut, which
   * the ordinary conflict update deliberately preserves), drop the old bridge
   * rows, insert the migrated events as identity rows, and bump the revision.
   * The orphaned `t_events` entities of the replaced rows are left in place —
   * like a torn-tail truncate, deletion only ever touches the session's
   * bridge.
   * @param log - the migrated (already decoded) released-format log.
   * @returns the re-read current-format log.
   */
  async rewriteStored(log) {
    await this.ready;
    const { meta, inheritedEventCount, events: events2 } = log;
    await this.backend.transaction(async (tx) => {
      await tx.rewriteSessionHeader(meta, inheritedEventCount);
      await tx.deleteBridgeTail(meta.id, 0);
      if (events2.length > 0) {
        const { headEventId, headSequence } = await appendEventTail(tx, meta, events2, {
          parentId: "",
          nextSeq: 0
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      } else {
        await tx.updateHead(meta.id, "", -1);
      }
      await tx.bumpRevision(meta.id);
    });
    const rewritten = await this.loadStored(meta.id);
    if (rewritten === void 0) {
      throw new Error(`session "${meta.id}" disappeared during its format migration`);
    }
    return rewritten;
  }
  /**
   * Durably append one validated batch to a session's tail in ONE transaction:
   * materialize the header row (if the session is new) and insert every event
   * plus its bridge row, or roll back entirely.
   *
   * {@link WriteGuard.assertNoConcurrentWriter} rejects a second PROCESS's
   * writer before any row lands: each backend instance keeps its own cursor and
   * would otherwise append through a stale view of the log. SQLite additionally
   * acquires the write lock up front (`BEGIN IMMEDIATE`, queued behind
   * `busy_timeout`); PostgreSQL relies on the transaction's row locks and the
   * `UNIQUE (f_session_id, f_sequence)` constraint.
   * @param meta - the session's current-format header.
   * @param inheritedEventCount - its exact inherited cut.
   * @param events - the contiguous batch to persist, in seq order.
   */
  async appendBatch(meta, inheritedEventCount, events2) {
    await this.ready;
    if (events2.length === 0) return;
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, inheritedEventCount, randomUUID3());
      const head = await tx.getHead(meta.id);
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(tx, meta, events2, {
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
   * one transaction) WITHOUT any event row. Row existence IS the
   * materialization signal, so there is no head-cursor advance and no revision
   * bump.
   * @param meta - the session's current-format header.
   * @param inheritedEventCount - its exact inherited cut.
   */
  async materializeHeader(meta, inheritedEventCount) {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, inheritedEventCount, randomUUID3());
    });
  }
  /**
   * Durably drop a never-committed torn tail: DELETE the bridge rows from
   * `from`, rewind the head cursor to the last surviving event, and bump the
   * revision once. Called by a write handle immediately before its first new
   * append (the seam's "a torn tail is truncated by the write path before its
   * first append").
   * @param meta - the session's current-format header.
   * @param from - the presented seq the tail starts at.
   */
  async truncateTornTail(meta, from) {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.deleteBridgeTail(meta.id, from);
      const prev = await tx.getPrevBridge(meta.id, from - 1);
      await tx.updateHead(meta.id, prev?.fEventId ?? "", prev?.fSequence ?? -1);
      await tx.bumpRevision(meta.id);
    });
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }
  /** Whether this process still tracks a created-but-unmaterialized session. */
  hasPending(id) {
    return this.tracker.hasPending(id);
  }
  /** Drop a session's in-process pending entry once it reached durable storage. */
  markMaterialized(id) {
    this.tracker.materialized(id);
  }
  /** Release one handle's in-process bookkeeping on close. */
  releaseHandle(handle, materialized) {
    this.tracker.release(handle, materialized);
  }
  /** Source-qualified revision token for one stored row. */
  revisionOf(row) {
    return SessionPersistenceRevision2(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`
    );
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
async function appendEventTail(tx, meta, events2, anchor) {
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

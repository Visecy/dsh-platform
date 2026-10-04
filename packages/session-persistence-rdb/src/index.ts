/**
 * SQLite / PostgreSQL durable session-persistence backend for the 0.1.5
 * handle-based persistence seam.
 *
 * Storage follows the playpen-session store: `t_sessions` carries the header
 * and a head cursor, `t_events` stores each event as a globally addressable
 * entity (event id + parent chain + kind/role/name/action-id dimensions), and
 * `t_session_events` bridges sessions to events in per-session seq order.
 *
 * Since 0.1.2 the backend persists EVERY event the writer produces —
 * `assistant/attempt`/`assistant/message` streams and events marked
 * `ignorable` included — under its exact logical seq (`f_original_seq` ==
 * `f_sequence` == event.seq). Nothing is dropped or renumbered at write time,
 * so provenance columns are stored verbatim and reads pass through as
 * identity. Logs written by the rc.2-era backend (which dropped
 * `assistant/chunk` deltas and dense-renumbered survivors) stay readable: a
 * legacy segment is detected by `f_original_seq != f_sequence` rows and
 * routed through the legacy upstream→presented remap pre-pass (see `log.ts`),
 * then through the same format migration as every other log.
 *
 * Format migration: every read serves the CURRENT session format (v3). Rows
 * are synthesized into released physical records and streamed through
 * `sessionFormatCatalog` (v0→v1→v2→v3); see `migrate.ts` for exactly which
 * shapes take which path. A released-format log is additionally REWRITTEN in
 * place by `open(id, 'write')` before write ownership is granted, because a
 * current-format append must not land next to released-format rows the current
 * decoder cannot read.
 *
 * This class owns the handle seam's orchestration: the in-process single-writer
 * registry, per-session operation serialization (in the handles), the live
 * `session/event` → buffer / `session/flush` → drain barrier /
 * `session/disposed` → close routing, and the teardown that closes every open
 * handle before the database. `WriteGuard` remains anchored inside the append
 * transaction as the CROSS-process (two dsh processes on one database)
 * detector.
 *
 * The database is chosen by configuration (discriminated union on `type`):
 * `{ type: "sqlite", path }` or `{ type: "postgres", connectionString }`.
 * All access goes through drizzle; the schema is declared once per dialect
 * (`schema.ts` / `postgres.ts`) and the hand-written DDL there is the only
 * migration story for the PHYSICAL table layout (no migration toolchain —
 * incompatible stores are rejected, never migrated). The layout is unchanged
 * from the rc.2 era, so existing databases open as-is; only the logical session
 * format inside the JSON columns needed migrating.
 *
 * It has no independent per-session artifact, so its locator is a
 * refusal-diagnostics pointer at the one database this instance serves.
 * @module @visecy/dsh-session-persistence-rdb
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  assertVersion,
  materializeCreateHeader,
  type SessionAccess,
  type SessionHandle,
  type SessionLocation,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import type { Backend, BackendTx, EventInsert } from "./backend.ts";
import { WriteGuard } from "./write-guard.ts";
import { decodeStoredLog, storedHeader, type StoredLog } from "./migrate.ts";
import { RdbSessionHandle, type RdbHandleStorage } from "./handle.ts";
import { RdbTracker } from "./tracker.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  EVENT_ENCODING,
  IGNORABLE_EVENT_ENCODING,
  eventDimensions,
  type JournalMode,
} from "./schema.ts";
import { SqliteBackend } from "./sqlite.ts";
import { PostgresBackend } from "./postgres.ts";

export { SCHEMA_VERSION } from "./schema.ts";

/**
 * Plugin configuration — a discriminated union on `type`. The SQLite arm keeps
 * the file path plus the SQLite-specific pragmas; the PostgreSQL arm takes a
 * `node-postgres` connection string.
 */
export type Config =
  | {
      type: "sqlite";
      /**
       * Filesystem path to the SQLite database file. The special value `:memory:`
       * opens an in-process database (tests). On filesystems with POSIX modes,
       * missing directories and databases are created owner-only; existing path
       * modes are preserved.
       */
      path: string;
      /**
       * SQLite `journal_mode` pragma. `wal` (the default) is the recorded
       * durability model; pick a rollback-journal mode (`delete`/`truncate`/
       * `persist`) on filesystems where WAL's shared-memory files do not work
       * (network mounts). See {@link JournalMode}.
       */
      journalMode?: JournalMode;
      /**
       * Milliseconds to wait for a contended write lock before failing. SQLite
       * fails immediately by default, so a second process sharing this database
       * would lose every append that meets an in-flight commit; a nonzero wait
       * turns the contention window into a queue. `0` restores fail-fast.
       */
      busyTimeout?: number;
    }
  | {
      type: "postgres";
      /**
       * `node-postgres` connection string (e.g.
       * `postgres://user:pass@host:5432/db`). The database must be reachable;
       * the backend creates its tables and identity on first open.
       */
      connectionString: string;
    };

/**
 * The persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and installs the live write-path routing. Callers
 * address one stored session through the handle `create`/`open` return.
 *
 * Configuration resolution: `$DSH_HOME/settings.yaml` 的
 * `session-persistence-rdb` namespace（settings 服务）覆盖 cordis 层 entry
 * config，见 {@link SessionPersistenceRdb.settingsNs}。
 */
export class SessionPersistenceRdb extends SessionPersistence implements RdbHandleStorage {
  static inject = ["sessions", "settings"];

  static Config: z<Config> = z.union([
    z.object({
      type: z.const("sqlite"),
      path: z.string().required(),
      journalMode: z.union(["wal", "delete", "truncate", "persist"] as const).default("wal"),
      busyTimeout: z.number().step(1).min(0).default(DEFAULT_BUSY_TIMEOUT_MS),
    }),
    z.object({
      type: z.const("postgres"),
      connectionString: z.string().required(),
    }),
  ]);

  /**
   * settings namespace：`$DSH_HOME/settings.yaml` 的 `session-persistence-rdb`
   * section。0.1.2 的 dsh-settings 移除了 `settingsNamespace()` 帮助函数 —
   * 字面量本身即合法 namespace（小写连字符标识符）。
   */
  static readonly settingsNs = "session-persistence-rdb" as const;

  /**
   * Backend label for teardown diagnostics and live-routing warnings.
   * Intentionally shadows cordis `Service.name` (set to `'sessionPersistence'`
   * by the base); see the JSONL backend for why this does not affect service
   * resolution.
   */
  override readonly name = "session-persistence-rdb";

  private readonly backend: Backend;
  private storeIdentity!: string;
  private readonly ready: Promise<void>;
  /**
   * Write-authority state: the confirmed head per session (CROSS-process
   * concurrent-writer detection). See {@link WriteGuard} for the timing
   * contract; the in-process single-writer registry lives in the tracker.
   */
  private readonly writeGuard = new WriteGuard();
  /** In-process write ownership, live event routing, and open-handle teardown. */
  private readonly tracker = new RdbTracker("session-persistence-rdb");

  constructor(
    ctx: Context,
    public config: Config,
    /**
     * @internal Test injection: use a pre-built backend (e.g. a drizzle PG
     * instance over an in-memory pglite) instead of {@link createBackend}.
     */
    injectedBackend?: Backend,
  ) {
    // settings.yaml 的 `session-persistence-rdb` namespace 覆盖 cordis 层 entry
    // config（base）。settings 服务已注册时（dsh 环境；服务注册完成即初始
    // publish 完成，见 SettingsProvider[Service.init]）同步 register 读取；settings
    // 服务缺失时（纯 cordis 装配/测试）退化为 entry config。经 ctx.reflect
    // 查询避免未 inject 的 ctx 服务访问守卫。
    let resolved: Config = config;
    const settings = ctx.reflect.get("settings") as unknown as SettingsProvider | undefined;
    if (settings !== undefined) {
      const scope = settings.register(
        SessionPersistenceRdb.settingsNs,
        SessionPersistenceRdb.Config,
        { base: config },
      );
      resolved = scope.get();
      scope.watch(() => {
        // 后端在构造时建成（数据库连接 + 写路径监听），settings 变更后需重启
        // dsh 生效；热重建会与已打开的 handle 冲突。
        ctx.logger.warn(
          "session-persistence-rdb: settings changed; restart to apply the new configuration",
        );
      });
    }
    super(ctx);
    // Open asynchronously so connection setup (file creation / DB connect +
    // schema check) does not block plugin apply; every storage operation awaits
    // the same readiness promise.
    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    // Live routing + teardown are effects of this fiber: closing every open
    // handle (close drains the routed buffer) and then the database connection.
    this.tracker.install(ctx, async () => {
      await this.ready;
      await this.backend.close();
    });
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  /**
   * Refusal diagnostics: this backend has ONE database, not an independent
   * artifact per session, so a format refusal points at the database the
   * instance serves rather than at a per-session file.
   */
  private locate(): SessionLocation {
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
  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const snapshot = materializeCreateHeader(header);
    assertVersion(snapshot, this.locate());
    if (snapshot.isSeeded && options?.inheritedEventCount === undefined) {
      throw new Error("seeded session header requires an inherited event count");
    }
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if (!snapshot.isSeeded && inheritedEventCount !== 0) {
      throw new Error("unseeded session header inherited event count must be 0");
    }
    await this.ready;
    options?.signal?.throwIfAborted();
    if (this.tracker.hasPending(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id);
    if ((await this.backend.getSession(snapshot.id)) !== undefined) {
      throw new SessionAlreadyExistsError(snapshot.id);
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
          current: true,
        },
      }),
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
  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    if (access === "read") {
      const pending = this.tracker.pendingOf(id);
      if (pending !== undefined) {
        return this.tracker.adopt(
          new RdbSessionHandle(this, id, pending.header, "read", {
            cursor: 0,
            materialized: false,
            inheritedEventCount: pending.inheritedEventCount,
          }),
        );
      }
      const stored = await this.loadStored(id, options?.signal);
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id);
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, stored.meta, "read", {
          cursor: 0,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          ...(stored.tornFrom !== undefined ? { tornFrom: stored.tornFrom } : {}),
        }),
      );
    }
    this.tracker.claimWrite(id);
    try {
      const loaded = await this.loadStored(id, options?.signal);
      if (loaded === undefined) throw new SessionPersistenceNotFoundError(id);
      const stored = loaded.current ? loaded : await this.rewriteStored(loaded);
      options?.signal?.throwIfAborted();
      return this.tracker.adopt(
        new RdbSessionHandle(this, id, stored.meta, "write", {
          cursor: stored.events.length,
          materialized: true,
          inheritedEventCount: stored.inheritedEventCount,
          ...(stored.tornFrom !== undefined ? { tornFrom: stored.tornFrom } : {}),
          primed: stored,
        }),
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
  async flush(): Promise<void> {
    await this.ready;
    await this.tracker.flushAll();
  }

  /**
   * Observe one stored session without reading its event log.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted();
    await this.ready;
    options?.signal?.throwIfAborted();
    const pending = this.tracker.pendingOf(id);
    if (pending !== undefined) {
      return { header: pending.header, revision: pending.revision };
    }
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    options?.signal?.throwIfAborted();
    return { header: storedHeader(row, this.locate()), revision: this.revisionOf(row) };
  }

  /**
   * List every stored session visible to this process: materialized rows plus
   * this process's created-but-unmaterialized sessions.
   * @param options - optional cancellation.
   * @returns one snapshot per session, in no promised order.
   */
  async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    const snapshots: SessionPersistenceSnapshot[] = rows.map((row) => ({
      header: storedHeader(row, this.locate()),
      revision: this.revisionOf(row),
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
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredLog | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) {
      // Confirmed absence: a fresh session this instance has read about. A
      // later append to a session that meanwhile got a row must reject.
      this.writeGuard.confirmHead(id, -1);
      return undefined;
    }
    const rows = await this.backend.getEventRows(id);
    signal?.throwIfAborted();
    const log = decodeStoredLog(row, rows, this.locate());
    signal?.throwIfAborted();
    // The confirmed head is the last PRESERVED seq: a torn tail is removed by
    // the write path's repair, which re-confirms the head afterwards.
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
  async rewriteStored(log: StoredLog): Promise<StoredLog> {
    await this.ready;
    const { meta, inheritedEventCount, events } = log;
    await this.backend.transaction(async (tx) => {
      await tx.rewriteSessionHeader(meta, inheritedEventCount);
      await tx.deleteBridgeTail(meta.id, 0);
      if (events.length > 0) {
        const { headEventId, headSequence } = await appendEventTail(tx, meta, events, {
          parentId: "",
          nextSeq: 0,
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      } else {
        await tx.updateHead(meta.id, "", -1);
      }
      await tx.bumpRevision(meta.id);
    });
    const rewritten = await this.loadStored(meta.id);
    /* v8 ignore next -- the row was rewritten inside the transaction above */
    if (rewritten === undefined) {
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
  async appendBatch(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): Promise<void> {
    await this.ready;
    if (events.length === 0) return;
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, inheritedEventCount, randomUUID());
      const head = await tx.getHead(meta.id);
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(tx, meta, events, {
        parentId: head.fHeadEventId,
        nextSeq: head.fHeadSequence + 1,
      });
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });
    // Confirm the new head only after the commit: a rollback must not leave a
    // confirmed head this instance did not actually write.
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
  async materializeHeader(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
  ): Promise<void> {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, inheritedEventCount, randomUUID());
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
  async truncateTornTail(meta: SessionHeader, from: number): Promise<void> {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.deleteBridgeTail(meta.id, from);
      const prev = await tx.getPrevBridge(meta.id, from - 1);
      await tx.updateHead(meta.id, prev?.fEventId ?? "", prev?.fSequence ?? -1);
      await tx.bumpRevision(meta.id);
    });
    // Re-confirm the head AFTER the repair: truncation rewinds it and the next
    // append must not be rejected against a stale confirmation.
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }

  /** Whether this process still tracks a created-but-unmaterialized session. */
  hasPending(id: SessionId): boolean {
    return this.tracker.hasPending(id);
  }

  /** Drop a session's in-process pending entry once it reached durable storage. */
  markMaterialized(id: SessionId): void {
    this.tracker.materialized(id);
  }

  /** Release one handle's in-process bookkeeping on close. */
  releaseHandle(handle: RdbSessionHandle, materialized: boolean): void {
    this.tracker.release(handle, materialized);
  }

  /** Source-qualified revision token for one stored row. */
  private revisionOf(row: { fIncarnation: string; fRevision: number }): SessionPersistenceRevision {
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
    );
  }
}

/**
 * Build the configured backend. The PostgreSQL arm creates the `node-postgres`
 * pool here (its identity base comes from the parsed pool options); tests
 * inject a drizzle PG instance directly via {@link PostgresBackend}.
 */
function createBackend(config: Config): Backend {
  if (config.type === "sqlite") {
    return new SqliteBackend({
      path: config.path,
      journalMode: config.journalMode ?? "wal",
      busyTimeout: config.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
  }
  const pool = new Pool({ connectionString: config.connectionString });
  // node-postgres 官方要求 Pool 必须监听 error：idle client 被服务器端
  // 切断（数据库重启、DROP DATABASE ... FORCE）时，未监听的 error 会以
  // uncaughtException 崩溃进程。池级错误会在下一次操作（query）处可见，
  // 这里只需消费事件，无需输出。
  pool.on("error", () => {});
  const db = drizzlePg({ client: pool });
  const identityBase = [
    "postgres",
    pool.options.host ?? "localhost",
    String(pool.options.port ?? 5432),
    pool.options.database ?? "",
  ].join(":");
  return new PostgresBackend(db, { identityBase, close: () => pool.end() });
}

/**
 * Serialize an event's surface-metadata fields for SQL binding. Both fields are
 * nullable TEXT columns — null when the event has no surface metadata
 * (non-surface events, or an empty source set, which the format contract admits
 * only on `assistant/message`).
 *
 * The stored surface-op spelling is the CURRENT one (`startSeq`/`endSeq`): a
 * legacy `{start,end}` marker re-emitted under the current format would be read
 * back as an invalid marker. Legacy rows are translated on read instead.
 * @param event - the event to serialize.
 */
function surfaceBindings(event: SessionEvent): [string | null, string | null] {
  const se = event as SessionEvent;
  const sourceSeqs = se.sourceEventSeqs;
  return [
    sourceSeqs !== undefined && sourceSeqs.length > 0 ? JSON.stringify(sourceSeqs) : null,
    se.surfaceOp !== undefined ? JSON.stringify(se.surfaceOp) : null,
  ];
}

/**
 * Durably append one batch of events to a session's tail inside the enclosing
 * transaction: mint each event's row (parent chain + playpen dimensions +
 * surface-metadata columns + ignorable-encoding marker) and its bridge row,
 * land both as ONE multi-row INSERT each (N events are 2 statements instead of
 * 2N), and return the resulting head cursor.
 *
 * Every event is persisted under its OWN seq: the bridge `f_sequence` equals
 * the event's logical seq (asserted — a mismatch means the physical tail and
 * the batch disagree, which must fail loud rather than renumber), and
 * `f_original_seq` records the same value. Events the writer marked
 * `ignorable` keep the marker in `f_encoding`, so reads can reproduce the
 * envelope.
 *
 * The anchor is the caller's responsibility: an append starts from the head
 * cursor (`head.fHeadEventId` / `head.fHeadSequence + 1`), while a format
 * migration rewrites from seq 0 with an empty parent.
 * @param tx - the enclosing transaction.
 * @param meta - the session being written.
 * @param events - the events to append, in seq order (may be empty).
 * @param anchor - the parent event id to chain from and the next seq.
 * @returns the new head cursor (last event id + its seq).
 */
async function appendEventTail(
  tx: BackendTx,
  meta: SessionHeader,
  events: readonly SessionEvent[],
  anchor: { parentId: string; nextSeq: number },
): Promise<{ headEventId: string; headSequence: number }> {
  let parentId = anchor.parentId;
  let nextSeq = anchor.nextSeq;
  // Build both batches up front, then land them in ONE multi-row INSERT each:
  // N events are 2 statements instead of 2N (fewer SQLite statements and fewer
  // PostgreSQL round trips per commit).
  const eventRows: EventInsert[] = [];
  const bridgeRows: Array<{ fSessionId: SessionId; fEventId: string; fSequence: number }> = [];
  for (const event of events) {
    if (event.seq !== nextSeq) {
      throw new Error(
        `append seq mismatch for "${meta.id}": physical tail is at ${nextSeq - 1}, batch event carries seq ${event.seq} — refusing to renumber`,
      );
    }
    const eventId = randomUUID();
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
      fSurfaceOp: surfaceOp,
    });
    bridgeRows.push({ fSessionId: meta.id, fEventId: eventId, fSequence: nextSeq });
    parentId = eventId;
    nextSeq++;
  }
  await tx.insertEvents(eventRows);
  await tx.insertBridges(bridgeRows);
  return { headEventId: parentId, headSequence: nextSeq - 1 };
}

export default SessionPersistenceRdb;

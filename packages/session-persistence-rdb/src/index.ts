/**
 * SQLite / PostgreSQL durable session-persistence backend.
 *
 * Storage follows the playpen-session store: `t_sessions` carries the header
 * and a head cursor, `t_events` stores each event as a globally addressable
 * entity (event id + parent chain + kind/role/name/action-id dimensions), and
 * `t_session_events` bridges sessions to events in per-session seq order.
 *
 * Since 0.1.2 the backend persists EVERY event the coordinator delivers —
 * `assistant/chunk` deltas and events the writer marked `ignorable` included —
 * under its exact logical seq (`f_original_seq` == `f_sequence` == event.seq).
 * Nothing is dropped or renumbered at write time, so provenance columns are
 * stored verbatim and reads pass through as identity. Logs written by the
 * rc.2-era backend (which dropped deltas and dense-renumbered survivors) stay
 * readable: a legacy segment is detected by `f_original_seq != f_sequence`
 * rows and routed through the old upstream→persisted remap path (see
 * `log.ts`); rows written by this build need no remap. The stored
 * `f_seed_length` cut keeps the JSONL backend's semantics: its presence is
 * `isSeeded`, and the cut itself rides out of band on every read
 * (`StoredPrefix`/`StoredSuffix` carry `inheritedEventCount`) because the
 * 0.1.2 `SessionHeader` forbids `seedLength`.
 *
 * The database is chosen by configuration (discriminated union on `type`):
 * `{ type: "sqlite", path }` or `{ type: "postgres", connectionString }`.
 * All access goes through drizzle; the schema is declared once per dialect
 * (`schema.ts` / `postgres.ts`) and the hand-written DDL there is the only
 * migration story (no migration toolchain — incompatible stores are rejected,
 * never migrated). The physical layout is unchanged from the rc.2 era, so no
 * DDL migration exists; column semantics only tightened (`f_original_seq` is
 * now always the event seq on rows this build writes).
 *
 * It delegates write-path orchestration to {@link PersistenceCoordinator} and
 * has no independent per-session artifact, so its locator returns `undefined`.
 * @module @visecy/dsh-session-persistence-rdb
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { SettingsProvider } from "@deepseek-ai/dsh-settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  PersistenceCoordinator,
  type BorrowedSessionSource,
  type PersistenceBackend,
  type SessionEventSuffix,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type SessionStorageMetadata,
  type StoredPrefix,
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPreparation,
  type SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import type { Backend, BackendTx, EventInsert, EventRow } from "./backend.ts";
import { WriteGuard } from "./write-guard.ts";
import {
  buildSeqMap,
  hasLegacyRenumbering,
  rowToMeta,
  scanRows,
  storedInheritedCount,
} from "./log.ts";
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
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker is the persisted seq to delete from.
 *
 * Configuration resolution: `$DSH_HOME/settings.yaml` 的
 * `session-persistence-rdb` namespace（settings 服务）覆盖 cordis 层 entry
 * config，见 {@link SessionPersistenceRdb.settingsNs}。
 */
export class SessionPersistenceRdb
  extends SessionPersistence
  implements PersistenceBackend<number>
{
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
   * Backend label for the coordinator's dispose diagnostics. Intentionally
   * shadows cordis `Service.name` (set to `'sessionPersistence'` by the base);
   * see the JSONL backend for why this does not affect service resolution.
   */
  override readonly name = "session-persistence-rdb";

  /** One RDB database holds every session; there is no per-session raw artifact. */
  override readonly supportsRawArtifacts = false;

  private readonly backend: Backend;
  private storeIdentity!: string;
  private readonly ready: Promise<void>;
  private readonly coordinator: PersistenceCoordinator<number>;
  /**
   * Write-authority state: the confirmed head per session (concurrent-writer
   * detection). See {@link WriteGuard} for the timing contract.
   */
  private readonly writeGuard = new WriteGuard();

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
        // 后端在构造时建成（数据库连接 + coordinator 写路径监听），settings
        // 变更后需重启 dsh 生效；热重建会与 coordinator 的持久状态冲突。
        ctx.logger.warn(
          "session-persistence-rdb: settings changed; restart to apply the new configuration",
        );
      });
    }
    super(ctx);
    // Open asynchronously so connection setup (file creation / DB connect +
    // schema check) does not block plugin apply; every storage hook awaits the
    // same readiness promise.
    this.config = resolved;
    this.backend = injectedBackend ?? createBackend(resolved);
    this.ready = this.init();
    this.coordinator = new PersistenceCoordinator<number>(this.ctx, this);
  }

  private async init(): Promise<void> {
    await this.backend.open();
    this.storeIdentity = this.backend.storeIdentity;
  }

  // --- SessionPersistence service surface (delegated to the coordinator) ---

  /** The backend has one database, not an independent local artifact per session. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    return this.coordinator.create(meta, inheritedEventCount);
  }

  ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id);
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal);
  }

  borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: SessionLogOffset,
    signal?: AbortSignal,
  ): Promise<SessionEventSuffix> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  // --- PersistenceBackend hooks (the storage primitives) ---

  /** Read a stored prefix by id (ids are globally unique — no scope to scan). */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
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
  async loadStoredFrom(
    id: SessionId,
    fromSeq: SessionLogOffset,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    const log = await this.readLog(id, { fromSeq }, signal);
    if (log === undefined) return undefined;
    return {
      meta: log.meta,
      inheritedEventCount: SessionLogOffset(log.inheritedEventCount),
      events: log.events,
    };
  }

  /**
   * Read a session's row + ordered events into a {@link StoredPrefix}. The
   * torn-tail marker is the persisted seq from which a never-committed tail
   * must be deleted (`scanRows` already returns it as `number | undefined`).
   * Records the confirmed head (or confirmed absence) so a later
   * `appendBatch` can detect a second writer that advanced the log.
   */
  private async readPrefix(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<number> | undefined> {
    const log = await this.readLog(id, {}, signal);
    if (log === undefined) {
      // Confirmed absence: a fresh session this instance has read about. A
      // later append to a session that meanwhile got a row must reject.
      this.writeGuard.confirmHead(id, -1);
      return undefined;
    }
    // The confirmed head is the last PRESERVED seq (a torn tail is removed by
    // the caller's commitRepair, which re-confirms the head after repair).
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
        `${this.storeIdentity}:incarnation:${log.incarnation}:revision:${log.revision}`,
      ),
      ...(log.tornFrom !== undefined ? { tornMarker: log.tornFrom } : {}),
    };
  }

  /**
   * Read the current source-qualified revision for one stored session without
   * loading its event log. Returns `undefined` when the identity is absent.
   * The representation matches {@link loadStored}'s `revision` and
   * {@link listSnapshots} — the coordinator compares them with `===`.
   */
  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    return SessionPersistenceRevision(
      `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
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
  private async readLog(
    id: SessionId,
    options: { fromSeq?: SessionLogOffset } = {},
    signal?: AbortSignal,
  ): Promise<
    | {
        meta: SessionHeader;
        inheritedEventCount: number;
        events: SessionEvent[];
        tornFrom?: number;
        /** The session row's stable identity (see {@link listSnapshots}). */
        incarnation: string;
        /** The session row's monotonic log-change token. */
        revision: number;
      }
    | undefined
  > {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const row = await this.backend.getSession(id);
    if (row === undefined) return undefined;
    const meta = rowToMeta(row);
    let eventRows: EventRow[];
    let seqRows: Array<{ fSequence: number; fOriginalSeq: number }>;
    let fromSeq = 0;
    if (options.fromSeq === undefined) {
      // Whole-log read: the event rows ARE the seq source (no extra query).
      eventRows = await this.backend.getEventRows(id);
      seqRows = eventRows;
    } else {
      // Suffix read: rows are only the suffix, but legacy provenance remapping
      // needs every row's upstream seq, so a lightweight two-column map is
      // read alongside — the query still scales with the suffix, not the log.
      fromSeq = options.fromSeq;
      eventRows = await this.backend.getEventRows(id, fromSeq);
      seqRows = await this.backend.getSeqMapRows(id);
    }
    signal?.throwIfAborted();
    // Legacy detection is per log, not per row: a log mixing rc.2-era rows
    // with rows written by this build (resume continuing a legacy session)
    // stays on the remap path — modern rows are identity-mapped there too.
    const legacy = hasLegacyRenumbering(seqRows);
    const seqMap = legacy ? buildSeqMap(seqRows) : undefined;
    const inheritedEventCount = storedInheritedCount(row.fSeedLength, seqRows, legacy);
    const { preserved, tornFrom } = scanRows(eventRows, fromSeq, seqMap);
    return {
      meta,
      inheritedEventCount,
      events: preserved,
      incarnation: row.fIncarnation,
      revision: row.fRevision,
      ...(tornFrom !== undefined ? { tornFrom } : {}),
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
  async appendBatch(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
    _isMaterialized: boolean,
  ): Promise<void> {
    await this.ready;
    const { meta } = storage;
    let confirmedHead = -1;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(meta, storage.inheritedEventCount, randomUUID());
      const head = await tx.getHead(meta.id);
      // Reject a second writer BEFORE any row lands: each coordinator instance
      // maintains its own cursor, so a second instance (or process) sharing
      // this database would append through a stale view of the log — the
      // batch's seqs would collide with (or silently overwrite) the other
      // writer's tail. The on-disk head must equal the last head this instance
      // confirmed (via its own writes or loadStored).
      this.writeGuard.assertNoConcurrentWriter(meta.id, head.fHeadSequence);
      const { headEventId, headSequence } = await appendEventTail(tx, storage, events, {
        parentId: head.fHeadEventId,
        nextSeq: head.fHeadSequence + 1,
      });
      await tx.updateHead(meta.id, headEventId, headSequence);
      await tx.bumpRevision(meta.id);
      confirmedHead = headSequence;
    });
    // Confirm the new head only after the commit: a rollback must not leave
    // a confirmed head this instance did not actually write.
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
  async materializeHeader(storage: SessionStorageMetadata): Promise<void> {
    await this.ready;
    await this.backend.transaction(async (tx) => {
      await tx.upsertSession(storage.meta, storage.inheritedEventCount, randomUUID());
    });
  }

  /**
   * Make a crash repair durable in ONE transaction: DELETE the torn tail (from
   * `tornMarker`), rewind the head cursor to the last surviving event, INSERT
   * the synthetic `closers`, and bump the revision once. After COMMIT the
   * stored rows == the balanced log. Closers are persisted verbatim like any
   * other event (they never carry dropped content).
   */
  async commitRepair(
    storage: SessionStorageMetadata,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    await this.ready;
    const { meta } = storage;
    if (tornMarker === undefined && closers.length === 0) return;
    await this.backend.transaction(async (tx) => {
      if (tornMarker !== undefined) {
        await tx.deleteBridgeTail(meta.id, tornMarker);
        // The head cursor rewinds to the last surviving event (or the initial
        // state when the torn tail started at seq 0).
        const prev = await tx.getPrevBridge(meta.id, tornMarker - 1);
        if (prev === undefined) {
          await tx.updateHead(meta.id, "", -1);
        } else {
          await tx.updateHead(meta.id, prev.fEventId, prev.fSequence);
        }
      }
      if (closers.length > 0) {
        // Anchor at the ACTUAL tail row: the head cursor can lag the rows (a
        // hand-written torn tail never updated it), so a closer must follow the
        // last physical row, not the cursor.
        const last = await tx.getLastBridge(meta.id);
        const { headEventId, headSequence } = await appendEventTail(tx, storage, closers, {
          parentId: last?.fEventId ?? "",
          nextSeq: (last?.fSequence ?? -1) + 1,
        });
        await tx.updateHead(meta.id, headEventId, headSequence);
      }
      await tx.bumpRevision(meta.id);
    });
    // Re-confirm the head AFTER repair: truncation can rewind it and the
    // closers advance it, and the next append must not be rejected (or worse,
    // silently renumbered) against a stale confirmation.
    const row = await this.backend.getSession(meta.id);
    this.writeGuard.confirmHead(meta.id, row?.fHeadSequence ?? -1);
  }

  /** List all materialized sessions' metadata (every row is a materialized session). */
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map(rowToMeta);
  }

  /** List metadata with a source-qualified monotonic revision per session. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    await this.ready;
    signal?.throwIfAborted();
    const rows = await this.backend.listSessions();
    signal?.throwIfAborted();
    return rows.map((row) => ({
      header: rowToMeta(row),
      revision: SessionPersistenceRevision(
        `${this.storeIdentity}:incarnation:${row.fIncarnation}:revision:${row.fRevision}`,
      ),
    }));
  }

  /** Close the database connection (awaited by the coordinator's dispose, post-drain). */
  async close(): Promise<void> {
    await this.ready;
    await this.backend.close();
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
 * (non-surface events, events written before surface support).
 *
 * Since 0.1.2 every delivered event is persisted with its exact seq, so
 * `sourceEventSeqs` needs no write-time pruning: the references always name
 * persisted rows and reads pass them through (identity) or remap them from
 * upstream space on a legacy log.
 * @param event - the event to serialize.
 */
function surfaceBindings(event: SessionEvent): [string | null, string | null] {
  const se = event as SessionEvent<SurfaceEventType>;
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
 * land both as ONE multi-row INSERT each (N events are 2 statements instead
 * of 2N), and return the resulting head cursor.
 *
 * Every event is persisted under its OWN seq: the bridge `f_sequence` equals
 * the event's logical seq (asserted — a mismatch means the physical tail and
 * the batch disagree, which must fail loud rather than renumber), and
 * `f_original_seq` records the same value. Events the writer marked
 * `ignorable` keep the marker in `f_encoding`, so reads can reproduce the
 * envelope for the coordinator's unknown-type tolerance.
 *
 * The anchor is the caller's responsibility: a normal append starts from the
 * head cursor (`head.fHeadEventId` / `head.fHeadSequence + 1`), while
 * crash-repair closers start from the ACTUAL tail row (the head cursor can lag
 * a hand-written torn tail). Both callers then persist the returned cursor via
 * {@link BackendTx.updateHead}.
 * @param tx - the enclosing transaction.
 * @param storage - the session being written (header + inherited cut; the id
 *   drives the bridge rows and the cut feeds a lazy row materialization).
 * @param events - the events to append, in seq order (non-empty).
 * @param anchor - the parent event id to chain from and the next seq.
 * @returns the new head cursor (last event id + its seq).
 */
async function appendEventTail(
  tx: BackendTx,
  storage: SessionStorageMetadata,
  events: readonly SessionEvent[],
  anchor: { parentId: string; nextSeq: number },
): Promise<{ headEventId: string; headSequence: number }> {
  const { meta } = storage;
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

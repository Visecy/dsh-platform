/**
 * 方言无关的存储后端抽象：`SessionPersistenceRdb` 的业务编排（head 游标确认、
 * 并发写者检测、scanRows 崩溃尾部语义等）只面向本模块的 {@link Backend} /
 * {@link BackendTx} 原语编程，SQLite 与 PostgreSQL 各自实现这些原语。
 *
 * 所有方法均为 async：SQLite（`node:sqlite`）驱动同步执行、PostgreSQL 驱动
 * 异步执行，接口统一为 Promise 以便两种后端共用同一套存储逻辑。
 * @module @visecy/dsh-session-persistence-rdb/backend
 */

import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionLocation } from "@deepseek-ai/dsh-session-persistence";

/**
 * 与方言无关的 `t_sessions` 行投影。SQLite / PostgreSQL 的 drizzle
 * `InferSelectModel` 均结构兼容（各自多出的自增主键列不影响赋值）。
 *
 * `f_seed_length`：0.1.2 起是 out-of-log 的继承前缀 cut——头部不再携带
 * `seedLength` 字段，`isSeeded` 由该列的存在性推导，cut 值随读路径带出
 * （`StoredPrefix.inheritedEventCount`）。rc.2 时代的行该列仍是第一代行的
 * upstream 空间 cut，由 {@link storedInheritedCount} 翻译（见 `log.ts`）。
 */
export interface SessionRow {
  fSessionId: string;
  /** Empty string means no head (fresh session or rewound to empty). */
  fHeadEventId: string;
  fHeadSequence: number;
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
  /** Stable identity assigned when this log is materialized. */
  fIncarnation: string;
  /** Monotonic log-change token incremented in each mutating transaction. */
  fRevision: number;
}

/**
 * 一次事件插入的完整列值（`t_events` 一行），由存储层按事件构造、后端落库。
 */
export interface EventInsert {
  fEventId: string;
  fParentId: string;
  fKind: string;
  fRole: string;
  fName: string;
  fActionId: string;
  fEncoding: string;
  fData: string;
  fCreatedAt: number;
  fOriginalSeq: number;
  fSourceEventSeqs: string | null;
  fSurfaceOp: string | null;
}

/**
 * 一个 joined `t_session_events` + `t_events` 行：按 session 本地 `f_sequence`
 * 寻址的持久化事件（`f_data` 为 JSON 文本，surface 列为 JSON 文本或 null）。
 *
 * 0.1.2 起的行满足 `f_sequence` == `f_original_seq` == 逻辑 seq（persist-
 * everything，无重编号）；rc.2 时代稠密重编号的行 `f_original_seq` 保存
 * upstream seq（读路径按 legacy 重映射，见 `log.ts`）。`f_encoding` 携带
 * envelope 的 `ignorable` 标记（`json-ignorable`）。
 */
export interface EventRow {
  /** `t_session_events.f_sequence` — the presented (persisted) seq. */
  fSequence: number;
  /** `t_events.f_original_seq` — the upstream seq (== f_sequence since 0.1.2). */
  fOriginalSeq: number;
  /** `t_events.f_kind` — the upstream `SessionEvent.type`. */
  fKind: string;
  /** `t_events.f_created_at` — the upstream `SessionEvent.time`. */
  fCreatedAt: number;
  /** `t_events.f_data` — JSON-encoded event data. */
  fData: string;
  /** `t_events.f_encoding` — `json`, or `json-ignorable` for an ignorable event. */
  fEncoding: string;
  /** JSON-encoded `number[]` — the event's sourceEventSeqs (upstream seqs), or null. */
  fSourceEventSeqs: string | null;
  /** JSON-encoded `SurfaceOp` — how the event entered the surface, or null. */
  fSurfaceOp: string | null;
}

/**
 * 事务内可用的数据访问原语。后端保证这些调用落在同一个数据库事务里
 * （SQLite 单连接隐式满足；PostgreSQL 绑定到 drizzle 的事务句柄）。
 */
export interface BackendTx {
  /**
   * Insert-or-replace the session's metadata row (initial head cursor).
   * `inheritedEventCount` is the row-space fork cut, stored in `f_seed_length`
   * only for a seeded header; ON CONFLICT the cut is preserved as stored
   * (legacy rows keep their upstream-space cut — see `sessionConflictRow`).
   */
  upsertSession(meta: SessionHeader, inheritedEventCount: number, incarnation: string): Promise<void>;
  /**
   * Overwrite an existing row's header columns INCLUDING the stored inherited
   * cut. Reserved for the in-place format migration, which renumbers the log
   * into presented coordinates and must move the cut with it (the ordinary
   * {@link upsertSession} conflict update deliberately preserves the cut).
   */
  rewriteSessionHeader(meta: SessionHeader, inheritedEventCount: number): Promise<void>;
  /** Fetch the head cursor; the caller materialized the row first. */
  getHead(id: SessionId): Promise<Pick<SessionRow, "fHeadEventId" | "fHeadSequence">>;
  /**
   * Insert event rows in ONE multi-row INSERT. Callers pass non-empty arrays;
   * the implementation may no-op on an empty input.
   */
  insertEvents(events: EventInsert[]): Promise<void>;
  /**
   * Insert session↔event bridge rows in ONE multi-row INSERT. Callers pass
   * non-empty arrays; the implementation may no-op on an empty input.
   */
  insertBridges(
    rows: Array<{ fSessionId: SessionId; fEventId: string; fSequence: number }>,
  ): Promise<void>;
  /** Move the head cursor forward. */
  updateHead(id: SessionId, headEventId: string, headSequence: number): Promise<void>;
  /** Increment the session's revision by one. */
  bumpRevision(id: SessionId): Promise<void>;
  /** Delete bridge rows with `f_sequence >= fromSequence` (torn-tail truncate). */
  deleteBridgeTail(id: SessionId, fromSequence: number): Promise<void>;
  /** The bridge row just below `sequence` (the surviving head anchor), if any. */
  getPrevBridge(
    id: SessionId,
    sequence: number,
  ): Promise<{ fEventId: string; fSequence: number } | undefined>;
  /** The highest bridge row (the physical tail anchor), if any. */
  getLastBridge(id: SessionId): Promise<{ fEventId: string; fSequence: number } | undefined>;
}

/**
 * 存储后端：连接生命周期 + store 身份 + 事务外读取。`storeIdentity` 仅在
 * {@link open} 完成后有效。
 */
export interface Backend {
  readonly kind: "sqlite" | "postgres";
  /** Source-qualified store identity (revision 前缀)，open 后可用。 */
  readonly storeIdentity: string;
  /**
   * Refusal-diagnostics pointer at the one database this backend serves
   * (`{kind, path}`): this provider keeps no per-session artifact, so a format
   * refusal can only name the database itself.
   */
  readonly location: SessionLocation;
  /** 连接 + 建表 + 版本/身份校验 + 读取 store id；失败时抛错（不迁移）。 */
  open(): Promise<void>;
  /** Fetch a session's row, or undefined if absent. */
  getSession(id: SessionId): Promise<SessionRow | undefined>;
  /** Joined event rows for one session, presented seq ascending. */
  getEventRows(id: SessionId): Promise<EventRow[]>;
  /** All materialized sessions' rows. */
  listSessions(): Promise<SessionRow[]>;
  /** Run `fn` inside one durable transaction. */
  transaction<T>(fn: (tx: BackendTx) => Promise<T>): Promise<T>;
  /** Close the connection (awaited by the backend's teardown, after every handle closed). */
  close(): Promise<void>;
}

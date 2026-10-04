import type { TableDef } from "./types.ts";

/**
 * `t_sessions` — 会话元数据（`SessionHeader` 列）+ playpen 风格 head 游标
 * （`f_head_event_id` / `f_head_sequence`，事务内维护，append 时提供 parent
 * 链与下一个 seq）。行的存在即 materialized 信号。
 */
export const sessions: TableDef = {
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
    { name: "f_revision", type: "integer", notNull: true },
  ],
  indexes: [{ name: "ix_sessions_subagent_parent", columns: ["f_parent_session", "f_origin"] }],
  // The v3→v4 migration discovers a parent's historical children on READ (one
  // indexed lookup per stored parent); every other access is served by
  // `f_session_id`. The index is created idempotently on every open, so an
  // existing v1 database gains it without a SCHEMA_VERSION bump.
};

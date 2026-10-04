/**
 * Raw SQLite store hooks shared by the fabricated-log specs.
 *
 * The write path can only produce current-format, fully committed logs. The
 * migration suites need the states an OLDER build left on disk: released-format
 * logs, dense-renumbered legacy segments, torn tails, and subagent child rows
 * (`f_parent_session` + `f_origin`) with their own descriptors. These hooks
 * hand-write those rows with raw SQL, bypassing the backend entirely.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/sqlite-raw
 */

import { randomUUID } from "node:crypto";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../sqlite.ts";
import { EVENT_ENCODING, IGNORABLE_EVENT_ENCODING } from "../../schema.ts";
import type { AgentLoopRawStore, StoredRowSpec } from "./agent-loop.ts";

/**
 * Hand-insert one event as an events + session_events pair (the backend's write
 * path always keeps them in step; a bridge row without an event row never
 * joins). Used to fabricate on-disk states (released logs, torn tails, child
 * descriptors) that the normal append path cannot produce.
 * @returns the minted event id (the bridge row's parent for the next event).
 */
function insertEventRow(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  row: StoredRowSpec,
  parentId: string,
): string {
  const eventId = randomUUID();
  db.prepare(`
    INSERT INTO t_events
      (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
    VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    parentId,
    row.kind,
    row.ignorable === true ? IGNORABLE_EVENT_ENCODING : EVENT_ENCODING,
    typeof row.data === "string" ? row.data : JSON.stringify(row.data),
    seq + 1,
    row.origSeq ?? seq,
    row.sourceEventSeqs === undefined || row.sourceEventSeqs === null
      ? null
      : JSON.stringify(row.sourceEventSeqs),
    row.surfaceOp === undefined ? null : JSON.stringify(row.surfaceOp),
  );
  db.prepare(
    "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence) VALUES (?, ?, ?)",
  ).run(sessionId, eventId, seq);
  return eventId;
}

/**
 * Build the raw-store hooks over one SQLite database path. The database must
 * already exist (i.e. the backend was opened at least once), because the hooks
 * reuse the backend's own `openDatabase` for pragmas and schema.
 * @param path - the SQLite database path the backend under test serves.
 * @returns the {@link AgentLoopRawStore} hooks.
 */
export function createSqliteRawStore(path: string): AgentLoopRawStore {
  return {
    path,
    fabricate: async (id, spec) => {
      const db = openDatabase(path, "wal");
      try {
        const seeded = spec.seedLength !== undefined && spec.seedLength !== null;
        db.prepare(
          `INSERT INTO t_sessions
             (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
              f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
           VALUES (?, '', -1, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          id,
          spec.version,
          spec.createdAt ?? 1,
          spec.cwd ?? null,
          spec.parentSession ?? null,
          seeded ? (spec.seedLength ?? 0) : null,
          spec.origin ?? null,
          spec.delegationDepth ?? 0,
          randomUUID(),
        );
        let parent = "";
        let head: { eventId: string; seq: number } | undefined;
        for (const [seq, row] of spec.rows.entries()) {
          const eventId = insertEventRow(db, id, seq, row, parent);
          parent = eventId;
          head = { eventId, seq };
        }
        if (head !== undefined) {
          db.prepare(
            "UPDATE t_sessions SET f_head_event_id = ?, f_head_sequence = ? WHERE f_session_id = ?",
          ).run(head.eventId, head.seq, id);
        }
      } finally {
        db.close();
      }
    },
    corruptTail: async (id) => {
      const db = openDatabase(path, "wal");
      try {
        const head = db
          .prepare(
            "SELECT f_head_event_id, f_head_sequence FROM t_sessions WHERE f_session_id = ?",
          )
          .get(id) as { f_head_event_id: string; f_head_sequence: number };
        insertEventRow(
          db,
          id,
          head.f_head_sequence + 1,
          { kind: "turn/start", data: "{not valid json" },
          head.f_head_event_id,
        );
      } finally {
        db.close();
      }
    },
    storedRows: async (id) => {
      const db = openDatabase(path, "wal");
      try {
        return db
          .prepare(
            `SELECT se.f_sequence AS seq, e.f_original_seq AS orig, e.f_kind AS kind,
                    e.f_encoding AS encoding
               FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id
              WHERE se.f_session_id = ? ORDER BY se.f_sequence`,
          )
          .all(id) as Array<{ seq: number; orig: number; kind: string; encoding: string }>;
      } finally {
        db.close();
      }
    },
    storedSession: async (id) => {
      const db = openDatabase(path, "wal");
      try {
        const row = db
          .prepare(
            "SELECT f_version AS version, f_seed_length AS seedLength, f_head_sequence AS headSequence FROM t_sessions WHERE f_session_id = ?",
          )
          .get(id) as
          | { version: number; seedLength: number | null; headSequence: number }
          | undefined;
        return row;
      } finally {
        db.close();
      }
    },
  };
}

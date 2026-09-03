/**
 * Per-instance write-authority state for one session-persistence backend.
 *
 * Each `PersistenceCoordinator` instance keeps its own event cursor in memory
 * and appends contiguous batches. Two backend instances (another `dsh`
 * process, or a duplicate persistence plugin in the same process) sharing one
 * database therefore must not both append to the same session id: each would
 * believe its own cursor is the log's authority and silently write over (or
 * interleave with) the other's tail. Since 0.1.2 the persisted seq IS the
 * event's logical seq, so an interleaved double-write would collide on
 * `UNIQUE(f_session_id, f_sequence)` — but only at the last row of a batch and
 * only after both writers committed their common prefix; the guard rejects
 * the second writer up front, before any row lands.
 *
 * This guard records, per session, the last CONFIRMED head this instance has
 * seen — its own writes or `loadStored` observations — and rejects any append
 * whose on-disk head no longer matches. One writer per session per log; a
 * second writer fails loud instead of corrupting the log. Different session
 * ids are independent (each has its own head), so two instances writing
 * different sessions remain a supported multi-process deployment.
 *
 * Pure in-memory state machine — no I/O — so the coordinator's timing contract
 * (never-read vs. confirmed absence vs. confirmed head; confirm after append /
 * after load / re-confirm after repair) is directly unit-testable instead of
 * requiring end-to-end multi-instance setups.
 * @module @visecy/dsh-session-persistence-rdb/write-guard
 */

import type { SessionId } from "@deepseek-ai/dsh-session";

/**
 * The write-authority state machine for one backend instance. Not part of the
 * {@link Backend} seam: it guards the orchestration layer's own invariants and
 * lives entirely in memory.
 */
export class WriteGuard {
  /**
   * Last CONFIRMED head per session — the head this instance itself wrote or
   * observed via `loadStored`. `-1` records a confirmed absence (no row).
   * `undefined` (absent from the map) means this instance never read or wrote
   * the session.
   */
  private readonly headSeqs = new Map<SessionId, number>();

  /**
   * Record a head this instance actually observed or wrote.
   * @param id - the session id.
   * @param head - the confirmed head, or `-1` for a confirmed absence
   *   (a fresh session this instance has read about — a later append to a
   *   session that meanwhile got a row must reject).
   */
  confirmHead(id: SessionId, head: number): void {
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
  assertNoConcurrentWriter(id: SessionId, storedHead: number): void {
    const known = this.headSeqs.get(id);
    if (known === undefined) {
      if (storedHead !== -1) {
        throw new Error(
          `session "${id}" has a persisted log this instance has not read; another writer may own it — load the session first`,
        );
      }
      return;
    }
    if (known !== storedHead) {
      throw new Error(
        `session "${id}" was modified by another writer (stored head ${storedHead}, this instance last confirmed head ${known}); ` +
          "concurrent writers on one session are not supported",
      );
    }
  }
}

import type { SessionId } from "@deepseek-ai/dsh-session";
import { SessionOwnershipLostError } from "@deepseek-ai/dsh-session-persistence";

/**
 * A durable-head divergence detected inside an append transaction: another
 * process advanced (or rewound) this session's log, so this handle's write
 * cursor is no longer the log's authority and its ownership is permanently
 * gone. Reported as the seam's {@link SessionOwnershipLostError} — the error
 * every caller of `append` already handles — while preserving the exact
 * divergence diagnostics the base message omits.
 */
export class WriterDivergenceError extends SessionOwnershipLostError {
  /** @param id - the session whose durable head diverged. */
  constructor(id: SessionId, detail: string) {
    super(id);
    this.message = `${this.message} (${detail})`;
  }
}

/**
 * Per-instance CROSS-PROCESS write-authority state for one session-persistence
 * backend.
 *
 * Since 0.1.5 the durability seam is handle-based: one process claims a
 * session's write ownership through its in-process registry
 * (`src/tracker.ts`, `SessionAlreadyOwnedError`), and that registry cannot see
 * a second `dsh` process sharing the same database. Two processes appending to
 * one session id each keep their own cursor and would silently interleave (or
 * overwrite) the other's tail, so this guard supplies the remaining half of the
 * single-writer rule: before any row of a batch lands, the append transaction
 * checks that the on-disk head still equals the head this instance last
 * confirmed — its own writes or the read it opened the handle with. A mismatch
 * means another writer advanced the log, and the append fails loud instead of
 * corrupting it.
 *
 * This guard is deliberately NOT the in-process ownership mechanism: an
 * in-process duplicate is the seam's `SessionAlreadyOwnedError`, while this
 * guard reports a durable-head divergence. Different session ids are
 * independent (each has its own head), so two processes writing different
 * sessions remain a supported deployment.
 *
 * Pure in-memory state machine — no I/O — so the timing contract (never-read
 * vs. confirmed absence vs. confirmed head; confirm after append / after a read
 * / re-confirm after a repair) is directly unit-testable instead of requiring
 * end-to-end multi-process setups.
 * @module @visecy/dsh-session-persistence-rdb/write-guard
 */

/**
 * The cross-process write-authority state machine for one backend instance. Not
 * part of the {@link Backend} seam: it guards the handle append path's own
 * invariant and lives entirely in memory.
 */
export class WriteGuard {
  /**
   * Last CONFIRMED head per session — the head this instance itself wrote or
   * observed when it loaded the stored log. `-1` records a confirmed absence.
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
   * means this instance's handle cursor is not the log's authority.
   * @param id - the session id.
   * @param storedHead - the on-disk head cursor, read inside the append
   *   transaction before any row is inserted.
   */
  assertNoConcurrentWriter(id: SessionId, storedHead: number): void {
    const known = this.headSeqs.get(id);
    if (known === undefined) {
      if (storedHead !== -1) {
        throw new WriterDivergenceError(
          id,
          "a persisted log exists that this instance has not read; another writer may own it — open the session for write first",
        );
      }
      return;
    }
    if (known !== storedHead) {
      throw new WriterDivergenceError(
        id,
        `modified by another writer: stored head ${storedHead}, this instance last confirmed head ${known}; ` +
          "concurrent writers on one session are not supported",
      );
    }
  }
}

/**
 * In-process bookkeeping for one RDB persistence instance: the single active
 * writer per session id (doubling as the live event router), the open-handle
 * set teardown closes, and the created-but-unmaterialized sessions this process
 * can already observe.
 *
 * Mirrors the first-party JSONL provider's tracker: persistence enforces one
 * active write handle per id per process; a second PROCESS at the same database
 * is caught by the durable head guard inside the append transaction
 * (`write-guard.ts`).
 *
 * @module @visecy/dsh-session-persistence-rdb/tracker
 */

import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";
import type { RdbSessionHandle } from "./handle.ts";

/** One created-but-unmaterialized session tracked in this process only. */
export interface PendingSession {
  readonly header: SessionHeader;
  readonly revision: SessionPersistenceRevision;
  /** Exact fork-inherited prefix length supplied at create. */
  readonly inheritedEventCount: SessionLogOffset;
}

/** The write-handle face the tracker routes live session events to. */
export type RdbWriteHandle = Pick<
  RdbSessionHandle,
  "id" | "close" | "flush" | "drainLive" | "enqueueLive"
>;

/** The RDB backend's in-process registry. */
export class RdbTracker {
  /** Every open handle; teardown closes what remains. */
  readonly openHandles = new Set<RdbSessionHandle>();
  /** `null` marks a claim whose handle is still being constructed. */
  private readonly writers = new Map<SessionId, RdbWriteHandle | null>();
  private readonly pending = new Map<SessionId, PendingSession>();
  private counter = 0;

  /** @param name - backend label used in in-memory revision tokens and teardown errors. */
  constructor(private readonly name: string) {}

  /**
   * Claim write ownership and record the created session as pending, making it
   * observable to this process before it materializes.
   * @param header - the validated detached header.
   * @param inheritedEventCount - the exact fork-inherited prefix length.
   * @throws {SessionAlreadyExistsError} when a concurrent create or an open
   *   write handle holds the id — for create, the duplicate is the fact.
   */
  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    this.writers.set(header.id, null);
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`memory:${this.name}:${++this.counter}`),
      inheritedEventCount,
    });
  }

  /**
   * Claim write ownership for an existing session.
   * @param id - the session to claim.
   * @throws {SessionAlreadyOwnedError} when an active write handle exists.
   */
  claimWrite(id: SessionId): void {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    this.writers.set(id, null);
  }

  /**
   * Roll a failed write open back.
   * @param id - the session whose claim is dropped.
   */
  releaseClaim(id: SessionId): void {
    this.writers.delete(id);
  }

  /**
   * The pending entry for a created-but-unmaterialized session, if any.
   * @param id - the session to look up.
   * @returns the pending header and in-memory revision.
   */
  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id);
  }

  /**
   * Whether this process still tracks a created-but-unmaterialized session.
   * @param id - the session to test.
   * @returns true while the pending entry exists.
   */
  hasPending(id: SessionId): boolean {
    return this.pending.has(id);
  }

  /**
   * Iterate the pending sessions for listing.
   * @returns the pending entries, keyed by session id.
   */
  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries();
  }

  /**
   * Drop a pending entry once the session materialized durably.
   * @param id - the session that reached durable storage.
   */
  materialized(id: SessionId): void {
    this.pending.delete(id);
  }

  /**
   * Track one open handle for teardown and, for a write handle, bind it as the
   * session's live event route.
   * @param handle - the just-constructed handle.
   * @returns the same handle, for construction-site chaining.
   */
  adopt(handle: RdbSessionHandle): RdbSessionHandle {
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
  release(handle: RdbSessionHandle, materialized: boolean): void {
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
  async flushAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue;
      try {
        await writer.drainLive();
        await writer.flush();
      } catch (error) {
        if (error instanceof SessionHandleClosedError) continue;
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
  install(ctx: Context, closeStorage: () => Promise<void>): void {
    ctx.on("session/event", (session, event: SessionEvent) => {
      this.writers.get(session.id)?.enqueueLive(event, (error: unknown) => {
        ctx.logger.warn(
          `session-persistence-rdb: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`,
        );
      });
    });
    ctx.on("session/flush", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === undefined) return undefined;
      return (async () => {
        await writer.drainLive();
        await writer.flush();
      })();
    });
    ctx.on("session/disposed", (session) => {
      const writer = this.writers.get(session.id);
      if (writer === null || writer === undefined) return;
      writer.close().catch((error: unknown) => {
        ctx.logger.warn(
          `session-persistence-rdb: final drain for session "${session.id}" failed: ${String(error)}`,
        );
      });
    });
    ctx.effect(
      () => async () => {
        const errors: unknown[] = [];
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
      `${this.name} open handles`,
    );
  }
}

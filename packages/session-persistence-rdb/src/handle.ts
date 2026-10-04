/**
 * The RDB session handle: one open channel onto a stored session's append-only
 * event log.
 *
 * Mutations serialize on a per-handle promise chain; reads re-read the stored
 * log (so an append that resolved is always visible) unless the handle still
 * holds the validated prefix it was opened with. Routed live events buffer in a
 * bounded window and drain through the same chain as explicit appends.
 *
 * Durability: unlike the JSONL provider (which batches physical writes behind
 * `append`), every accepted append is committed in one database transaction, so
 * `append` and `flush` are both durable barriers; `flush` additionally
 * materializes a created-but-still-empty session's header row.
 *
 * @module @visecy/dsh-session-persistence-rdb/handle
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import {
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  assertContiguous,
  materializeAppendBatch,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
} from "@deepseek-ai/dsh-session-persistence";
import type { StoredLog } from "./migrate.ts";

/** Maximum intentional wait before a routed live session batch starts writing. */
export const LIVE_WRITE_BATCH_MAX_DELAY_MS = 200;

/**
 * The storage primitives the handle drives on its owning service. Deliberately
 * provider-local: the persistence seam exposes only the service and handle
 * contracts.
 */
export interface RdbHandleStorage {
  /** Decode one stored log (migrating released formats); `undefined` when absent. */
  loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredLog | undefined>;
  /**
   * Rewrite a released-format log into the current format in one transaction and
   * return its decoded successor (see the service's in-place migration).
   */
  rewriteStored(log: StoredLog): Promise<StoredLog>;
  /** Append one validated batch to a session's stored tail in one transaction. */
  appendBatch(
    meta: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    events: readonly SessionEvent[],
  ): Promise<void>;
  /** Materialize the header-only row of an explicitly flushed empty session. */
  materializeHeader(meta: SessionHeader, inheritedEventCount: SessionLogOffset): Promise<void>;
  /** Durably drop a never-committed torn tail before the first new append. */
  truncateTornTail(meta: SessionHeader, from: number): Promise<void>;
  /** Whether this process still tracks a created-but-unmaterialized session. */
  hasPending(id: SessionId): boolean;
  /** Drop a session's in-process pending entry once it reached durable storage. */
  markMaterialized(id: SessionId): void;
  /** Release one handle's bookkeeping on close. */
  releaseHandle(handle: RdbSessionHandle, materialized: boolean): void;
}

/** Mutable per-handle log state; a write handle is its session's single mutator. */
export interface StorageHandleState {
  /** The stored next-seq (the logical end this handle knows). */
  cursor: number;
  /** Whether the session has a durable row yet. */
  materialized: boolean;
  /** Torn-tail truncation point, consumed by the first new append. */
  tornFrom?: number | undefined;
  /** Exact fork-inherited prefix length stored with the log. */
  inheritedEventCount: SessionLogOffset;
  /** The validated stored prefix served to reads until the first append. */
  primed?: StoredLog | undefined;
}

/** Normalize an unknown rejection into an `Error`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * One open channel onto an RDB-stored session.
 */
export class RdbSessionHandle implements SessionHandle {
  /** Per-handle mutation chain; the stored promise never rejects. */
  private chain: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  /** Highest event count this handle has observed (monotonic-read guard). */
  private observedLength = 0;
  /** Routed live events awaiting their batching deadline (persistence-owned copies). */
  private buffered: SessionEvent[] = [];
  private batchTimer: NodeJS.Timeout | undefined;
  /** Set when a drain failed; the automatic timer stays quiet until the next drain. */
  private drainPaused = false;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly storage: RdbHandleStorage,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: StorageHandleState,
  ) {
    this.observedLength = state.primed?.events.length ?? 0;
  }

  /** Exact fork-inherited prefix length stored with this session's log. */
  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount;
  }

  /**
   * Read a slice of the valid contiguous logical log; see the seam contract.
   * @param offset - first logical seq to include (default 0).
   * @param length - maximum events returned (default: the rest).
   * @param options - optional cancellation.
   * @returns a caller-owned outer slice carrying its values' ownership state.
   */
  async read(
    offset = 0,
    length?: number,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen("read");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
    }
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
    }
    options?.signal?.throwIfAborted();
    const events = await this.sourceEvents(options?.signal);
    const end = length === undefined ? undefined : offset + length;
    // A fresh outer array per call: `eventState: 'detached'` promises the caller
    // owns the array, and an offset at/past the end yields an empty slice.
    return { eventState: "detached", events: events.slice(offset, end) };
  }

  /**
   * Durably append a contiguous batch; see the seam contract.
   * @param events - the contiguous batch in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen("append");
    const batch = materializeAppendBatch(events);
    return this.run("append", async () => {
      options?.signal?.throwIfAborted();
      // Routed live events entered the log first, so they must land first.
      await this.flushBuffered();
      await this.persistContiguous(batch);
    });
  }

  /**
   * The durability barrier: routed live events drain durably and the session is
   * materialized, so an explicitly flushed empty session survives this process.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run("flush", async () => {
      options?.signal?.throwIfAborted();
      if (this.access !== "write") throw new SessionReadOnlyError(this.id, "flush");
      // Everything routed into this handle is part of the barrier, exactly as
      // the service-wide `SessionPersistence.flush` documents.
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
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      let drainFailure: unknown;
      for (;;) {
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
      if (this.batchTimer !== undefined) {
        clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
      }
      this.storage.releaseHandle(this, this.state.materialized);
      if (drainFailure !== undefined) throw toError(drainFailure);
    })());
  }

  /** `await using` support: delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Buffer one published live session event and arm the bounded batching
   * window when it is idle. The routing installer is the only caller.
   * @param event - the live event, retained as a persistence-owned copy.
   * @param reportBackgroundFailure - observes a deadline-driven drain failure
   *   (the events stay buffered; the next {@link drainLive} retries loudly).
   */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event));
    if (this.batchTimer !== undefined || this.drainPaused) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.drainLive().catch(reportBackgroundFailure);
    }, LIVE_WRITE_BATCH_MAX_DELAY_MS);
    // Never hold the process open for a batching deadline.
    this.batchTimer.unref?.();
  }

  /**
   * Durably drain the routed live buffer through the mutation chain; concurrent
   * callers join one drain, and a failure retains the batch in order so
   * `session/flush` can retry and reject loudly.
   */
  drainLive(): Promise<void> {
    this.draining ??= this.enqueueChain(() => this.flushBuffered()).finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** The events this handle can currently serve, honoring this handle's view. */
  private async sourceEvents(signal?: AbortSignal): Promise<readonly SessionEvent[]> {
    // The validated prefix from open is served to a WRITE handle until its
    // first append (its own mutations invalidate it). A READ handle always
    // re-reads, so events another handle appended after this open are visible.
    const primed = this.state.primed;
    if (primed !== undefined && this.access === "write") return primed.events;
    // A created-but-unmaterialized session has an empty log; once it
    // materializes, reads must see it without reopening the handle.
    if (!this.state.materialized && this.storage.hasPending(this.id)) return [];
    const log = await this.storage.loadStored(this.id, signal);
    if (log === undefined) {
      if (this.storage.hasPending(this.id)) return [];
      throw new SessionPersistenceNotFoundError(this.id);
    }
    if (log.events.length < this.observedLength) {
      throw new Error(
        `session "${this.id}": stored log shrank below a previously observed prefix (${log.events.length} < ${this.observedLength})`,
      );
    }
    this.observedLength = log.events.length;
    return log.events;
  }

  /** The shared durable-append body: contiguity, torn-tail repair, storage write, state advance. */
  private async persistContiguous(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, "append");
    if (batch.length === 0) return;
    assertContiguous(this.id, batch, this.state.cursor);
    if (this.state.tornFrom !== undefined) {
      await this.storage.truncateTornTail(this.header, this.state.tornFrom);
      this.state.tornFrom = undefined;
    }
    await this.storage.appendBatch(this.header, this.state.inheritedEventCount, batch);
    this.state.materialized = true;
    this.state.cursor += batch.length;
    this.state.primed = undefined;
    this.observedLength = this.state.cursor;
    this.storage.markMaterialized(this.id);
  }

  /** Drain the routed live buffer; assumes the caller holds the mutation chain. */
  private async flushBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
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
  private enqueueChain<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op);
    // A failed operation must not poison the chain for later ones.
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Serialize one public mutating operation onto this handle's chain. */
  private async run<T>(operation: string, op: () => Promise<T>): Promise<T> {
    this.assertOpen(operation);
    return this.enqueueChain(async () => {
      this.assertOpen(operation);
      return op();
    });
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation);
  }
}

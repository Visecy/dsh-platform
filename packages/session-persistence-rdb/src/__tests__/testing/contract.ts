/**
 * Reusable contract test for any handle-based {@link SessionPersistence}
 * backend. A backend package imports {@link runPersistenceContract} and calls
 * it with a factory that yields a fresh, empty backend (and a teardown), so
 * every backend is held to the same handle / ownership / lazily-materialized /
 * crash-tail semantics.
 *
 * The suite targets the 0.1.5 seam directly: no `PersistenceCoordinator`, no
 * `load`/`inspect`/`prepare`/`borrowSession`/`readFrom`. Every case obtains a
 * `SessionHandle` from `create`/`open` and drives `read`/`append`/`flush`/
 * `close`.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/contract
 */

import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  interruptedTurnClosers,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
} from "@deepseek-ai/dsh-session";
import type {
  SessionEvent,
  SessionHeader,
  SurfaceEvent,
  SurfaceEventType,
  SurfaceIntent,
} from "@deepseek-ai/dsh-session";
import { MessageId, ToolCallId, createMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  type SessionPersistence,
} from "@deepseek-ai/dsh-session-persistence";

/** A backend under test plus its teardown. */
export interface ContractBackend {
  /** The context the backend is mounted on (for live-session flows). */
  ctx: Context;
  persistence: SessionPersistence;
  dispose: () => Promise<void>;
}

/** Build a minimal UNSEEDED {@link SessionHeader} for a session id. */
export function meta(id: string, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** Build a SEEDED {@link SessionHeader} for a session id (a fork child). */
export function seededMeta(id: string, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1000,
    isSeeded: true,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/**
 * A well-formed one-turn current-format log (contiguous seqs from 0).
 *
 * The order mirrors what the agent loop actually publishes — `turn/start`,
 * `step/start`, then the message-producing events inside the step — and the
 * settlement event carries its embedded `stream`, which 0.1.5 seed validation
 * requires (`Array.isArray(data.stream)`).
 */
export function oneTurnLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: "step/start", seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    {
      type: "user/message",
      seq: SessionSeq(2),
      time: 3,
      data: freezeMessage({
        id: MessageId("one-turn-user"),
        role: "user",
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    {
      type: "assistant/message",
      seq: SessionSeq(3),
      time: 4,
      data: {
        turn: 1,
        step: 1,
        stream: [],
        message: freezeMessage({
          id: MessageId("one-turn-assistant"),
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: {
            kind: "model",
            provider: "mock",
            model: "mock",
          },
        }),
      },
      surfaceOp: "append",
    },
    { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

/**
 * Append recorded events to a live session while forwarding surface metadata verbatim. The broad
 * `SessionEvent` union makes the typed marker optional, but the runtime guard must still reject a
 * surface event whose fixture omitted it; this helper never synthesizes a default.
 */
export function appendLog(session: Session, events: readonly SessionEvent[]): void {
  for (const e of events) {
    const se = e as SessionEvent<SurfaceEventType>;
    if (se.surfaceOp !== undefined) {
      const intent: SurfaceIntent = {
        surfaceOp: se.surfaceOp,
        ...(se.sourceEventSeqs !== undefined ? { sourceEventSeqs: se.sourceEventSeqs } : {}),
      };
      session.append(e.type, e.data, intent);
    } else {
      session.append(e.type, e.data);
    }
  }
}

/**
 * Read a whole stored log through a fresh read handle.
 * @param persistence - the backend under test.
 * @param id - the stored session.
 * @returns the caller-owned event array.
 */
export async function readAll(
  persistence: SessionPersistence,
  id: SessionId,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(id, "read");
  try {
    return (await handle.read(0)).events;
  } finally {
    await handle.close();
  }
}

/** Run the backend-agnostic contract suite. `make()` MUST return a fresh, empty backend each call. */
export function runPersistenceContract(name: string, make: () => Promise<ContractBackend>): void {
  describe(`SessionPersistence contract: ${name}`, () => {
    it("round-trips a session: create + append → open(read).read returns identical meta and events", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("s1", "/work");
        const log = oneTurnLog();
        const handle = await persistence.create(m);
        await handle.append(log);

        const reader = await persistence.open(m.id, "read");
        expect(reader.header).toMatchObject({
          version: SESSION_FORMAT_VERSION,
          id: m.id,
          cwd: "/work",
        });
        expect(reader.inheritedEventCount).toBe(0);
        const read = await reader.read(0);
        expect(read.eventState).toBe("detached");
        expect(read.events).toEqual(log);
        // A read handle observes without owning: another read still works.
        await expect(persistence.open(m.id, "read")).resolves.toBeDefined();
        await reader.close();
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("read slices the log, tolerates an offset at/past the end, and returns a caller-owned array", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("read-slices");
        const log = oneTurnLog();
        const handle = await persistence.create(m);
        await handle.append(log);

        expect((await handle.read(3)).events).toEqual(log.slice(3));
        expect((await handle.read(3, 2)).events.map((e) => e.seq)).toEqual([3, 4]);
        expect((await handle.read(log.length)).events).toEqual([]);
        expect((await handle.read(log.length + 100)).events).toEqual([]);
        expect((await handle.read(0, 0)).events).toEqual([]);

        // The returned outer array is the caller's: mutating it never changes
        // what a later read observes.
        const first = await handle.read(0);
        (first.events as SessionEvent[]).push(log[0]!);
        expect((await handle.read(0)).events).toEqual(log);

        await expect(handle.read(-1)).rejects.toThrow(/non-negative safe integer/);
        await expect(handle.read(1.5)).rejects.toThrow(/non-negative safe integer/);
        await expect(handle.read(0, -1)).rejects.toThrow(/non-negative safe integer/);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("rejects a fractional creation timestamp without reserving its session id", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = { ...meta("fractional-created-at"), createdAt: 1.5 };
        await expect(persistence.create(m)).rejects.toThrow(
          "session metadata createdAt must be a non-negative safe integer",
        );

        const valid = meta("fractional-created-at");
        const handle = await persistence.create(valid);
        await handle.append(oneTurnLog());
        expect((await persistence.stat(valid.id))?.header.createdAt).toBe(valid.createdAt);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("create rejects a duplicate id with SessionAlreadyExistsError", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("duplicate");
        const handle = await persistence.create(m);
        await expect(persistence.create(m)).rejects.toBeInstanceOf(SessionAlreadyExistsError);
        // A session that never materialized leaves nothing behind, so the id is
        // reusable after its owner closes …
        await handle.close();
        const reused = await persistence.create(m);
        await reused.append(oneTurnLog());
        // … but a materialized session id stays taken.
        await reused.close();
        await expect(persistence.create(meta("duplicate"))).rejects.toBeInstanceOf(
          SessionAlreadyExistsError,
        );
      } finally {
        await dispose();
      }
    });

    it("open rejects an absent session and a second concurrent write owner", async () => {
      const { persistence, dispose } = await make();
      try {
        await expect(persistence.open(SessionId("absent"), "read")).rejects.toBeInstanceOf(
          SessionPersistenceNotFoundError,
        );
        await expect(persistence.open(SessionId("absent"), "write")).rejects.toBeInstanceOf(
          SessionPersistenceNotFoundError,
        );

        const m = meta("owned");
        const creator = await persistence.create(m);
        await creator.append(oneTurnLog());
        await expect(persistence.open(m.id, "write")).rejects.toBeInstanceOf(
          SessionAlreadyOwnedError,
        );
        // A read open never takes ownership: it works while the writer is live.
        const reader = await persistence.open(m.id, "read");
        expect((await reader.read(0)).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        await reader.close();

        await creator.close();
        const writer = await persistence.open(m.id, "write");
        expect((await writer.read(0)).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        await expect(persistence.open(m.id, "write")).rejects.toBeInstanceOf(
          SessionAlreadyOwnedError,
        );
        await writer.close();
      } finally {
        await dispose();
      }
    });

    it("a write handle reads its own appends while a read handle observes them", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("self-read");
        const writer = await persistence.create(m);
        const reader = await persistence.open(m.id, "read");
        await writer.append(oneTurnLog());
        expect((await writer.read(0)).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        expect((await reader.read(0)).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        // Reads are monotonic: a later read never observes a shorter log.
        expect((await reader.read(4)).events.map((e) => e.seq)).toEqual([4, 5]);
        await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError);
        await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError);
        await reader.close();
        await writer.close();
      } finally {
        await dispose();
      }
    });

    it("close is idempotent and every later operation rejects with SessionHandleClosedError", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("closed-handle");
        const handle = await persistence.create(m);
        await handle.append(oneTurnLog());
        await handle.close();
        await expect(handle.close()).resolves.toBeUndefined();
        await expect(handle.read(0)).rejects.toBeInstanceOf(SessionHandleClosedError);
        await expect(handle.append([])).rejects.toBeInstanceOf(SessionHandleClosedError);
        await expect(handle.flush()).rejects.toBeInstanceOf(SessionHandleClosedError);
        // The already-durable log survives the close.
        expect((await readAll(persistence, m.id)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      } finally {
        await dispose();
      }
    });

    it("a created session is visible to stat/list/open immediately, before it materializes", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("created-visible", "/work");
        const handle = await persistence.create(m);
        const snapshot = await persistence.stat(m.id);
        expect(snapshot?.header).toMatchObject({ id: m.id, cwd: "/work", isSeeded: false });
        const revision = snapshot?.revision;
        expect(revision).toBeDefined();
        expect((await persistence.list()).map((s) => s.header.id)).toContain(m.id);
        const reader = await persistence.open(m.id, "read");
        expect((await reader.read(0)).events).toEqual([]);
        await reader.close();

        // flush materializes the empty session durably …
        await handle.flush();
        const durable = (await persistence.stat(m.id))?.revision;
        expect(durable).toBeDefined();
        expect((await persistence.stat(m.id))?.revision).toBe(durable);
        // … and a later append still starts at seq 0 and moves the revision.
        await handle.append(oneTurnLog());
        expect((await readAll(persistence, m.id)).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
        expect((await persistence.stat(m.id))?.revision).not.toBe(durable);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("a created-but-unflushed session that never appended leaves no residue (the id is reusable)", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("abandoned");
        const handle = await persistence.create(m);
        await handle.close();
        expect(await persistence.stat(m.id)).toBeUndefined();
        expect((await persistence.list()).map((s) => s.header.id)).not.toContain(m.id);
        const reused = await persistence.create(m);
        await reused.append(oneTurnLog());
        expect((await readAll(persistence, m.id)).length).toBe(6);
        await reused.close();
      } finally {
        await dispose();
      }
    });

    it("crash recovery: an interrupted turn is preserved verbatim and closed by the CALLER's closers", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("interrupted");
        const handle = await persistence.create(m);
        await handle.append(oneTurnLog()); // turn 1, committed (seqs 0..5)
        // A second turn that crashed mid-flight: turn/start + step/start were
        // durably written, but no step/end / turn/end ever arrived.
        await handle.append([
          { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
          { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
        ]);
        const before = (await persistence.stat(m.id))?.revision;

        // A read never repairs: the durable prefix is served as stored.
        const cold = await handle.read(0);
        expect(cold.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect((await persistence.stat(m.id))?.revision).toBe(before);

        // The caller owns repair: derive the closers from the cold read, append
        // them, and continue — exactly the agent-loop resume protocol.
        const closers = interruptedTurnClosers(cold.events);
        expect(closers.map((e) => e.type)).toEqual(["step/end", "turn/end"]);
        await handle.append(closers);
        const balanced = await handle.read(0);
        expect(balanced.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const last = balanced.events.at(-1)!;
        expect(last.type === "turn/end" && last.data.reason).toEqual({ kind: "interrupted" });
        expect((await persistence.stat(m.id))?.revision).not.toBe(before);

        // The balanced log continues contiguously.
        await handle.append([
          { type: "turn/start", seq: SessionSeq(10), time: 9, data: { turn: 3 } },
          { type: "turn/end", seq: SessionSeq(11), time: 10, data: { turn: 3, reason: { kind: "completed" } } },
        ]);
        expect((await readAll(persistence, m.id)).map((e) => e.seq)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        ]);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("crash recovery: an unstarted assistant tool request gets a retryable synthetic result", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("interrupted-toolcall");
        const handle = await persistence.create(m);
        await handle.append(oneTurnLog()); // turn 1, committed (seqs 0..5)
        // Turn 2 crashed AFTER the assistant message asked for a tool call but
        // BEFORE the tool/result was written.
        await handle.append([
          { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
          { type: "step/start", seq: SessionSeq(7), time: 8, data: { turn: 2, step: 1 } },
          {
            type: "assistant/message",
            seq: SessionSeq(8),
            time: 9,
            data: {
              turn: 2,
              step: 1,
              stream: [],
              message: createMessage({
                role: "assistant",
                content: [
                  { type: "tool-call", id: ToolCallId("call-x"), name: "bash", arguments: "{}" },
                ],
                source: {
                  kind: "model",
                  provider: "mock",
                  model: "mock",
                },
              }),
            },
            surfaceOp: "append",
          },
        ]);

        const cold = await handle.read(0);
        const closers = interruptedTurnClosers(cold.events);
        // The orphaned call is answered by a synthetic error tool/result BEFORE
        // step/end + turn/end {interrupted}, so the step (and turn) are balanced.
        expect(closers.map((e) => e.type)).toEqual(["tool/result", "step/end", "turn/end"]);
        await handle.append(closers);

        const resumed = Session.fromRestore(
          m.id,
          [...cold.events, ...closers],
          m,
          SessionLogOffset(0),
          "detached",
        );
        const synthetic = resumed.snapshotEvents().find((e) => e.type === "tool/result");
        expect(synthetic?.type === "tool/result" && synthetic.data).toMatchObject({
          message: {
            source: { kind: "tool", callId: ToolCallId("call-x") },
            content: [{ type: "tool-result", toolCallId: ToolCallId("call-x"), isError: true }],
          },
          error: { code: TOOL_NOT_STARTED },
        });
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("crash recovery: a recorded tool call with no result tells the model to assess retry risk", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("unknown-tool-outcome");
        const handle = await persistence.create(m);
        await handle.append([
          { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
          { type: "step/start", seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
          {
            type: "assistant/message",
            seq: SessionSeq(2),
            time: 3,
            data: {
              turn: 1,
              step: 1,
              stream: [],
              message: createMessage({
                role: "assistant",
                content: [
                  { type: "tool-call", id: ToolCallId("call-risk"), name: "write", arguments: "{}" },
                ],
                source: {
                  kind: "model",
                  provider: "mock",
                  model: "mock",
                },
              }),
            },
            surfaceOp: "append",
          },
          {
            type: "tool/call",
            seq: SessionSeq(3),
            time: 4,
            data: {
              turn: 1,
              step: 1,
              callId: ToolCallId("call-risk"),
              name: "write",
              arguments: "{}",
            },
          },
        ]);

        const cold = await handle.read(0);
        const closers = interruptedTurnClosers(cold.events);
        await handle.append(closers);
        const synthetic = closers.find((e) => e.type === "tool/result");
        expect(synthetic?.type === "tool/result" && synthetic.data.error).toEqual({
          name: "ToolOutcomeUnknownError",
          code: TOOL_OUTCOME_UNKNOWN,
        });
        if (
          synthetic?.type !== "tool/result" ||
          synthetic.data.message.content[0].content[0]?.type !== "text"
        ) {
          throw new Error("expected a text tool result");
        }
        expect(synthetic.data.message.content[0].content[0].text).toContain(
          "retry only if the operation is read-only or idempotent",
        );

        const resumed = Session.fromRestore(
          m.id,
          [...cold.events, ...closers],
          m,
          SessionLogOffset(0),
          "detached",
        );
        const derived = resumed
          .deriveMessages()
          .find((message) => message.content.some((block) => block.type === "tool-result"));
        expect(derived?.content[0]).toMatchObject({
          type: "tool-result",
          toolCallId: ToolCallId("call-risk"),
          isError: true,
        });
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("append rejects a batch whose first seq does not match the stored next-seq", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("s3");
        const handle = await persistence.create(m);
        await handle.append(oneTurnLog()); // seqs 0..5, next-seq = 6
        // A re-append of an already-stored seq must be rejected, not duplicated.
        await expect(handle.append(oneTurnLog())).rejects.toThrow();
        expect((await handle.read(0)).events).toEqual(oneTurnLog());
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("append rejects a mid-batch seq gap and an empty batch is a no-op", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("s4");
        const handle = await persistence.create(m);
        await handle.append([]);
        expect(await persistence.stat(m.id)).toBeDefined();
        await expect(
          handle.append([
            { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
            { type: "step/start", seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1 } },
          ]),
        ).rejects.toThrow();
        // The rejected batch left nothing behind.
        expect((await handle.read(0)).events).toEqual([]);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("append rejects non-JSON-serializable event data, naming the event type", async () => {
      const { persistence, dispose } = await make();
      try {
        // Every value `isJsonValue` rejects must be rejected by the backend, not just BigInt —
        // otherwise a backend could pass this contract while still accepting values that
        // corrupt the durable round-trip.
        const cyclic: Record<string, unknown> = { type: "text", text: "x" };
        cyclic["self"] = cyclic;
        const badValues: unknown[] = [
          1n, // BigInt
          undefined, // dropped by JSON.stringify
          Infinity, // → null
          () => 0, // function
          Symbol("s"), // symbol
          new Map(), // exotic object
          cyclic, // circular ref
        ];
        for (const [i, bad] of badValues.entries()) {
          const mi = meta(`s5-${i}`);
          const handle = await persistence.create(mi);
          const events = [
            {
              type: "user/message",
              seq: 0,
              time: 1,
              data: {
                id: MessageId(`invalid-json-${i}`),
                role: "user",
                content: [{ type: "text", text: "x" }],
                source: { kind: "user" },
                extra: bad,
              },
            },
          ] as unknown as SessionEvent[];
          await expect(handle.append(events)).rejects.toThrow(/losslessly JSON-serializable/);
          await handle.close();
        }
      } finally {
        await dispose();
      }
    });

    it("persist-everything: attempt streams and ignorable events round-trip at their exact seqs", async () => {
      // The backend persists EVERY event the writer produced: no delta filtering,
      // no dense renumbering. A batch containing ONLY stream/ignorable events is a
      // normal append (materializing) instead of a no-op.
      const { persistence, dispose } = await make();
      try {
        const m = meta("persist-everything", "/work");
        const handle = await persistence.create(m);
        await handle.append([
          {
            type: "assistant/attempt",
            seq: SessionSeq(0),
            time: 1,
            data: {
              turn: 1,
              step: 1,
              stream: [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: ["he"] }],
            },
          },
          {
            type: "plugin/telemetry",
            seq: 1,
            time: 2,
            data: { metric: 1 },
            ignorable: true,
          } as unknown as SessionEvent,
          { type: "turn/start", seq: SessionSeq(2), time: 3, data: { turn: 1 } },
          { type: "turn/end", seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: "completed" } } },
        ]);

        // A stream/ignorable-only prefix still materialized the session.
        expect((await persistence.list()).map((s) => s.header.id)).toContain(m.id);
        const read = await handle.read(0);
        expect(read.events).toHaveLength(4);
        expect(read.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
        // The attempt is stored verbatim, and the unknown ignorable event keeps
        // its ignorable marker (a reader that knows the type may skip it; the
        // log itself is intact).
        expect(read.events[0]).toMatchObject({ type: "assistant/attempt" });
        expect(read.events[1]).toMatchObject({ type: "plugin/telemetry", ignorable: true });
        expect((await handle.read(1)).events.map((e) => e.seq)).toEqual([1, 2, 3]);
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("lists stable lightweight revisions that change after an append", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("s2");
        const handle = await persistence.create(m);
        await handle.append(oneTurnLog());
        const first = await persistence.stat(m.id);
        const repeated = await persistence.stat(m.id);
        expect(first).toBeDefined();
        expect(repeated?.revision).toBe(first?.revision);

        await handle.append([
          { type: "turn/start", seq: SessionSeq(6), time: 7, data: { turn: 2 } },
        ]);
        const changed = await persistence.stat(m.id);
        expect(changed?.revision).not.toBe(first?.revision);
        expect((await persistence.list()).map((s) => s.header.id)).toContain(m.id);
        await handle.close();

        expect(await persistence.stat(SessionId("absent-stat"))).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it("rejects pre-aborted operations with the exact cancellation reason", async () => {
      const { persistence, dispose } = await make();
      try {
        const reason = new Error("persistence cancelled");
        const controller = new AbortController();
        await expect(persistence.list({ signal: controller.signal })).resolves.toEqual([]);
        await expect(
          persistence.stat(SessionId("cancelled"), { signal: controller.signal }),
        ).resolves.toBeUndefined();
        controller.abort(reason);

        await expect(persistence.list({ signal: controller.signal })).rejects.toBe(reason);
        await expect(
          persistence.stat(SessionId("cancelled"), { signal: controller.signal }),
        ).rejects.toBe(reason);
        await expect(
          persistence.create(meta("cancelled-create"), { signal: controller.signal }),
        ).rejects.toBe(reason);
        await expect(
          persistence.open(SessionId("cancelled-open"), "read", { signal: controller.signal }),
        ).rejects.toBe(reason);
      } finally {
        await dispose();
      }
    });

    it("service flush materializes every open write handle in one barrier", async () => {
      const { persistence, dispose } = await make();
      try {
        const a = await persistence.create(meta("flush-all-a"));
        const b = await persistence.create(meta("flush-all-b"));
        const reader = await persistence.open(a.id, "read");
        await b.append(oneTurnLog());
        await persistence.flush();
        const ids = (await persistence.list()).map((s) => s.header.id);
        expect(ids).toContain(a.id);
        expect(ids).toContain(b.id);
        // Both handles remain usable after the barrier.
        await a.append(oneTurnLog());
        expect((await a.read(0)).events).toHaveLength(6);
        await reader.close();
        await a.close();
        await b.close();
      } finally {
        await dispose();
      }
    });

    it("a seeded session round-trips its exact inherited cut and stays resumable", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = seededMeta("seeded", "/work");
        // A fork child's constructor seed is exactly the inherited prefix plus
        // the tagged end-seed marker at the cut.
        const seed: SessionEvent[] = [
          ...oneTurnLog(),
          { type: "session/end-seed", seq: SessionSeq(6), time: 7, data: { inherited: true } },
        ];
        const handle = await persistence.create(m, {
          inheritedEventCount: SessionLogOffset(6),
        });
        await handle.append(seed);
        await handle.append([
          { type: "turn/start", seq: SessionSeq(7), time: 8, data: { turn: 2 } },
          { type: "turn/end", seq: SessionSeq(8), time: 9, data: { turn: 2, reason: { kind: "completed" } } },
        ]);
        const read = await handle.read(0);
        expect(read.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        await handle.close();

        const writer = await persistence.open(m.id, "write");
        expect(writer.header.isSeeded).toBe(true);
        expect(writer.inheritedEventCount).toBe(6);
        expect((await writer.read(0)).events.map((e) => e.seq)).toEqual([
          0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        await writer.close();
      } finally {
        await dispose();
      }
    });

    it("a seeded create requires its inherited count and an unseeded one refuses a nonzero cut", async () => {
      const { persistence, dispose } = await make();
      try {
        await expect(persistence.create(seededMeta("seeded-no-cut"))).rejects.toThrow(
          /requires an inherited event count/,
        );
        await expect(
          persistence.create(meta("unseeded-cut"), { inheritedEventCount: SessionLogOffset(3) }),
        ).rejects.toThrow(/inherited event count must be 0/);
      } finally {
        await dispose();
      }
    });

    it("live routing persists published session events through ctx.sessions.flush", async () => {
      const { ctx, persistence, dispose } = await make();
      try {
        const session = ctx.sessions.create(SessionId("live-routed"));
        const handle = await persistence.create(session.header);
        // The store's flush reaches the persistence listener installed by the
        // backend; a backend that never subscribed would report `false` here.
        appendLog(session, oneTurnLog());
        expect(await ctx.sessions.flush(session)).toBe(true);
        expect((await readAll(persistence, session.id)).map((e) => e.type)).toEqual(
          oneTurnLog().map((e) => e.type),
        );
        await handle.close();
      } finally {
        await dispose();
      }
    });

    it("surface metadata round-trips through the stored columns", async () => {
      const { persistence, dispose } = await make();
      try {
        const m = meta("surface-roundtrip");
        const handle = await persistence.create(m);
        const log = oneTurnLog();
        // A replacement op exercises the current spelling (`startSeq`/`endSeq`).
        const replacement: SessionEvent = {
          type: "user/message",
          seq: SessionSeq(6),
          time: 7,
          data: freezeMessage({
            id: MessageId("surface-replacement"),
            role: "user",
            content: [{ type: "text", text: "replaced" }],
            source: { kind: "plugin", plugin: "compact" },
          }),
          surfaceOp: { op: "replace", startSeq: SessionSeq(2), endSeq: SessionSeq(2) },
          sourceEventSeqs: [SessionSeq(2)],
        };
        await handle.append([...log, replacement]);
        const read = await handle.read(0);
        const stored = read.events.at(-1) as SurfaceEvent;
        expect(stored.surfaceOp).toEqual({
          op: "replace",
          startSeq: SessionSeq(2),
          endSeq: SessionSeq(2),
        });
        expect(stored.sourceEventSeqs).toEqual([SessionSeq(2)]);
        const user = read.events[2] as SurfaceEvent;
        expect(user.surfaceOp).toBe("append");
        expect(user.sourceEventSeqs).toBeUndefined();
        await handle.close();
      } finally {
        await dispose();
      }
    });
  });
}

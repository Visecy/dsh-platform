/**
 * The agent-loop protocol contract: the exact sequence the 0.1.5
 * `dsh-agent-loop` (and `dsh-message-feedback`, `dsh-workspace`) drives against
 * a persistence backend, plus the crash-tail and format-migration behaviour a
 * real deployment depends on.
 *
 * This replaces the deleted `PersistenceCoordinator` suite. The coordinator is
 * gone, so nothing here asserts orchestration-layer ownership adoption: the
 * backend's job is the handle contract, the in-process single-writer registry,
 * the live routing, and serving every stored log as a valid current-format
 * (v3) log.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/agent-loop
 */

import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  SessionLogOffset,
  interruptedTurnClosers,
  SessionSeq,
  SESSION_FORMAT_VERSION,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { MessageId, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import {
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  type SessionHandle,
  type SessionPersistence,
} from "@deepseek-ai/dsh-session-persistence";
import { appendLog, meta, oneTurnLog, seededMeta } from "./contract.ts";

/** One hand-written physical row (raw SQL, bypassing the write path). */
export interface StoredRowSpec {
  kind: string;
  data: unknown;
  /** Stored surface marker, in the released or current spelling. */
  surfaceOp?: unknown;
  sourceEventSeqs?: number[] | null;
  /** Stored `f_original_seq`; defaults to the row index (identity rows). */
  origSeq?: number;
  ignorable?: boolean;
}

/** One hand-written stored log. */
export interface FabricatedLogSpec {
  /** Stored `f_version` (0 for a released log, 3 for current). */
  version: number;
  createdAt?: number;
  cwd?: string;
  seedLength?: number | null;
  rows: readonly StoredRowSpec[];
}

/** Raw-store hooks used by the fabricated-log cases (SQLite fixtures). */
export interface AgentLoopRawStore {
  /** Hand-write a whole stored log, bypassing the write path. */
  fabricate(id: SessionId, spec: FabricatedLogSpec): Promise<void>;
  /** Append one unparsable row past the committed region. */
  corruptTail(id: SessionId): Promise<void>;
  /** Stored row projection, in presented seq order. */
  storedRows(
    id: SessionId,
  ): Promise<Array<{ seq: number; orig: number; kind: string; encoding: string }>>;
  /** Stored session row projection. */
  storedSession(
    id: SessionId,
  ): Promise<{ version: number; seedLength: number | null; headSequence: number } | undefined>;
  /** The database path, for refusal-message assertions. */
  path: string;
}

/** A fresh backend fixture for one suite case. */
export interface AgentLoopFixture {
  /** A context carrying the services the backend injects, not yet mounted. */
  context(): Promise<Context>;
  mount(ctx: Context): Promise<{ dispose: () => Promise<void> }>;
  /** Raw-store hooks; the fabricated-log cases are skipped when absent. */
  raw?: AgentLoopRawStore;
  cleanup(): Promise<void>;
}

/**
 * The agent loop's resume transaction: cold write open → read(0) → closers →
 * append(closers) → `prepare`/`enter`/`announce` with the cold read's exact
 * seed and event state.
 * @param ctx - the mounted context.
 * @param id - the stored session to resume.
 * @returns the write handle and the live session, already announced.
 */
export async function resumeSession(
  ctx: Context,
  id: SessionId,
): Promise<{ handle: SessionHandle; session: Session; cold: readonly SessionEvent[] }> {
  const handle = await ctx.sessionPersistence.open(id, "write");
  const read = await handle.read(0);
  const closers = interruptedTurnClosers(read.events);
  if (closers.length > 0) await handle.append(closers);
  const session = ctx.sessions.prepare(id, {
    seed: [...read.events, ...closers],
    meta: structuredClone(handle.header),
    inheritedEventCount: handle.inheritedEventCount,
    eventState: read.eventState,
  });
  // The constructor may have appended a seed-boundary marker that never
  // re-emits through `session/event`; publication must flush it through the
  // handle BEFORE live events start routing into it (the agent loop's
  // `appendUnstoredSuffix`).
  let storedCount = read.events.length + closers.length;
  const suffix = session.snapshotEvents(SessionLogOffset(storedCount));
  if (suffix.length > 0) await handle.append(suffix);
  storedCount += suffix.length;
  ctx.sessions.enter(session);
  ctx.sessions.announce(session);
  return { handle, session, cold: read.events };
}

/** Mount a fresh context with the backend under test. */
async function mountWith(
  fixture: AgentLoopFixture,
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = await fixture.context();
  const backend = await fixture.mount(ctx);
  return { ctx, dispose: backend.dispose };
}

/** Create a live session plus its persistence write handle (the create transaction). */
async function createLive(
  ctx: Context,
  id: SessionId,
  options: { cwd?: string } = {},
): Promise<{ session: Session; handle: SessionHandle }> {
  const session = ctx.sessions.create(id, options.cwd === undefined ? {} : { meta: { cwd: options.cwd } });
  const handle = await ctx.sessionPersistence.create(session.header);
  return { session, handle };
}

/** One realistic released-v0 turn: header prompt, user message, streamed answer. */
export function releasedV0Turn(): StoredRowSpec[] {
  return [
    { kind: "turn/start", data: { turn: 1 } },
    { kind: "step/start", data: { turn: 1, step: 1 } },
    {
      kind: "request/header",
      data: {
        header: { config: { provider: "mock", model: "mock" }, system: "SYS PROMPT" },
        reason: "initial",
      },
    },
    {
      kind: "user/message",
      data: {
        id: "v0-user",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    {
      kind: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
    },
    {
      kind: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
    },
    {
      kind: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "v0-assistant",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "model", provider: "mock", model: "mock" },
        },
      },
      surfaceOp: "append",
      sourceEventSeqs: [4, 5],
    },
    { kind: "step/end", data: { turn: 1, step: 1 } },
    { kind: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

/** Run the agent-loop protocol suite. */
export function runAgentLoopContract(
  name: string,
  make: () => Promise<AgentLoopFixture>,
): void {
  const raw = (fixture: AgentLoopFixture): AgentLoopRawStore => {
    if (fixture.raw === undefined) throw new Error("raw store hooks are unavailable");
    return fixture.raw;
  };

  describe(`agent-loop contract: ${name}`, () => {
    it("a created session that fails before its first append leaves no residue", async () => {
      const fixture = await make();
      try {
        const { ctx, dispose } = await mountWith(fixture);
        const id = SessionId("failed-setup");
        const session = ctx.sessions.create(id);
        const handle = await ctx.sessionPersistence.create(session.header);
        // The publication commit point never arrived: close the unmaterialized
        // handle. Nothing durable may exist, so the SAME id can be created again.
        await handle.close();
        expect(await ctx.sessionPersistence.stat(id)).toBeUndefined();
        expect((await ctx.sessionPersistence.list()).map((s) => s.header.id)).not.toContain(id);

        const second = await ctx.sessionPersistence.create(session.header);
        await second.append(oneTurnLog());
        expect((await second.read(0)).events).toHaveLength(6);
        await second.close();
        await dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("the live lifecycle persists through session/flush and survives a reload", async () => {
      const fixture = await make();
      try {
        const first = await mountWith(fixture);
        const { session, handle } = await createLive(first.ctx, SessionId("live-lifecycle"), {
          cwd: "/work",
        });
        appendLog(session, oneTurnLog());
        expect(await first.ctx.sessions.flush(session)).toBe(true);
        await handle.close();
        await first.dispose();

        // A cold instance sees the whole log and the stored header.
        const second = await mountWith(fixture);
        const reader = await second.ctx.sessionPersistence.open(session.id, "read");
        expect(reader.header).toMatchObject({
          id: session.id,
          cwd: "/work",
          version: SESSION_FORMAT_VERSION,
        });
        // The live store stamps real times and echoes the recorded payloads, so
        // the durable round-trip is asserted on the log's shape.
        expect((await reader.read(0)).events.map((e) => `${e.seq}:${e.type}`)).toEqual(
          oneTurnLog().map((e) => `${e.seq}:${e.type}`),
        );
        await reader.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("resume: cold write open + read(0) + closers + prepare + live continuation", async () => {
      const fixture = await make();
      try {
        const first = await mountWith(fixture);
        const id = SessionId("resume-interrupted");
        const { session, handle } = await createLive(first.ctx, id, { cwd: "/work" });
        appendLog(session, oneTurnLog());
        // Turn 2 crashed mid-step: it opens but never closes.
        session.append("turn/start", { turn: 2 });
        session.append("step/start", { turn: 2, step: 1 });
        await first.ctx.sessions.flush(session);
        await handle.close();
        await first.dispose();

        const second = await mountWith(fixture);
        const { handle: writer, session: resumed, cold } = await resumeSession(second.ctx, id);
        // The cold read served the durable prefix verbatim (no backend repair).
        expect(cold.map((e) => e.type)).toEqual([
          "turn/start",
          "step/start",
          "user/message",
          "assistant/message",
          "step/end",
          "turn/end",
          "turn/start",
          "step/start",
        ]);
        expect(cold.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(cold[2]).toMatchObject({ type: "user/message" });
        // The caller appended the two closers (balancing turn 2 at seq 8..9) and
        // the constructor's untagged seed-boundary marker was flushed at seq 10,
        // so the live session continues at 11.
        expect(resumed.seq).toBe(SessionLogOffset(11));
        expect((await writer.read(0)).events.map((e) => `${e.seq}:${e.type}`)).toEqual([
          "0:turn/start",
          "1:step/start",
          "2:user/message",
          "3:assistant/message",
          "4:step/end",
          "5:turn/end",
          "6:turn/start",
          "7:step/start",
          "8:step/end",
          "9:turn/end",
          "10:session/end-seed",
        ]);
        resumed.append("user/message", createUserMessage({
          content: [{ type: "text", text: "again" }],
          source: { kind: "user" },
        }), { surfaceOp: "append" });
        resumed.append("assistant/message", {
          turn: 3,
          step: 1,
          stream: [],
          message: freezeMessage({
            id: MessageId("resume-assistant"),
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        }, { surfaceOp: "append" });
        resumed.append("step/end", { turn: 3, step: 1 });
        resumed.append("turn/end", { turn: 3, reason: { kind: "completed" } });
        await second.ctx.sessions.flush(resumed);
        await writer.close();

        const third = await mountWith(fixture);
        const read = await third.ctx.sessionPersistence.open(id, "read");
        const events = (await read.read(0)).events;
        expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
        expect(events.at(-1)).toMatchObject({ type: "turn/end" });
        // The synthetic closers are durable, so the resumed turn reads back
        // interrupted rather than silently restored.
        expect(events[9]).toMatchObject({ type: "turn/end", data: { reason: { kind: "interrupted" } } });
        expect(events[10]).toMatchObject({ type: "session/end-seed" });
        await read.close();
        await third.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("resume of a balanced log appends no closers and continues at the stored end", async () => {
      const fixture = await make();
      try {
        const first = await mountWith(fixture);
        const id = SessionId("resume-balanced");
        const { session, handle } = await createLive(first.ctx, id);
        appendLog(session, oneTurnLog());
        await first.ctx.sessions.flush(session);
        await handle.close();
        await first.dispose();

        const second = await mountWith(fixture);
        const { handle: writer, session: resumed } = await resumeSession(second.ctx, id);
        // 0..5 the stored log, 6 the constructor's untagged seed marker.
        expect(resumed.seq).toBe(SessionLogOffset(7));
        expect((await writer.read(0)).events.map((e) => `${e.seq}:${e.type}`)).toEqual([
          "0:turn/start",
          "1:step/start",
          "2:user/message",
          "3:assistant/message",
          "4:step/end",
          "5:turn/end",
          "6:session/end-seed",
        ]);
        await writer.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a seeded fork child persists its inherited prefix once and resumes with the exact cut", async () => {
      const fixture = await make();
      try {
        const first = await mountWith(fixture);
        const parentId = SessionId("fork-parent");
        const parent = await createLive(first.ctx, parentId, { cwd: "/work" });
        appendLog(parent.session, oneTurnLog());
        await first.ctx.sessions.flush(parent.session);
        await parent.handle.close();

        // Fork: the child's constructor seed is the parent prefix plus the
        // tagged end-seed marker at the cut.
        const childId = SessionId("fork-child");
        const child = first.ctx.sessions.fork(parentId, SessionSeq(5), childId);
        const childHandle = await first.ctx.sessionPersistence.create(child.header, {
          inheritedEventCount: child.inheritedEventCount,
        });
        await childHandle.append(child.snapshotEvents());
        // The child's own turn is published live and routed to its handle.
        child.append("turn/start", { turn: 2 });
        child.append("turn/end", { turn: 2, reason: { kind: "completed" } });
        expect(await first.ctx.sessions.flush(child)).toBe(true);
        await childHandle.close();
        await first.dispose();

        const second = await mountWith(fixture);
        const { handle: writer, session: resumed } = await resumeSession(second.ctx, childId);
        expect(writer.header.isSeeded).toBe(true);
        expect(writer.inheritedEventCount).toBe(6);
        expect(resumed.header.isSeeded).toBe(true);
        // 0..5 the inherited prefix, 6 the inherited end-seed marker, 7..8 the
        // child's own turn, 9 the untagged restore-boundary marker the
        // constructor appends when the stored log does not already end in one.
        expect((await writer.read(0)).events.map((e) => `${e.seq}:${e.type}`)).toEqual([
          "0:turn/start",
          "1:step/start",
          "2:user/message",
          "3:assistant/message",
          "4:step/end",
          "5:turn/end",
          "6:session/end-seed",
          "7:turn/start",
          "8:turn/end",
          "9:session/end-seed",
        ]);
        expect(writer.inheritedEventCount).toBe(6);
        await writer.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("an explicit write-handle flush is a durability barrier for routed live events", async () => {
      const fixture = await make();
      try {
        const first = await mountWith(fixture);
        const id = SessionId("handle-flush-barrier");
        const { session, handle } = await createLive(first.ctx, id, { cwd: "/work" });
        appendLog(session, oneTurnLog());
        // No `ctx.sessions.flush`: the handle's own barrier must drain the
        // routed buffer and materialize the session.
        await handle.flush();
        await first.dispose();

        const second = await mountWith(fixture);
        const reader = await second.ctx.sessionPersistence.open(id, "read");
        expect((await reader.read(0)).events.map((e) => `${e.seq}:${e.type}`)).toEqual(
          oneTurnLog().map((e) => `${e.seq}:${e.type}`),
        );
        await reader.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("session/disposed closes the owning handle and drains its routed buffer", async () => {
      const fixture = await make();
      try {
        const { ctx, dispose } = await mountWith(fixture);
        const id = SessionId("disposed-drain");
        const session = ctx.sessions.prepare(id, { meta: { cwd: "/work" } });
        const detach = ctx.sessions.enter(session);
        ctx.sessions.announce(session);
        const handle = await ctx.sessionPersistence.create(session.header);
        appendLog(session, oneTurnLog());
        // Removing the live session emits `session/disposed`; the routing
        // listener closes the owning handle, whose close drains the still
        // buffered batch durably and releases write ownership.
        detach();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await expect(handle.read(0)).rejects.toThrow(/closed/);
        const reader = await ctx.sessionPersistence.open(id, "read");
        expect((await reader.read(0)).events).toHaveLength(6);
        // The closed handle released its claim, so a fresh write open succeeds.
        const writer = await ctx.sessionPersistence.open(id, "write");
        await writer.close();
        await reader.close();
        await dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("dispose closes every open handle and then the database", async () => {
      const fixture = await make();
      try {
        const { ctx, dispose } = await mountWith(fixture);
        const id = SessionId("dispose-drain");
        const { session } = await createLive(ctx, id);
        appendLog(session, oneTurnLog());
        // No explicit flush: teardown must drain the routed buffer itself.
        await dispose();

        const second = await mountWith(fixture);
        const reader = await second.ctx.sessionPersistence.open(id, "read");
        expect((await reader.read(0)).events).toHaveLength(6);
        await reader.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("stat/list observe a created-but-unmaterialized session and its migrated header", async () => {
      const fixture = await make();
      try {
        const { ctx, dispose } = await mountWith(fixture);
        const handle = await ctx.sessionPersistence.create(meta("pending-observed", "/work"));
        const snapshot = await ctx.sessionPersistence.stat(SessionId("pending-observed"));
        expect(snapshot?.header).toMatchObject({ id: "pending-observed", isSeeded: false });
        expect((await ctx.sessionPersistence.list()).map((s) => s.header.id)).toContain(
          "pending-observed",
        );
        await handle.close();
        await dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a torn tail is cut from reads and truncated before the next append", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const first = await mountWith(fixture);
        const id = SessionId("torn-tail");
        const { handle } = await createLive(first.ctx, id);
        await handle.append(oneTurnLog());
        await handle.close();
        await store.corruptTail(id);
        await first.dispose();

        const second = await mountWith(fixture);
        const reader = await second.ctx.sessionPersistence.open(id, "read");
        // The never-committed fragment is never returned.
        expect((await reader.read(0)).events).toHaveLength(6);
        await reader.close();

        // The write path truncates it before the first append lands.
        const writer = await second.ctx.sessionPersistence.open(id, "write");
        await writer.append([
          { type: "turn/start", seq: SessionSeq(6), time: 20, data: { turn: 2 } },
          { type: "turn/end", seq: SessionSeq(7), time: 21, data: { turn: 2, reason: { kind: "completed" } } },
        ]);
        expect((await writer.read(0)).events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        await writer.close();
        expect((await store.storedRows(id)).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a released v0 log is migrated on READ to the current format", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("released-v0-read");
        const first = await mountWith(fixture);
        await store.fabricate(id, {
          version: 0,
          cwd: "/legacy",
          createdAt: 1000,
          seedLength: null,
          rows: releasedV0Turn(),
        });
        const reader = await first.ctx.sessionPersistence.open(id, "read");
        // The header is served as the current format, and the released body is
        // migrated: the system prompt became surface node 0, the top-level
        // chunk rows were embedded into the assistant message's stream, and the
        // request header no longer carries `system`.
        expect(reader.header).toMatchObject({
          version: SESSION_FORMAT_VERSION,
          id,
          cwd: "/legacy",
          isSeeded: false,
        });
        const events = (await reader.read(0)).events;
        expect(events.map((e) => e.type)).toEqual([
          "turn/start",
          "step/start",
          "system/message",
          "system/message",
          "request/header",
          "user/message",
          "assistant/message",
          "step/end",
          "turn/end",
        ]);
        const prompt = events[3];
        expect(prompt.type === "system/message" && prompt.data.message.content).toEqual([
          { type: "text", text: "SYS PROMPT" },
        ]);
        const assistant = events[6];
        expect(
          assistant.type === "assistant/message" && (assistant.data.stream as unknown[]).length,
        ).toBe(1);
        expect(assistant.type === "assistant/message" && assistant.sourceEventSeqs).toBeUndefined();
        // The stored rows were NOT touched by a read.
        expect((await store.storedRows(id)).map((r) => r.kind)).toEqual(
          releasedV0Turn().map((r) => r.kind),
        );
        await reader.close();
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a WRITE open rewrites a released v0 log in place and continues it", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("released-v0-write");
        const first = await mountWith(fixture);
        await store.fabricate(id, {
          version: 0,
          cwd: "/legacy",
          createdAt: 1000,
          seedLength: null,
          rows: releasedV0Turn(),
        });

        const writer = await first.ctx.sessionPersistence.open(id, "write");
        const migrated = (await writer.read(0)).events;
        // Opening for write left the released generation behind: every stored
        // row is now a current-format identity row.
        const rows = await store.storedRows(id);
        expect(rows.map((r) => r.kind)).toEqual(migrated.map((e) => e.type));
        expect(rows.every((r) => r.seq === r.orig)).toBe(true);
        expect((await store.storedSession(id))?.version).toBe(SESSION_FORMAT_VERSION);

        // The rewritten log is valid current format: a fresh read agrees …
        const reader = await first.ctx.sessionPersistence.open(id, "read");
        expect((await reader.read(0)).events).toEqual(migrated);
        await reader.close();

        // … and the next append continues at its end.
        const next = migrated.length;
        await writer.append([
          { type: "turn/start", seq: SessionSeq(next), time: 30, data: { turn: 2 } },
          {
            type: "turn/end",
            seq: SessionSeq(next + 1),
            time: 31,
            data: { turn: 2, reason: { kind: "completed" } },
          },
        ]);
        expect((await writer.read(0)).events).toHaveLength(next + 2);
        await writer.close();
        await first.dispose();

        // A cold instance reads the same log without any migration.
        const second = await mountWith(fixture);
        const coldReader = await second.ctx.sessionPersistence.open(id, "read");
        expect((await coldReader.read(0)).events).toHaveLength(next + 2);
        await coldReader.close();
        await second.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a legacy dense-renumbered (rc.2-era) log is remapped and migrated", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("legacy-renumbered");
        const first = await mountWith(fixture);
        // The rc.2-era backend dropped the two chunk rows (upstream seqs 4,5)
        // and dense-renumbered the survivors; the assistant message kept only
        // the pruned provenance the old write path left behind.
        await store.fabricate(id, {
          version: 0,
          cwd: "/legacy",
          createdAt: 1000,
          seedLength: null,
          rows: [
            { kind: "turn/start", data: { turn: 1 }, origSeq: 0 },
            { kind: "step/start", data: { turn: 1, step: 1 }, origSeq: 1 },
            { kind: "request/header", data: {
              header: { config: { provider: "mock", model: "mock" }, system: "SYS" },
              reason: "initial",
            }, origSeq: 2 },
            {
              kind: "user/message",
              data: {
                id: "legacy-user",
                role: "user",
                content: [{ type: "text", text: "hi" }],
                source: { kind: "user" },
              },
              surfaceOp: "append",
              origSeq: 3,
            },
            {
              kind: "assistant/message",
              data: {
                turn: 1,
                step: 1,
                message: {
                  id: "legacy-assistant",
                  role: "assistant",
                  content: [{ type: "text", text: "hello" }],
                  source: { kind: "model", provider: "mock", model: "mock" },
                },
              },
              surfaceOp: "append",
              sourceEventSeqs: [3],
              origSeq: 6,
            },
            { kind: "step/end", data: { turn: 1, step: 1 }, origSeq: 7 },
            { kind: "turn/end", data: { turn: 1, reason: { kind: "completed" } }, origSeq: 8 },
          ],
        });

        const writer = await first.ctx.sessionPersistence.open(id, "write");
        const events = (await writer.read(0)).events;
        expect(events.map((e) => e.type)).toEqual([
          "turn/start",
          "step/start",
          "system/message",
          "system/message",
          "request/header",
          "user/message",
          "assistant/message",
          "step/end",
          "turn/end",
        ]);
        // The pruned chunk provenance was dropped (the current format forbids
        // it on `assistant/message`), and the rewrite made every row identity.
        const assistant = events.find((e) => e.type === "assistant/message");
        expect(assistant?.sourceEventSeqs).toBeUndefined();
        const rows = await store.storedRows(id);
        expect(rows.every((r) => r.seq === r.orig)).toBe(true);
        expect((await store.storedSession(id))?.version).toBe(SESSION_FORMAT_VERSION);

        const next = events.length;
        await writer.append([
          { type: "turn/start", seq: SessionSeq(next), time: 30, data: { turn: 2 } },
          {
            type: "turn/end",
            seq: SessionSeq(next + 1),
            time: 31,
            data: { turn: 2, reason: { kind: "completed" } },
          },
        ]);
        expect((await writer.read(0)).events).toHaveLength(next + 2);
        await writer.close();
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("an unmigratable released log refuses loudly, naming the store", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const first = await mountWith(fixture);

        // Retired pre-release vocabulary the released chain refuses.
        const retired = SessionId("retired-vocabulary");
        await store.fabricate(retired, {
          version: 0,
          createdAt: 1,
          seedLength: null,
          rows: [
            { kind: "turn/start", data: { turn: 1 } },
            { kind: "request/header-delta", data: { config: { model: "legacy" } } },
            { kind: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
          ],
        });
        await expect(
          first.ctx.sessionPersistence.open(retired, "read"),
        ).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
        await expect(first.ctx.sessionPersistence.open(retired, "write")).rejects.toThrow(
          /request\/header-delta/,
        );
        // A header-only observation does not decode the body: the released
        // header is migratable, so `stat` answers without touching the retired
        // vocabulary (the refusal arrives when a caller reads the log).
        expect((await first.ctx.sessionPersistence.stat(retired))?.header.version).toBe(
          SESSION_FORMAT_VERSION,
        );

        // A surface event before the first step cannot acquire a protected
        // system head without reordering chronology.
        const chronology = SessionId("surface-before-step");
        await store.fabricate(chronology, {
          version: 0,
          createdAt: 1,
          seedLength: null,
          rows: [
            { kind: "turn/start", data: { turn: 1 } },
            {
              kind: "user/message",
              data: {
                id: "early-user",
                role: "user",
                content: [{ type: "text", text: "hi" }],
                source: { kind: "user" },
              },
              surfaceOp: "append",
            },
            { kind: "step/start", data: { turn: 1, step: 1 } },
            { kind: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
          ],
        });
        try {
          const reader = await first.ctx.sessionPersistence.open(chronology, "read");
          await reader.read(0);
          throw new Error("expected the migration to refuse this log");
        } catch (error) {
          expect(error).toBeInstanceOf(SessionFormatUnsupportedError);
          expect((error as SessionFormatUnsupportedError).location?.path).toBe(store.path);
          expect((error as Error).message).toMatch(/system head/);
        }
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("an unsupported stored format version refuses loudly", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("future-version");
        const first = await mountWith(fixture);
        await store.fabricate(id, {
          version: 99,
          createdAt: 1,
          seedLength: null,
          rows: [{ kind: "turn/start", data: { turn: 1 } }],
        });
        // Both the read path and the header-only observation refuse it.
        await expect(first.ctx.sessionPersistence.open(id, "read")).rejects.toThrow(
          /newer format v99/,
        );
        await expect(first.ctx.sessionPersistence.stat(id)).rejects.toBeInstanceOf(
          SessionFormatUnsupportedError,
        );
        await expect(first.ctx.sessionPersistence.open(id, "write")).rejects.toBeInstanceOf(
          SessionFormatUnsupportedError,
        );
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a legacy write open is exclusive: a second write open rejects while it is live", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("legacy-exclusive");
        const first = await mountWith(fixture);
        await store.fabricate(id, {
          version: 0,
          createdAt: 1,
          seedLength: null,
          rows: releasedV0Turn(),
        });
        const writer = await first.ctx.sessionPersistence.open(id, "write");
        await expect(first.ctx.sessionPersistence.open(id, "write")).rejects.toBeInstanceOf(
          SessionAlreadyOwnedError,
        );
        await writer.close();
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });

    it("a seeded released log keeps its inherited cut across the migration", async () => {
      const fixture = await make();
      if (fixture.raw === undefined) return;
      try {
        const store = raw(fixture);
        const id = SessionId("released-seeded");
        const first = await mountWith(fixture);
        const rows: StoredRowSpec[] = [
          ...releasedV0Turn(),
          { kind: "session/end-seed", data: {} },
          { kind: "turn/start", data: { turn: 2 } },
          { kind: "step/start", data: { turn: 2, step: 1 } },
          {
            kind: "user/message",
            data: {
              id: "v0-child-user",
              role: "user",
              content: [{ type: "text", text: "child" }],
              source: { kind: "user" },
            },
            surfaceOp: "append",
          },
          { kind: "step/end", data: { turn: 2, step: 1 } },
          { kind: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
        ];
        await store.fabricate(id, {
          version: 0,
          cwd: "/legacy",
          createdAt: 1000,
          seedLength: 9,
          rows,
        });

        const writer = await first.ctx.sessionPersistence.open(id, "write");
        expect(writer.header.isSeeded).toBe(true);
        const events = (await writer.read(0)).events;
        // The inherited prefix is the first nine released rows, ending exactly
        // at the tagged end-seed marker.
        expect(writer.inheritedEventCount).toBe(9);
        expect(events[9]).toMatchObject({ type: "session/end-seed", data: { inherited: true } });
        expect(events.length).toBeGreaterThan(9);
        // The migrated session restores as a valid, resumable child.
        const restored = Session.fromRestore(
          id,
          [...events],
          writer.header,
          writer.inheritedEventCount,
          "detached",
        );
        expect(restored.inheritedEventCount).toBe(SessionLogOffset(9));
        await writer.close();
        await first.dispose();
      } finally {
        await fixture.cleanup();
      }
    });
  });
}

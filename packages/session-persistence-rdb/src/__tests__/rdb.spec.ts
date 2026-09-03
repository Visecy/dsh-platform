import { randomUUID } from "node:crypto";
import { MessageId, ToolCallId, createMessage, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { afterEach, describe, expect, it } from "vitest";
import { EmptySettings } from "./testing/helpers.ts";
import { Context } from "@deepseek-ai/cordis";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore, SessionLogOffset, SessionId } from "@deepseek-ai/dsh-session";
import type {
  Session,
  SessionEvent,
  SurfaceEvent,
  SurfaceEventType,
} from "@deepseek-ai/dsh-session";
import SessionPersistenceSqlite, { SCHEMA_VERSION } from "../index.ts";
import {
  buildSeqMap,
  hasLegacyRenumbering,
  remapShadowedRange,
  remapSurfaceOp,
  rowToEvent,
  rowToMeta,
  scanRows,
  storedInheritedCount,
} from "../log.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  EVENT_ENCODING,
  IGNORABLE_EVENT_ENCODING,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  eventDimensions,
  type EventRow,
  type SessionRow,
} from "../schema.ts";
import { openDatabase } from "../sqlite.ts";
import { runPersistenceContract, meta, oneTurnLog, appendLog } from "./testing/contract.ts";
import { runCoordinatorContract, type CoordinatorFixture } from "./testing/coordinator-contract.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function expectFlushError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected flush to reject");
}

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sqlite-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

/**
 * Hand-insert one event as an events + session_events pair (the backend's write
 * path always keeps them in step; a bridge row without an event row never
 * joins). Used to fabricate on-disk states (legacy logs, torn tails) that the
 * normal append path cannot produce.
 * @returns the minted event id (the bridge row's parent for the next event).
 */
function insertEventRow(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  kind: string,
  data: unknown,
  parentId: string,
  options: {
    originalSeq?: number;
    encoding?: string;
    surfaceSeqs?: string | null;
    surfaceOp?: string | null;
    createdAt?: number;
  } = {},
): string {
  const eventId = randomUUID();
  db.prepare(`
    INSERT INTO t_events
      (f_event_id, f_parent_id, f_kind, f_role, f_name, f_action_id, f_encoding,
       f_data, f_created_at, f_original_seq, f_source_event_seqs, f_surface_op)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    parentId,
    kind,
    "",
    "",
    "",
    options.encoding ?? EVENT_ENCODING,
    typeof data === "string" ? data : JSON.stringify(data),
    options.createdAt ?? seq + 1,
    options.originalSeq ?? seq,
    options.surfaceSeqs ?? null,
    options.surfaceOp ?? null,
  );
  db.prepare(
    "INSERT INTO t_session_events (f_session_id, f_event_id, f_sequence) VALUES (?, ?, ?)",
  ).run(sessionId, eventId, seq);
  return eventId;
}

/** Insert the `t_sessions` row directly (raw SQL — bypasses the write path). */
function insertSessionRow(
  db: DatabaseSync,
  row: {
    fSessionId: string;
    fHeadEventId: string;
    fHeadSequence: number;
    fVersion: number;
    fCreatedAt: number;
    fCwd: string | null;
    fSeedLength: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO t_sessions
      (f_session_id, f_head_event_id, f_head_sequence, f_version, f_created_at, f_cwd,
       f_parent_session, f_seed_length, f_origin, f_delegation_depth, f_incarnation, f_revision)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, 1)
  `).run(
    row.fSessionId,
    row.fHeadEventId,
    row.fHeadSequence,
    row.fVersion,
    row.fCreatedAt,
    row.fCwd,
    row.fSeedLength,
    "hand-written",
  );
}

/** A context with the session store + SQLite backend, plus a teardown. */
async function backend(path = ":memory:"): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

// Run the same backend-agnostic contract as JSONL to pin identical semantics.
runPersistenceContract("sqlite", async () => {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
  return {
    ctx,
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose();
    },
  };
});

// A file-backed database lets two mounts share rows across reload. `corruptTail`
// inserts an unparsable row past the committed seq (as an events + session_events
// pair, since a bridge row without an event row never joins), exercising
// coordinator repair against real database rows.
runCoordinatorContract("sqlite", async (): Promise<CoordinatorFixture> => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-sqlite-coord-"));
  const path = join(dir, "sessions.db");
  return {
    mount: async (ctx) => {
      // HMR 测试会在同一 ctx 上多次 reload 后端；settings 服务只注册一次。
      if (ctx.reflect.get("settings") === undefined) {
        await ctx.plugin(EmptySettings);
      }
      return await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    },
    corruptTail: async (id) => {
      const db = openDatabase(path, "wal");
      const head = db
        .prepare("SELECT f_head_event_id, f_head_sequence FROM t_sessions WHERE f_session_id = ?")
        .get(id) as { f_head_event_id: string; f_head_sequence: number };
      const next = head.f_head_sequence + 1;
      insertEventRow(db, id, next, "assistant/chunk", "{not valid json", head.f_head_event_id);
      db.close();
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

/** A one-turn log with a delta stream between step/start and assistant/message. */
function chunkedTurnLog(): SessionEvent[] {
  return [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 1,
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    { type: "step/start", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "assistant/chunk",
      seq: 3,
      time: 4,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
    },
    {
      type: "assistant/chunk",
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "llo" } },
    },
    {
      type: "assistant/message",
      seq: 5,
      time: 6,
      data: {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId("chunked-assistant"),
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
      },
      surfaceOp: "append",
      sourceEventSeqs: [1, 3, 4],
    },
    { type: "step/end", seq: 6, time: 7, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 7, time: 8, data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

describe("eventDimensions", () => {
  it("classifies boundary events as turn role", () => {
    const { role, name, actionId } = eventDimensions({
      type: "turn/start",
      seq: 0,
      time: 1,
      data: { turn: 1 },
    });
    expect([role, name, actionId]).toEqual(["turn", "", ""]);
  });

  it("classifies messages and chunk deltas as user/model roles", () => {
    expect(
      eventDimensions({
        type: "user/message",
        seq: 1,
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
      }).role,
    ).toBe("user");
    expect(
      eventDimensions({
        type: "assistant/message",
        seq: 2,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "assistant",
            content: [],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
      }).role,
    ).toBe("model");
    // Since 0.1.2 chunk deltas are persisted too; they classify as model output.
    expect(
      eventDimensions({
        type: "assistant/chunk",
        seq: 3,
        time: 4,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "he" } },
      }),
    ).toEqual({ role: "model", name: "", actionId: "" });
  });

  it("extracts the function name and call id from tool/call", () => {
    const dims = eventDimensions({
      type: "tool/call",
      seq: 4,
      time: 5,
      data: { turn: 1, step: 1, callId: ToolCallId("call-1"), name: "read", arguments: "{}" },
    });
    expect(dims).toEqual({ role: "function", name: "read", actionId: "call-1" });
  });

  it("extracts the call id from tool/result and classifies todo/write as state", () => {
    const callId = ToolCallId("call-2");
    const result = eventDimensions({
      type: "tool/result",
      seq: 5,
      time: 6,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "user",
          content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
          source: { kind: "tool", callId },
        }),
      },
    });
    expect(result).toEqual({ role: "function", name: "", actionId: "call-2" });
    expect(eventDimensions({ type: "todo/write", seq: 6, time: 7, data: { todos: [] } })).toEqual({
      role: "state",
      name: "todos",
      actionId: "",
    });
  });

  it("keeps playpen defaults for unknown plugin-merged event types", () => {
    expect(
      eventDimensions({ type: "plugin/custom", seq: 0, time: 1, data: {} } as SessionEvent),
    ).toEqual({ role: "", name: "", actionId: "" });
  });
});

describe("scanRows", () => {
  // scanRows works off EventRows (data is a JSON string column); build them from
  // SessionEvents so the unit tests read in terms of the event vocabulary. With
  // persist-everything the persisted seq equals the event's logical seq.
  const rows = (events: SessionEvent[]): EventRow[] =>
    events.map((e) => {
      const se = e as SessionEvent<SurfaceEventType>;
      return {
        fSequence: e.seq,
        fOriginalSeq: e.seq,
        fKind: e.type,
        fCreatedAt: e.time,
        fData: JSON.stringify(e.data),
        fEncoding: e.ignorable === true ? IGNORABLE_EVENT_ENCODING : EVENT_ENCODING,
        fSourceEventSeqs:
          se.sourceEventSeqs === undefined ? null : JSON.stringify(se.sourceEventSeqs),
        fSurfaceOp: se.surfaceOp !== undefined ? JSON.stringify(se.surfaceOp) : null,
      };
    });

  it("preserves the full log when it ends exactly on a turn/end (no torn tail)", () => {
    const { preserved, tornFrom } = scanRows(rows(oneTurnLog()));
    expect(preserved).toEqual(oneTurnLog());
    expect(tornFrom).toBeUndefined();
  });

  it("PRESERVES the real events of an interrupted turn after the last turn/end", () => {
    const withOpenTurn: SessionEvent[] = [
      ...oneTurnLog(),
      {
        type: "turn/start",
        seq: 6,
        time: 7,
        data: { turn: 2 },
      },
      { type: "step/start", seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ];
    const { preserved, tornFrom } = scanRows(rows(withOpenTurn));
    expect(preserved.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tornFrom).toBeUndefined();
  });

  it("preserves the contiguous prefix and flags a torn tail at a seq gap", () => {
    const gapped: SessionEvent[] = [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
    ];
    const { preserved, tornFrom } = scanRows(rows(gapped));
    expect(preserved.map((e) => e.seq)).toEqual([0]);
    expect(tornFrom).toBe(1);
  });

  it("an empty log preserves nothing and has no torn tail", () => {
    expect(scanRows([])).toEqual({ preserved: [] });
  });

  it("throws on a seq gap inside the committed region (before the last turn/end)", () => {
    const gapped: SessionEvent[] = [
      {
        type: "turn/start",
        seq: 0,
        time: 1,
        data: { turn: 1 },
      },
      { type: "step/start", seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      { type: "turn/end", seq: 3, time: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ];
    expect(() => scanRows(rows(gapped))).toThrow(/seq gap in committed region/);
  });

  it("throws on an unparsable row inside the committed region", () => {
    const withCorruptCommitted: EventRow[] = [
      {
        fSequence: 0,
        fOriginalSeq: 0,
        fKind: "turn/start",
        fCreatedAt: 1,
        fData: "{not json",
        fEncoding: EVENT_ENCODING,
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
      {
        fSequence: 1,
        fOriginalSeq: 1,
        fKind: "turn/end",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
        fEncoding: EVENT_ENCODING,
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/);
  });

  it("tolerates an unparsable torn-tail row after the last turn/end", () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      {
        fSequence: 6,
        fOriginalSeq: 6,
        fKind: "turn/start",
        fCreatedAt: 7,
        fData: "{not json",
        fEncoding: EVENT_ENCODING,
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    const { preserved, tornFrom } = scanRows(withCorruptTail);
    expect(preserved).toEqual(oneTurnLog());
    expect(tornFrom).toBe(6);
  });
});

describe("rowToMeta", () => {
  const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
    fSessionId: "s1",
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: 0,
    fCreatedAt: 1000,
    fCwd: null,
    fParentSession: null,
    fSeedLength: null,
    fOrigin: null,
    fDelegationDepth: null,
    fIncarnation: "i1",
    fRevision: 1,
    ...overrides,
  });

  it("rejects fractional stored creation metadata", () => {
    expect(() => rowToMeta(row({ fCreatedAt: 1.5 }))).toThrow(
      "stored session createdAt must be a non-negative safe integer",
    );
  });

  it("derives isSeeded from the stored cut's presence and never emits seedLength", () => {
    // The 0.1.2 header REQUIRES isSeeded and FORBIDS seedLength; the cut is
    // out-of-band storage state (mirrors the JSONL header line's seedLength).
    expect(rowToMeta(row())).toMatchObject({ id: "s1", isSeeded: false });
    expect(rowToMeta(row())).not.toHaveProperty("seedLength");
    expect(rowToMeta(row({ fSeedLength: 3 }))).toMatchObject({ id: "s1", isSeeded: true });
    expect(rowToMeta(row({ fSeedLength: 3 }))).not.toHaveProperty("seedLength");
    expect(rowToMeta(row({ fSeedLength: 0 }))).toMatchObject({ isSeeded: true });
  });

  it("maps NULL columns to omitted optional fields", () => {
    expect(rowToMeta(row())).toEqual({
      version: 0,
      id: "s1",
      createdAt: 1000,
      isSeeded: false,
    });
    expect(
      rowToMeta(
        row({
          fCwd: "/w",
          fParentSession: "p1",
          fOrigin: "subagent",
          fDelegationDepth: 2,
        }),
      ),
    ).toMatchObject({
      cwd: "/w",
      parentSession: "p1",
      origin: "subagent",
      delegationDepth: 2,
    });
  });
});

describe("rowToEvent", () => {
  const row = (overrides: Partial<EventRow> = {}): EventRow => ({
    fSequence: 0,
    fOriginalSeq: 0,
    fKind: "assistant/message",
    fCreatedAt: 1,
    fData: "{}",
    fEncoding: EVENT_ENCODING,
    fSourceEventSeqs: null,
    fSurfaceOp: null,
    ...overrides,
  });

  it("parses surface fields from EventRow columns", () => {
    const event = rowToEvent(
      row({
        fKind: "user/message",
        fData: JSON.stringify({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
        fSourceEventSeqs: JSON.stringify([3, 5]),
        fSurfaceOp: JSON.stringify("append"),
      }),
    );
    expect(event.seq).toBe(0);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([3, 5]);
    expect((event as SurfaceEvent).surfaceOp).toBe("append");
    expect(event.ignorable).toBeUndefined();
  });

  it("restores the ignorable envelope marker from the ignorable encoding", () => {
    // An unknown-type ignorable event must read back with `ignorable: true` or
    // the coordinator's unknown-type tolerance would refuse the whole log.
    const event = rowToEvent(
      row({
        fKind: "plugin/telemetry",
        fEncoding: IGNORABLE_EVENT_ENCODING,
        fData: "null",
      }),
    );
    expect(event).toMatchObject({ type: "plugin/telemetry", ignorable: true, data: null });
  });

  it("remaps sourceEventSeqs through the upstream→persisted seq map (legacy rows)", () => {
    // Rows written by the rc.2-era delta-filtering backend are dense-renumbered;
    // provenance is stored in upstream seqs and translated on read.
    const legacy = row({
      fSequence: 4,
      fOriginalSeq: 7,
      fKind: "assistant/message",
      fData: JSON.stringify({ turn: 1, step: 1, content: [] }),
      fSourceEventSeqs: JSON.stringify([2, 6]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 0, end: 1 }),
    });
    const map = new Map<number, number>([
      [0, 0],
      [1, 1],
      [2, 2],
      [6, 3],
      [7, 4],
    ]);
    const event = rowToEvent(legacy, map);
    expect(event.seq).toBe(4);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([2, 3]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 0, end: 1 });
  });

  it("keeps an unmapped sourceEventSeqs entry verbatim (tolerated like a scan hole)", () => {
    const legacy = row({
      fSequence: 1,
      fOriginalSeq: 1,
      fKind: "user/message",
      fData: JSON.stringify({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
      fSourceEventSeqs: JSON.stringify([9]),
    });
    const event = rowToEvent(legacy, new Map<number, number>([[1, 1]]));
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([9]);
  });

  it("remaps a positional replace surfaceOp through the upstream→persisted seq map (legacy rows)", () => {
    // The dense persisted seq must be used for the replacement range, or the
    // surface fold rejects the log ("start seq N not found in surface").
    const legacy = row({
      fSequence: 9,
      fOriginalSeq: 30,
      fKind: "tool/result",
      fData: JSON.stringify({
        turn: 1,
        step: 1,
        message: { source: { kind: "tool", callId: "c" }, content: [] },
      }),
      fSourceEventSeqs: JSON.stringify([2]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 2, end: 2 }),
    });
    const map = new Map<number, number>([
      [2, 5],
      [30, 9],
    ]);
    const event = rowToEvent(legacy, map);
    expect((event as SurfaceEvent).sourceEventSeqs).toEqual([5]);
    expect((event as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 5, end: 5 });
  });

  it("remaps a compaction/summary shadowedRange through the upstream→persisted seq map (legacy rows)", () => {
    // The metering event's shadow-price claim names the replaced range by
    // UPSTREAM seq; it must follow the replace's surfaceOp into dense space or
    // the token-meter fold rejects the log ("token surface: replace ... has no
    // adjacent shadow price").
    const legacy = row({
      fSequence: 4056,
      fOriginalSeq: 400_000,
      fKind: "compaction/summary",
      fData: JSON.stringify({
        turn: 1,
        summary: "…",
        shadowedRange: { start: 15, end: 398_881 },
        shadowedTokenCount: 12_345,
      }),
    });
    const map = new Map<number, number>([
      [15, 15],
      [398_881, 4048],
      [400_000, 4056],
    ]);
    const event = rowToEvent(legacy, map);
    expect(event.data).toMatchObject({
      shadowedRange: { start: 15, end: 4048 },
      shadowedTokenCount: 12_345,
    });
  });

  it("remaps a compaction/prune shadowedRange and leaves other data untouched (legacy rows)", () => {
    const legacy = row({
      fSequence: 3,
      fOriginalSeq: 10,
      fKind: "compaction/prune",
      fData: JSON.stringify({
        turn: 2,
        shadowedRange: { start: 7, end: 9 },
        shadowedTokenCount: 42,
      }),
    });
    const event = rowToEvent(
      legacy,
      new Map<number, number>([
        [7, 1],
        [9, 2],
        [10, 3],
      ]),
    );
    expect(event.data).toMatchObject({
      turn: 2,
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 42,
    });
  });

  it("keeps surface metadata verbatim without a seq map (current rows, identity)", () => {
    const current = row({
      fSequence: 3,
      fOriginalSeq: 3,
      fKind: "compaction/summary",
      fData: JSON.stringify({
        turn: 1,
        shadowedRange: { start: 1, end: 2 },
        shadowedTokenCount: 9,
      }),
      fSourceEventSeqs: JSON.stringify([1, 2]),
      fSurfaceOp: JSON.stringify({ op: "replace", start: 1, end: 2 }),
    });
    expect(rowToEvent(current).data).toMatchObject({
      shadowedRange: { start: 1, end: 2 },
      shadowedTokenCount: 9,
    });
    expect((rowToEvent(current) as SurfaceEvent).surfaceOp).toEqual({
      op: "replace",
      start: 1,
      end: 2,
    });
    expect((rowToEvent(current) as SurfaceEvent).sourceEventSeqs).toEqual([1, 2]);
  });
});

describe("remapSurfaceOp", () => {
  it("leaves append untouched", () => {
    expect(
      remapSurfaceOp("append", () => {
        throw new Error("append must not remap");
      }),
    ).toBe("append");
  });

  it("remaps both ends of a replace range", () => {
    expect(remapSurfaceOp({ op: "replace", start: 2, end: 4 }, (seq) => seq * 10)).toEqual({
      op: "replace",
      start: 20,
      end: 40,
    });
  });
});

describe("remapShadowedRange", () => {
  it("remaps both ends of the shadowed range", () => {
    expect(remapShadowedRange({ start: 15, end: 398_881 }, (seq) => seq - 10)).toEqual({
      start: 5,
      end: 398_871,
    });
  });
});

describe("buildSeqMap", () => {
  it("maps upstream seqs to dense persisted seqs", () => {
    const map = buildSeqMap([
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 4 },
      { fSequence: 2, fOriginalSeq: 5 },
    ]);
    expect(map.get(0)).toBe(0);
    expect(map.get(4)).toBe(1);
    expect(map.get(5)).toBe(2);
  });

  it("keeps the first mapping when upstream seqs overlap across a resume boundary", () => {
    // After resume, the new segment's upstream seqs renumber from the seed
    // boundary and overlap the seed segment's space; a seed-segment provenance
    // reference must resolve to the seed-space row (the first occurrence).
    const map = buildSeqMap([
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 100 },
      { fSequence: 2, fOriginalSeq: 101 },
      { fSequence: 3, fOriginalSeq: 3 },
      { fSequence: 4, fOriginalSeq: 100 },
      { fSequence: 5, fOriginalSeq: 102 },
    ]);
    expect(map.get(100)).toBe(1);
    expect(map.get(101)).toBe(2);
    expect(map.get(102)).toBe(5);
  });
});

describe("hasLegacyRenumbering / storedInheritedCount", () => {
  it("detects rc.2-era dense renumbering only when a row's seqs disagree", () => {
    expect(hasLegacyRenumbering([])).toBe(false);
    expect(hasLegacyRenumbering([{ fSequence: 0, fOriginalSeq: 0 }])).toBe(false);
    expect(
      hasLegacyRenumbering([
        { fSequence: 0, fOriginalSeq: 0 },
        { fSequence: 1, fOriginalSeq: 4 },
      ]),
    ).toBe(true);
  });

  it("uses the stored cut verbatim on current (identity) logs", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ fSequence: i, fOriginalSeq: i }));
    expect(storedInheritedCount(null, rows, false)).toBe(0);
    expect(storedInheritedCount(3, rows, false)).toBe(3);
  });

  it("translates a legacy log's upstream-space cut into the dense row count", () => {
    // Legacy seed: upstream seqs 0..5 with chunk deltas 3,4 dropped → 4 dense
    // rows; the child's own turn continues at dense 4 with upstream seqs >= 6.
    const rows = [
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 1 },
      { fSequence: 2, fOriginalSeq: 2 },
      { fSequence: 3, fOriginalSeq: 5 },
      { fSequence: 4, fOriginalSeq: 6 },
      { fSequence: 5, fOriginalSeq: 8 },
    ];
    // Stored cut 6 (upstream) → the 4 seed rows with f_original_seq < 6.
    expect(storedInheritedCount(6, rows, true)).toBe(4);
    // Identity rows under the same cut count directly.
    expect(storedInheritedCount(6, rows, false)).toBe(6);
    // An unseeded legacy log has no cut.
    expect(storedInheritedCount(null, rows, true)).toBe(0);
  });
});

describe("SessionPersistenceSqlite: durability and crash semantics", () => {
  it("rejects a stored v0 log containing a legacy request/header-delta event", async () => {
    const path = await freshDbPath();
    const m = meta("legacy-header-delta", "/legacy");
    const db = openDatabase(path, "wal");
    insertSessionRow(db, {
      fSessionId: m.id,
      fHeadEventId: "",
      fHeadSequence: -1,
      fVersion: m.version,
      fCreatedAt: m.createdAt,
      fCwd: m.cwd ?? null,
      fSeedLength: null,
    });
    let parent = "";
    parent = insertEventRow(db, m.id, 0, "turn/start", { turn: 1 }, parent);
    parent = insertEventRow(db, m.id, 1, "request/header-delta", { config: { model: "legacy" } }, parent);
    insertEventRow(db, m.id, 2, "turn/end", { turn: 1, reason: { kind: "completed" } }, parent);
    db.close();

    const mounted = await backend(path);
    await expect(mounted.ctx.sessionPersistence.load(m.id)).rejects.toThrow(
      /unsupported legacy request\/header-delta event at seq 1/,
    );
    await mounted.dispose();
  });

  it("has no independent per-session log location", async () => {
    const { ctx, dispose } = await backend();
    expect(ctx.sessionPersistence.locate(meta("sqlite-location"))).toBeUndefined();
    await dispose();
  });

  it("an interrupted turn (rows after the last turn/end) is PRESERVED and closed during load", async () => {
    const path = await freshDbPath();
    const m = meta("crash");
    // Run 1: persist a complete turn, then a half-written second turn (no turn/end).
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog());
    await b1.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 6, time: 7, data: { turn: 2 } },
      { type: "step/start", seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ]);
    await b1.dispose();

    // Run 2: load PRESERVES the interrupted turn's real events (a turn can be huge
    // — never truncated) and closes the orphaned turn with synthetic boundary
    // events: step/end (the step was open) then turn/end {interrupted}.
    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end", // turn 1
      "turn/start",
      "step/start",
      "step/end",
      "turn/end", // turn 2: real events + synthetic closers
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last = loaded.events.at(-1)!;
    expect(last.type === "turn/end" && last.data.reason).toEqual({ kind: "interrupted" });

    // load durably closed the turn, so the next append continues at the balanced
    // length (seq 10) and a reload round-trips identically.
    await b2.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 10, time: 9, data: { turn: 3 } },
      { type: "turn/end", seq: 11, time: 10, data: { turn: 3, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await b2.dispose();
  });

  it("load() durably closes the interrupted turn: the synthetic closers are on disk after load", async () => {
    const path = await freshDbPath();
    const m = meta("load-closes");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()); // seqs 0..5
    await b1.dispose();
    // Hand-write an interrupted turn (turn/start seq 6, no turn/end).
    const db = openDatabase(path, "wal");
    const head = db
      .prepare("SELECT f_head_event_id FROM t_sessions WHERE f_session_id = ?")
      .get(m.id) as { f_head_event_id: string };
    insertEventRow(db, m.id, 6, "turn/start", { turn: 2 }, head.f_head_event_id);
    db.close();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    // turn 2's real turn/start (seq 6) is preserved + a synthetic turn/end (seq 7).
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loaded.events.at(-1)!.type).toBe("turn/end");
    // load() is mutating: the synthetic turn/end MUST be on disk so the stored log
    // is balanced and the cursor is truthful (contract: load closes, not defers).
    const probe = openDatabase(path, "wal");
    const stored = probe
      .prepare(`
      SELECT se.f_sequence, e.f_kind FROM t_session_events se
      JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as { f_sequence: number; f_kind: string }[];
    probe.close();
    expect(stored.map((r) => r.f_sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(stored.at(-1)!.f_kind).toBe("turn/end");
    await b2.dispose();
  });

  it("rejects opening a database whose schema version is not the current build (newer OR older)", async () => {
    const path = await freshDbPath();
    openDatabase(path, "wal").close(); // stamp user_version = SCHEMA_VERSION
    const dbNewer = openDatabase(path, "wal");
    dbNewer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    dbNewer.close();
    expect(() => openDatabase(path, "wal")).toThrow(/incompatible with this build/);

    const olderPath = await freshDbPath();
    openDatabase(olderPath, "wal").close();
    const dbOlder = openDatabase(olderPath, "wal");
    dbOlder.exec("PRAGMA user_version = 123");
    dbOlder.close();
    expect(() => openDatabase(olderPath, "wal")).toThrow(/incompatible with this build/);
  });

  it("rejects a table-backed unversioned database before stamping or changing journal mode", async () => {
    const path = await freshDbPath();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE t_sessions (id TEXT PRIMARY KEY)");
    legacy.close();

    expect(() => openDatabase(path, "wal")).toThrow(/unversioned schema or application identity/);

    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(unchanged.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    unchanged.close();
  });

  it("rejects view-only and foreign-application unversioned databases without mutation", async () => {
    const viewPath = await freshDbPath();
    const viewOnly = new DatabaseSync(viewPath);
    viewOnly.exec("CREATE VIEW foreign_view AS SELECT 1 AS value");
    viewOnly.close();

    expect(() => openDatabase(viewPath, "wal")).toThrow(
      /unversioned schema or application identity/,
    );
    const unchangedView = new DatabaseSync(viewPath);
    expect(unchangedView.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    unchangedView.close();

    const applicationPath = await freshDbPath();
    const foreignApplication = new DatabaseSync(applicationPath);
    foreignApplication.exec("PRAGMA application_id = 12345");
    foreignApplication.close();

    expect(() => openDatabase(applicationPath, "wal")).toThrow(
      /unversioned schema or application identity/,
    );
    const unchangedApplication = new DatabaseSync(applicationPath);
    expect(unchangedApplication.prepare("PRAGMA application_id").get()).toEqual({
      application_id: 12345,
    });
    expect(unchangedApplication.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    unchangedApplication.close();
  });

  it("rejects a current-version database with a foreign application identity", async () => {
    const path = await freshDbPath();
    const foreign = new DatabaseSync(path);
    foreign.exec("PRAGMA application_id = 12345");
    foreign.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    foreign.close();

    expect(() => openDatabase(path, "wal")).toThrow(/has application id 12345/);
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare("PRAGMA application_id").get()).toEqual({ application_id: 12345 });
    unchanged.close();
  });

  it("stamps the persistence application identity with the schema version", async () => {
    const path = await freshDbPath();
    openDatabase(path, "wal").close();

    const db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA application_id").get()).toEqual({
      application_id: SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
    });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
  });

  it("a corrupt-JSON row in the uncommitted tail is discarded on load, not unloadable", async () => {
    const path = await freshDbPath();
    const m = meta("corrupt-tail");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()); // committed: seqs 0..5
    await b1.dispose();

    const db = openDatabase(path, "wal");
    const head = db
      .prepare("SELECT f_head_event_id FROM t_sessions WHERE f_session_id = ?")
      .get(m.id) as { f_head_event_id: string };
    insertEventRow(db, m.id, 6, "turn/start", "{not valid json", head.f_head_event_id);
    db.close();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events).toEqual(oneTurnLog()); // torn tail discarded, committed intact (turn 1 already balanced → no closers)
    // load physically deleted the corrupt tail row, so a fresh append continues.
    await b2.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 6, time: 8, data: { turn: 2 } },
      { type: "turn/end", seq: 7, time: 9, data: { turn: 2, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await b2.dispose();
  });

  it("append rejects a batch that re-states an already-stored seq and leaves the log unchanged", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
    const m = meta("no-duplicate");
    await ctx.sessionPersistence.create(m);
    await ctx.sessionPersistence.append(m.id, oneTurnLog()); // seqs 0..5

    // The coordinator's cursor check (or the UNIQUE (session_id, seq)
    // constraint inside the transaction) rejects the restated batch; either way
    // nothing is written and the stored log is unchanged.
    await expect(ctx.sessionPersistence.append(m.id, oneTurnLog())).rejects.toThrow();
    const loaded = await ctx.sessionPersistence.load(m.id);
    expect(loaded.events).toEqual(oneTurnLog());
    await fiber.dispose();
  });

  it("persists across separate backend instances over the same file", async () => {
    const path = await freshDbPath();
    const m = meta("persist", "/proj");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog());
    await b1.dispose();

    const b2 = await backend(path);
    expect((await b2.ctx.sessionPersistence.list()).map((x) => x.id)).toContain(m.id);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.meta).toMatchObject({ id: m.id, cwd: "/proj", isSeeded: false });
    expect(loaded.events).toEqual(oneTurnLog());
    await b2.dispose();
  });

  it("source-qualifies revisions across stores while preserving same-file reopen identity", async () => {
    const pathA = await freshDbPath();
    const pathB = await freshDbPath();
    const m = meta("revision-source");
    const a = await backend(pathA);
    await a.ctx.sessionPersistence.create(m);
    await a.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const revisionA = (await a.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    await a.dispose();

    const probeA = openDatabase(pathA, "wal");
    const storeIdA = (
      probeA.prepare("SELECT f_store_id FROM t_persistence_state WHERE f_singleton = 1").get() as {
        f_store_id: string;
      }
    ).f_store_id;
    probeA.close();

    const aliasA = `${pathA}.alias`;
    await symlink(pathA, aliasA);
    const reopenedA = await backend(aliasA);
    expect((await reopenedA.ctx.sessionPersistence.listSnapshots())[0]?.revision).toBe(revisionA);
    await reopenedA.dispose();

    const b = await backend(pathB);
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const revisionB = (await b.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    const probeB = openDatabase(pathB, "wal");
    const storeIdB = (
      probeB.prepare("SELECT f_store_id FROM t_persistence_state WHERE f_singleton = 1").get() as {
        f_store_id: string;
      }
    ).f_store_id;
    probeB.close();
    expect(storeIdB).not.toBe(storeIdA);
    expect(revisionB).not.toBe(revisionA);
    expect(String(revisionA)).toMatch(/:revision:1$/);
    expect(String(revisionB)).toMatch(/:revision:1$/);
    await b.dispose();
  });

  it("changes revisions when a deleted session id is materialized again in the same database", async () => {
    const path = await freshDbPath();
    const m = meta("recreated-revision");
    const first = await backend(path);
    await first.ctx.sessionPersistence.create(m);
    await first.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const before = (await first.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    await first.dispose();

    const cleanup = openDatabase(path, "wal");
    cleanup.prepare("DELETE FROM t_sessions WHERE f_session_id = ?").run(m.id);
    cleanup.close();

    const second = await backend(path);
    await second.ctx.sessionPersistence.create(m);
    await second.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const after = (await second.ctx.sessionPersistence.listSnapshots())[0]?.revision;
    expect(after).not.toBe(before);
    expect(String(before)).toMatch(/:revision:1$/);
    expect(String(after)).toMatch(/:revision:1$/);
    await second.dispose();
  });

  it("keeps the revision stable for an empty repair hook", async () => {
    const b = await backend();
    const m = meta("empty-repair");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, oneTurnLog());
    const before = await b.ctx.sessionPersistence.listSnapshots();
    const plugin = b.ctx.sessionPersistence as SessionPersistenceSqlite;
    await plugin.commitRepair(
      { meta: m, inheritedEventCount: SessionLogOffset(0) },
      undefined,
      [],
    );
    expect(await b.ctx.sessionPersistence.listSnapshots()).toEqual(before);
    await b.dispose();
  });

  it("applies the configured busy timeout to every opened connection (default 5000ms)", async () => {
    const path = await freshDbPath();
    const immediate = openDatabase(path, "wal", 0);
    expect(immediate.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    immediate.close();
    const custom = openDatabase(path, "wal", 321);
    expect(custom.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 321 });
    custom.close();
    const defaulted = openDatabase(path, "wal");
    expect(defaulted.prepare("PRAGMA busy_timeout").get()).toEqual({
      timeout: DEFAULT_BUSY_TIMEOUT_MS,
    });
    defaulted.close();
  });

  it("busyTimeout config wires from the plugin into the database connection", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      busyTimeout: 0,
    });
    await ctx.sessionPersistence.list();
    await fiber.dispose();
  });
});

describe("SessionPersistenceSqlite: persist-everything (nothing dropped, nothing renumbered)", () => {
  it("persists chunk deltas and ignorable events verbatim at their exact seqs", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("persist-all");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 8, time: 9, data: { turn: 2 } },
      {
        type: "plugin/telemetry",
        seq: 9,
        time: 10,
        data: { metric: 1 },
        ignorable: true,
      } as unknown as SessionEvent,
      { type: "turn/end", seq: 10, time: 11, data: { turn: 2, reason: { kind: "completed" } } },
    ]);

    // All 11 rows exist: identity seqs (f_sequence == f_original_seq == seq),
    // chunk deltas classified as model output, ignorable marker in f_encoding.
    const probe = openDatabase(path, "wal");
    const rows = probe
      .prepare(`
      SELECT se.f_sequence, e.f_original_seq, e.f_kind, e.f_role, e.f_encoding
      FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id
      WHERE se.f_session_id = ? ORDER BY se.f_sequence
    `)
      .all(m.id) as {
      f_sequence: number;
      f_original_seq: number;
      f_kind: string;
      f_role: string;
      f_encoding: string;
    }[];
    expect(rows).toEqual([
      { f_sequence: 0, f_original_seq: 0, f_kind: "turn/start", f_role: "turn", f_encoding: EVENT_ENCODING },
      { f_sequence: 1, f_original_seq: 1, f_kind: "user/message", f_role: "user", f_encoding: EVENT_ENCODING },
      { f_sequence: 2, f_original_seq: 2, f_kind: "step/start", f_role: "turn", f_encoding: EVENT_ENCODING },
      { f_sequence: 3, f_original_seq: 3, f_kind: "assistant/chunk", f_role: "model", f_encoding: EVENT_ENCODING },
      { f_sequence: 4, f_original_seq: 4, f_kind: "assistant/chunk", f_role: "model", f_encoding: EVENT_ENCODING },
      { f_sequence: 5, f_original_seq: 5, f_kind: "assistant/message", f_role: "model", f_encoding: EVENT_ENCODING },
      { f_sequence: 6, f_original_seq: 6, f_kind: "step/end", f_role: "turn", f_encoding: EVENT_ENCODING },
      { f_sequence: 7, f_original_seq: 7, f_kind: "turn/end", f_role: "turn", f_encoding: EVENT_ENCODING },
      { f_sequence: 8, f_original_seq: 8, f_kind: "turn/start", f_role: "turn", f_encoding: EVENT_ENCODING },
      { f_sequence: 9, f_original_seq: 9, f_kind: "plugin/telemetry", f_role: "", f_encoding: IGNORABLE_EVENT_ENCODING },
      { f_sequence: 10, f_original_seq: 10, f_kind: "turn/end", f_role: "turn", f_encoding: EVENT_ENCODING },
    ]);
    // The head cursor tracks the real seq.
    expect(
      probe.prepare("SELECT f_head_sequence FROM t_sessions WHERE f_session_id = ?").get(m.id),
    ).toEqual({ f_head_sequence: 10 });
    probe.close();

    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "turn/end",
      "turn/start",
      "plugin/telemetry",
      "turn/end",
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The chunk events and the ignorable marker round-trip losslessly.
    const telemetry = loaded.events[9]!;
    expect(telemetry).toMatchObject({ type: "plugin/telemetry", ignorable: true });
    expect(loaded.events[3]!).toMatchObject({
      type: "assistant/chunk",
      data: { chunk: { type: "text-delta", index: 0, text: "he" } },
    });
    await b.dispose();
  });

  it("stores sourceEventSeqs and surfaceOp verbatim (chunk references included)", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("provenance-verbatim");
    await b.ctx.sessionPersistence.create(m);
    // The assistant/message cites the user message AND both chunk deltas.
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());

    const probe = openDatabase(path, "wal");
    const row = probe
      .prepare(
        "SELECT e.f_source_event_seqs AS ses, e.f_surface_op AS op FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND e.f_kind = 'assistant/message'",
      )
      .get(m.id) as { ses: string | null; op: string | null };
    probe.close();
    // Nothing pruned, nothing remapped: the references name REAL seqs (chunks
    // are persisted now), so they replay cleanly.
    expect(JSON.parse(row.ses!)).toEqual([1, 3, 4]);
    expect(JSON.parse(row.op!)).toEqual("append");

    const loaded = await b.ctx.sessionPersistence.load(m.id);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(5);
    expect((assistant as SurfaceEvent).sourceEventSeqs).toEqual([1, 3, 4]);
    expect((assistant as SurfaceEvent).surfaceOp).toBe("append");
    await b.dispose();
  });

  it("a batch containing only delta/ignorable events is a normal materializing append", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("delta-only");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, [
      {
        type: "assistant/chunk",
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "x" } },
      },
      {
        type: "plugin/test",
        seq: 1,
        time: 2,
        data: null,
        ignorable: true,
      } as unknown as SessionEvent,
    ]);
    // The delta-only batch materialized the session with BOTH events at their
    // exact seqs — no no-op, no renumbering.
    expect(await b.ctx.sessionPersistence.list()).toHaveLength(1);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(loaded.events[0]).toMatchObject({ type: "assistant/chunk" });
    expect(loaded.events[1]).toMatchObject({ type: "plugin/test", ignorable: true, data: null });
    // The log continues contiguously at seq 2.
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 2, time: 3, data: { turn: 1 } },
      { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b.ctx.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    await b.dispose();
  });

  it("readFrom returns the suffix with identity seqs", async () => {
    const path = await freshDbPath();
    const b = await backend(path);
    const m = meta("identity-readfrom");
    await b.ctx.sessionPersistence.create(m);
    await b.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    const suffix = await b.ctx.sessionPersistence.readFrom(m.id, 3);
    expect(suffix.events.map((e) => e.type)).toEqual([
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    expect(suffix.events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
    await b.dispose();
  });

  it("an interrupted delta-stream turn keeps its chunks and is closed with synthetic closers on load", async () => {
    const path = await freshDbPath();
    const m = meta("chunk-crash");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    // Turn 1 committed (0..7), then a crashed turn 2 whose streamed chunks are
    // durable but never closed.
    await b1.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    await b1.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 8, time: 9, data: { turn: 2 } },
      {
        type: "assistant/chunk",
        seq: 9,
        time: 10,
        data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "gone" } },
      },
    ]);
    await b1.dispose();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    // The chunks survive; the orphaned turn is closed with turn/end {interrupted}.
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/chunk",
      "assistant/chunk",
      "assistant/message",
      "step/end",
      "turn/end",
      "turn/start",
      "assistant/chunk",
      "turn/end",
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(loaded.events.at(-1)!.type === "turn/end" && loaded.events.at(-1)!.data).toMatchObject({
      reason: { kind: "interrupted" },
    });
    await b2.dispose();
  });

  it("reload + append continues from the persisted seq", async () => {
    const path = await freshDbPath();
    const m = meta("identity-reload");
    const b1 = await backend(path);
    await b1.ctx.sessionPersistence.create(m);
    await b1.ctx.sessionPersistence.append(m.id, chunkedTurnLog());
    await b1.dispose();

    const b2 = await backend(path);
    const loaded = await b2.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Re-create the live session from the loaded log: the store adopts the
    // persisted prefix and the next append continues at seq 8.
    const session = b2.ctx.sessions.create(SessionId(m.id), { seed: loaded.events });
    session.append("turn/start", { turn: 2 });
    session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    await b2.ctx.sessions.flush(session);

    const reloaded = await b2.ctx.sessionPersistence.load(m.id);
    // 0..7 the replay seed, 8 the constructor's end-seed marker, 9..10 the live turn.
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(reloaded.events.map((e) => e.type).slice(8)).toEqual([
      "session/end-seed",
      "turn/start",
      "turn/end",
    ]);
    await b2.dispose();
  });
});

describe("SessionPersistenceSqlite: legacy (rc.2-era) log tolerance", () => {
  // Fabricate the on-disk shape the OLD backend wrote: rows are
  // dense-renumbered (chunk deltas 3,4 dropped), f_original_seq keeps the
  // upstream seq, provenance was pruned at write time, and surface rows carry
  // upstream-space replace ranges.
  function fabricateLegacyLog(
    path: string,
    m: { id: string; version: number; createdAt: number; cwd?: string },
    rows: Array<{ seq: number; orig: number; kind: string; data: unknown; ses?: number[] }>,
    seedLength: number | null,
  ): void {
    const db = openDatabase(path, "wal");
    // The sessions row must exist BEFORE bridge rows (FK enforcement) — the
    // write path materializes the row and its events in ONE transaction, so a
    // fabricated legacy log is written in the same order.
    insertSessionRow(db, {
      fSessionId: m.id,
      fHeadEventId: "",
      fHeadSequence: -1,
      fVersion: m.version,
      fCreatedAt: m.createdAt,
      fCwd: m.cwd ?? null,
      fSeedLength: seedLength,
    });
    let parent = "";
    let head: { fEventId: string; fSequence: number } | undefined;
    for (const row of rows) {
      parent = insertEventRow(db, m.id, row.seq, row.kind, row.data, parent, {
        originalSeq: row.orig,
        surfaceSeqs: row.ses === undefined || row.ses.length === 0 ? null : JSON.stringify(row.ses),
        surfaceOp: row.ses === undefined ? null : JSON.stringify("append"),
      });
      head = { fEventId: parent, fSequence: row.seq };
    }
    if (head !== undefined) {
      db.prepare("UPDATE t_sessions SET f_head_event_id = ?, f_head_sequence = ? WHERE f_session_id = ?").run(
        head.fEventId,
        head.fSequence,
        m.id,
      );
    }
    db.close();
  }

  const legacyUser = {
    id: "legacy-user",
    role: "user",
    content: [{ type: "text", text: "hi" }],
    source: { kind: "user" },
  };

  it("loads a dense-renumbered log through the legacy remap path and continues it", async () => {
    const path = await freshDbPath();
    const m = meta("legacy-load", "/legacy");
    // Upstream log 0..7 with chunk deltas 3,4 dropped at write time; the old
    // backend pruned the assistant/message provenance down to [1].
    fabricateLegacyLog(
      path,
      m,
      [
        { seq: 0, orig: 0, kind: "turn/start", data: { turn: 1 } },
        { seq: 1, orig: 1, kind: "user/message", data: legacyUser, ses: [] },
        { seq: 2, orig: 2, kind: "step/start", data: { turn: 1, step: 1 } },
        {
          seq: 3,
          orig: 5,
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
          ses: [1],
        },
        { seq: 4, orig: 6, kind: "step/end", data: { turn: 1, step: 1 } },
        { seq: 5, orig: 7, kind: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      ],
      null,
    );

    const b = await backend(path);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    // Presented densely with provenance remapped into the dense space.
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    expect(loaded.meta.isSeeded).toBe(false);
    expect(loaded.inheritedEventCount).toBe(0);
    const assistant = loaded.events.find((e) => e.type === "assistant/message")!;
    expect(assistant.seq).toBe(3);
    expect((assistant as SurfaceEvent).sourceEventSeqs).toEqual([1]);

    // A suffix read maps through the same legacy space.
    const suffix = await b.ctx.sessionPersistence.readFrom(m.id, 3);
    expect(suffix.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(suffix.events[0]).toMatchObject({ type: "assistant/message" });
    expect(suffix.inheritedEventCount).toBe(0);

    // Continuation rows written by THIS build are identity rows inside the
    // same log; reads keep presenting a coherent dense log.
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 6, time: 9, data: { turn: 2 } },
      { type: "turn/end", seq: 7, time: 10, data: { turn: 2, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b.ctx.sessionPersistence.load(m.id);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const probe = openDatabase(path, "wal");
    const newest = probe
      .prepare(
        "SELECT e.f_original_seq FROM t_session_events se JOIN t_events e ON se.f_event_id = e.f_event_id WHERE se.f_session_id = ? AND se.f_sequence = 7",
      )
      .get(m.id) as { f_original_seq: number };
    probe.close();
    expect(newest.f_original_seq).toBe(7); // identity row
    await b.dispose();
  });

  it("derives isSeeded and the dense inherited cut of a legacy fork child", async () => {
    const path = await freshDbPath();
    const m = meta("legacy-seeded", "/legacy");
    // A legacy fork child: its 3-event seed (upstream cut 3) had no drops, so
    // the first three rows are identity; its own chunked turn lost upstream
    // seqs 6,7 at write time and starts at dense seq 3.
    fabricateLegacyLog(
      path,
      m,
      [
        { seq: 0, orig: 0, kind: "turn/start", data: { turn: 1 } },
        { seq: 1, orig: 1, kind: "user/message", data: legacyUser, ses: [] },
        { seq: 2, orig: 2, kind: "step/start", data: { turn: 1, step: 1 } },
        { seq: 3, orig: 3, kind: "turn/start", data: { turn: 2 } },
        { seq: 4, orig: 4, kind: "user/message", data: legacyUser, ses: [] },
        { seq: 5, orig: 5, kind: "step/start", data: { turn: 2, step: 1 } },
        {
          seq: 6,
          orig: 8,
          kind: "assistant/message",
          data: {
            turn: 2,
            step: 1,
            message: {
              id: "legacy-child-assistant",
              role: "assistant",
              content: [{ type: "text", text: "hi again" }],
              source: { kind: "model", provider: "mock", model: "mock" },
            },
          },
          ses: [],
        },
        { seq: 7, orig: 9, kind: "step/end", data: { turn: 2, step: 1 } },
        { seq: 8, orig: 10, kind: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
      ],
      3, // stored upstream-space cut (the child inherited 3 events)
    );

    const b = await backend(path);
    const inspection = await b.ctx.sessionPersistence.inspect(m.id);
    // The header marks the lineage; the cut is translated to the DENSE count
    // of the inherited prefix (3 identity rows here).
    expect(inspection.meta.isSeeded).toBe(true);
    expect(inspection.inheritedEventCount).toBe(3);
    expect(inspection.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // The durable cut is not part of the header (no seedLength field).
    expect(inspection.meta).not.toHaveProperty("seedLength");

    // The derived cut is stable across later appends (the stored upstream cut
    // is never rewritten by conflict updates).
    await b.ctx.sessionPersistence.append(m.id, [
      { type: "turn/start", seq: 9, time: 20, data: { turn: 3 } },
      { type: "turn/end", seq: 10, time: 21, data: { turn: 3, reason: { kind: "completed" } } },
    ]);
    const reloaded = await b.ctx.sessionPersistence.load(m.id);
    expect(reloaded.inheritedEventCount).toBe(3);
    expect(reloaded.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const probe = openDatabase(path, "wal");
    expect(
      probe.prepare("SELECT f_seed_length FROM t_sessions WHERE f_session_id = ?").get(m.id),
    ).toEqual({ f_seed_length: 3 });
    probe.close();
    await b.dispose();
  });

  it("repairs a legacy log's interrupted turn with dense-space closers", async () => {
    const path = await freshDbPath();
    const m = meta("legacy-crash", "/legacy");
    // A chunked turn whose tail (chunks + step/end + turn/end) was never
    // committed: only turn/start + user/message survive in the row space.
    fabricateLegacyLog(
      path,
      m,
      [
        { seq: 0, orig: 0, kind: "turn/start", data: { turn: 1 } },
        { seq: 1, orig: 1, kind: "user/message", data: legacyUser, ses: [] },
      ],
      null,
    );

    const b = await backend(path);
    const loaded = await b.ctx.sessionPersistence.load(m.id);
    expect(loaded.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "turn/end",
    ]);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(loaded.events.at(-1)!.type === "turn/end" && loaded.events.at(-1)!.data).toMatchObject({
      reason: { kind: "interrupted" },
    });
    await b.dispose();
  });
});

describe("SessionPersistenceSqlite: edge cases", () => {
  it("rejects and closes a current-schema database with an invalid store identity", async () => {
    const path = await freshDbPath();
    const db = openDatabase(path, "wal");
    db.exec("UPDATE t_persistence_state SET f_store_id = '' WHERE f_singleton = 1");
    db.close();

    const b = await backend(path);
    await expect(b.ctx.sessionPersistence.listSnapshots()).rejects.toThrow(
      /no valid store identity/,
    );
    await expect(b.dispose()).resolves.toBeUndefined();
  });

  it("creates a new database and WAL sidecars with owner-only modes without changing its parent mode", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    const dir = dirname(path);
    await chmod(dir, 0o755);

    const b = await backend(path);
    await b.ctx.sessionPersistence.list();

    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600);
    await b.dispose();
  });

  it("creates a persistent rollback journal with owner-only mode", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      journalMode: "persist",
    });
    const m = meta("persist-permissions");

    await ctx.sessionPersistence.create(m);
    await ctx.sessionPersistence.append(m.id, oneTurnLog());

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}-journal`)).mode & 0o777).toBe(0o600);
    await fiber.dispose();
  });

  it("preserves the mode of an existing database file", async () => {
    if (process.platform === "win32") return;
    const path = await freshDbPath();
    await writeFile(path, "", { mode: 0o644 });
    await chmod(path, 0o644);

    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path,
      journalMode: "delete",
    });
    await ctx.sessionPersistence.list();

    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await fiber.dispose();
  });

  it("journalMode config reaches the database (default wal, rollback modes selectable)", async () => {
    const walPath = await freshDbPath();
    const bWal = await backend(walPath);
    await bWal.ctx.sessionPersistence.create(meta("jm-wal"));
    const probe = openDatabase(walPath, "wal");
    expect(
      (probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    probe.close();
    await bWal.dispose();

    const deletePath = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, {
      type: "sqlite",
      path: deletePath,
      journalMode: "delete",
    });
    await ctx.sessionPersistence.create(meta("jm-delete"));
    const db = openDatabase(deletePath, "delete");
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "delete",
    );
    db.close();
    expect(existsSync(`${deletePath}-wal`)).toBe(false);
    await fiber.dispose();
  });

  it("HMR: a DIFFERENT session colliding with a materialized on-disk id is rejected", async () => {
    const path = await freshDbPath();
    // Instance 1 materializes a session and disposes.
    const b1 = await backend(path);
    const s1 = b1.ctx.sessions.create(SessionId("hmr-collide"));
    appendLog(s1, oneTurnLog());
    await b1.ctx.sessions.flush(s1);
    await b1.dispose();

    // A fresh context with an UNRELATED live session reusing the id meets a
    // materialized row that is NOT a prefix of its events → reject.
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    let session!: Session;
    await ctx.plugin(
      Object.assign(
        (inner: Context) => {
          session = inner.sessions.create(SessionId("hmr-collide"));
        },
        { inject: ["sessions"] },
      ),
    );
    session.append("turn/start", { turn: 1 });
    await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path });
    await expectFlushError(ctx.sessions.flush(session), /id collision/);
    await ctx.fiber.dispose();
  });
});

describe("surface field round-trip", () => {
  it("scanRows with surface columns reconstructs events with surface fields", () => {
    const rows: EventRow[] = [
      {
        fSequence: 0,
        fOriginalSeq: 0,
        fKind: "user/message",
        fCreatedAt: 1,
        fData: JSON.stringify({
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
        fEncoding: EVENT_ENCODING,
        fSourceEventSeqs: null,
        fSurfaceOp: JSON.stringify({ op: "replace", start: 0, end: 0 }),
      },
      {
        fSequence: 1,
        fOriginalSeq: 1,
        fKind: "turn/end",
        fCreatedAt: 2,
        fData: JSON.stringify({ turn: 1, reason: { kind: "completed" } }),
        fEncoding: EVENT_ENCODING,
        fSourceEventSeqs: null,
        fSurfaceOp: null,
      },
    ];
    const { preserved } = scanRows(rows);
    expect(preserved).toHaveLength(2);
    expect((preserved[0]! as SurfaceEvent).surfaceOp).toEqual({ op: "replace", start: 0, end: 0 });
    expect((preserved[0]! as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    expect((preserved[1] as SessionEvent<SurfaceEventType>).surfaceOp).toBeUndefined();
  });

  it("append and load round-trips surface fields through SQLite", async () => {
    const ctx = new Context();
    await ctx.plugin(EmptySettings);
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { type: "sqlite", path: ":memory:" });
    const session = ctx.sessions.create(SessionId("roundtrip-surface"));
    session.append("turn/start", { turn: 1 });
    session.append("step/start", { turn: 1, step: 1 });
    session.append(
      "user/message",
      createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: createMessage({
          role: "assistant",
          content: [],
          source: { kind: "model", provider: "mock", model: "mock" },
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [2] },
    );
    session.append("step/end", { turn: 1, step: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessions.flush(session);
    const loaded = await ctx.sessionPersistence.load(SessionId("roundtrip-surface"));
    expect(loaded.events).toHaveLength(6);
    const um = loaded.events[2]!;
    expect((um as SurfaceEvent).surfaceOp).toBe("append");
    expect((um as SurfaceEvent).sourceEventSeqs).toBeUndefined();
    const am = loaded.events[3]!;
    expect((am as SurfaceEvent).surfaceOp).toBe("append");
    expect((am as SurfaceEvent).sourceEventSeqs).toEqual([2]);
    await fiber.dispose();
  });
});

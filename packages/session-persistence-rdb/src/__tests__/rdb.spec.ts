/**
 * SQLite-specific behaviour of the RDB session-persistence backend: the
 * dialect-free row conversion unit tests, the on-disk schema/pragma contract,
 * the file-permission guarantees, and the two shared suites
 * (`runPersistenceContract`, `runAgentLoopContract`) mounted on a real SQLite
 * database (file-backed, so the raw-store hooks can fabricate released-format
 * logs and torn tails exactly as an old build left them).
 */
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, afterEach } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { MessageId, ToolCallId, createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionPersistenceRdb, { SCHEMA_VERSION } from "../index.ts";
import {
  buildSeqMap,
  currentSurfaceOp,
  hasLegacyRenumbering,
  releasedSurfaceOp,
  remapReleasedData,
  rowToReleasedRow,
  scanRows,
  sessionConflictRow,
  sessionRewriteRow,
  storedInheritedCount,
  type ReleasedRow,
} from "../log.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  EVENT_ENCODING,
  IGNORABLE_EVENT_ENCODING,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  eventDimensions,
} from "../schema.ts";
import type { EventRow, SessionRow } from "../backend.ts";

/**
 * Classify one event fixture through {@link eventDimensions}. Surface metadata
 * is irrelevant to the playpen classification, so partial fixtures are lifted
 * here instead of being spelled with their required markers.
 */
function dims(event: Record<string, unknown>): { role: string; name: string; actionId: string } {
  return eventDimensions(event as unknown as SessionEvent);
}
import { openDatabase } from "../sqlite.ts";
import { runPersistenceContract, meta } from "./testing/contract.ts";
import { runAgentLoopContract, type AgentLoopFixture } from "./testing/agent-loop.ts";
import { createSqliteRawStore } from "./testing/sqlite-raw.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-"));
  dirs.push(dir);
  return dir;
}

async function freshDbPath(): Promise<string> {
  return join(await freshDir(), "sessions.db");
}

/** A context with the session store + SQLite backend on a fresh database. */
async function backend(
  path = ":memory:",
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

// --- the two shared suites, mounted on real SQLite databases ---------------

runPersistenceContract("sqlite", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: ":memory:" });
  return {
    ctx,
    persistence: ctx.sessionPersistence,
    dispose: async () => {
      await fiber.dispose();
    },
  };
});

/**
 * File-backed fixture for the agent-loop suite. `raw` writes rows with raw SQL
 * (bypassing the write path) so released-format logs and torn tails can be
 * fabricated exactly as an older build left them.
 */
runAgentLoopContract("sqlite", async (): Promise<AgentLoopFixture> => {
  const dir = await freshDir();
  const path = join(dir, "sessions.db");
  return {
    context: async () => {
      const ctx = new Context();
      await ctx.plugin(SessionStore);
      return ctx;
    },
    mount: async (ctx) => {
      const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
      return { dispose: () => fiber.dispose() };
    },
    raw: createSqliteRawStore(path),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

// --- dialect-free row conversion -------------------------------------------

/** Build {@link EventRow}s from events so the unit tests read in event terms. */
function eventRows(events: SessionEvent[]): EventRow[] {
  return events.map((event) => {
    const surface = event as SessionEvent & {
      sourceEventSeqs?: number[];
      surfaceOp?: unknown;
    };
    return {
      fSequence: event.seq,
      fOriginalSeq: event.seq,
      fKind: event.type,
      fCreatedAt: event.time,
      fData: JSON.stringify(event.data),
      fEncoding: event.ignorable === true ? IGNORABLE_EVENT_ENCODING : EVENT_ENCODING,
      fSourceEventSeqs:
        surface.sourceEventSeqs === undefined ? null : JSON.stringify(surface.sourceEventSeqs),
      fSurfaceOp: surface.surfaceOp === undefined ? null : JSON.stringify(surface.surfaceOp),
    };
  });
}

function oneTurn(): SessionEvent[] {
  return [
    { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: "step/start", seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(2),
      time: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

describe("SessionPersistenceRdb: loader-entry configuration", () => {
  /**
   * The 0.2 settings service is `SettingsForms`: a form editor over
   * loader-entry config. It has no `register`, so a backend must not reach for
   * one — this stand-in is the exact shape whose presence used to kill the
   * constructor with `settings.register is not a function` and take seven
   * suites down with it.
   */
  it("activates beside 0.2's SettingsForms service, taking its config from its own entry", async () => {
    let configured = 0;
    const settingsForms = { configure: () => void configured++ };
    const ctx = new Context();
    ctx.provide("settings", settingsForms);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: ":memory:" });
    const persistence = ctx.sessionPersistence as SessionPersistenceRdb;
    expect(persistence).toBeInstanceOf(SessionPersistenceRdb);
    // The entry config (with the schema defaults) is the whole configuration.
    expect(persistence.config).toEqual({
      type: "sqlite",
      path: ":memory:",
      journalMode: "wal",
      busyTimeout: DEFAULT_BUSY_TIMEOUT_MS,
    });
    expect(configured).toBe(0);
  });
});

describe("scanRows", () => {
  it("preserves the full log when it ends exactly on a turn/end (no torn tail)", () => {
    const rows = eventRows(oneTurn());
    const { preserved, tornFrom } = scanRows(rows);
    expect(preserved.map((r) => r.fSequence)).toEqual([0, 1, 2]);
    expect(tornFrom).toBeUndefined();
  });

  it("PRESERVES the real events of an interrupted turn after the last turn/end", () => {
    const rows = eventRows([
      ...oneTurn(),
      { type: "turn/start", seq: SessionSeq(3), time: 4, data: { turn: 2 } },
    ]);
    const { preserved, tornFrom } = scanRows(rows);
    expect(preserved.map((r) => r.fSequence)).toEqual([0, 1, 2, 3]);
    expect(tornFrom).toBeUndefined();
  });

  it("preserves the contiguous prefix and flags a torn tail at a seq gap", () => {
    const rows = eventRows(oneTurn());
    rows.push({ ...rows[0]!, fSequence: 4, fOriginalSeq: 4 }); // seq 3 missing
    const { preserved, tornFrom } = scanRows(rows);
    expect(preserved.map((r) => r.fSequence)).toEqual([0, 1, 2]);
    expect(tornFrom).toBe(3);
  });

  it("an empty log preserves nothing and has no torn tail", () => {
    expect(scanRows([])).toEqual({ preserved: [] });
  });

  it("throws on a seq gap inside the committed region (before the last turn/end)", () => {
    const rows = eventRows(oneTurn());
    rows.splice(1, 1); // drop step/start → the last turn/end is now before the hole
    expect(() => scanRows(rows)).toThrow(/seq gap in committed region/);
  });

  it("throws on an unparsable row inside the committed region", () => {
    const rows = eventRows(oneTurn());
    rows[0]!.fData = "{not json";
    expect(() => scanRows(rows)).toThrow(/unparsable committed event/);
  });

  it("tolerates an unparsable torn-tail row after the last turn/end", () => {
    const rows = eventRows([
      ...oneTurn(),
      { type: "turn/start", seq: SessionSeq(3), time: 4, data: { turn: 2 } },
    ]);
    rows[3]!.fData = "{not json";
    const { preserved, tornFrom } = scanRows(rows);
    expect(preserved.map((r) => r.fSequence)).toEqual([0, 1, 2]);
    expect(tornFrom).toBe(3);
  });
});

describe("legacy renumbering helpers", () => {
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

  it("uses the stored cut verbatim on identity logs", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ fSequence: i, fOriginalSeq: i }));
    expect(storedInheritedCount(null, rows, false)).toBe(0);
    expect(storedInheritedCount(3, rows, false)).toBe(3);
  });

  it("translates a legacy log's upstream-space cut into the presented row count", () => {
    // Legacy seed: upstream seqs 0..5 with chunk deltas 3,4 dropped → 4 rows;
    // the child's own turn continues at presented 4 with upstream seqs >= 6.
    const rows = [
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 1 },
      { fSequence: 2, fOriginalSeq: 2 },
      { fSequence: 3, fOriginalSeq: 5 },
      { fSequence: 4, fOriginalSeq: 6 },
      { fSequence: 5, fOriginalSeq: 8 },
    ];
    expect(storedInheritedCount(6, rows, true)).toBe(4);
    expect(storedInheritedCount(6, rows, false)).toBe(6);
    expect(storedInheritedCount(null, rows, true)).toBe(0);
  });

  it("maps upstream seqs to presented seqs, first occurrence winning", () => {
    const map = buildSeqMap([
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 4 },
      { fSequence: 2, fOriginalSeq: 5 },
    ]);
    expect(map.get(0)).toBe(0);
    expect(map.get(4)).toBe(1);
    expect(map.get(5)).toBe(2);
    // After resume the new segment's upstream seqs overlap the seed space; a
    // seed-segment reference must resolve to the seed-space row.
    const overlapping = buildSeqMap([
      { fSequence: 0, fOriginalSeq: 0 },
      { fSequence: 1, fOriginalSeq: 100 },
      { fSequence: 2, fOriginalSeq: 101 },
      { fSequence: 3, fOriginalSeq: 3 },
      { fSequence: 4, fOriginalSeq: 100 },
    ]);
    expect(overlapping.get(100)).toBe(1);
  });
});

describe("surface-op projection", () => {
  it("keeps append untouched in both directions", () => {
    expect(
      releasedSurfaceOp("append", () => {
        throw new Error("append must not remap");
      }),
    ).toBe("append");
    expect(currentSurfaceOp("append")).toBe("append");
  });

  it("projects a stored replace op into the released-v0 spelling with remapped seqs", () => {
    expect(releasedSurfaceOp({ op: "replace", start: 2, end: 4 }, (seq) => seq * 10)).toEqual({
      op: "replace",
      start: 20,
      end: 40,
    });
    // A current-spelling marker read back through the released projection is
    // still translated (a mixed log stays readable).
    expect(
      releasedSurfaceOp({ op: "replace", startSeq: 1, endSeq: 2 }, (seq) => seq + 1),
    ).toEqual({ op: "replace", start: 2, end: 3 });
  });

  it("normalizes a stored replace op into the CURRENT spelling (never a stale marker)", () => {
    expect(currentSurfaceOp({ op: "replace", start: 2, end: 4 })).toEqual({
      op: "replace",
      startSeq: 2,
      endSeq: 4,
    });
    expect(currentSurfaceOp({ op: "replace", startSeq: 2, endSeq: 4 })).toEqual({
      op: "replace",
      startSeq: 2,
      endSeq: 4,
    });
  });
});

describe("remapReleasedData", () => {
  it("remaps compaction shadow references", () => {
    const summary: Record<string, unknown> = {
      turn: 1,
      summary: "…",
      shadowedRange: { start: 15, end: 398_881 },
      shadowedSeqs: [15, 398_881],
      shadowedTokenCount: 12,
    };
    remapReleasedData("compaction/summary", summary, (seq) => (seq === 398_881 ? 4048 : seq));
    expect(summary["shadowedRange"]).toEqual({ start: 15, end: 4048 });
    expect(summary["shadowedSeqs"]).toEqual([15, 4048]);
    expect(summary["shadowedTokenCount"]).toBe(12);
  });

  it("remaps title message seqs and a command/done source seq", () => {
    const title: Record<string, unknown> = { title: "t", messageSeqs: [7, 9], source: { kind: "llm" } };
    remapReleasedData("session/title", title, (seq) => seq - 1);
    expect(title["messageSeqs"]).toEqual([6, 8]);
    const command: Record<string, unknown> = { commandId: "c", kind: "success", sourceEventSeq: 4 };
    remapReleasedData("command/done", command, (seq) => seq + 10);
    expect(command["sourceEventSeq"]).toBe(14);
  });

  it("leaves non-record payloads untouched", () => {
    expect(() => remapReleasedData("plugin/x", null, (seq) => seq)).not.toThrow();
  });
});

describe("rowToReleasedRow", () => {
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

  it("parses surface fields into the released row shape", () => {
    const released = rowToReleasedRow(
      row({
        fKind: "user/message",
        fData: JSON.stringify({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
        fSourceEventSeqs: JSON.stringify([3, 5]),
        fSurfaceOp: JSON.stringify("append"),
      }),
    );
    expect(released.seq).toBe(0);
    expect(released.sourceEventSeqs).toEqual([3, 5]);
    expect(released.surfaceOp).toBe("append");
    expect(released.ignorable).toBeUndefined();
  });

  it("projects a stored replace op into the released-v0 spelling", () => {
    const released = rowToReleasedRow(
      row({
        fSequence: 9,
        fOriginalSeq: 30,
        fKind: "tool/result",
        fData: JSON.stringify({ turn: 1, step: 1, message: { source: { kind: "tool", callId: "c" }, content: [] } }),
        fSourceEventSeqs: JSON.stringify([2]),
        fSurfaceOp: JSON.stringify({ op: "replace", start: 2, end: 2 }),
      }),
      (seq) => (seq === 2 ? 5 : seq === 30 ? 9 : seq),
    );
    expect(released.sourceEventSeqs).toEqual([5]);
    expect(released.surfaceOp).toEqual({ op: "replace", start: 5, end: 5 });
  });

  it("uses the current spelling when the current projection is selected", () => {
    const released = rowToReleasedRow(
      row({
        fSurfaceOp: JSON.stringify({ op: "replace", start: 1, end: 2 }),
      }),
      undefined,
      currentSurfaceOp,
    );
    expect(released.surfaceOp).toEqual({ op: "replace", startSeq: 1, endSeq: 2 });
  });

  it("restores the ignorable envelope marker from the ignorable encoding", () => {
    const released = rowToReleasedRow(
      row({ fKind: "plugin/telemetry", fEncoding: IGNORABLE_EVENT_ENCODING, fData: "null" }),
    );
    expect(released).toMatchObject({ type: "plugin/telemetry", ignorable: true, data: null });
  });

  it("omits an empty source set (stored NULL by the write path)", () => {
    const released = rowToReleasedRow(
      row({ fSourceEventSeqs: JSON.stringify([]) }),
    );
    expect(released.sourceEventSeqs).toBeUndefined();
    expect(released as ReleasedRow).not.toHaveProperty("sourceEventSeqs");
  });
});

describe("session row projections", () => {
  const header: SessionHeader = {
    version: 3,
    id: SessionId("s"),
    createdAt: 5,
    isSeeded: true,
    cwd: "/w",
    delegationDepth: 2,
  };

  it("stores the cut only for a seeded header and preserves it on conflict", () => {
    expect(sessionConflictRow(header)).not.toHaveProperty("fSeedLength");
    // The ordinary conflict update never rewrites the cut …
    expect(sessionRewriteRow(header, 4).fSeedLength).toBe(4);
    // … while the format migration deliberately does.
    expect(sessionRewriteRow({ ...header, isSeeded: false }, 0).fSeedLength).toBeNull();
  });
});

describe("eventDimensions", () => {
  it("classifies boundary events as turn role", () => {
    expect(dims({ type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } })).toEqual({
      role: "turn",
      name: "",
      actionId: "",
    });
  });

  it("classifies messages, system prompts, and attempt settlements", () => {
    expect(
      dims({
        type: "user/message",
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({
          content: [{ type: "text", text: "hi" }],
          source: { kind: "user" },
        }),
      }).role,
    ).toBe("user");
    expect(
      dims({
        type: "system/message",
        seq: SessionSeq(2),
        time: 3,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "system",
            content: [],
            source: { kind: "plugin", plugin: "mock" },
          }),
        },
      }).role,
    ).toBe("system");
    expect(
      dims({
        type: "assistant/message",
        seq: SessionSeq(3),
        time: 4,
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: createMessage({
            role: "assistant",
            content: [],
            source: { kind: "model", provider: "mock", model: "mock" },
          }),
        },
      }).role,
    ).toBe("model");
    expect(
      dims({
        type: "assistant/attempt",
        seq: SessionSeq(4),
        time: 5,
        data: { turn: 1, step: 1, stream: [] },
      }),
    ).toEqual({ role: "model", name: "", actionId: "" });
  });

  it("extracts the function name and call id from tool/call and tool/result", () => {
    expect(
      dims({
        type: "tool/call",
        seq: SessionSeq(5),
        time: 6,
        data: { turn: 1, step: 1, callId: ToolCallId("call-1"), name: "read", arguments: "{}" },
      }),
    ).toEqual({ role: "function", name: "read", actionId: "call-1" });
    const callId = ToolCallId("call-2");
    expect(
      dims({
        type: "tool/result",
        seq: SessionSeq(6),
        time: 7,
        data: {
          turn: 1,
          step: 1,
          message: createMessage({
            role: "user",
            content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
            source: { kind: "tool", callId },
          }),
        },
      }),
    ).toEqual({ role: "function", name: "", actionId: "call-2" });
  });

  it("keeps playpen defaults (and the plugin-merged todo classification)", () => {
    expect(
      dims({
        type: "plugin/custom",
        seq: SessionSeq(0),
        time: 1,
        data: {},
      } as unknown as SessionEvent),
    ).toEqual({ role: "", name: "", actionId: "" });
    expect(
      dims({
        type: "todo/write",
        seq: SessionSeq(1),
        time: 2,
        data: { todos: [] },
      } as unknown as SessionEvent),
    ).toEqual({ role: "state", name: "todos", actionId: "" });
  });
});

// --- on-disk schema ---------------------------------------------------------

describe("SessionPersistenceSqlite: database schema and lifecycle", () => {
  it("has no independent per-session log location (the database is the artifact)", async () => {
    const path = await freshDbPath();
    const { ctx, dispose } = await backend(path);
    const handle = await ctx.sessionPersistence.create(meta("sqlite-location"));
    await handle.append(oneTurn());
    await handle.close();
    // A format refusal names the database; `locate` is not a public seam member
    // any more, so the pointer is asserted through a refusal message instead.
    await expect(
      ctx.sessionPersistence.open(SessionId("missing"), "read"),
    ).rejects.toThrow(/not found/i);
    await dispose();
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

  it("adds the child-discovery index to an existing database without a schema bump", async () => {
    // The v3→v4 migration discovers children by
    // `(f_parent_session, f_origin)`; the index is the ONLY DDL the migration
    // needs, and it must arrive idempotently on an existing v1 store.
    expect(SCHEMA_VERSION).toBe(1);
    const path = await freshDbPath();
    openDatabase(path, "wal").close();
    const preexisting = new DatabaseSync(path);
    preexisting.exec('DROP INDEX IF EXISTS "ix_sessions_subagent_parent"');
    preexisting.close();

    const b = await backend(path);
    await b.ctx.sessionPersistence.list();
    await b.dispose();

    const after = new DatabaseSync(path);
    expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(
      after
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_sessions_subagent_parent'",
        )
        .get(),
    ).toEqual({ name: "ix_sessions_subagent_parent" });
    expect(
      after
        .prepare('PRAGMA index_info("ix_sessions_subagent_parent")')
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(["f_parent_session", "f_origin"]);
    after.close();
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
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceRdb, {
      type: "sqlite",
      path,
      busyTimeout: 0,
    });
    await ctx.sessionPersistence.list();
    await fiber.dispose();
  });

  it("rejects and closes a current-schema database with an invalid store identity", async () => {
    const path = await freshDbPath();
    const db = openDatabase(path, "wal");
    db.exec("UPDATE t_persistence_state SET f_store_id = '' WHERE f_singleton = 1");
    db.close();

    const b = await backend(path);
    await expect(b.ctx.sessionPersistence.list()).rejects.toThrow(/no valid store identity/);
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
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceRdb, {
      type: "sqlite",
      path,
      journalMode: "persist",
    });
    const handle = await ctx.sessionPersistence.create(meta("persist-permissions"));
    await handle.append(oneTurn());
    await handle.close();

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
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceRdb, {
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
    const wal = await backend(walPath);
    const walHandle = await wal.ctx.sessionPersistence.create(meta("jm-wal"));
    await walHandle.append(oneTurn());
    await walHandle.close();
    const probe = openDatabase(walPath, "wal");
    expect(
      (probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("wal");
    probe.close();
    await wal.dispose();

    const deletePath = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    const fiber = await ctx.plugin(SessionPersistenceRdb, {
      type: "sqlite",
      path: deletePath,
      journalMode: "delete",
    });
    const handle = await ctx.sessionPersistence.create(meta("jm-delete"));
    await handle.append(oneTurn());
    await handle.close();
    const db = openDatabase(deletePath, "delete");
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "delete",
    );
    db.close();
    expect(existsSync(`${deletePath}-wal`)).toBe(false);
    await fiber.dispose();
  });

  it("source-qualifies revisions across stores while preserving same-file reopen identity", async () => {
    const pathA = await freshDbPath();
    const pathB = await freshDbPath();
    const m = meta("revision-source");
    const a = await backend(pathA);
    const aHandle = await a.ctx.sessionPersistence.create(m);
    await aHandle.append(oneTurn());
    await aHandle.close();
    const revisionA = (await a.ctx.sessionPersistence.stat(m.id))?.revision;
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
    expect((await reopenedA.ctx.sessionPersistence.stat(m.id))?.revision).toBe(revisionA);
    await reopenedA.dispose();

    const b = await backend(pathB);
    const bHandle = await b.ctx.sessionPersistence.create(m);
    await bHandle.append(oneTurn());
    await bHandle.close();
    const revisionB = (await b.ctx.sessionPersistence.stat(m.id))?.revision;
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
    const firstHandle = await first.ctx.sessionPersistence.create(m);
    await firstHandle.append(oneTurn());
    await firstHandle.close();
    const before = (await first.ctx.sessionPersistence.stat(m.id))?.revision;
    await first.dispose();

    const cleanup = openDatabase(path, "wal");
    cleanup.prepare("DELETE FROM t_sessions WHERE f_session_id = ?").run(m.id);
    cleanup.close();

    const second = await backend(path);
    const secondHandle = await second.ctx.sessionPersistence.create(m);
    await secondHandle.append(oneTurn());
    await secondHandle.close();
    const after = (await second.ctx.sessionPersistence.stat(m.id))?.revision;
    expect(after).not.toBe(before);
    expect(String(before)).toMatch(/:revision:1$/);
    expect(String(after)).toMatch(/:revision:1$/);
    await second.dispose();
  });

  it("round-trips an interrupted turn through separate instances", async () => {
    const path = await freshDbPath();
    const m = meta("persist-interrupted");
    const b1 = await backend(path);
    const handle = await b1.ctx.sessionPersistence.create(m);
    await handle.append(oneTurn());
    await handle.close();
    await b1.dispose();

    const b2 = await backend(path);
    const reader = await b2.ctx.sessionPersistence.open(m.id, "read");
    expect((await reader.read(0)).events).toEqual(oneTurn());
    await reader.close();
    expect((await b2.ctx.sessionPersistence.list()).map((s) => s.header.id)).toContain(m.id);
    await b2.dispose();
  });

  it("HMR: reloading the backend leaves a still-live session's log readable and continuable", async () => {
    const path = await freshDbPath();
    const ctx = new Context();
    await ctx.plugin(SessionStore);
    const first = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
    const session = ctx.sessions.create(SessionId("hmr-reload"));
    const handle = await ctx.sessionPersistence.create(session.header);
    session.append("turn/start", { turn: 1 });
    session.append("step/start", { turn: 1, step: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessions.flush(session);
    await handle.close();
    await first.dispose();
    // A second backend on the same file (the HMR reload) sees a complete,
    // closed turn and can take write ownership.
    const second = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
    const writer = await ctx.sessionPersistence.open(session.id, "write");
    expect((await writer.read(0)).events.map((e) => e.type)).toEqual([
      "turn/start",
      "step/start",
      "turn/end",
    ]);
    await writer.close();
    await second.dispose();
    await ctx.fiber.dispose();
  });
});

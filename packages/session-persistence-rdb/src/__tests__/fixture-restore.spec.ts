/**
 * Regression guard for the committed v3 golden fixture
 * (`tests/fixtures/v3-golden.sql`).
 *
 * The fixture is a database the 0.1.5 build actually wrote — the LAST build
 * that can produce DSH session format v3. It is loaded into a fresh SQLite
 * file and served through the package's own plugin, so this suite fails loudly
 * the moment a change breaks v3 reads (most importantly: the 0.2.x v4 work,
 * whose migration edge consumes exactly these three sessions' facts).
 *
 * The four facts the v3→v4 migration needs, all asserted here:
 *   - `parent-1` holds the `subagent/catalog` discovery event;
 *   - `child-1`'s header carries `origin: 'subagent'` + `parentSession` +
 *     `delegationDepth` + `createdAt`, and its own log holds the
 *     `subagent/descriptor` event;
 *   - `plain-2` is childless — the migration's mandatory empty-array arm.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/fixture-restore
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import SessionPersistenceRdb from "../index.ts";
import { oneTurnLog } from "./testing/contract.ts";

/** The committed golden database, as portable SQL. */
const FIXTURE = new URL("../../tests/fixtures/v3-golden.sql", import.meta.url);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Apply the fixture SQL to a fresh temp database and return its path. */
async function loadFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v3-fixture-"));
  dirs.push(dir);
  const path = join(dir, "sessions.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(await readFile(FIXTURE, "utf8"));
    // The dump must be self-sufficient: identity pragmas and schema.
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("PRAGMA application_id").get()).toEqual({ application_id: 0x44534850 });
  } finally {
    db.close();
  }
  return path;
}

/** Mount the package plugin over one database path. */
async function mount(
  path: string,
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

/** Read a whole stored log through a fresh read handle. */
async function readSession(
  ctx: Context,
  id: string,
): Promise<{ events: readonly SessionEvent[]; header: unknown; inheritedEventCount: number }> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), "read");
  try {
    const read = await handle.read(0);
    return {
      events: read.events,
      header: handle.header,
      inheritedEventCount: handle.inheritedEventCount,
    };
  } finally {
    await handle.close();
  }
}

describe("v3 golden fixture restore", () => {
  it("stores the three sessions at format v3, and reading them does not rewrite the store", async () => {
    const path = await loadFixture();
    // The physical rows are the historical facts: every session v3.
    const stored = new DatabaseSync(path);
    let before: Array<{ f_session_id: string; f_version: number }>;
    try {
      before = stored
        .prepare("SELECT f_session_id, f_version FROM t_sessions ORDER BY f_id")
        .all() as Array<{ f_session_id: string; f_version: number }>;
    } finally {
      stored.close();
    }
    expect(before).toEqual([
      { f_session_id: "parent-1", f_version: 3 },
      { f_session_id: "child-1", f_version: 3 },
      { f_session_id: "plain-2", f_version: 3 },
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      expect((await ctx.sessionPersistence.list()).map((s) => s.header.id)).toEqual([
        "parent-1",
        "child-1",
        "plain-2",
      ]);

      // Every log reads back as a valid CURRENT-format log: the session
      // constructor independently validates sequence continuity, surface
      // transitions, and header fields of the decoded events.
      for (const id of ["parent-1", "child-1", "plain-2"]) {
        const { events, header, inheritedEventCount } = await readSession(ctx, id);
        expect((header as { version: number }).version).toBe(SESSION_FORMAT_VERSION);
        expect(inheritedEventCount).toBe(0);
        expect(() =>
          Session.fromRestore(
            SessionId(id),
            [...events],
            header as Parameters<typeof Session.fromRestore>[2],
            inheritedEventCount as Parameters<typeof Session.fromRestore>[3],
            "detached",
          ),
        ).not.toThrow();
      }
    } finally {
      await dispose();
    }

    // A read never moves the stored generation: still v3, still 20 rows.
    const after = new DatabaseSync(path);
    try {
      expect(
        after.prepare("SELECT COUNT(*) AS n FROM t_events").get(),
      ).toEqual({ n: 20 });
      expect(
        after
          .prepare("SELECT COUNT(*) AS n FROM t_sessions WHERE f_version = 3")
          .get(),
      ).toEqual({ n: 3 });
    } finally {
      after.close();
    }
  });

  it("parent-1 carries the subagent/catalog discovery fact the v4 edge consumes", async () => {
    const { ctx, dispose } = await mount(await loadFixture());
    try {
      const { events, header } = await readSession(ctx, "parent-1");
      expect(header).toMatchObject({
        id: "parent-1",
        cwd: "/workspaces/parent-1",
        createdAt: 1000,
        isSeeded: false,
        version: SESSION_FORMAT_VERSION,
      });
      expect(events.map((e) => `${e.seq}:${e.type}`)).toEqual([
        ...oneTurnLog().map((e) => `${e.seq}:${e.type}`),
        "6:subagent/catalog",
      ]);
      expect(events.at(-1)?.data).toEqual({
        version: 0,
        childId: "child-1",
        childCreatedAt: 2000,
        mode: "continuable",
        label: "worker",
      });
    } finally {
      await dispose();
    }
  });

  it("child-1 is the subagent child the parent catalog names, with its descriptor event", async () => {
    const { ctx, dispose } = await mount(await loadFixture());
    try {
      const { events, header } = await readSession(ctx, "child-1");
      expect(header).toMatchObject({
        id: "child-1",
        cwd: "/workspaces/parent-1",
        createdAt: 2000,
        isSeeded: false,
        origin: "subagent",
        parentSession: "parent-1",
        delegationDepth: 1,
        version: SESSION_FORMAT_VERSION,
      });
      expect(events.map((e) => `${e.seq}:${e.type}`)).toEqual([
        ...oneTurnLog().map((e) => `${e.seq}:${e.type}`),
        "6:subagent/descriptor",
      ]);
      expect(events.at(-1)?.data).toEqual({
        version: 3,
        mode: "continuable",
        provider: "mock",
        label: "worker",
      });
    } finally {
      await dispose();
    }
  });

  it("plain-2 is childless — the migration's mandatory empty-child-facts arm", async () => {
    const path = await loadFixture();
    const db = new DatabaseSync(path);
    try {
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM t_sessions WHERE f_parent_session = 'plain-2'")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    const { ctx, dispose } = await mount(path);
    try {
      const { events, header } = await readSession(ctx, "plain-2");
      expect(header).toMatchObject({ id: "plain-2", isSeeded: false, version: SESSION_FORMAT_VERSION });
      expect(events.map((e) => `${e.seq}:${e.type}`)).toEqual(
        oneTurnLog().map((e) => `${e.seq}:${e.type}`),
      );
    } finally {
      await dispose();
    }
  });
});

/**
 * Cross-INSTANCE write authority: two persistence instances (two cordis
 * contexts, i.e. two `dsh` processes on one `sessions.sqlite`) must never
 * interleave one session's log. The in-process registry cannot see the other
 * instance, so the durable head guard inside the append transaction must reject
 * the second writer BEFORE any row lands.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  SessionOwnershipLostError,
  type SessionPersistence,
} from "@deepseek-ai/dsh-session-persistence";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { EmptySettings } from "./testing/helpers.ts";
import SessionPersistenceRdb from "../index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-multiinst-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

async function mount(path: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

function oneTurn(offset: number): SessionEvent[] {
  return [
    {
      type: "turn/start",
      seq: SessionSeq(offset + 0),
      time: 1,
      data: { turn: 1 },
    },
    {
      type: "user/message",
      seq: SessionSeq(offset + 1),
      time: 2,
      data: createUserMessage({
        content: [{ type: "text", text: `msg${offset}` }],
        source: { kind: "user" },
      }),
      surfaceOp: "append",
    },
    {
      type: "turn/end",
      seq: SessionSeq(offset + 2),
      time: 3,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
}

async function readLog(
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

describe("multi-instance write authority", () => {
  it("two instances create the SAME id concurrently, then both append — the log must not interleave", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("shared-id");
    // Both instances create the id before either materializes a row: neither
    // tracker can see the other, and no durable artifact exists yet.
    const h1 = await b1.ctx.sessionPersistence.create({
      id,
      version: 3,
      createdAt: 1,
      isSeeded: false,
      cwd: "/a",
    });
    const h2 = await b2.ctx.sessionPersistence.create({
      id,
      version: 3,
      createdAt: 1,
      isSeeded: false,
      cwd: "/b",
    });

    // The first append materializes the row …
    await h1.append(oneTurn(0));
    // … and the second writer must fail loud rather than silently continue a log
    // it never read (its cursor is 0 while the stored head is already 2).
    // The refusal uses the seam's ownership-loss vocabulary, not an ad-hoc Error.
    const refused = await h2.append(oneTurn(0)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionOwnershipLostError);
    expect((refused as Error).message).toMatch(/not read|another writer/i);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    const events = await readLog(b3.ctx.sessionPersistence, id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    await b3.dispose();
  });

  it("two instances append DIFFERENT ids concurrently — no cross contamination", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const [h1, h2] = await Promise.all([
      b1.ctx.sessionPersistence.create({ id: SessionId("i1"), version: 3, createdAt: 1, isSeeded: false }),
      b2.ctx.sessionPersistence.create({ id: SessionId("i2"), version: 3, createdAt: 1, isSeeded: false }),
    ]);
    await Promise.all([h1.append(oneTurn(0)), h2.append(oneTurn(0))]);
    await Promise.all([h1.close(), h2.close()]);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    expect((await readLog(b3.ctx.sessionPersistence, SessionId("i1"))).map((e) => e.seq)).toEqual([
      0, 1, 2,
    ]);
    expect((await readLog(b3.ctx.sessionPersistence, SessionId("i2"))).map((e) => e.seq)).toEqual([
      0, 1, 2,
    ]);
    await b3.dispose();
  });

  it("SAME id, two instances, interleaved batches stay consistent", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const id = SessionId("interleaved");
    const h1 = await b1.ctx.sessionPersistence.create({
      id,
      version: 3,
      createdAt: 1,
      isSeeded: false,
    });
    const h2 = await b2.ctx.sessionPersistence.create({
      id,
      version: 3,
      createdAt: 1,
      isSeeded: false,
    });
    await h1.append(oneTurn(0));
    // b2 never read the log, yet a row now exists: reject, never renumber.
    await expect(h2.append(oneTurn(0))).rejects.toThrow(/another writer|not read/i);
    await h1.append(oneTurn(3));
    // b2's cursor is still 0, so its next attempt fails the same way.
    await expect(h2.append(oneTurn(0))).rejects.toThrow(/another writer|not read|seq mismatch/i);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    expect((await readLog(b3.ctx.sessionPersistence, id)).map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    await b3.dispose();
  });

  it("an instance that READ the session may continue it; the stale writer is rejected", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const id = SessionId("auth");
    const h1 = await b1.ctx.sessionPersistence.create({
      id,
      version: 3,
      createdAt: 1,
      isSeeded: false,
    });
    await h1.append(oneTurn(0)); // b1: head 0..2

    // b2 explicitly opens the session for write (authorized continuation): its
    // confirmed head matches the stored one.
    const b2 = await mount(path);
    const h2 = await b2.ctx.sessionPersistence.open(id, "write");
    expect((await h2.read(0)).events).toHaveLength(3);
    await h2.append(oneTurn(3)); // continues 3..5
    await h2.close();
    await b2.dispose();

    // b1's view is stale (it never saw b2's batch): continuing must be refused.
    await expect(h1.append(oneTurn(3))).rejects.toThrow(/modified by another writer/);
    await b1.dispose();

    const b3 = await mount(path);
    const events = await readLog(b3.ctx.sessionPersistence, id);
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    await b3.dispose();
  });
});

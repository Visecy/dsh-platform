/**
 * Concurrency across many sessions and many instances: every case writes
 * through the handle seam, disposes, and re-reads from a cold mount so the
 * assertions cover the stored database, not in-memory state.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { SessionHandle, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { createMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { EmptySettings } from "./testing/helpers.ts";
import SessionPersistenceRdb from "../index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 3 });
});

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-multi-"));
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

/** Create the session's write handle and store its constructor seed, if any. */
async function storeSession(
  persistence: SessionPersistence,
  session: Session,
): Promise<SessionHandle> {
  const handle = await persistence.create(session.header, {
    inheritedEventCount: session.inheritedEventCount,
  });
  const seed = session.snapshotEvents();
  if (seed.length > 0) await handle.append(seed);
  return handle;
}

/** Read one stored log through a fresh read handle. */
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

/**
 * One complete current-format turn: stream settlement events are persisted
 * verbatim, so the log carries the attempt AND the settled message.
 */
function appendTurn(s: Session, turn: number): void {
  s.append("turn/start", { turn });
  s.append("step/start", { turn, step: 1 });
  s.append(
    "user/message",
    createUserMessage({
      content: [{ type: "text", text: `hi ${turn}` }],
      source: { kind: "user" },
    }),
    { surfaceOp: "append" },
  );
  s.append("assistant/attempt", {
    turn,
    step: 1,
    stream: [{ type: "text-chunks", time0: 1, index: 0, dt: [], texts: ["x"] }],
  });
  s.append(
    "assistant/message",
    {
      turn,
      step: 1,
      stream: [],
      message: createMessage({
        role: "assistant",
        content: [],
        source: { kind: "model", provider: "mock", model: "mock" },
      }),
    },
    { surfaceOp: "append" },
  );
  s.append("step/end", { turn, step: 1 });
  s.append("turn/end", { turn, reason: { kind: "completed" } });
}

const TURN_EVENTS = 7;

describe("multi-session concurrency (cold-path verification)", () => {
  it("many live sessions append concurrently, then each reloads intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const N = 12;
    const sessions: Session[] = [];
    for (let i = 0; i < N; i++) {
      const session = b.ctx.sessions.create(SessionId(`live-${i}`));
      await storeSession(b.ctx.sessionPersistence, session);
      sessions.push(session);
    }
    // Two rounds, flushed across all sessions at once.
    for (let round = 0; round < 2; round++) {
      for (const s of sessions) appendTurn(s, round + 1);
      await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    }
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const events = await readLog(b2.ctx.sessionPersistence, SessionId(`live-${i}`));
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(TURN_EVENTS * 2);
      // The attempt settlements are persisted verbatim — nothing was filtered.
      expect(events.filter((e) => e.type === "assistant/attempt")).toHaveLength(2);
    }
    await b2.dispose();
  });

  it("two backend instances share one file and append different sessions concurrently", async () => {
    const path = await freshDbPath();
    const b1 = await mount(path);
    const b2 = await mount(path);
    const s1 = b1.ctx.sessions.create(SessionId("inst-1"));
    const s2 = b2.ctx.sessions.create(SessionId("inst-2"));
    await Promise.all([
      storeSession(b1.ctx.sessionPersistence, s1),
      storeSession(b2.ctx.sessionPersistence, s2),
    ]);
    appendTurn(s1, 1);
    appendTurn(s2, 1);
    await Promise.all([b1.ctx.sessions.flush(s1), b2.ctx.sessions.flush(s2)]);
    await Promise.all([b1.dispose(), b2.dispose()]);

    const b3 = await mount(path);
    for (const id of ["inst-1", "inst-2"]) {
      const events = await readLog(b3.ctx.sessionPersistence, SessionId(id));
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: TURN_EVENTS }, (_, k) => k),
      );
    }
    await b3.dispose();
  });

  it("concurrent appends to MANY sessions never interleave parent chains", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const N = 20;
    const sessions: Session[] = [];
    for (let i = 0; i < N; i++) {
      const session = b.ctx.sessions.create(SessionId(`p-${i}`));
      await storeSession(b.ctx.sessionPersistence, session);
      sessions.push(session);
    }
    for (const s of sessions) appendTurn(s, 1);
    await Promise.all(sessions.map((s) => b.ctx.sessions.flush(s)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const events = await readLog(b2.ctx.sessionPersistence, SessionId(`p-${i}`));
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: TURN_EVENTS }, (_, k) => k),
      );
    }
    await b2.dispose();
  });

  it("append + read racing on one id stays consistent", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const s = b.ctx.sessions.create(SessionId("race"));
    const handle = await storeSession(b.ctx.sessionPersistence, s);
    for (let round = 1; round <= 4; round++) {
      appendTurn(s, round);
      await b.ctx.sessions.flush(s);
      // The writer's own reads are monotonic while the log keeps growing.
      expect((await handle.read(0)).events.length).toBe(TURN_EVENTS * round);
    }
    await b.dispose();

    const b2 = await mount(path);
    const events = await readLog(b2.ctx.sessionPersistence, SessionId("race"));
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: TURN_EVENTS * 4 }, (_, k) => k),
    );
    await b2.dispose();
  });

  it("subagent-style: parallel fork children persist their inherited prefix and own turn", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const parent = b.ctx.sessions.create(SessionId("parent"));
    await storeSession(b.ctx.sessionPersistence, parent);
    appendTurn(parent, 1);
    await b.ctx.sessions.flush(parent);

    const N = 8;
    const children = Array.from({ length: N }, (_, i) =>
      b.ctx.sessions.fork(parent, undefined, SessionId(`child-${i}`)),
    );
    for (const child of children) await storeSession(b.ctx.sessionPersistence, child);
    for (const child of children) appendTurn(child, 1);
    await Promise.all(children.map((c) => b.ctx.sessions.flush(c)));
    await b.dispose();

    const b2 = await mount(path);
    for (let i = 0; i < N; i++) {
      const handle = await b2.ctx.sessionPersistence.open(SessionId(`child-${i}`), "read");
      const events = (await handle.read(0)).events;
      await handle.close();
      const seqs = events.map((e) => e.seq);
      // parent prefix (7) + the inherited end-seed marker (1) + own turn (7).
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, k) => k));
      expect(seqs.length).toBe(TURN_EVENTS + 1 + TURN_EVENTS);
      expect(events.filter((e) => e.type === "assistant/attempt")).toHaveLength(2);
      expect(handle.header.isSeeded).toBe(true);
    }
    await b2.dispose();
  });

  it("subagent-style: parallel children + parent all append interleaved, then all reload intact", async () => {
    const path = await freshDbPath();
    const b = await mount(path);
    const parent = b.ctx.sessions.create(SessionId("parent-2"));
    const N = 6;
    const children = Array.from({ length: N }, (_, i) =>
      b.ctx.sessions.create(SessionId(`sib-${i}`)),
    );
    await storeSession(b.ctx.sessionPersistence, parent);
    for (const c of children) await storeSession(b.ctx.sessionPersistence, c);
    // parent and children write interleaved.
    appendTurn(parent, 1);
    for (const c of children) appendTurn(c, 1);
    await Promise.all([b.ctx.sessions.flush(parent), ...children.map((c) => b.ctx.sessions.flush(c))]);
    appendTurn(parent, 2);
    for (const c of children) appendTurn(c, 2);
    await Promise.all([b.ctx.sessions.flush(parent), ...children.map((c) => b.ctx.sessions.flush(c))]);
    await b.dispose();

    const b2 = await mount(path);
    const expected = Array.from({ length: TURN_EVENTS * 2 }, (_, k) => k);
    expect((await readLog(b2.ctx.sessionPersistence, SessionId("parent-2"))).map((e) => e.seq)).toEqual(
      expected,
    );
    for (let i = 0; i < N; i++) {
      expect(
        (await readLog(b2.ctx.sessionPersistence, SessionId(`sib-${i}`))).map((e) => e.seq),
      ).toEqual(expected);
    }
    await b2.dispose();
  });
});

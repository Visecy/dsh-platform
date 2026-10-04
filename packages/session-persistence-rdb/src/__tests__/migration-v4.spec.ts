/**
 * Session format v3 → v4 migration: the parent's `subagent/catalog` synthesis.
 *
 * DSH 0.2.x moved `SESSION_FORMAT_VERSION` to 4, and the sanctioned v3→v4 edge
 * cannot run off the build-static catalog: it REQUIRES explicit historical child
 * facts (one array per parent, `[]` mandatory for a parent without children) and
 * synthesizes a `subagent/catalog` event into the parent's log for every child
 * the parent never recorded. The RDB backend therefore discovers children on the
 * READ side — `f_parent_session` + `f_origin='subagent'` rows — and decodes each
 * child's own log with the prerequisite-only (v0–v3) catalog, exactly as the
 * first-party JSONL backend does.
 *
 * These cases pin the whole contract:
 *   - the mandatory empty-array arm;
 *   - one/many children, with each child's own descriptor deciding the entry;
 *   - the format's sanctioned degradation (unknown mode) for a child whose log
 *     or descriptor cannot supply evidence — the parent still migrates;
 *   - a child row that is gone (an identity-only loss: a stored entry survives,
 *     nothing is fabricated);
 *   - a stored entry that CONFLICTS with live child evidence: refuse loudly,
 *     never downgrade evidence;
 *   - no recursion into grandchildren, and no re-discovery on a write rewrite;
 *   - the committed golden v3 fixture (captured from the LAST 0.1.5 build, which
 *     can no longer produce v3) migrating end to end.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/migration-v4
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionFormatUnsupportedError } from "@deepseek-ai/dsh-session-persistence";
import SessionPersistenceRdb from "../index.ts";
import { oneTurnLog } from "./testing/contract.ts";
import { EmptySettings } from "./testing/helpers.ts";
import type { AgentLoopRawStore, StoredRowSpec } from "./testing/agent-loop.ts";
import { createSqliteRawStore } from "./testing/sqlite-raw.ts";

/** The committed golden v3 database, as portable SQL. */
const GOLDEN_FIXTURE = new URL("../../tests/fixtures/v3-golden.sql", import.meta.url);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A fresh temp database path plus its raw-store hooks. */
async function freshStore(): Promise<{ path: string; raw: AgentLoopRawStore }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v4-"));
  dirs.push(dir);
  const path = join(dir, "sessions.db");
  return { path, raw: createSqliteRawStore(path) };
}

/** Mount the backend over one database path. */
async function mount(path: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(EmptySettings);
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path });
  return { ctx, dispose: () => fiber.dispose() };
}

/** Read one whole stored log through a fresh read handle. */
async function readAll(
  ctx: Context,
  id: string,
): Promise<{ header: SessionHeader; events: readonly { type: string; seq: number; data: unknown }[] }> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), "read");
  try {
    const read = await handle.read(0);
    return {
      header: handle.header,
      events: read.events as unknown as readonly { type: string; seq: number; data: unknown }[],
    };
  } finally {
    await handle.close();
  }
}

/** Convert logical current-format events into the physical rows a v3 build stored. */
function rowsOf(events: readonly { type: string; data: unknown }[]): StoredRowSpec[] {
  return events.map((event) => {
    const surface = event as { surfaceOp?: unknown; sourceEventSeqs?: number[] };
    return {
      kind: event.type,
      data: event.data,
      ...(surface.surfaceOp === undefined ? {} : { surfaceOp: surface.surfaceOp }),
      ...(surface.sourceEventSeqs === undefined
        ? {}
        : { sourceEventSeqs: surface.sourceEventSeqs }),
    };
  });
}

/** A complete v3 turn (seqs 0..5), exactly as a 0.1.5 build stored it. */
const TURN_ROWS = rowsOf(oneTurnLog());

/** One `subagent/descriptor` row at seq 6 (the child's own durable evidence). */
function descriptorRow(data: unknown): StoredRowSpec {
  return { kind: "subagent/descriptor", data };
}

/** One `subagent/catalog` row at seq 6 (the 0.1.5 plugin's parent-side fact). */
function catalogRow(data: unknown): StoredRowSpec {
  return { kind: "subagent/catalog", data };
}

/** A v3 parent row (no children unless the rows say otherwise). */
async function fabricateParent(
  raw: AgentLoopRawStore,
  id: string,
  rows: readonly StoredRowSpec[] = TURN_ROWS,
): Promise<void> {
  await raw.fabricate(SessionId(id), {
    version: 3,
    createdAt: 1000,
    cwd: "/work",
    rows,
  });
}

/** A v3 subagent child row naming `parent` as its direct parent. */
async function fabricateChild(
  raw: AgentLoopRawStore,
  id: string,
  parent: string,
  options: { createdAt: number; rows: readonly StoredRowSpec[] },
): Promise<void> {
  await raw.fabricate(SessionId(id), {
    version: 3,
    createdAt: options.createdAt,
    cwd: "/work",
    origin: "subagent",
    parentSession: parent,
    delegationDepth: 1,
    rows: options.rows,
  });
}

/** The catalog entries in a served log, in order. */
function catalogFacts(
  events: readonly { type: string; data: unknown }[],
): unknown[] {
  return events.filter((event) => event.type === "subagent/catalog").map((event) => event.data);
}

describe("v3 → v4 migration of a stored parent", () => {
  it("reads a v3-stored replace surface op in its OWN physical spelling", async () => {
    // A v3 row stores `{op:'replace', startSeq, endSeq}` (the v2→v3 edge renamed
    // the released `{start,end}`); the released-v3 decoder refuses the older
    // spelling, so the read path must project by the ROW's version, not by the
    // installed one.
    const { path, raw } = await freshStore();
    await fabricateParent(raw, "p1", [
      ...TURN_ROWS,
      {
        kind: "user/message",
        data: {
          id: "v3-replacement",
          role: "user",
          content: [{ type: "text", text: "replaced" }],
          source: { kind: "user" },
        },
        surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
        sourceEventSeqs: [2],
      },
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      const { events } = await readAll(ctx, "p1");
      const replacement = events.at(-1) as { surfaceOp?: unknown; sourceEventSeqs?: number[] };
      expect(replacement.surfaceOp).toEqual({ op: "replace", startSeq: 2, endSeq: 2 });
      expect(replacement.sourceEventSeqs).toEqual([2]);
    } finally {
      await dispose();
    }
  });

  it("serves a childless v3 parent at v4 through the mandatory empty child set", async () => {
    const { path, raw } = await freshStore();
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      const { header, events } = await readAll(ctx, "p1");
      expect(header.version).toBe(SESSION_FORMAT_VERSION);
      expect(events.map((event) => `${event.seq}:${event.type}`)).toEqual(
        oneTurnLog().map((event) => `${event.seq}:${event.type}`),
      );
      expect(catalogFacts(events)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("synthesizes the catalog fact from the child's own descriptor", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "worker" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      const { header, events } = await readAll(ctx, "p1");
      expect(header.version).toBe(SESSION_FORMAT_VERSION);
      // Appended after every source event, at the final source event's time.
      expect(events.at(-1)).toMatchObject({ type: "subagent/catalog", seq: 6, time: 6 });
      expect(events.at(-1)?.data).toEqual({
        version: 0,
        childId: "c1",
        childCreatedAt: 2000,
        mode: "continuable",
        label: "worker",
      });
    } finally {
      await dispose();
    }
  });

  it("keeps a childless parent's log free of synthesized entries while a sibling's gains them", async () => {
    const { path, raw } = await freshStore();
    await fabricateParent(raw, "parent");
    await fabricateParent(raw, "childless", TURN_ROWS);
    await fabricateChild(raw, "child", "parent", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "one-shot", provider: "mock" }),
      ],
    });

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "childless")).events)).toEqual([]);
      expect(catalogFacts((await readAll(ctx, "parent")).events)).toEqual([
        // `one-shot` without a label: the entry has no `label` key at all.
        { version: 0, childId: "child", childCreatedAt: 2000, mode: "one-shot" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("orders multiple synthesized entries by child creation time and child id", async () => {
    const { path, raw } = await freshStore();
    // Fabricated in reverse order: discovery must be deterministic regardless.
    await fabricateChild(raw, "c-late", "p1", {
      createdAt: 3000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "one-shot", provider: "mock" }),
      ],
    });
    await fabricateChild(raw, "c-early", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "first" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        {
          version: 0,
          childId: "c-early",
          childCreatedAt: 2000,
          mode: "continuable",
          label: "first",
        },
        { version: 0, childId: "c-late", childCreatedAt: 3000, mode: "one-shot" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("excludes a fork child and another parent's subagent child", async () => {
    const { path, raw } = await freshStore();
    // A fork: a parent link but NOT a subagent origin.
    await raw.fabricate(SessionId("fork"), {
      version: 3,
      createdAt: 1500,
      cwd: "/work",
      parentSession: "p1",
      rows: TURN_ROWS,
    });
    await fabricateChild(raw, "other-child", "other-parent", {
      createdAt: 2500,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "nope" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("degrades to unknown mode without recursing into a child's own children", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "grandchild", "c1", {
      createdAt: 3000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "deep" }),
      ],
    });
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "middle" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      // The parent's evidence is its DIRECT children only — never a recursion.
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        {
          version: 0,
          childId: "c1",
          childCreatedAt: 2000,
          mode: "continuable",
          label: "middle",
        },
      ]);
      // The child is itself a parent and migrates through its own evidence.
      expect(catalogFacts((await readAll(ctx, "c1")).events)).toEqual([
        {
          version: 0,
          childId: "grandchild",
          childCreatedAt: 3000,
          mode: "continuable",
          label: "deep",
        },
      ]);
    } finally {
      await dispose();
    }
  });

  it("retains a stored entry whose child row is gone, fabricating nothing", async () => {
    const { path, raw } = await freshStore();
    await fabricateParent(raw, "p1", [
      ...TURN_ROWS,
      catalogRow({
        version: 0,
        childId: "ghost",
        childCreatedAt: 5000,
        mode: "continuable",
        label: "lost",
      }),
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      const { header, events } = await readAll(ctx, "p1");
      expect(header.version).toBe(SESSION_FORMAT_VERSION);
      expect(events.map((event) => event.type)).toEqual([
        ...oneTurnLog().map((event) => event.type),
        "subagent/catalog",
      ]);
      expect(catalogFacts(events)).toEqual([
        { version: 0, childId: "ghost", childCreatedAt: 5000, mode: "continuable", label: "lost" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("retains a stored entry that agrees with the live child (no duplicate event)", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "worker" }),
      ],
    });
    await fabricateParent(raw, "p1", [
      ...TURN_ROWS,
      catalogRow({
        version: 0,
        childId: "c1",
        childCreatedAt: 2000,
        mode: "continuable",
        label: "worker",
      }),
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      const { events } = await readAll(ctx, "p1");
      expect(events).toHaveLength(7);
      expect(catalogFacts(events)).toEqual([
        { version: 0, childId: "c1", childCreatedAt: 2000, mode: "continuable", label: "worker" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("refuses loudly when a stored entry's creation time conflicts with the child", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "worker" }),
      ],
    });
    await fabricateParent(raw, "p1", [
      ...TURN_ROWS,
      catalogRow({
        version: 0,
        childId: "c1",
        childCreatedAt: 9999,
        mode: "continuable",
        label: "worker",
      }),
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      const refused = await ctx.sessionPersistence
        .open(SessionId("p1"), "read")
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SessionFormatUnsupportedError);
      expect((refused as Error).message).toMatch(/conflicts with its parent catalog/);
      // Evidence is never downgraded to force a migration: the stored rows stay.
      expect((await raw.storedSession(SessionId("p1")))?.version).toBe(3);
      // ... and a header-only observation still works.
      expect((await ctx.sessionPersistence.stat(SessionId("p1")))?.header.version).toBe(
        SESSION_FORMAT_VERSION,
      );
    } finally {
      await dispose();
    }
  });

  it("refuses loudly when a stored entry's mode conflicts with the child's descriptor", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "worker" }),
      ],
    });
    await fabricateParent(raw, "p1", [
      ...TURN_ROWS,
      catalogRow({ version: 0, childId: "c1", childCreatedAt: 2000, mode: "one-shot" }),
    ]);

    const { ctx, dispose } = await mount(path);
    try {
      await expect(ctx.sessionPersistence.open(SessionId("p1"), "read")).rejects.toThrow(
        /conflicts with its parent catalog/,
      );
    } finally {
      await dispose();
    }
  });
});

describe("v3 → v4 degradation when a child cannot supply complete evidence", () => {
  it("uses a version-1 unknown entry for a malformed descriptor and still migrates", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "c1", "p1", {
      createdAt: 2000,
      // A supported version without its required `provider`.
      rows: [...TURN_ROWS, descriptorRow({ version: 3, mode: "continuable", label: "worker" })],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      const { header, events } = await readAll(ctx, "p1");
      expect(header.version).toBe(SESSION_FORMAT_VERSION);
      expect(catalogFacts(events)).toEqual([
        { version: 1, childId: "c1", childCreatedAt: 2000, mode: "unknown" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("uses a version-1 unknown entry when the child has no single descriptor", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "none", "p1", { createdAt: 2000, rows: TURN_ROWS });
    await fabricateChild(raw, "two", "p1", {
      createdAt: 2500,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "a" }),
        descriptorRow({ version: 3, mode: "one-shot", provider: "mock" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        { version: 1, childId: "none", childCreatedAt: 2000, mode: "unknown" },
        { version: 1, childId: "two", childCreatedAt: 2500, mode: "unknown" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("uses a version-1 unknown entry when the child's own log is corrupt", async () => {
    const { path, raw } = await freshStore();
    const corrupted = rowsOf(oneTurnLog());
    corrupted[0] = { ...corrupted[0]!, data: "{not valid json" };
    await fabricateChild(raw, "broken", "p1", {
      createdAt: 2000,
      rows: [...corrupted, descriptorRow({ version: 3, mode: "continuable", provider: "mock" })],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        { version: 1, childId: "broken", childCreatedAt: 2000, mode: "unknown" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("counts only descriptors after a seeded child's own inherited cut", async () => {
    const { path, raw } = await freshStore();
    // `forked` is a SEEDED subagent child: rows 0..5 are the inherited prefix
    // and carry an OLD descriptor; its own descriptor sits after the tagged
    // cut marker at seq 6. Only the own descriptor may decide the entry.
    await raw.fabricate(SessionId("forked"), {
      version: 3,
      createdAt: 2000,
      cwd: "/work",
      origin: "subagent",
      parentSession: "p1",
      delegationDepth: 1,
      seedLength: 6,
      rows: [
        ...TURN_ROWS.slice(0, 5),
        descriptorRow({ version: 3, mode: "one-shot", provider: "mock", label: "inherited" }),
        { kind: "session/end-seed", data: { inherited: true } },
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "own" }),
      ],
    });
    // `seed-only` has its only descriptor INSIDE the inherited prefix.
    await raw.fabricate(SessionId("seed-only"), {
      version: 3,
      createdAt: 2500,
      cwd: "/work",
      origin: "subagent",
      parentSession: "p1",
      delegationDepth: 1,
      seedLength: 6,
      rows: [
        ...TURN_ROWS.slice(0, 5),
        descriptorRow({ version: 3, mode: "continuable", provider: "mock", label: "inherited" }),
        { kind: "session/end-seed", data: { inherited: true } },
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        {
          version: 0,
          childId: "forked",
          childCreatedAt: 2000,
          mode: "continuable",
          label: "own",
        },
        { version: 1, childId: "seed-only", childCreatedAt: 2500, mode: "unknown" },
      ]);
    } finally {
      await dispose();
    }
  });

  it("reads a version-1 descriptor as continuable, keeping its label", async () => {
    const { path, raw } = await freshStore();
    await fabricateChild(raw, "legacy", "p1", {
      createdAt: 2000,
      rows: [
        ...TURN_ROWS,
        descriptorRow({ version: 1, provider: "mock", mode: "one-shot", label: "legacy" }),
      ],
    });
    await fabricateParent(raw, "p1");

    const { ctx, dispose } = await mount(path);
    try {
      expect(catalogFacts((await readAll(ctx, "p1")).events)).toEqual([
        {
          version: 0,
          childId: "legacy",
          childCreatedAt: 2000,
          mode: "continuable",
          label: "legacy",
        },
      ]);
    } finally {
      await dispose();
    }
  });
});

describe("v3 → v4 migration of the golden fixture", () => {
  it("serves every golden session at v4 without refusing, keeping the stored catalog fact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v4-golden-"));
    dirs.push(dir);
    const path = join(dir, "sessions.db");
    const seed = new DatabaseSync(path);
    try {
      seed.exec(await readFile(GOLDEN_FIXTURE, "utf8"));
    } finally {
      seed.close();
    }

    const { ctx, dispose } = await mount(path);
    try {
      // The exact regression: before the fix this rejected with
      // `SessionFormatUnsupportedError` ("requires explicit historical child
      // facts") for every stored v3 log.
      const opening = ctx.sessionPersistence.open(SessionId("parent-1"), "read");
      await expect(opening).resolves.toBeDefined();
      const handle = await opening;
      try {
        expect(handle.header.version).toBe(SESSION_FORMAT_VERSION);
        const events = (await handle.read(0)).events;
        expect(catalogFacts(events)).toEqual([
          {
            version: 0,
            childId: "child-1",
            childCreatedAt: 2000,
            mode: "continuable",
            label: "worker",
          },
        ]);
      } finally {
        await handle.close();
      }

      // The childless session exercises the mandatory empty-array arm.
      expect(catalogFacts((await readAll(ctx, "plain-2")).events)).toEqual([]);
      // The child migrates through its own (empty) child set.
      expect(catalogFacts((await readAll(ctx, "child-1")).events)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it("synthesizes the catalog fact from the golden child row when the stored entry is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v4-golden-synth-"));
    dirs.push(dir);
    const path = join(dir, "sessions.db");
    const seed = new DatabaseSync(path);
    try {
      seed.exec(await readFile(GOLDEN_FIXTURE, "utf8"));
    } finally {
      seed.close();
    }
    deleteStoredEvents(path, "parent-1", "subagent/catalog");

    const { ctx, dispose } = await mount(path);
    try {
      const { header, events } = await readAll(ctx, "parent-1");
      expect(header.version).toBe(SESSION_FORMAT_VERSION);
      expect(events.map((event) => `${event.seq}:${event.type}`)).toEqual([
        ...oneTurnLog().map((event) => `${event.seq}:${event.type}`),
        "6:subagent/catalog",
      ]);
      // Reconstructed from child-1's own header identity + descriptor, not from
      // the (deleted) parent-side record.
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

  it("rewrites the golden parent in place at v4 with exactly one catalog fact, idempotently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v4-golden-write-"));
    dirs.push(dir);
    const path = join(dir, "sessions.db");
    const seed = new DatabaseSync(path);
    try {
      seed.exec(await readFile(GOLDEN_FIXTURE, "utf8"));
    } finally {
      seed.close();
    }

    const first = await mount(path);
    let migrated: readonly { type: string; data: unknown }[];
    try {
      const writer = await first.ctx.sessionPersistence.open(SessionId("parent-1"), "write");
      migrated = (await writer.read(0)).events as unknown as readonly {
        type: string;
        data: unknown;
      }[];
      await writer.close();
    } finally {
      await first.dispose();
    }

    const raw = createSqliteRawStore(path);
    expect((await raw.storedSession(SessionId("parent-1")))?.version).toBe(
      SESSION_FORMAT_VERSION,
    );
    expect((await raw.storedRows(SessionId("parent-1"))).map((row) => row.kind)).toEqual(
      migrated.map((event) => event.type),
    );
    expect(catalogFacts(migrated)).toHaveLength(1);

    // A cold instance re-reads the rewritten log with no second synthesis.
    const second = await mount(path);
    try {
      const { events } = await readAll(second.ctx, "parent-1");
      expect(events).toEqual(migrated);
    } finally {
      await second.dispose();
    }
  });
});

/**
 * Delete one session's events of a given kind from a loaded fixture (plus their
 * bridge rows), rewinding the head cursor to the surviving tail. Models the
 * "stored catalog entry is gone but the child row survives" repair case.
 */
function deleteStoredEvents(path: string, sessionId: string, kind: string): void {
  const db = new DatabaseSync(path);
  try {
    const doomed = db
      .prepare(
        `SELECT se.f_event_id AS id FROM t_session_events se
           JOIN t_events e ON e.f_event_id = se.f_event_id
          WHERE se.f_session_id = ? AND e.f_kind = ?`,
      )
      .all(sessionId, kind) as Array<{ id: string }>;
    for (const row of doomed) {
      db.prepare("DELETE FROM t_session_events WHERE f_session_id = ? AND f_event_id = ?").run(
        sessionId,
        row.id,
      );
      db.prepare("DELETE FROM t_events WHERE f_event_id = ?").run(row.id);
    }
    const head = db
      .prepare(
        "SELECT f_event_id AS id, f_sequence AS seq FROM t_session_events WHERE f_session_id = ? ORDER BY f_sequence DESC LIMIT 1",
      )
      .get(sessionId) as { id: string; seq: number } | undefined;
    db.prepare(
      "UPDATE t_sessions SET f_head_event_id = ?, f_head_sequence = ? WHERE f_session_id = ?",
    ).run(head?.id ?? "", head?.seq ?? -1, sessionId);
  } finally {
    db.close();
  }
}

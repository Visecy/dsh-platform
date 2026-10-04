/**
 * Capture the golden DSH session-format **v3** database fixture.
 *
 * DISABLED BY DEFAULT: the suite is skipped unless `DSH_CAPTURE_FIXTURE=1`,
 * because its job is not to assert but to WRITE
 * `tests/fixtures/v3-golden.sql`. That file (plus the generator that produced
 * it) is committed so the v3→v4 migration can be proven later against a
 * database a real 0.1.5 build wrote. After the DSH dependency is bumped to
 * 0.2.x this generator can no longer produce a v3 database — the backend would
 * stamp v4 rows — which is exactly why the fixture is captured now.
 *
 * Run from the package directory:
 *
 *     DSH_CAPTURE_FIXTURE=1 npx vitest run src/__tests__/capture-v3-fixture.spec.ts
 *
 * The three captured sessions are the facts the v3→v4 migration edge needs:
 *
 *   - `parent-1` — a normal session with one complete turn plus the
 *     `subagent/catalog` fact the 0.1.5 subagent plugin appends
 *     (`parent.append("subagent/catalog", { version: 0, childId,
 *     childCreatedAt, mode, label? })`);
 *   - `child-1` — a subagent child whose HEADER carries the identity
 *     (`origin: 'subagent'`, `parentSession`, `delegationDepth`,
 *     `createdAt`) plus the `subagent/descriptor` event the plugin appends in
 *     the child's initial turn;
 *   - `plain-2` — a childless session, which exercises the mandatory *empty
 *     array* arm of the migration's historical-child-facts contract.
 *
 * Determinism (a committed fixture must be reproducible byte-for-byte):
 * the write path mints opaque identity UUIDs (`t_events.f_event_id` /
 * `f_parent_id`, `t_sessions.f_head_event_id` / `f_incarnation`,
 * `t_persistence_state.f_store_id`) and `Session.append` stamps `Date.now()`.
 * The generator therefore (a) writes each log through the handle seam with the
 * explicit `seq`/`time` values `oneTurnLog()` already defines instead of the
 * live `Session.append` (whose derived seq is `log.length` — so 6 after
 * `oneTurnLog()` — but whose time is wall-clock), and (b) canonicalizes the
 * opaque UUID columns to stable tokens in primary-key traversal order while
 * dumping. Every session-format fact (ids, headers, seqs, kinds, payloads,
 * times) is stored exactly as the build wrote it.
 *
 * @module @visecy/dsh-session-persistence-rdb/tests/capture-v3-fixture
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  SessionStore,
} from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import SessionPersistenceRdb from "../index.ts";
// NOTE: `meta` is aliased: a top-level binding literally named `meta`
// makes Vite 5's SSR transform rewrite `import.meta` twice and fail
// ("Cannot split a chunk that has already been edited").
import { meta as sessionMeta, oneTurnLog } from "./testing/contract.ts";
import { EmptySettings } from "./testing/helpers.ts";

/** The fixture this generator owns (package-root `tests/fixtures/`). */
const FIXTURE_PATH = new URL("../../tests/fixtures/v3-golden.sql", import.meta.url);

/** `t_sessions`/`t_events`/... in the order their rows are dumped. */
const TABLES = [
  { name: "t_persistence_state", primaryKey: "f_singleton" },
  { name: "t_sessions", primaryKey: "f_id" },
  { name: "t_events", primaryKey: "f_id" },
  { name: "t_session_events", primaryKey: "f_id" },
] as const;

/**
 * Opaque identity columns canonicalized on dump: a random UUID carries no
 * session-format meaning, but it would make every capture differ. The token
 * kind groups columns that must stay mutually consistent (`f_event_id` and the
 * `f_parent_id`/`f_head_event_id` references to it share one namespace).
 */
const IDENTITY_COLUMNS: Record<string, Record<string, IdentityKind>> = {
  t_persistence_state: { f_store_id: "store" },
  t_sessions: { f_head_event_id: "event", f_incarnation: "incarnation" },
  t_events: { f_event_id: "event", f_parent_id: "event" },
  t_session_events: { f_event_id: "event" },
};

type IdentityKind = "event" | "incarnation" | "store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOKEN_PREFIX: Record<IdentityKind, string> = {
  event: "evt",
  incarnation: "inc",
  store: "store",
};

/** One SQL literal for a value `node:sqlite` returned from a row. */
function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`unsupported SQLite value type "${typeof value}" in the fixture dump`);
}

/** The exact catalog fact the 0.1.5 subagent plugin appends to the PARENT. */
function catalogEvent(): SessionEvent {
  return {
    type: "subagent/catalog",
    seq: SessionSeq(6),
    time: 7,
    data: {
      version: 0,
      childId: "child-1",
      childCreatedAt: 2000,
      mode: "continuable",
      label: "worker",
    },
  } as SessionEvent;
}

/**
 * A plausible continuable descriptor exactly as the 0.1.5 plugin's
 * `snapshotSubagentDescriptor` writes it (version 3; `provider` + `label`
 * required for the continuable arm, provider-composition fields optional).
 */
function descriptorEvent(): SessionEvent {
  return {
    type: "subagent/descriptor",
    seq: SessionSeq(6),
    time: 7,
    data: {
      version: 3,
      mode: "continuable",
      provider: "mock",
      label: "worker",
    },
  } as SessionEvent;
}

/** The child header the 0.1.5 subagent plugin persists for `child-1`. */
function childHeader(): SessionHeader {
  return {
    ...sessionMeta("child-1", "/workspaces/parent-1"),
    createdAt: 2000,
    origin: "subagent",
    parentSession: SessionId("parent-1"),
    delegationDepth: 1,
  };
}

/** Build the portable SQL dump of the captured database. */
async function dumpFixture(dbPath: string, provenance: readonly string[]): Promise<string> {
  const db = new DatabaseSync(dbPath);
  try {
    // Refuse to overwrite the golden fixture with anything but v3. After the
    // DSH dependency is bumped this generator would capture v4 rows; failing
    // here (before `writeFile`) keeps the committed v3 database intact.
    const versions = db
      .prepare("SELECT DISTINCT f_version FROM t_sessions ORDER BY f_version")
      .all() as Array<{ f_version: number }>;
    if (versions.length !== 1 || versions[0]?.f_version !== 3) {
      throw new Error(
        `refusing to capture: this build stores session format ${versions
          .map((v) => v.f_version)
          .join("/")}, not the golden v3 — the fixture must not be overwritten`,
      );
    }

    // Schema: the build's own DDL as SQLite recorded it (auto-indexes of
    // UNIQUE constraints are `sqlite_*` and are recreated by the constraints).
    const schema = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
          ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string }>;

    const lines: string[] = [
      "-- ============================================================================",
      "-- GOLDEN FIXTURE — DSH session format v3, stored by the RDB persistence backend.",
      "-- Do not edit by hand: regenerate with",
      "--   DSH_CAPTURE_FIXTURE=1 npx vitest run src/__tests__/capture-v3-fixture.spec.ts",
      "-- ----------------------------------------------------------------------------",
      ...provenance.map((line) => `-- ${line}`),
      "-- ----------------------------------------------------------------------------",
      "-- Opaque identity UUIDs are canonicalized (f_event_id/f_parent_id/",
      "-- f_head_event_id -> evt-NNNN, f_incarnation -> inc-NNNN, f_store_id ->",
      "-- store-NNNN) in primary-key order so captures are diff-free; all other",
      "-- stored values are exactly what the build wrote.",
      "-- ============================================================================",
      "",
      `PRAGMA user_version = 1;`,
      `PRAGMA application_id = ${0x44534850};`,
      "",
      "BEGIN;",
      "",
    ];

    for (const { type, sql } of schema) {
      lines.push(`${sql};`, "");
    }

    // Rows: identity columns canonicalized in one stable traversal.
    const counters = new Map<IdentityKind, number>();
    const canonical = new Map<string, string>();
    const canonicalize = (kind: IdentityKind, value: string): string => {
      if (!UUID_RE.test(value)) return value;
      const key = `${kind}:${value}`;
      let token = canonical.get(key);
      if (token === undefined) {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        token = `${TOKEN_PREFIX[kind]}-${String(next).padStart(4, "0")}`;
        canonical.set(key, token);
      }
      return token;
    };

    const counts: Array<[string, number]> = [];
    for (const { name, primaryKey } of TABLES) {
      const columns = (
        db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      const identity = IDENTITY_COLUMNS[name] ?? {};
      const rows = db
        .prepare(
          `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${name}" ORDER BY "${primaryKey}"`,
        )
        .all() as Array<Record<string, unknown>>;
      counts.push([name, rows.length]);
      lines.push(`-- ${name}: ${rows.length} row${rows.length === 1 ? "" : "s"}`);
      for (const row of rows) {
        const values = columns.map((column) => {
          const value = row[column];
          const kind = identity[column];
          return sqlValue(
            kind !== undefined && typeof value === "string" ? canonicalize(kind, value) : value,
          );
        });
        lines.push(`INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});`);
      }
      lines.push("");
    }

    lines.push("COMMIT;", "");
    console.log(
      `[capture-v3-fixture] rows: ${counts.map(([table, count]) => `${table}=${count}`).join(" ")}`,
    );
    return lines.join("\n");
  } finally {
    db.close();
  }
}

/** Provenance header lines for the fixture (deterministic except the date). */
async function provenance(): Promise<string[]> {
  const pkg = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    version: string;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  // The DSH build this capture is only valid for, from the exact dev pin.
  const dshVersion = (
    pkg.devDependencies?.["@deepseek-ai/dsh-session"] ??
    pkg.peerDependencies?.["@deepseek-ai/dsh-session"] ??
    "unknown"
  ).replace(/^[\^~]/, "");
  let commit = "unknown";
  let branch = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    }).trim();
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    }).trim();
  } catch {
    // Captured outside a git checkout: keep the placeholder, not a failure.
  }
  return [
    `produced by: ${pkg.name}@${pkg.version} (Visecy/dsh-platform) via`,
    "             src/__tests__/capture-v3-fixture.spec.ts",
    `dsh version: ${dshVersion}`,
    `session format version: ${SESSION_FORMAT_VERSION} (v3)`,
    `sqlite schema version: 1 (application_id 0x44534850)`,
    `git commit: ${commit} (${branch})`,
    `note: recorded from HEAD at capture time; the fixture itself landed in the`,
    `      next commit on this branch.`,
    `captured: ${new Date().toISOString().slice(0, 10)}`,
  ];
}

describe.skipIf(process.env.DSH_CAPTURE_FIXTURE !== "1")("capture the golden v3 fixture", () => {
  it(
    "writes tests/fixtures/v3-golden.sql from a freshly captured database",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "dsh-rdb-v3-capture-"));
      const dbPath = join(dir, "sessions.db");
      const ctx = new Context();
      await ctx.plugin(EmptySettings);
      await ctx.plugin(SessionStore);
      const fiber = await ctx.plugin(SessionPersistenceRdb, { type: "sqlite", path: dbPath });
      try {
        /** Create one stored session and land its whole log in seq order. */
        const store = async (
          header: SessionHeader,
          turn: readonly SessionEvent[],
          extra?: SessionEvent,
        ): Promise<void> => {
          const handle = await ctx.sessionPersistence.create(header);
          // Batch 1: the complete turn, ending at seq 5.
          await handle.append(turn);
          // Batch 2 (when present): the session-format extra fact, continuing
          // at seq 6 — `Session.append` derives `seq = log.length`, so 6 is the
          // exact next seq after the six-event `oneTurnLog()`; the handle
          // refuses a renumber, so a wrong value would fail loudly here.
          if (extra !== undefined) await handle.append([extra]);
          await handle.flush();
          await handle.close();
        };

        // 1) parent-1: a normal top-level session + the child discovery fact.
        await store(sessionMeta("parent-1", "/workspaces/parent-1"), oneTurnLog(), catalogEvent());
        // 2) child-1: the subagent child with the durable descriptor.
        await store(childHeader(), oneTurnLog(), descriptorEvent());
        // 3) plain-2: no children — the migration's mandatory empty-array arm.
        await store(sessionMeta("plain-2"), oneTurnLog());

        const sql = await dumpFixture(dbPath, await provenance());
        await mkdir(new URL("../../tests/fixtures/", import.meta.url), { recursive: true });
        await writeFile(FIXTURE_PATH, sql, "utf8");
        expect(sql).toContain("CREATE TABLE");
        expect(sql).toContain("subagent/catalog");
        expect(sql).toContain("subagent/descriptor");
      } finally {
        await fiber.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

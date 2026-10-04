/**
 * Representation conversion for a session log: persisted rows (`t_sessions` /
 * joined `t_session_events` + `t_events` rows) → the RELEASED physical row
 * shape the first-party format chain decodes, plus the column mapping helpers
 * shared by both dialects. All functions are dialect-free and I/O-free —
 * unit-tested directly.
 *
 * Why the released shape: since 0.1.5 the session format is v3 and the read
 * path refuses anything older, so every stored log must be migrated. The
 * sanctioned migration is `@deepseek-ai/dsh-session-format-catalog`'s adjacent
 * v0→v1→v2→v3 chain, which consumes *physical rows* — exactly the shape this
 * backend's columns already hold (`f_kind`/`f_sequence`/`f_created_at`/
 * `f_data` + the two surface columns). `src/migrate.ts` therefore synthesizes
 * `{type, seq, time, data, …surface}` rows here and feeds them to the catalog;
 * this module owns the pure row → released-row conversion.
 *
 * Two stored shapes exist in the wild and both are handled:
 *
 * - **Identity logs** (written by the 0.1.2-era and current builds):
 *   `f_sequence == f_original_seq == the event's logical seq`, references are
 *   already in presented coordinates.
 * - **Legacy dense-renumbered logs** (rc.2 era): the old backend dropped
 *   `assistant/chunk` deltas at write time and pruned/renumbered provenance.
 *   `hasLegacyRenumbering` detects that shape; `buildSeqMap` maps upstream seqs
 *   to the presented (dense) seqs and `rowToReleasedRow` translates every
 *   audited reference through it. `storedInheritedCount` translates the stored
 *   `f_seed_length` (recorded in the first generation's upstream space) into
 *   the presented count.
 *
 * `scanRows` implements the crash-tail semantics: a never-committed tail
 * (unparsable JSON or a seq hole after the last `turn/end`) is cut and
 * reported as `tornFrom`; the same hole inside the committed region refuses.
 *
 * @module @visecy/dsh-session-persistence-rdb/log
 */

import type { SessionHeader } from "@deepseek-ai/dsh-session";
import { IGNORABLE_EVENT_ENCODING } from "./schema.ts";
import type { EventRow } from "./backend.ts";

/**
 * One synthesized RELEASED physical session row — the shape
 * `sessionFormatCatalog`'s v0/v3 codecs decode from a JSONL line. `sourceEventSeqs`
 * and `surfaceOp` are present only when the event carries them.
 */
export interface ReleasedRow {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
  sourceEventSeqs?: number[];
  surfaceOp?: unknown;
}

/**
 * A stored replace op's seq range under either spelling: the released-v0
 * `{start,end}` and the current `{startSeq,endSeq}`.
 */
interface StoredReplaceOp {
  op: "replace";
  start?: number;
  end?: number;
  startSeq?: number;
  endSeq?: number;
}

/** The seq range of a stored replace op, tolerating both spellings. */
function replaceRange(op: StoredReplaceOp): { start: number; end: number } | undefined {
  const start = op.start ?? op.startSeq;
  const end = op.end ?? op.endSeq;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

/**
 * `t_sessions` INSERT column values: the `SessionHeader` persistence columns +
 * the inherited-prefix cut (`f_seed_length`, stored only for a seeded header —
 * mirroring the released header record's `seedLength`) + the initial head
 * cursor + materialization identity (`f_incarnation`) + revision 0.
 * Dialect-free; both backends share it via `upsertSession`.
 * @param meta - the header being materialized (current format, version 3).
 * @param inheritedEventCount - exact inherited prefix length (presented seqs);
 *   required when `meta.isSeeded`, ignored (stored NULL) otherwise.
 * @param incarnation - the materialization identity for the new row.
 */
export function sessionInsertRow(
  meta: SessionHeader,
  inheritedEventCount: number,
  incarnation: string,
): {
  fSessionId: string;
  fHeadEventId: string;
  fHeadSequence: number;
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
  fIncarnation: string;
  fRevision: number;
} {
  return {
    fSessionId: meta.id,
    fHeadEventId: "",
    fHeadSequence: -1,
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fSeedLength: meta.isSeeded ? inheritedEventCount : null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
    fIncarnation: incarnation,
    fRevision: 0,
  };
}

/**
 * `t_sessions` ON CONFLICT update columns: refresh the header columns, but
 * PRESERVE the head cursor (`f_head_event_id`/`f_head_sequence`), the
 * materialization identity (`f_incarnation`/`f_revision`), and
 * `f_seed_length`. The cut is deliberately not refreshed: on a legacy
 * (rc.2-era) log the stored cut lives in the first generation's UPSTREAM seq
 * space and must stay untouched so every later read translates it
 * consistently (see {@link storedInheritedCount}); a log whose header needs a
 * different cut is rewritten once by the in-place format migration
 * (`rewriteSessionHeader`), which deliberately overrides this row.
 */
export function sessionConflictRow(meta: SessionHeader): {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
} {
  return {
    fVersion: meta.version,
    fCreatedAt: meta.createdAt,
    fCwd: meta.cwd ?? null,
    fParentSession: meta.parentSession ?? null,
    fOrigin: meta.origin ?? null,
    fDelegationDepth: meta.delegationDepth ?? null,
  };
}

/**
 * `t_sessions` UPDATE column values for an in-place FORMAT migration: unlike
 * {@link sessionConflictRow} this deliberately rewrites `f_seed_length`, because
 * the migration renumbers the log into presented coordinates and the stored cut
 * must follow it.
 * @param meta - the migrated (current-format) header.
 * @param inheritedEventCount - the migrated inherited prefix length.
 */
export function sessionRewriteRow(
  meta: SessionHeader,
  inheritedEventCount: number,
): {
  fVersion: number;
  fCreatedAt: number;
  fCwd: string | null;
  fParentSession: string | null;
  fSeedLength: number | null;
  fOrigin: string | null;
  fDelegationDepth: number | null;
} {
  return {
    ...sessionConflictRow(meta),
    fSeedLength: meta.isSeeded ? inheritedEventCount : null,
  };
}

/**
 * Whether stored rows were written by the rc.2-era delta-filtering backend:
 * any row whose presented seq differs from its recorded original seq proves a
 * dense renumbering happened at write time. Rows written by later builds always
 * satisfy `f_original_seq == f_sequence` (identity), so a log with no mismatch
 * needs no legacy reference remap.
 * @param rows - one session's seq rows (upstream + presented).
 * @returns true when the log contains a dense-renumbered legacy segment.
 */
export function hasLegacyRenumbering(
  rows: readonly { fSequence: number; fOriginalSeq: number }[],
): boolean {
  return rows.some((row) => row.fOriginalSeq !== row.fSequence);
}

/**
 * Translate a stored `f_seed_length` cut into the count this log's read
 * presents. For identity rows the stored cut IS the presented count. For a
 * legacy log the cut was recorded in the first generation's UPSTREAM seq space:
 * the inherited prefix of the dense presentation is exactly the rows whose
 * original seq falls below that cut (a delta-dropped seed compresses to fewer
 * rows than its upstream cut).
 * @param storedCut - `t_sessions.f_seed_length`; null when unseeded.
 * @param seqRows - ALL of the session's seq rows (upstream + presented).
 * @param legacy - whether the log carries a dense-renumbered segment.
 * @returns the inherited event count in presented (dense) coordinates.
 */
export function storedInheritedCount(
  storedCut: number | null,
  seqRows: readonly { fSequence: number; fOriginalSeq: number }[],
  legacy: boolean,
): number {
  if (storedCut === null) return 0;
  if (!legacy) return storedCut;
  let count = 0;
  for (const row of seqRows) {
    if (row.fOriginalSeq < storedCut) count += 1;
  }
  return count;
}

/**
 * Build the upstream→presented seq map for one session's legacy segment (only
 * meaningful when delta filtering renumbered the log).
 *
 * A session re-opened by resume (or forked) persists the seed segment and the
 * new segment in ONE log: the seed rows keep the PARENT session's upstream seqs
 * while the resumed rows carry the child session's own upstream seqs, which
 * renumber from the seed boundary and therefore OVERLAP the parent space. The
 * FIRST mapping wins so a seed-segment event's provenance reference resolves to
 * the seed-space row it actually derived from (rows are ordered by presented
 * seq, so the seed segment always precedes the resumed one); the resumed
 * segment's references are unique within their own space unless they point at a
 * shared value, which only the parent could have produced first.
 * @param rows - one session's seq rows (upstream + presented), ordered by seq
 *   ascending (only the two seq columns are needed).
 * @returns map from `f_original_seq` to `f_sequence` (first occurrence wins).
 */
export function buildSeqMap(
  rows: readonly Pick<EventRow, "fSequence" | "fOriginalSeq">[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!map.has(row.fOriginalSeq)) map.set(row.fOriginalSeq, row.fSequence);
  }
  return map;
}

/**
 * Translate a stored replace op into the RELEASED-v0 physical spelling
 * (`{op:'replace',start,end}`) whose range follows the upstream→presented map.
 * Only the migration pre-pass uses this: the released decoder expects the old
 * spelling, and the v2→v3 edge renames the range to `startSeq`/`endSeq` while
 * remapping it into target coordinates. A present-format marker must NEVER be
 * produced from this helper — see {@link currentSurfaceOp} for that direction.
 * @param op - the stored surface op (either spelling).
 * @param remap - upstream→presented seq mapping (identity when absent).
 * @returns the released-v0 surface op.
 */
export function releasedSurfaceOp(op: unknown, remap: (seq: number) => number): unknown {
  if (op === "append") return "append";
  if (op === null || typeof op !== "object") return op;
  const range = replaceRange(op as StoredReplaceOp);
  if (range === undefined) return op;
  return { op: "replace", start: remap(range.start), end: remap(range.end) };
}

/**
 * Normalize a stored surface op into the current-format spelling
 * (`{op:'replace',startSeq,endSeq}`), keeping its seqs verbatim. Used when a
 * present-format row is read directly: re-emitting a stored legacy
 * `{start,end}` marker under the current format would make the surface fold
 * read it back as an invalid marker (silent corruption).
 * @param op - the stored surface op (either spelling).
 * @returns the current-format surface op.
 */
export function currentSurfaceOp(op: unknown): unknown {
  if (op === "append") return "append";
  if (op === null || typeof op !== "object") return op;
  const range = replaceRange(op as StoredReplaceOp);
  if (range === undefined) return op;
  return { op: "replace", startSeq: range.start, endSeq: range.end };
}

/**
 * Rewrite the audited same-artifact references inside one legacy event payload
 * from upstream coordinates into the presented (dense) coordinates. These are
 * exactly the references the format chain remaps when it rewrites the log
 * (`compaction/{summary,prune}` shadow ranges, title message seqs, and
 * `command/done`'s source seq); a reference missing from the map is kept
 * verbatim — tolerated like a scan hole, never silently dropped.
 * @param type - the event type.
 * @param data - the parsed event payload (mutated in place).
 * @param remap - upstream→presented seq mapping.
 */
export function remapReleasedData(
  type: string,
  data: unknown,
  remap: (seq: number) => number,
): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return;
  const record = data as Record<string, unknown>;
  const remapArray = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => (typeof entry === "number" ? remap(entry) : entry));
  };
  switch (type) {
    case "compaction/summary":
    case "compaction/prune": {
      const range = record["shadowedRange"];
      if (range !== null && typeof range === "object" && !Array.isArray(range)) {
        const { start, end } = range as { start?: unknown; end?: unknown };
        if (typeof start === "number" && typeof end === "number") {
          record["shadowedRange"] = { start: remap(start), end: remap(end) };
        }
      }
      if (record["shadowedSeqs"] !== undefined) {
        record["shadowedSeqs"] = remapArray(record["shadowedSeqs"]);
      }
      break;
    }
    case "session/title":
    case "session/title-llm-request": {
      if (record["messageSeqs"] !== undefined) {
        record["messageSeqs"] = remapArray(record["messageSeqs"]);
      }
      break;
    }
    case "command/done": {
      const source = record["sourceEventSeq"];
      if (typeof source === "number") record["sourceEventSeq"] = remap(source);
      break;
    }
    default:
      break;
  }
}

/**
 * Reconstruct a RELEASED physical row from a joined row. The emitted row
 * carries the PRESENTED seq (`row.fSequence`). For a legacy
 * (rc.2-era, dense-renumbered) segment, `sourceEventSeqs`, a positional
 * `replace` surface op's range, and the audited payload references are remapped
 * from upstream seqs into presented seqs through `remap` (an entry missing from
 * the map is kept verbatim — tolerated like a scan hole, not corruption).
 * Present-format rows pass through identity. An event whose envelope marked
 * `ignorable: true` is stored with the ignorable encoding and re-marked here, so
 * the format codecs see the marker.
 * @param row - the joined `t_session_events` + `t_events` row.
 * @param remap - upstream→presented seq mapping; identity for present-format rows.
 * @param projectSurface - which surface-op spelling the target format expects:
 *   {@link releasedSurfaceOp} for a released-v0 decode,
 *   {@link currentSurfaceOp} for a present-format decode.
 * @returns the released physical row; throws when `f_data` is not valid JSON
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToReleasedRow(
  row: EventRow,
  remap: (seq: number) => number = (seq) => seq,
  projectSurface: (op: unknown, remap: (seq: number) => number) => unknown = releasedSurfaceOp,
): ReleasedRow {
  const data = JSON.parse(row.fData) as unknown;
  remapReleasedData(row.fKind, data, remap);
  const released: ReleasedRow = {
    type: row.fKind,
    seq: row.fSequence,
    time: row.fCreatedAt,
    data,
  };
  if (row.fEncoding === IGNORABLE_EVENT_ENCODING) released.ignorable = true;
  if (row.fSourceEventSeqs !== null) {
    const sources = (JSON.parse(row.fSourceEventSeqs) as number[]).map(remap);
    // The released surface contract admits an empty array only for
    // `assistant/message`; the write path stores an empty set as NULL, so an
    // empty array here is a legacy artifact of that convention and is omitted.
    if (sources.length > 0) released.sourceEventSeqs = sources;
  }
  if (row.fSurfaceOp !== null) {
    released.surfaceOp = projectSurface(JSON.parse(row.fSurfaceOp) as unknown, remap);
  }
  return released;
}

/**
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by presented seq ascending.
 * @param base - the presented seq the first row is expected to carry; `0` for
 *   a whole-log read.
 * @returns the preserved rows, plus `tornFrom` — the presented seq the physical
 *   delete starts at — when a torn tail exists.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
): { preserved: EventRow[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  const parsed: boolean[] = rows.map((row) => {
    try {
      JSON.parse(row.fData);
      return true;
    } catch {
      return false;
    }
  });

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i] === true && rows[i]?.fKind === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  const preserved: EventRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (parsed[i] !== true) {
      if (i <= lastTurnEnd)
        throw new Error(`corrupt session log: unparsable committed event at seq ${row.fSequence}`);
      break; // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (row.fSequence !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${row.fSequence})`,
        );
      break; // gap after the last turn/end — torn tail, stop
    }
    preserved.push(row);
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for the write path's repair.
  return preserved.length < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}

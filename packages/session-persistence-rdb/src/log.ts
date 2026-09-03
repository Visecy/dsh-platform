/**
 * Representation conversion for a session log: persisted rows (`t_sessions` /
 * joined `t_session_events` + `t_events` rows) → the upstream
 * `SessionHeader` / `SessionEvent`, and the reverse column mapping helpers.
 * All functions are dialect-free and I/O-free — unit-tested directly.
 *
 * Since 0.1.2 the backend persists EVERY event the coordinator delivers with
 * its exact seq (`f_sequence` == `f_original_seq` == the logical seq), so the
 * write path needs no renumbering and reads pass through as identity.
 *
 * Backward read tolerance: rows written by the rc.2-era backend may still be
 * dense-renumbered (`f_original_seq` != `f_sequence`, delta events dropped).
 * `hasLegacyRenumbering` detects that shape and routes the read through the
 * old remap path: `buildSeqMap` maps upstream seqs to persisted seqs and
 * `rowToEvent` / `remapSurfaceOp` / `remapShadowedRange` translate provenance
 * into the dense space the log presents. Rows written by this build pass
 * through identity (no map). A legacy log's stored inherited cut
 * (`f_seed_length`, recorded in the UPSTREAM space of its first generation)
 * is translated to the dense row space by `storedInheritedCount`.
 *
 * `scanRows` implements the crash-tail semantics (torn-tail cut + committed
 * corruption refusal), unchanged by persist-everything.
 *
 * @module @visecy/dsh-session-persistence-rdb/log
 */

import type { SessionEvent, SessionHeader, SessionId, SurfaceOp } from "@deepseek-ai/dsh-session";
import { IGNORABLE_EVENT_ENCODING } from "./schema.ts";
import type { EventRow, SessionRow } from "./backend.ts";

/**
 * Reconstruct the {@link SessionHeader} from a `t_sessions` row. `NULL`
 * columns map to omitted optional fields. `f_seed_length` (the out-of-log
 * inherited-prefix cut) is NOT part of the logical header anymore: its
 * PRESENCE is the `isSeeded` marker (mirroring the JSONL backend's
 * `seedLength` line field); the cut itself travels out of band on every read
 * (see {@link storedInheritedCount}).
 * @param row - the `t_sessions` table row.
 * @returns the header; `isSeeded` is derived, never stored in the header.
 */
export function rowToMeta(row: SessionRow): SessionHeader {
  if (!Number.isSafeInteger(row.fCreatedAt) || row.fCreatedAt < 0) {
    throw new Error("stored session createdAt must be a non-negative safe integer");
  }
  return {
    version: row.fVersion,
    id: row.fSessionId as SessionId,
    createdAt: row.fCreatedAt,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession as SessionId } : {}),
    isSeeded: row.fSeedLength !== null,
    ...(row.fOrigin !== null ? { origin: row.fOrigin as "subagent" } : {}),
    ...(row.fDelegationDepth === null ? {} : { delegationDepth: row.fDelegationDepth }),
  };
}

/**
 * `t_sessions` INSERT column values: the `SessionHeader` persistence columns +
 * the inherited-prefix cut (`f_seed_length`, stored only for a seeded
 * header — mirroring the JSONL header line) + the initial head cursor +
 * materialization identity (`f_incarnation`) + revision 0.
 * Dialect-free; both backends share it via `upsertSession`.
 * @param meta - the header being materialized.
 * @param inheritedEventCount - exact inherited prefix length (row space);
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
 * consistently (see {@link storedInheritedCount}); on a current log the
 * coordinator passes back exactly the stored value, so refreshing would be a
 * no-op anyway.
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
 * Whether stored rows were written by the rc.2-era delta-filtering backend:
 * any row whose persisted seq differs from its recorded original seq proves a
 * dense renumbering happened at write time. Rows written by this build always
 * satisfy `f_original_seq == f_sequence` (identity), so a log with no
 * mismatch needs no legacy remap.
 * @param rows - one session's seq rows (upstream + persisted).
 * @returns true when the log contains a dense-renumbered legacy segment.
 */
export function hasLegacyRenumbering(
  rows: readonly { fSequence: number; fOriginalSeq: number }[],
): boolean {
  return rows.some((row) => row.fOriginalSeq !== row.fSequence);
}

/**
 * Translate a stored `f_seed_length` cut into the count this log's read
 * presents. For rows written by this build (identity), the stored cut IS the
 * row-space count. For a legacy log the cut was recorded in the first
 * generation's UPSTREAM seq space: the inherited prefix of the dense
 * presentation is exactly the rows whose original seq falls below that cut
 * (a delta-dropped seed compresses to fewer rows than its upstream cut).
 * @param storedCut - `t_sessions.f_seed_length`; null when unseeded.
 * @param seqRows - ALL of the session's seq rows (upstream + persisted).
 * @param legacy - whether the log carries a dense-renumbered segment.
 * @returns the inherited event count of the presented (row-space) log.
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
 * Remap a stored {@link SurfaceOp} from upstream seqs to persisted seqs. An
 * `append` op carries no seqs; a positional `replace`'s `start`/`end` name
 * surface nodes by UPSTREAM seq and must follow {@link SessionEvent.sourceEventSeqs}
 * through the same upstream→persisted map when a legacy segment
 * re-numbered the log — otherwise the replacement range is looked up against
 * DENSE seqs and the surface fold rejects the log ("start seq N not found in
 * surface"). With current rows the mapping is identity.
 * @param op - the stored surface op.
 * @param remap - upstream→persisted seq mapping (identity when absent).
 * @returns the remapped surface op.
 */
export function remapSurfaceOp(op: SurfaceOp, remap: (seq: number) => number): SurfaceOp {
  if (op === "append") return op;
  return { op: "replace", start: remap(op.start), end: remap(op.end) };
}

/**
 * The compact metering events (`compaction/summary`, `compaction/prune`) carry the
 * token-meter's shadow-price claim in `data.shadowedRange`: the inclusive
 * surface-node seqs of the range the IMMEDIATELY following surface `replace`
 * shadows. The range names surface nodes by UPSTREAM seq, so it must follow
 * the replace's `surfaceOp` through the same upstream→persisted map — the
 * fold compares claim and replacement ranges for exact equality, and an
 * un-remapped claim (upstream) next to a remapped replacement range (dense)
 * makes replay fail loud ("token surface: replace ... has no adjacent shadow
 * price"). With current rows the mapping is identity.
 * @param range - the stored shadowed range (upstream seqs).
 * @param remap - upstream→persisted seq mapping (identity when absent).
 * @returns the remapped shadowed range.
 */
export function remapShadowedRange(
  range: { start: number; end: number },
  remap: (seq: number) => number,
): { start: number; end: number } {
  return { start: remap(range.start), end: remap(range.end) };
}

/**
 * Reconstruct a {@link SessionEvent} from a joined row. The emitted event
 * carries the PRESENTED seq (`row.fSequence`). For a legacy
 * (rc.2-era, dense-renumbered) segment, `sourceEventSeqs` entries, a
 * positional `replace` {@link SurfaceOp}'s range, and the compact metering
 * events' `shadowedRange` are remapped from upstream seqs to persisted seqs
 * through `seqMap` (an entry missing from the map is kept verbatim —
 * tolerated like a scan hole, not corruption). Current rows pass through
 * identity (no map). An event whose envelope marked `ignorable: true` is
 * stored with the ignorable encoding and re-marked here, so the coordinator's
 * unknown-type tolerance sees the marker.
 * @param row - the joined `t_session_events` + `t_events` row.
 * @param seqMap - upstream→persisted seq map, present only when a legacy
 *   segment re-numbered the log (optional).
 * @returns the reconstructed event; throws when a JSON column fails to parse
 *   ({@link scanRows} treats that as a hole, not corruption, in the tail).
 */
export function rowToEvent(row: EventRow, seqMap?: ReadonlyMap<number, number>): SessionEvent {
  // Surface-metadata fields are conditional on the event type in the type
  // system; spread them so each variant gets only the fields it declares.
  const remap = (seq: number) => seqMap?.get(seq) ?? seq;
  const surfaceFields = {
    ...(row.fSourceEventSeqs !== null
      ? {
          sourceEventSeqs: (JSON.parse(row.fSourceEventSeqs) as number[]).map(remap),
        }
      : {}),
    ...(row.fSurfaceOp !== null
      ? {
          surfaceOp: remapSurfaceOp(JSON.parse(row.fSurfaceOp) as SurfaceOp, remap),
        }
      : {}),
  };
  const data = JSON.parse(row.fData) as SessionEvent["data"];
  // `compaction/summary` / `compaction/prune` are plugin-merged types whose
  // metering data is not part of the core `SessionEventMap`; narrow through a
  // structural view to remap the shadow-price claim's range (see
  // {@link remapShadowedRange}).
  if (row.fKind === "compaction/summary" || row.fKind === "compaction/prune") {
    const metering = data as unknown as { shadowedRange?: { start: number; end: number } };
    if (metering.shadowedRange !== undefined) {
      metering.shadowedRange = remapShadowedRange(metering.shadowedRange, remap);
    }
  }
  return {
    type: row.fKind as SessionEvent["type"],
    seq: row.fSequence,
    time: row.fCreatedAt,
    data,
    ...(row.fEncoding === IGNORABLE_EVENT_ENCODING ? { ignorable: true } : {}),
    ...surfaceFields,
  } as SessionEvent;
}

/**
 * Build the upstream→persisted seq map for one session's legacy segment
 * (only meaningful when delta filtering re-numbered the log).
 *
 * A session re-opened by resume (or forked) persists the seed segment and the
 * new segment in ONE log: the seed rows keep the PARENT session's upstream seqs
 * while the resumed rows carry the child session's own upstream seqs, which
 * renumber from the seed boundary and therefore OVERLAP the parent space. The
 * FIRST mapping wins so a seed-segment event's provenance reference resolves to
 * the seed-space row it actually derived from (rows are ordered by persisted
 * seq, so the seed segment always precedes the resumed one); the resumed
 * segment's references are unique within their own space unless they point at a
 * shared value, which only the parent could have produced first.
 * @param rows - one session's seq rows (upstream + persisted), ordered by seq
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
 * Find the preserved prefix of ordered event rows. Fully written rows in an
 * interrupted final turn remain in the prefix. The first unparsable row or seq
 * gap after the last `turn/end` marks a tolerated torn tail; the same hole in
 * the committed region rejects.
 *
 * @param rows - one session's event rows, ordered by persisted seq ascending.
 * @param base - the persisted seq the first row is expected to carry; `0` for
 *   a whole log, the requested `fromSeq` for a suffix read (`loadStoredFrom`).
 * @param seqMap - upstream→persisted seq map forwarded to {@link rowToEvent};
 *   present only for a legacy (dense-renumbered) log.
 * @returns the preserved event prefix, plus `tornFrom` — the persisted seq the
 *   physical delete starts at — when a torn tail exists.
 */
export function scanRows(
  rows: readonly EventRow[],
  base = 0,
  seqMap?: ReadonlyMap<number, number>,
): { preserved: SessionEvent[]; tornFrom?: number } {
  // Pass 1: parse each row's data; a row whose data is not valid JSON is a hole.
  // (The seq/type COLUMNS are always present even when `data` is corrupt.)
  interface Parsed {
    ok: boolean;
    event?: SessionEvent;
  }
  const parsed: Parsed[] = rows.map((row) => {
    try {
      return { ok: true, event: rowToEvent(row, seqMap) };
    } catch {
      return { ok: false };
    }
  });

  // The last index that is a valid `turn/end` — holes through a closed turn
  // are always committed corruption.
  let lastTurnEnd = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i]?.ok && rows[i]?.fKind === "turn/end") {
      lastTurnEnd = i;
      break;
    }
  }

  // Preserve the contiguous prefix, including a complete interrupted turn;
  // holes through the last committed boundary throw, while later holes stop.
  const preserved: SessionEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = parsed[i];
    if (!p?.ok || p.event === undefined) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: unparsable committed event at seq ${rows[i]?.fSequence}`,
        );
      break; // torn tail fragment after the last turn/end — stop, tolerate
    }
    if (p.event.seq !== base + i) {
      if (i <= lastTurnEnd)
        throw new Error(
          `corrupt session log: seq gap in committed region (expected ${base + i}, got ${p.event.seq})`,
        );
      break; // gap after the last turn/end — torn tail, stop
    }
    preserved.push(p.event);
  }

  // Any rows past the preserved prefix are a never-committed torn tail; their
  // first seq is the deletion point for load's physical repair.
  return preserved.length < rows.length
    ? { preserved, tornFrom: base + preserved.length }
    : { preserved };
}

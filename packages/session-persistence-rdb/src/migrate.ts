/**
 * Stored-log decoding and legacy-format migration for the RDB backend.
 *
 * Every stored log is served as the CURRENT session format (v3). The read path
 * synthesizes the released physical records this backend's columns already
 * hold — a header record from the `t_sessions` row and one
 * `{type, seq, time, data, …surface}` row per stored event — and drives the
 * sanctioned adjacent chain through `sessionFormatCatalog` from
 * `@deepseek-ai/dsh-session-format-catalog`:
 *
 * ```
 * readHeader(physicalHeader)                      → directional classification
 * createRestore(physicalHeader, {recovery: 'strict', validation: 'transformed'})
 *   .decodeRow(physicalRow)…                      → v0→v1→v2→v3 streaming migration
 *   .finish()                                     → {header, inheritedEventCount, events}
 * assertVersion + assertStoredId + validateStoredEvents   → storage-contract gates
 * ```
 *
 * That single chain performs every logical v0→v3 step: system-prompt promotion
 * to the protected surface head, `assistant/chunk`→`assistant/attempt` stream
 * embedding, PTC vocabulary renames, the surface-op `start`/`end` →
 * `startSeq`/`endSeq` rename, and the audited reference remap. Nothing about
 * the logical migration is hand-rolled here.
 *
 * Two stored physical shapes exist and are handled distinctly:
 *
 * 1. **Identity logs** (0.1.2-era and current builds): `f_sequence` is already
 *    the event's logical seq and every reference is in presented coordinates.
 *    Rows are fed to the catalog verbatim (only the surface-op spelling is
 *    normalized to what the stored version's codec expects).
 * 2. **Legacy dense-renumbered logs** (rc.2 era, `f_original_seq !=
 *    f_sequence`): the old backend dropped `assistant/chunk` deltas at write
 *    time and pruned provenance, so the row stream is dense but its references
 *    live in upstream coordinates. A pre-pass (`log.ts`) translates
 *    `sourceEventSeqs`, surface ranges, shadow ranges, title/command
 *    references, and `f_seed_length` into presented coordinates, and — for a
 *    log that retained no `assistant/chunk` row at all — drops the pruned
 *    `assistant/message` chunk provenance (the v3 target forbids that field on
 *    `assistant/message` anyway; the v1→v2 edge would otherwise refuse a
 *    provenance list with no adjacent chunk attempt).
 *
 * Logs whose shape the sanctioned chain refuses (for example a surface event
 * that precedes the first `step/start`, which cannot acquire a protected
 * system head without reordering chronology) are refused loudly as
 * {@link SessionFormatUnsupportedError} naming the database — never silently
 * truncated or renumbered.
 *
 * @module @visecy/dsh-session-persistence-rdb/migrate
 */

// The catalog re-exports the format layer's refusal class, so this package
// needs no direct dependency on `@deepseek-ai/dsh-session-format` (which is a
// transitive dependency and therefore not resolvable from here under pnpm).
import {
  sessionFormatCatalog,
  SessionFormatUnsupportedMigrationError,
} from "@deepseek-ai/dsh-session-format-catalog";
import { SESSION_FORMAT_VERSION, SessionLogOffset } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  assertStoredId,
  assertVersion,
  validateStoredEvents,
  type SessionLocation,
} from "@deepseek-ai/dsh-session-persistence";
import type { EventRow, SessionRow } from "./backend.ts";
import {
  buildSeqMap,
  hasLegacyRenumbering,
  rowToReleasedRow,
  currentSurfaceOp,
  scanRows,
  storedInheritedCount,
  type ReleasedRow,
} from "./log.ts";

/** The installed format catalog must agree with the installed Session package. */
if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
  throw new Error(
    `session-persistence-rdb: format catalog v${sessionFormatCatalog.currentVersion} does not match Session v${SESSION_FORMAT_VERSION}`,
  );
}

/**
 * One stored session log decoded into the current logical format — the value
 * every handle read and write primitive operates on.
 */
export interface StoredLog {
  /** Migrated immutable header (always {@link SESSION_FORMAT_VERSION}). */
  readonly meta: SessionHeader;
  /** Exact fork-inherited prefix length in presented coordinates. */
  readonly inheritedEventCount: SessionLogOffset;
  /** Validated contiguous current-format events from seq 0. */
  readonly events: readonly SessionEvent[];
  /** The event values are freshly decoded/parsed, so they are caller-owned. */
  readonly eventState: "detached";
  /** Presented seq a never-committed torn tail starts at, when one exists. */
  readonly tornFrom?: number;
  /** Whether the presented seqs had to be read through the legacy remap path. */
  readonly legacy: boolean;
  /**
   * Whether the rows are already stored in the current format (no migration and
   * no legacy renumbering). `false` means a write open must rewrite the log
   * in place before appending, or the appended current-format rows would land
   * next to released-format rows the current decoder cannot read.
   */
  readonly current: boolean;
}

/**
 * Build the RELEASED physical header record for one stored session row.
 *
 * The two released header layouts differ: v0/v1 have no `isSeeded` field and
 * DERIVE it from `seedLength`'s presence, while v2/v3 carry `isSeeded`
 * explicitly and reject `seedLength` (both codecs validate an exact key set).
 * @param row - the `t_sessions` row.
 * @param inheritedEventCount - the inherited prefix length in the same
 *   coordinate space as the synthesized rows (presented/dense seqs).
 * @returns the physical header record accepted by the version's codec.
 */
export function physicalHeader(
  row: SessionRow,
  inheritedEventCount: number,
): Record<string, unknown> {
  const seeded = row.fSeedLength !== null;
  const base = {
    type: "session",
    version: row.fVersion,
    id: row.fSessionId,
    createdAt: row.fCreatedAt,
    delegationDepth: row.fDelegationDepth ?? 0,
    ...(row.fCwd !== null ? { cwd: row.fCwd } : {}),
    ...(row.fParentSession !== null ? { parentSession: row.fParentSession } : {}),
    ...(row.fOrigin !== null ? { origin: row.fOrigin } : {}),
  };
  return row.fVersion >= 2
    ? { ...base, isSeeded: seeded }
    : { ...base, ...(seeded ? { seedLength: inheritedEventCount } : {}) };
}

/** Translate one format-layer failure into the persistence seam's vocabulary. */
function migrationFailure(error: unknown, id: string, location?: SessionLocation): Error {
  if (error instanceof SessionFormatUnsupportedMigrationError) {
    return new SessionFormatUnsupportedError(
      location === undefined
        ? `${error.message} (session "${id}")`
        : `${error.message} (session "${id}"; raw store: ${location.path})`,
      location,
    );
  }
  if (error instanceof SessionPersistenceCorruptionError) return error;
  if (error instanceof SessionFormatUnsupportedError) return error;
  return new SessionPersistenceCorruptionError(
    `session "${id}": stored log is corrupt: ${
      error instanceof Error ? error.message : String(error)
    }${location === undefined ? "" : ` (raw store: ${location.path})`}`,
    { cause: error },
  );
}

/**
 * Classify and migrate one stored header without reading the event body. Used
 * by `stat`/`list`, which must observe sessions without decoding their logs.
 * @param row - the `t_sessions` row.
 * @param location - the backend artifact location for refusal diagnostics.
 * @returns the migrated current-format header.
 * @throws {SessionFormatUnsupportedError} for a version this build cannot read.
 * @throws {SessionPersistenceCorruptionError} for a malformed stored header.
 */
export function storedHeader(row: SessionRow, location?: SessionLocation): SessionHeader {
  // Only `seedLength`'s PRESENCE matters for a header-only read (`isSeeded`),
  // so the exact cut (which needs the body for a legacy log) is not required.
  const headerValue = physicalHeader(row, row.fSeedLength ?? 0);
  let header: Extract<
    ReturnType<typeof sessionFormatCatalog.readHeader>,
    { status: "current" | "migration-required" }
  >["header"];
  try {
    const classification = sessionFormatCatalog.readHeader(headerValue);
    if (classification.status === "unsupported") {
      throw new SessionFormatUnsupportedError(
        `${classification.reason} (session "${row.fSessionId}")${
          location === undefined ? "" : `; raw store: ${location.path}`
        }`,
        location,
      );
    }
    if (classification.status === "malformed") {
      const reason = new Error(classification.reason);
      throw new SessionPersistenceCorruptionError(
        `session "${row.fSessionId}": stored header is malformed: ${classification.reason}`,
        { cause: reason },
      );
    }
    header = classification.header;
  } catch (error) {
    if (
      error instanceof SessionFormatUnsupportedError ||
      error instanceof SessionPersistenceCorruptionError
    ) {
      throw error;
    }
    throw migrationFailure(error, row.fSessionId, location);
  }
  const meta = header as unknown as SessionHeader;
  assertVersion(meta, location);
  assertStoredId(row.fSessionId as SessionId, meta);
  return meta;
}

/**
 * Decode one stored session log into the current format, migrating released
 * formats through the build-static catalog.
 *
 * The physical torn-tail scan runs first (rows the write path never committed
 * are cut and reported as `tornFrom`), then the surviving rows are streamed
 * through the migration chain in one pass.
 * @param row - the `t_sessions` row.
 * @param rows - the session's joined event rows, presented seq ascending.
 * @param location - the backend artifact location for refusal diagnostics.
 * @returns the migrated log.
 * @throws {SessionFormatUnsupportedError} when the log cannot be faithfully
 *   migrated (unknown historical vocabulary, unrepresentable chronology).
 * @throws {SessionPersistenceCorruptionError} when the committed region is
 *   damaged.
 */
export function decodeStoredLog(
  row: SessionRow,
  rows: readonly EventRow[],
  location?: SessionLocation,
): StoredLog {
  const id = row.fSessionId;
  let preserved: EventRow[];
  let tornFrom: number | undefined;
  try {
    ({ preserved, tornFrom } = scanRows(rows));
  } catch (error) {
    throw new SessionPersistenceCorruptionError(
      `session "${id}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const legacy = hasLegacyRenumbering(rows);
  const inheritedEventCount = storedInheritedCount(row.fSeedLength, rows, legacy);
  const headerValue = physicalHeader(row, inheritedEventCount);

  let restore: ReturnType<typeof sessionFormatCatalog.createRestore>;
  try {
    restore = sessionFormatCatalog.createRestore(headerValue, {
      recovery: "strict",
      validation: "transformed",
    });
  } catch (error) {
    throw migrationFailure(error, id, location);
  }

  const remap = legacy ? buildSeqMap(rows) : undefined;
  const remapSeq = (seq: number): number => remap?.get(seq) ?? seq;
  // A delta-dropped legacy log retains no chunk row at all, so its
  // `assistant/message` provenance can only be the pruned remainder the old
  // write path left behind. The v1→v2 edge demands a complete adjacent chunk
  // attempt for a cited provenance list and the v3 target forbids the field on
  // `assistant/message` entirely; dropping it is the faithful reading.
  const dropPrunedChunkProvenance =
    legacy && !preserved.some((candidate) => candidate.fKind === "assistant/chunk");
  const projectSurface = row.fVersion === SESSION_FORMAT_VERSION ? currentSurfaceOp : undefined;

  for (const candidate of preserved) {
    let releasedRow: ReleasedRow;
    try {
      releasedRow = rowToReleasedRow(candidate, remapSeq, projectSurface);
      if (
        dropPrunedChunkProvenance &&
        releasedRow.type === "assistant/message" &&
        releasedRow.sourceEventSeqs !== undefined
      ) {
        delete releasedRow.sourceEventSeqs;
      }
    } catch (error) {
      throw migrationFailure(error, id, location);
    }
    try {
      restore.decodeRow(releasedRow);
    } catch (error) {
      throw migrationFailure(error, id, location);
    }
  }

  let artifact;
  try {
    artifact = restore.finish();
  } catch (error) {
    throw migrationFailure(error, id, location);
  }

  const meta = artifact.header as unknown as SessionHeader;
  assertVersion(meta, location);
  assertStoredId(row.fSessionId as SessionId, meta);
  const events = validateStoredEvents(
    meta,
    artifact.events.map((event) => event as unknown as SessionEvent),
    location,
  );
  return {
    meta,
    inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
    events,
    eventState: "detached",
    ...(tornFrom !== undefined ? { tornFrom } : {}),
    legacy,
    current: !legacy && row.fVersion === SESSION_FORMAT_VERSION,
  };
}

/**
 * Per-parent format catalogs for the session-format v3 → v4 edge.
 *
 * DSH 0.2.x moved `SESSION_FORMAT_VERSION` to 4, and the v3→v4 edge cannot run
 * off the build-static catalog: it synthesizes a `subagent/catalog` event into
 * the PARENT's log for every historical child, so it requires explicit child
 * evidence — one array per parent, with `[]` mandatory for a parent that has no
 * children. This module owns the three selectors that turn that requirement
 * into storage facts:
 *
 * - {@link catalogForSource} — the catalog that decodes one stored PARENT log.
 *   Every stored version below the current one gets the child-bound catalog
 *   (a v0/v1/v2 log also traverses the v3→v4 edge); a current-format log gets
 *   the static catalog.
 * - {@link prerequisiteCatalogFor} — the catalog that decodes one CHILD's own
 *   log while collecting evidence: the prerequisite-only (v0–V3) catalog, so
 *   collection never recurses into a grandchild catalog.
 * - {@link factFromArtifact} / {@link unavailableFact} — one child's evidence,
 *   or the format's own sanctioned identity-only degradation.
 *
 * The fact shape is the format layer's (`childId` + `childCreatedAt` +
 * `descriptorCount` + `descriptor` [+ optional `sourcePath`]), and the v3→v4
 * stage interprets the descriptor itself: exactly one supported descriptor
 * (`version` 1/2/3) yields a version-0 entry with that child's mode
 * (`version: 1` always means `continuable`), anything else yields the version-1
 * `mode: 'unknown'` entry.
 *
 * `historicalChildCatalogSource` implements the same collection for the
 * first-party JSONL backend but is exported by
 * `@deepseek-ai/dsh-session-format-v3-to-v4` — a package the catalog depends on
 * but does not re-export (verified for 0.2.0-rc.2 and 0.2.1-alpha.1). Rather
 * than add a second direct dependency the deployment would have to resolve,
 * {@link historicalChildFact} mirrors that function exactly, including its
 * validation: a knowingly malformed descriptor must make collection fail (and
 * therefore degrade), because the v3→v4 stage itself refuses such evidence and
 * would otherwise take the parent down with it.
 *
 * @module @visecy/dsh-session-persistence-rdb/catalog
 */

import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import {
  createSessionFormatCatalogWithChildren,
  historicalSessionFormatCatalog,
  sessionFormatCatalog,
} from "@deepseek-ai/dsh-session-format-catalog";

/**
 * One element of a parent's historical child evidence array — structurally the
 * format layer's `SessionFormatJsonValue`, derived from the catalog's own
 * signature so this package needs no direct dependency on the format package.
 */
export type ChildFact = Parameters<typeof createSessionFormatCatalogWithChildren>[0][number];

/**
 * One child's own decoded log at its STORED version (the prerequisite read):
 * identity, exact inherited cut, and the child's events.
 */
export type PrerequisiteArtifact = ReturnType<
  ReturnType<typeof historicalSessionFormatCatalog.createRestore>["finish"]
>;

/** The format catalog this backend drives, whichever selector produced it. */
export type FormatCatalog = ReturnType<typeof createSessionFormatCatalogWithChildren>;

/**
 * The catalog that decodes one stored session log.
 *
 * Anything below the installed format version traverses the v3→v4 edge and
 * therefore NEEDS the child evidence — including a log with no children, which
 * must still be declared with an explicit `[]`. Only a current-format log is
 * served by the static catalog (reads of an already-migrated log do not touch
 * child evidence at all).
 * @param storedVersion - the row's stored `f_version`.
 * @param children - the complete direct-child evidence for this parent.
 * @returns the catalog to drive `createRestore` with.
 */
export function catalogForSource(
  storedVersion: number,
  children: readonly ChildFact[],
): ReturnType<typeof createSessionFormatCatalogWithChildren> {
  return storedVersion >= SESSION_FORMAT_VERSION
    ? sessionFormatCatalog
    : createSessionFormatCatalogWithChildren(children);
}

/**
 * The catalog that decodes one CHILD's own log while collecting evidence: the
 * prerequisite-only (v0–V3) catalog for a historical child, the static catalog
 * for a child already stored at the current version. The historical catalog has
 * no v3→v4 edge, so collecting a parent's evidence never recurses into a
 * grandchild catalog (a child's own migration collects its own children
 * separately).
 * @param storedVersion - the child row's stored `f_version`.
 * @returns the catalog to drive `createRestore` with.
 */
export function prerequisiteCatalogFor(
  storedVersion: number,
): ReturnType<typeof createSessionFormatCatalogWithChildren> {
  return storedVersion >= SESSION_FORMAT_VERSION
    ? sessionFormatCatalog
    : historicalSessionFormatCatalog;
}

/**
 * The format's sanctioned identity-only fact: the child exists (its row carries
 * id + creation time) but its log or descriptor cannot supply mode evidence.
 * The v3→v4 stage turns this into a version-1 `mode: 'unknown'` entry without
 * inventing a label.
 * @param childId - the child's own session id.
 * @param childCreatedAt - the child's header creation time.
 * @returns the degraded fact.
 */
export function unavailableFact(childId: string, childCreatedAt: number): ChildFact {
  return { childId, childCreatedAt, descriptorCount: 0, descriptor: null };
}

/**
 * Collect one child's evidence from its own decoded log — the RDB analogue of
 * the first-party JSONL backend's `historicalChildCatalogSource`. Only
 * descriptors at or after the child's OWN inherited cut count (the child may be
 * a seeded fork), which is why the cut comes from the decoded artifact and is
 * never re-derived in SQL.
 * @param artifact - the child's decoded stored-format log.
 * @returns the child fact the parent's catalog will interpret.
 * @throws {Error} when the artifact is not a subagent child with a direct
 *   parent, or when its single supported descriptor has invalid discovery
 *   fields.
 */
export function historicalChildFact(artifact: PrerequisiteArtifact): ChildFact {
  const header = artifact.header;
  if (header.origin !== "subagent" || header.parentSession === undefined) {
    throw new Error("catalog migration requires a subagent child with a direct parent");
  }
  const descriptors = artifact.events.filter(
    (event) => event.type === "subagent/descriptor" && event.seq >= artifact.inheritedEventCount,
  );
  const source = {
    childId: header.id,
    childCreatedAt: header.createdAt,
    descriptorCount: descriptors.length,
    descriptor: descriptors[0]?.data ?? null,
  };
  // Validate now: the v3→v4 stage refuses a supported descriptor with invalid
  // discovery fields, and that refusal must stay LOCAL to this child.
  childCatalogFact(source);
  return source;
}

/**
 * {@link historicalChildFact} as the storage layer uses it: a child whose log
 * cannot be decoded, has no single supported descriptor, or carries a malformed
 * one yields `undefined` so the caller can degrade to
 * {@link unavailableFact} instead of refusing the parent.
 * @param artifact - the child's decoded stored-format log.
 * @returns the child fact, or `undefined` when the child cannot supply it.
 */
export function factFromArtifact(artifact: PrerequisiteArtifact): ChildFact | undefined {
  try {
    return historicalChildFact(artifact);
  } catch {
    return undefined;
  }
}

/**
 * Interpret only the discovery fields of a known historical descriptor and
 * throw for a malformed one — the exact validation the v3→v4 edge performs, so
 * collection can degrade BEFORE the parent's migration is attempted.
 * @param source - collected child identity plus descriptor evidence.
 */
function childCatalogFact(source: {
  childId: string;
  childCreatedAt: number;
  descriptorCount: number;
  descriptor: unknown;
}): void {
  const descriptor = source.descriptor;
  const known =
    descriptor !== null &&
    typeof descriptor === "object" &&
    !Array.isArray(descriptor) &&
    [1, 2, 3].includes((descriptor as { version?: unknown }).version as number);
  if (source.descriptorCount !== 1 || !known) return;
  const record = descriptor as { version: number; provider?: unknown; mode?: unknown };
  if (typeof record.provider !== "string") {
    throw new Error(`session ${source.childId} has an invalid subagent descriptor provider`);
  }
  if (
    record.version !== 1 &&
    record.mode !== "continuable" &&
    record.mode !== "one-shot"
  ) {
    throw new Error(`session ${source.childId} has an invalid subagent descriptor mode`);
  }
}

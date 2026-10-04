-- ============================================================================
-- GOLDEN FIXTURE — DSH session format v3, stored by the RDB persistence backend.
-- Do not edit by hand: regenerate with
--   DSH_CAPTURE_FIXTURE=1 npx vitest run src/__tests__/capture-v3-fixture.spec.ts
-- ----------------------------------------------------------------------------
-- produced by: @visecy/dsh-session-persistence-rdb@0.1.22 (Visecy/dsh-platform) via
--              src/__tests__/capture-v3-fixture.spec.ts
-- dsh version: 0.1.5-rc.1
-- session format version: 3 (v3)
-- sqlite schema version: 1 (application_id 0x44534850)
-- git commit: 3dbe195e3f080b9d9e5cf92e507f2afa45404668 (feat/zero-patch-auth)
-- note: recorded from HEAD at capture time; the fixture itself landed in the
--       next commit on this branch.
-- captured: 2026-10-04
-- ----------------------------------------------------------------------------
-- Opaque identity UUIDs are canonicalized (f_event_id/f_parent_id/
-- f_head_event_id -> evt-NNNN, f_incarnation -> inc-NNNN, f_store_id ->
-- store-NNNN) in primary-key order so captures are diff-free; all other
-- stored values are exactly what the build wrote.
-- ============================================================================

PRAGMA user_version = 1;
PRAGMA application_id = 1146308688;

BEGIN;

CREATE TABLE "t_events" (
  "f_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "f_event_id" TEXT NOT NULL UNIQUE,
  "f_parent_id" TEXT NOT NULL DEFAULT '',
  "f_kind" TEXT NOT NULL DEFAULT '',
  "f_role" TEXT NOT NULL DEFAULT '',
  "f_name" TEXT NOT NULL DEFAULT '',
  "f_action_id" TEXT NOT NULL DEFAULT '',
  "f_encoding" TEXT NOT NULL DEFAULT '',
  "f_data" TEXT NOT NULL,
  "f_created_at" INTEGER NOT NULL DEFAULT 0,
  "f_original_seq" INTEGER NOT NULL,
  "f_source_event_seqs" TEXT,
  "f_surface_op" TEXT
) STRICT;

CREATE TABLE "t_persistence_state" (
  "f_singleton" INTEGER PRIMARY KEY,
  "f_store_id" TEXT NOT NULL,
  CHECK (f_singleton = 1)
) STRICT;

CREATE TABLE "t_session_events" (
  "f_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "f_session_id" TEXT NOT NULL REFERENCES "t_sessions"("f_session_id") ON DELETE CASCADE,
  "f_event_id" TEXT NOT NULL REFERENCES "t_events"("f_event_id") ON DELETE CASCADE,
  "f_sequence" INTEGER NOT NULL,
  UNIQUE ("f_session_id", "f_sequence")
) STRICT;

CREATE TABLE "t_sessions" (
  "f_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "f_session_id" TEXT NOT NULL UNIQUE,
  "f_head_event_id" TEXT NOT NULL DEFAULT '',
  "f_head_sequence" INTEGER NOT NULL DEFAULT -1,
  "f_version" INTEGER NOT NULL,
  "f_created_at" INTEGER NOT NULL,
  "f_cwd" TEXT,
  "f_parent_session" TEXT,
  "f_seed_length" INTEGER,
  "f_origin" TEXT,
  "f_delegation_depth" INTEGER,
  "f_incarnation" TEXT NOT NULL,
  "f_revision" INTEGER NOT NULL
) STRICT;

-- t_persistence_state: 1 row
INSERT INTO "t_persistence_state" ("f_singleton", "f_store_id") VALUES (1, 'store-0001');

-- t_sessions: 3 rows
INSERT INTO "t_sessions" ("f_id", "f_session_id", "f_head_event_id", "f_head_sequence", "f_version", "f_created_at", "f_cwd", "f_parent_session", "f_seed_length", "f_origin", "f_delegation_depth", "f_incarnation", "f_revision") VALUES (1, 'parent-1', 'evt-0001', 6, 3, 1000, '/workspaces/parent-1', NULL, NULL, NULL, NULL, 'inc-0001', 2);
INSERT INTO "t_sessions" ("f_id", "f_session_id", "f_head_event_id", "f_head_sequence", "f_version", "f_created_at", "f_cwd", "f_parent_session", "f_seed_length", "f_origin", "f_delegation_depth", "f_incarnation", "f_revision") VALUES (3, 'child-1', 'evt-0002', 6, 3, 2000, '/workspaces/parent-1', 'parent-1', NULL, 'subagent', 1, 'inc-0002', 2);
INSERT INTO "t_sessions" ("f_id", "f_session_id", "f_head_event_id", "f_head_sequence", "f_version", "f_created_at", "f_cwd", "f_parent_session", "f_seed_length", "f_origin", "f_delegation_depth", "f_incarnation", "f_revision") VALUES (5, 'plain-2', 'evt-0003', 5, 3, 1000, NULL, NULL, NULL, NULL, NULL, 'inc-0003', 1);

-- t_events: 20 rows
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (1, 'evt-0004', '', 'turn/start', 'turn', '', '', 'json', '{"turn":1}', 1, 0, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (2, 'evt-0005', 'evt-0004', 'step/start', 'turn', '', '', 'json', '{"turn":1,"step":1}', 2, 1, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (3, 'evt-0006', 'evt-0005', 'user/message', 'user', '', '', 'json', '{"id":"one-turn-user","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}', 3, 2, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (4, 'evt-0007', 'evt-0006', 'assistant/message', 'model', '', '', 'json', '{"turn":1,"step":1,"stream":[],"message":{"id":"one-turn-assistant","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}}}', 4, 3, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (5, 'evt-0008', 'evt-0007', 'step/end', 'turn', '', '', 'json', '{"turn":1,"step":1}', 5, 4, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (6, 'evt-0009', 'evt-0008', 'turn/end', 'turn', '', '', 'json', '{"turn":1,"reason":{"kind":"completed"}}', 6, 5, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (7, 'evt-0001', 'evt-0009', 'subagent/catalog', '', '', '', 'json', '{"version":0,"childId":"child-1","childCreatedAt":2000,"mode":"continuable","label":"worker"}', 7, 6, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (8, 'evt-0010', '', 'turn/start', 'turn', '', '', 'json', '{"turn":1}', 1, 0, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (9, 'evt-0011', 'evt-0010', 'step/start', 'turn', '', '', 'json', '{"turn":1,"step":1}', 2, 1, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (10, 'evt-0012', 'evt-0011', 'user/message', 'user', '', '', 'json', '{"id":"one-turn-user","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}', 3, 2, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (11, 'evt-0013', 'evt-0012', 'assistant/message', 'model', '', '', 'json', '{"turn":1,"step":1,"stream":[],"message":{"id":"one-turn-assistant","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}}}', 4, 3, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (12, 'evt-0014', 'evt-0013', 'step/end', 'turn', '', '', 'json', '{"turn":1,"step":1}', 5, 4, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (13, 'evt-0015', 'evt-0014', 'turn/end', 'turn', '', '', 'json', '{"turn":1,"reason":{"kind":"completed"}}', 6, 5, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (14, 'evt-0002', 'evt-0015', 'subagent/descriptor', '', '', '', 'json', '{"version":3,"mode":"continuable","provider":"mock","label":"worker"}', 7, 6, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (15, 'evt-0016', '', 'turn/start', 'turn', '', '', 'json', '{"turn":1}', 1, 0, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (16, 'evt-0017', 'evt-0016', 'step/start', 'turn', '', '', 'json', '{"turn":1,"step":1}', 2, 1, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (17, 'evt-0018', 'evt-0017', 'user/message', 'user', '', '', 'json', '{"id":"one-turn-user","role":"user","content":[{"type":"text","text":"hi"}],"source":{"kind":"user"}}', 3, 2, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (18, 'evt-0019', 'evt-0018', 'assistant/message', 'model', '', '', 'json', '{"turn":1,"step":1,"stream":[],"message":{"id":"one-turn-assistant","role":"assistant","content":[{"type":"text","text":"hello"}],"source":{"kind":"model","provider":"mock","model":"mock"}}}', 4, 3, NULL, '"append"');
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (19, 'evt-0020', 'evt-0019', 'step/end', 'turn', '', '', 'json', '{"turn":1,"step":1}', 5, 4, NULL, NULL);
INSERT INTO "t_events" ("f_id", "f_event_id", "f_parent_id", "f_kind", "f_role", "f_name", "f_action_id", "f_encoding", "f_data", "f_created_at", "f_original_seq", "f_source_event_seqs", "f_surface_op") VALUES (20, 'evt-0003', 'evt-0020', 'turn/end', 'turn', '', '', 'json', '{"turn":1,"reason":{"kind":"completed"}}', 6, 5, NULL, NULL);

-- t_session_events: 20 rows
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (1, 'parent-1', 'evt-0004', 0);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (2, 'parent-1', 'evt-0005', 1);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (3, 'parent-1', 'evt-0006', 2);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (4, 'parent-1', 'evt-0007', 3);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (5, 'parent-1', 'evt-0008', 4);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (6, 'parent-1', 'evt-0009', 5);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (7, 'parent-1', 'evt-0001', 6);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (8, 'child-1', 'evt-0010', 0);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (9, 'child-1', 'evt-0011', 1);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (10, 'child-1', 'evt-0012', 2);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (11, 'child-1', 'evt-0013', 3);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (12, 'child-1', 'evt-0014', 4);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (13, 'child-1', 'evt-0015', 5);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (14, 'child-1', 'evt-0002', 6);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (15, 'plain-2', 'evt-0016', 0);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (16, 'plain-2', 'evt-0017', 1);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (17, 'plain-2', 'evt-0018', 2);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (18, 'plain-2', 'evt-0019', 3);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (19, 'plain-2', 'evt-0020', 4);
INSERT INTO "t_session_events" ("f_id", "f_session_id", "f_event_id", "f_sequence") VALUES (20, 'plain-2', 'evt-0003', 5);

COMMIT;

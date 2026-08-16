/**
 * daemon-protocol: wire types for the sandbox daemon (files / commands / pty).
 * Kept dependency-free so both the daemon and the k8s adapters share it.
 * Aligned with the E2B API subset used by the official dsh e2b POC.
 */

// ── files ────────────────────────────────────────────────────────────────

export type FileType = 'file' | 'directory' | 'other' | 'symlink'

export interface EntryInfo {
  path: string
  name: string
  type: FileType
  size?: number
  mode?: number
  modifiedTime?: number
  symlinkTarget?: string
  /** Content version token (sha256 of identity+size+mode+mtime). */
  version?: string
}

/** One directory listing entry. */
export interface DirEntry {
  name: string
  type: FileType
  path: string
  size?: number
}

/** Write intent: create-if-absent or replace-if-version (CAS). */
export type WriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }

export interface WriteOutcome {
  operation: 'create' | 'replace' | 'noop'
  version: string
}

export interface FilesApi {
  read(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<Uint8Array>
  write(path: string, content: Uint8Array, intent?: WriteIntent): Promise<WriteOutcome>
  list(path: string, opts?: { depth?: number }): Promise<DirEntry[]>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<boolean>
  info(path: string): Promise<EntryInfo | undefined>
  remove(path: string): Promise<void>
  rename(src: string, dst: string): Promise<void>
}

// ── commands ─────────────────────────────────────────────────────────────

export interface CommandSpec {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  stdin?: Uint8Array
  /** Deadline for the command; applies only to workspace-wide background grace (see lifecycle spec). */
  timeoutMs?: number
  /** Opaque caller identity (dsh session id) for auditing/grouping. */
  sessionId?: string
}

export interface CommandHandleInfo {
  cmdId: string
  /** -1 until the remote process group publishes. */
  pid: number
  pgid: number
}

export interface CommandExit {
  exitCode: number | null
  signal: string | null
}

/** Output frame streamed over the command output channel. */
export type OutputFrame =
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'eof' }
  | { type: 'error'; message: string }

// ── pty ──────────────────────────────────────────────────────────────────

export interface PtySpec {
  argv: string[]
  cwd: string
  env?: Record<string, string>
  rows: number
  cols: number
}

export type PtyClientMessage =
  | { type: 'input'; data: Uint8Array }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'signal'; sig: string }

// ── transport helpers ────────────────────────────────────────────────────

/** Reserved EOF frame marker (kept identical in meaning to the E2B POC marker). */
export const EOF_MARKER = '!dsh-e2b-output-complete!'

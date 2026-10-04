/**
 * FilesService: the sandbox filesystem under a fixed root.
 * Atomic writes (staging + rename), content-version tokens (sha256),
 * createIfAbsent (hard-link semantics) and replaceIfVersion (CAS) intents,
 * per-target serialization, and root confinement (no traversal).
 */
import {
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DirEntry, EntryInfo, FileType, FilesApi, WriteIntent, WriteOutcome } from './protocol.ts'

export type FilesErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'OUT_OF_ROOT'
  | 'NOT_DIRECTORY'
  | 'NOT_REGULAR_FILE'
  | 'IO_ERROR'

export class FilesError extends Error {
  code: FilesErrorCode
  constructor(code: FilesErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Serialize (and serialize) mutations per canonical relative path. */
class MutationLocks {
  private chains = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(key, next.catch(() => undefined))
    return next
  }
}

export class FilesService implements FilesApi {
  readonly root: string
  private locks = new MutationLocks()

  constructor(root: string) {
    this.root = resolve(root)
  }

  // ── path confinement ───────────────────────────────────────────────────

  /** Canonical in-root relative path, or throws OUT_OF_ROOT. */
  private confine(path: string): string {
    const abs = resolve(join(this.root, path))
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new FilesError('OUT_OF_ROOT', `path escapes sandbox root: ${path}`)
    }
    return abs
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Positional read: returns the bytes at `[offset, offset + maxBytes)`,
   * shorter at EOF, empty when `offset` is at or past the end. Bounded by the
   * WINDOW, never by the file — the daemon opens the file and reads directly
   * into a window-sized buffer, so a whole-file read is the only case that
   * allocates file-sized memory and an oversized window can never appear.
   * `maxBytes` omitted means "the whole file" (the provider's unbounded read
   * path); every seam-bounded caller passes an explicit window.
   */
  async read(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<Uint8Array> {
    const abs = this.confine(path)
    const offset = Math.max(0, Math.trunc(opts?.offset ?? 0))
    const requested = opts?.maxBytes === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(opts.maxBytes))
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(abs, 'r')
      const info = await handle.stat()
      if (info.isDirectory()) throw new FilesError('NOT_REGULAR_FILE', `not a regular file: ${path}`)
      const want = Math.max(0, Math.min(info.size - offset, requested))
      if (want === 0) return new Uint8Array(0)
      const out = Buffer.allocUnsafe(want)
      let filled = 0
      while (filled < want) {
        const { bytesRead } = await handle.read(out, filled, want - filled, offset + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return new Uint8Array(out.subarray(0, filled))
    } catch (e) {
      if (e instanceof FilesError) throw e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilesError('NOT_FOUND', `no such file: ${path}`)
      }
      if ((e as NodeJS.ErrnoException).code === 'EISDIR') {
        throw new FilesError('NOT_REGULAR_FILE', `not a regular file: ${path}`)
      }
      throw new FilesError('IO_ERROR', String(e))
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async write(path: string, content: Uint8Array, intent?: WriteIntent): Promise<WriteOutcome> {
    const key = this.confine(path)
    return this.locks.run(path, async () => {
      const staging = join(dirname(key), `.dsh-staging-${randomBytes(6).toString('hex')}`)
      try {
        await mkdir(dirname(key), { recursive: true })
        await writeFile(staging, content, { mode: 0o600 })

        if (intent?.kind === 'createIfAbsent') {
          try {
            await link(staging, key) // atomic, fails if target exists
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new FilesError('ALREADY_EXISTS', `already exists: ${path}`)
            }
            throw e
          }
        } else if (intent?.kind === 'replaceIfVersion') {
          let current: string
          try {
            current = await this.versionOf(key)
          } catch {
            throw new FilesError('NOT_FOUND', `no such file: ${path}`)
          }
          if (current !== intent.version) {
            throw new FilesError('VERSION_CONFLICT', `stale version for ${path}`)
          }
          await fsRename(staging, key)
        } else {
          // plain write: replace or create, atomically
          const existed = await this.exists(key)
          await fsRename(staging, key)
          return { operation: existed ? 'replace' : 'create', version: await this.versionOf(key) }
        }
      } catch (e) {
        await rm(staging, { force: true }).catch(() => undefined)
        if (e instanceof FilesError) throw e
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FilesError('NOT_FOUND', `no such file: ${path}`)
        }
        throw new FilesError('IO_ERROR', String(e))
      }
      return { operation: intent?.kind === 'createIfAbsent' ? 'create' : 'replace', version: await this.versionOf(key) }
    })
  }

  async list(path: string, opts?: { depth?: number }): Promise<DirEntry[]> {
    const abs = this.confine(path)
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(abs)
    } catch {
      throw new FilesError('NOT_FOUND', `no such directory: ${path}`)
    }
    if (!st.isDirectory()) throw new FilesError('NOT_DIRECTORY', `not a directory: ${path}`)
    const entries: DirEntry[] = []
    for (const name of await readdir(abs)) {
      const full = join(abs, name)
      const lst = await lstat(full)
      const type: FileType = lst.isDirectory() ? 'directory' : lst.isSymbolicLink() ? 'symlink' : lst.isFile() ? 'file' : 'other'
      entries.push({ name, type, path: join(path, name).replace(/\\/g, '/'), size: lst.isFile() ? lst.size : undefined })
    }
    // The seam promises a stable name order; readdir's order is filesystem-defined.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return entries
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<boolean> {
    const abs = this.confine(path)
    try {
      await mkdir(abs, { recursive: opts?.recursive ?? false })
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw new FilesError('IO_ERROR', String(e))
    }
  }

  /**
   * Path metadata. `follow: true` resolves symbolic links (the dsh fs seam's
   * `stat`, target-shaped); the default inspects the path itself (the seam's
   * `lstat`, which lets a consumer reject the link before any follow).
   */
  async info(path: string, opts?: { follow?: boolean }): Promise<EntryInfo | undefined> {
    const abs = this.confine(path)
    const follow = opts?.follow === true
    let lst: Awaited<ReturnType<typeof lstat>>
    try {
      lst = follow ? await stat(abs) : await lstat(abs)
    } catch {
      return undefined
    }
    const type: FileType = lst.isDirectory() ? 'directory' : lst.isSymbolicLink() ? 'symlink' : lst.isFile() ? 'file' : 'other'
    let version: string | undefined
    if (lst.isFile()) {
      try {
        version = await this.versionOf(abs)
      } catch {
        // version token unavailable; leave undefined
      }
    }
    return {
      path,
      name: path.split('/').filter(Boolean).pop() ?? '/',
      type,
      size: lst.isFile() ? lst.size : undefined,
      mode: lst.mode & 0o777,
      modifiedTime: lst.mtimeMs,
      symlinkTarget: !follow && lst.isSymbolicLink() ? (await readlinkSafe(abs)) : undefined,
      version,
    }
  }

  async remove(path: string): Promise<void> {
    const abs = this.confine(path)
    try {
      await rm(abs, { recursive: true, force: false })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilesError('NOT_FOUND', `no such path: ${path}`)
      }
      throw new FilesError('IO_ERROR', String(e))
    }
  }

  async rename(src: string, dst: string): Promise<void> {
    const absSrc = this.confine(src)
    const absDst = this.confine(dst)
    try {
      await fsRename(absSrc, absDst)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilesError('NOT_FOUND', `no such path: ${src}`)
      }
      throw new FilesError('IO_ERROR', String(e))
    }
  }

  private async exists(abs: string): Promise<boolean> {
    try {
      await stat(abs)
      return true
    } catch {
      return false
    }
  }

  // ── version tokens ─────────────────────────────────────────────────────

  private async versionOf(abs: string): Promise<string> {
    const st = await stat(abs)
    const rel = relative(this.root, abs)
    const hash = createHash('sha256')
    hash.update(rel)
    hash.update(String(st.size))
    hash.update(String(st.mode))
    hash.update(String(st.mtimeMs))
    return hash.digest('hex').slice(0, 16)
  }
}

async function readlinkSafe(abs: string): Promise<string | undefined> {
  const { readlink } = await import('node:fs/promises')
  try {
    return await readlink(abs)
  } catch {
    return undefined
  }
}

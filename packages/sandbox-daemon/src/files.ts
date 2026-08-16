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
  opendir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DirEntry, EntryInfo, FileType, FilesApi, WriteIntent, WriteOutcome } from './protocol.js'

export type FilesErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'OUT_OF_ROOT'
  | 'NOT_DIRECTORY'
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

  async read(path: string, opts?: { offset?: number; maxBytes?: number }): Promise<Uint8Array> {
    const abs = this.confine(path)
    try {
      const buf = await readFile(abs)
      const offset = opts?.offset ?? 0
      const max = opts?.maxBytes ?? buf.length
      return new Uint8Array(buf.subarray(offset, offset + max))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FilesError('NOT_FOUND', `no such file: ${path}`)
      }
      throw new FilesError('IO_ERROR', String(e))
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

  async info(path: string): Promise<EntryInfo | undefined> {
    const abs = this.confine(path)
    let lst: Awaited<ReturnType<typeof lstat>>
    try {
      lst = await lstat(abs)
    } catch {
      return undefined
    }
    const type: FileType = lst.isDirectory() ? 'directory' : lst.isSymbolicLink() ? 'symlink' : lst.isFile() ? 'file' : 'other'
    return {
      path,
      name: path.split('/').filter(Boolean).pop() ?? '/',
      type,
      size: lst.isFile() ? lst.size : undefined,
      mode: lst.mode & 0o777,
      modifiedTime: lst.mtimeMs,
      symlinkTarget: lst.isSymbolicLink() ? (await readlinkSafe(abs)) : undefined,
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

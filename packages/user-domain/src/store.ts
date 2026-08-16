/**
 * Per-user JSON document store: one file per user under a root dir.
 * read-modify-write with a per-file promise chain (no cross-process locks in
 * v1 — the platform runs one control plane process).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class UserStore {
  private chains = new Map<string, Promise<unknown>>()

  constructor(private root: string) {}

  userDir(userId: string): string {
    // sanitize: keep the id filesystem-safe
    const safe = userId.replace(/[^a-zA-Z0-9._-]/g, '_')
    return join(this.root, 'users', safe)
  }

  async read(userId: string, file: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(join(this.userDir(userId), file), 'utf8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw e
    }
  }

  async write(userId: string, file: string, doc: Record<string, unknown>): Promise<void> {
    const key = userId + '/' + file
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(async () => {
      const dir = join(this.userDir(userId))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), JSON.stringify(doc, null, 2), 'utf8')
    })
    this.chains.set(key, next.catch(() => undefined))
    return next
  }
}

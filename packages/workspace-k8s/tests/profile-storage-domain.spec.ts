/**
 * Contract test for the profile patch layer that routes the official
 * `ctx.storageDomain` facility to Postgres.
 *
 * Why this lives here: `@deepseek-ai/dsh-workspace` (the official registry whose
 * `sessionIds` are the ONLY place a session<->workspace association exists)
 * persists exclusively through `ctx.storageDomain`, which is served by the
 * official `@deepseek-ai/dsh-storage-domain` row. Its base config is
 * `backend: json` rooted under `DSH_HOME` — an emptyDir in the deployment — so
 * leaving it alone wipes the whole registry on every pod replacement and every
 * session drops to "Ungrouped". This package is the consumer and the owner of
 * the repair path (see reconciler.ts), so it pins the routing that makes the
 * repair durable.
 *
 * The patch layer is composed by the CLI, so the profile YAML is asserted as
 * text: no YAML dependency is added to this package for one structural check,
 * and `scripts/harness-profile.sh` separately proves that the real CLI renders
 * the intended row (`--dump-config`, stderr empty).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

/** The backend name `apply()` in storage-db/src/index.ts registers (`config.type`). */
const REGISTERED_BACKEND = 'postgres'

interface YAMLRow {
  /** Indentation column of the `- id:` scalar (0 = top-level patch row). */
  indent: number
  id: string
  /** Dedented lines of the row, excluding the `- id:` line itself. */
  body: string[]
}

/**
 * Collect every `- id: <name>` row with its indent, carrying forward the
 * deeper-indented lines that follow it as its body. Indentation is what
 * separates a TOP-LEVEL patch row (indent 0, patches the base row in place)
 * from an `insert:` entry (indent > 0, appends a new row and duplicates the id).
 */
function rows(source: string): YAMLRow[] {
  const found: YAMLRow[] = []
  let current: YAMLRow | undefined
  for (const line of source.split('\n')) {
    const match = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line)
    if (match !== null) {
      current = { indent: match[1].length, id: match[2], body: [] }
      found.push(current)
      continue
    }
    if (current === undefined) continue
    const indent = line.length - line.trimStart().length
    // A dedent to (or above) the row's own column ends the row; blank and
    // comment lines belong to nobody.
    if (indent <= current.indent) {
      current = undefined
      continue
    }
    current.body.push(line)
  }
  return found
}

const profile = (name: 'web' | 'headless'): string =>
  readFileSync(resolve(REPO_ROOT, `docker/profiles/${name}.cordis.patch.yml`), 'utf8')

describe('profile patch: the official storage-domain row is routed to Postgres', () => {
  for (const name of ['web', 'headless'] as const) {
    describe(`${name}.cordis.patch.yml`, () => {
      it('patches the official storage-domain row in place with backend: postgres', () => {
        const source = profile(name)
        const matching = rows(source).filter((row) => row.id === 'storage-domain')
        expect(matching).toHaveLength(1)
        const [row] = matching
        // A TOP-LEVEL row patches the row the base profile already owns. An
        // `insert:` entry (indent > 0 under a top-level `- insert:`) adds a
        // second `storage-domain` id to the loader and breaks boot.
        expect(row.indent).toBe(0)
        const backend = /^\s+backend:\s*(\S+)\s*$/m.exec(row.body.join('\n'))
        expect(backend?.[1]).toBe(REGISTERED_BACKEND)
        // A patch row carries no `name`: restating it would re-declare the
        // module instead of overriding the base row's config.
        expect(/^\s+name:/m.test(row.body.join('\n'))).toBe(false)
      })

      it('still mounts the postgres backend the row routes to', () => {
        const body = profile(name)
        const storageDb = rows(body).find((row) => row.id === 'storage-db')
        expect(storageDb).toBeDefined()
        const type = /^\s+type:\s*(\S+)\s*$/m.exec(storageDb!.body.join('\n'))
        expect(type?.[1]).toBe(REGISTERED_BACKEND)
      })
    })
  }
})

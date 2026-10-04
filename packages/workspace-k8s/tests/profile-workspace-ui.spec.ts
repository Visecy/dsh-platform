/**
 * Contract test for the profile rows that serve workspace selection after the
 * UI decoupling.
 *
 * Re-enabling the official `ui-workspace` row brings back the official
 * workspace/session browser AND its workspace-creation flow, which selects a
 * directory through `ctx.directoryPicker`. That service is a cordis Service
 * named `directoryPicker` with a documented one-implementation-per-context rule
 * ("loading a second throws, cordis' standard duplicate-service behavior"), and
 * the picker the deployment wants is `@visecy/dsh-workspace-picker` (k8s PVCs
 * mapped to /workspaces/<id>) rather than the official local-filesystem
 * auto-picker. So the invariant is:
 *
 *   - the official auto row stays DISABLED (otherwise the platform picker
 *     cannot register at all),
 *   - the platform picker and the official browse surface are each mounted
 *     exactly once,
 *   - and `ui-workspace` is not disabled (the whole point of the decoupling).
 *
 * The patch layer is composed by the CLI, so the profile YAML is asserted as
 * text; `scripts/harness-profile.sh` separately proves the real CLI renders it
 * (`--dump-config`, stderr empty, no duplicate row ids).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const WEB_PROFILE = resolve(REPO_ROOT, 'docker/profiles/web.cordis.patch.yml')

interface YAMLRow {
  /** Indentation column of the `- id:` scalar (0 = top-level patch row). */
  indent: number
  id: string
  /** Dedented lines of the row, excluding the `- id:` line itself. */
  body: string[]
}

/** Collect every `- id: <name>` row with its indent and following body lines. */
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
    if (indent <= current.indent) {
      current = undefined
      continue
    }
    current.body.push(line)
  }
  return found
}

const web = (): string => readFileSync(WEB_PROFILE, 'utf8')

const bodyOf = (row: YAMLRow | undefined): string => row?.body.join('\n') ?? ''

describe('web profile: workspace selection after the UI decoupling', () => {
  it('carries no ui-workspace row at all, i.e. the disable is gone for good', () => {
    const all = rows(web())
    // The base profile OWNS the row; the only reason this patch layer ever
    // mentioned it was `disabled: true`, and that reason (a patched copy of the
    // official browser and the official one both registering the `workspace`
    // locale namespace) died with the vendoring. Absence is the assertion — a
    // re-added disable would take the official sidebar list away again.
    expect(all.filter((row) => row.id === 'ui-workspace')).toHaveLength(0)
    expect(web()).not.toMatch(/vendored/i)
  })

  it('keeps the official local-filesystem auto picker disabled', () => {
    const picker = rows(web()).find((row) => row.id === 'directory-picker')
    expect(picker).toBeDefined()
    expect(picker?.indent).toBe(0)
    expect(bodyOf(picker)).toMatch(/disabled:\s*true/)
  })

  it('mounts the platform picker and the official browse surface exactly once each', () => {
    const all = rows(web())
    const platform = all.filter((row) => row.id === 'workspace-picker')
    const browse = all.filter((row) => row.id === 'ui-directory-picker-browse')
    expect(platform).toHaveLength(1)
    expect(browse).toHaveLength(1)
    // Both are `insert:` entries: they are not base-profile rows being patched.
    expect(platform[0]?.indent).toBeGreaterThan(0)
    expect(browse[0]?.indent).toBeGreaterThan(0)
  })

  it('keeps patching the workspace plugin rows the panel reads from', () => {
    const all = rows(web())
    expect(all.filter((row) => row.id === 'workspace-runtime')).toHaveLength(1)
  })
})

/**
 * Contract test for the profile rows behind the settings page's Permissions
 * surface — the pair whose host half this profile disables.
 *
 * The operator's settings page failed with:
 *
 *   gateway/internal: client api: permissionPresets/catalog failed:
 *     transport failure for /api/permissionPresets/catalog: HTTP 404
 *
 * The pairing, established from the installed 0.2.0-rc.2 composition
 * (`dsh --profile web --dump-default-config`) and the package manifests, is:
 *
 *   - HOST:   row `permission`  = `@deepseek-ai/dsh-permission-presets`
 *             (`lib/typert.host.js` registers the `permissionPresets` service
 *             and its `Remote("catalog")` method — the `/api/permissionPresets/
 *             catalog` RPC);
 *   - CLIENT: row `ui-permission` = `@deepseek-ai/dsh-client-ui-permission-presets`
 *             (`lib/client.js` calls `ctx.remote.permissionPresets.catalog()`
 *             from its settings row).
 *
 * `docker/profiles/web.cordis.patch.yml` disables the HOST row because its
 * presets bundle a sandbox MODE, and the sandbox half of that bundle is the
 * host-local confinement chain (`@deepseek-ai/dsh-sandbox-local` → bwrap /
 * Landlock / Seatbelt against `workspaceRoot`). On this platform execution is
 * routed by `@visecy/dsh-subprocess-k8s` into a per-workspace KUBERNETES POD:
 * the pod is the isolation boundary, the control plane holds no workspace bytes
 * and no sandbox runner, and `permission` cannot even activate here (it throws
 * `the mounted bash executor does not confine (no sandboxMode)` unless
 * `bash-sandbox` — also disabled — is mounted). So the coherent repair is to
 * stop loading the CLIENT half, not to restore a host capability that would
 * have to wrap pod commands in a control-plane sandbox that does not exist.
 *
 * The invariant this spec pins is the general one behind the 404: a client half
 * whose host capability is gone must not stay enabled. It is asserted as text
 * because the CLI composes the patch layer; `scripts/harness-profile.sh`
 * separately proves the real CLI renders the patched profile (`--dump-config`,
 * stderr empty).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

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

const profile = (name: 'web' | 'headless'): string =>
  readFileSync(resolve(REPO_ROOT, `docker/profiles/${name}.cordis.patch.yml`), 'utf8')

const findRow = (source: string, id: string): YAMLRow | undefined =>
  rows(source).find((row) => row.id === id)

/**
 * The comment block that documents a top-level row.
 *
 * This file's convention is rationale-ABOVE-the-row (see every disable in
 * `web.cordis.patch.yml`), so `YAMLRow.body` deliberately ends at the first
 * comment line and the reason lives in the consecutive `#` lines directly
 * above the `- id:` line.
 */
function rationaleAbove(source: string, id: string): string {
  const lines = source.split('\n')
  const at = lines.findIndex((line) => new RegExp(`^-\\s+id:\\s*${id}\\s*$`).test(line))
  if (at === -1) return ''
  const block: string[] = []
  for (let i = at - 1; i >= 0 && lines[i].trimStart().startsWith('#'); i -= 1) block.unshift(lines[i])
  return block.join('\n')
}

const isDisabled = (row: YAMLRow | undefined): boolean =>
  row !== undefined && /^\s+disabled:\s*true\s*$/m.test(row.body.join('\n'))

describe('web profile: the permission-presets pair', () => {
  const web = (): string => profile('web')

  it('keeps the host half disabled, as the composition it replaces requires', () => {
    // The disable is load-bearing: un-disabling `permission` without also
    // restoring `bash-sandbox` fails the composition loudly at construction.
    const host = findRow(web(), 'permission')
    expect(host).toBeDefined()
    expect(host?.indent).toBe(0)
    expect(isDisabled(host)).toBe(true)
  })

  it('disables the client half that calls it, so the settings page cannot 404', () => {
    const client = findRow(web(), 'ui-permission')
    expect(client).toBeDefined()
    expect(client?.indent).toBe(0)
    expect(isDisabled(client)).toBe(true)
  })

  it('states WHICH side was dropped and why, where the disable lives', () => {
    const rationale = rationaleAbove(web(), 'ui-permission')
    // The row must carry its own rationale: the next reader has to be able to
    // tell a deliberate drop from a disable someone added to make a test pass.
    expect(rationale).toMatch(/permissionPresets\/catalog/)
    expect(rationale).toMatch(/ui-permission/)
    expect(rationale).toMatch(/subprocess-k8s/)
    expect(rationale).toMatch(/sandbox/)
  })

  it('leaves no client half enabled for a host capability this profile removed', () => {
    // Every host↔client pair this profile touches, with what backs the client
    // half. `permission` and `workspace-changes` have no replacement, so their
    // clients must be disabled; `directory-picker`'s client surface is backed
    // by `@visecy/dsh-workspace-picker`, which the profile inserts, so the
    // browse surface stays mounted.
    const pairs = [
      { host: 'permission', client: 'ui-permission', backed: false },
      { host: 'workspace-changes', client: 'ui-deliverables', backed: false },
      { host: 'directory-picker', client: 'ui-directory-picker-browse', backed: true },
    ] as const
    for (const pair of pairs) {
      expect(isDisabled(findRow(web(), pair.host)), `${pair.host} must be disabled`).toBe(true)
      if (!pair.backed) {
        expect(
          isDisabled(findRow(web(), pair.client)),
          `${pair.client} calls the disabled ${pair.host} row and has no replacement provider`,
        ).toBe(true)
      }
    }
    // …and the replacement is actually mounted for the one pair that has one.
    const picker = findRow(web(), 'workspace-picker')
    expect(picker).toBeDefined()
    expect(picker?.indent).toBeGreaterThan(0)
  })
})

describe('headless profile: the same pair, without a browser half', () => {
  it('mentions neither row, keeping --dump-config stderr clean', () => {
    // The headless composition has no client rows at all. A disable row for an
    // unknown id is not a silent no-op: cordis answers
    // `patch: entry "ui-permission" not found` on stderr while still exiting 0.
    const headless = profile('headless')
    expect(findRow(headless, 'ui-permission')).toBeUndefined()
    expect(isDisabled(findRow(headless, 'permission'))).toBe(true)
  })
})

/**
 * Which implementation owns `ctx.directoryPicker` — the service the official
 * workspace-creation flow browses through.
 *
 * `DirectoryPicker` (the official host seam) documents a
 * one-implementation-per-context rule: it is a cordis `Service`, so loading a
 * second implementation throws cordis' duplicate-service error and the FIRST
 * registrant keeps the service. The deployment therefore cannot rely on
 * "whoever mounts last wins", and it cannot rely on the official auto picker
 * politely standing down: the platform keeps `directory-picker`
 * (`@deepseek-ai/dsh-host-directory-picker-auto`, which mounts the official
 * HOST-FILESYSTEM browse backend and its client surface through
 * `ctx.loader.create`) disabled in the web profile, and mounts
 * `@visecy/dsh-workspace-picker` in its place.
 *
 * These tests pin that composition at RUNTIME, not just as profile text:
 *
 *   - the platform picker, mounted exactly as the profile mounts it, is the
 *     implementation the service resolves to, and it serves the `browse`
 *     capability the official creation flow drives;
 *   - its listing is the k8s side (workspace resources), so re-enabling the
 *     official auto picker — or adding any other registrant — is what makes
 *     the creation flow browse the control plane's own filesystem instead;
 *   - the one-implementation rule itself: a second registrant throws, in both
 *     mount orders, so the FIRST registrant is the one that matters and a
 *     re-enabled official row silently takes the service from the platform.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import { WorkspacePicker, apply, name } from '../src/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

/** The deployment's picker config (docker/profiles/web.cordis.patch.yml). */
const DEPLOYMENT_CONFIG = { namespace: 'dsh-platform', daemonPort: 4390, hostRoot: '/workspaces' }

/** The deployment config plus an injected cluster client (tests never call one). */
const configWith = (kc: unknown) => ({ ...DEPLOYMENT_CONFIG, kc: kc as never })

/** A k8s client that answers like a cluster with one running workspace. */
const fakeKc = {
  loadFromDefault: () => {},
  makeApiClient: () => ({
    listNamespacedPod: async () => ({ body: { items: [{ metadata: { name: 'git' } }] } }),
    listNamespacedPersistentVolumeClaim: async () => ({ body: { items: [{ metadata: { name: 'git-data' } }] } }),
  }),
} as never

/**
 * Stand-in for the official auto picker's browse backend: the host filesystem,
 * which on this control plane is the empty `/workspaces/<id>` anchors.
 */
class OfficialHostBackend extends DirectoryPicker {
  constructor(ctx: Context) {
    super(ctx)
  }
  capability(): unknown {
    return {
      kind: 'browse' as const,
      list: async () => ({ path: '/', home: '/', crumbs: [], entries: [], truncated: false }),
      createDirectory: async (path: string) => path,
    }
  }
}

describe('directoryPicker ownership', () => {
  it('resolves to the platform picker when the profile mounts it', async () => {
    const ctx = new Context()
    apply(ctx, configWith(fakeKc))

    const owner = ctx.get('directoryPicker') as DirectoryPicker | undefined
    expect(owner).toBeInstanceOf(WorkspacePicker)
    const capability = owner?.capability() as { kind: string; list: (path?: string) => Promise<{ entries: Array<{ name: string; path: string }> }> }
    expect(capability.kind).toBe('browse')

    // And what it serves is the k8s side: the workspace resources, not files
    // read from the control plane's own disk.
    const listing = await capability.list('/workspaces')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['git'])
    expect(listing.entries[0]?.path).toBe('/workspaces/git')
  })

  it('cannot be taken over by a second implementation (and cannot take over either)', () => {
    // Official-first, platform-second: the platform's registration throws, so
    // a re-enabled `directory-picker` row wins and the creation flow browses
    // the host filesystem.
    const officialFirst = new Context()
    new OfficialHostBackend(officialFirst)
    expect(() => new WorkspacePicker(officialFirst, configWith(fakeKc))).toThrow(/directoryPicker/)
    expect(officialFirst.get('directoryPicker')).toBeInstanceOf(OfficialHostBackend)

    // Platform-first, official-second: the official registration throws and the
    // platform keeps the service.
    const platformFirst = new Context()
    new WorkspacePicker(platformFirst, configWith(fakeKc))
    expect(() => new OfficialHostBackend(platformFirst)).toThrow(/directoryPicker/)
    expect(platformFirst.get('directoryPicker')).toBeInstanceOf(WorkspacePicker)
  })

  it('keeps the official auto picker row disabled in the web profile', () => {
    // The runtime assertion above only holds while this row is disabled: it is
    // the auto picker that mounts the host-filesystem backend.
    const web = readFileSync(resolve(REPO_ROOT, 'docker/profiles/web.cordis.patch.yml'), 'utf8')
    const row = /^-\s+id:\s*directory-picker\s*$\n((?:[ \t]+.*\n|\n)*)/m.exec(web)
    expect(row).not.toBeNull()
    expect(row?.[1]).toMatch(/disabled:\s*true/)
    // The platform picker is mounted exactly once, and the exported plugin name
    // is the one the row references.
    expect(web.match(/id:\s*workspace-picker\s*$/gm)).toHaveLength(1)
    expect(name).toBe('@visecy/dsh-workspace-picker')
  })
})

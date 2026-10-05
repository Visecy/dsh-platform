/**
 * Boot the SHIPPED client bundle (`lib/client.js`, the artifact the image
 * loads) in Node with a stand-in module loader, and assert what it registers.
 *
 * This is the end-to-end check that the decoupling really landed in the built
 * artifact rather than only in the sources: the bundle must export an `apply`,
 * claim the additive panel surfaces (`main`, `sidebar.panellist`) plus the two
 * `directoryFlow` seats the name-based new-workspace dialog fills, must not
 * touch `sidebar.workspaces` (the official ui-workspace row owns it now), must
 * carry no trace of the deleted vendored browser string, must not re-register
 * the `shell.overlay` pill that used to cover the brand mark, and must apply
 * on a context that provides nothing but `slots` — the removed client services
 * (`remote`, `workspaces`, `sessions`) were only ever needed by the vendored
 * browser, and reading one that the fiber did not declare is what once left
 * this whole plugin pending.
 *
 * React and the DOM are stubbed: `apply()` performs registration only, and the
 * components are never rendered here (the surfaces' behaviour is pinned by
 * `new-workspace-dialog.spec.ts` through the same harness). The bundle is
 * materialized exactly once (Node caches it), then applied per case against a
 * fresh fake registry.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require = createRequire(import.meta.url)

interface Registered {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

/** Minimal React stand-in: the bundle requires it, but apply() never renders. */
const reactStub = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: {},
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}

let cached: { apply: (ctx: unknown) => void } | undefined

/** Materialize the bundle once through a stand-in `window.__ModuleLoader__`. */
const loadExports = (): { apply: (ctx: unknown) => void } => {
  if (cached !== undefined) return cached
  if (!existsSync(BUNDLE)) throw new Error(`client bundle missing: ${BUNDLE} — run pnpm build first`)
  let exports: { apply?: (ctx: unknown) => void } | undefined
  vi.stubGlobal('window', {
    __ModuleLoader__: {
      load: (definition: { factory: (req: (id: string) => unknown) => unknown }) => {
        exports = definition.factory((id: string) =>
          id === 'react' || id === 'react/jsx-runtime' ? reactStub : {}) as typeof exports
      },
    },
  })
  vi.stubGlobal('document', {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => undefined },
  })
  require(BUNDLE)
  if (exports === undefined || typeof exports.apply !== 'function') {
    throw new Error('client bundle exported no apply() — the module table would deliver an empty plugin')
  }
  cached = exports
  return cached
}

interface Applied {
  registered: Registered[]
  injected: string[]
  /** Services the bundle asked the client context for while applying. */
  requested: string[]
}

const applyBundle = (): Applied => {
  const registered: Registered[] = []
  const injected: string[] = []
  const requested: string[] = []
  loadExports().apply({
    on: () => undefined,
    get: (name: string) => { requested.push(name); return undefined },
    slots: {
      inject(slot: string, callback: () => unknown) {
        injected.push(slot)
        callback()
        return () => undefined
      },
      register(options: Record<string, unknown>, component: unknown) {
        registered.push({ slot: String(options.name), options, component })
        return () => undefined
      },
    },
  })
  return { registered, injected, requested }
}

describe('shipped client bundle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is the artifact the package exports to the client module loader', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>
      dsh: { client: { platform: string; inject: string[] } }
    }
    expect(pkg.exports['./client']?.default).toBe('./lib/client.js')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(existsSync(BUNDLE)).toBe(true)
  })

  it('registers the additive panel surfaces on the official slots', () => {
    const { registered, injected } = applyBundle()
    expect(injected).toEqual([
      'main',
      'sidebar.panellist',
      'conversation.hero.workspace.directoryFlow',
      'sidebar.workspaces.directoryFlow',
    ])
    expect(registered.map((r) => r.slot)).toEqual([
      'main',
      'sidebar.panellist',
      'conversation.hero.workspace.directoryFlow',
      'sidebar.workspaces.directoryFlow',
    ])
    expect(registered.find((r) => r.slot === 'main')?.options.key).toBe('workspace-status')
    expect(registered.find((r) => r.slot === 'sidebar.panellist')?.options.id).toBe('workspace-status')
    for (const call of registered) expect(call.component).toBeTruthy()
  })

  it('never claims the surfaces the official ui-workspace row owns', () => {
    const { registered } = applyBundle()
    const slots = registered.map((r) => r.slot)
    expect(slots).not.toContain('sidebar.workspaces')
    expect(slots).not.toContain('conversation.hero.workspace')
  })

  it('does not re-register the shell overlay pill that covered the brand mark', () => {
    const { registered, injected } = applyBundle()
    expect(injected).not.toContain('shell.overlay')
    expect(registered.map((r) => r.slot)).not.toContain('shell.overlay')
    expect(readFileSync(BUNDLE, 'utf8')).not.toContain('dsh-wsp-pill')
  })

  it('carries no vendored workspace browser string', () => {
    const source = readFileSync(BUNDLE, 'utf8')
    expect(source).not.toContain('@visecy/dsh-workspace-k8s/vendored-browser')
    expect(source).not.toContain('dsh-wsb-titlerow')
  })

  it('applies on a context that provides only slots', () => {
    const { requested, registered } = applyBundle()
    // Nothing is pulled out of the client context any more: the panel watches
    // its own HTTP snapshot, and the dialog commits through its own injected
    // share.
    expect(requested).toEqual([])
    // main + sidebar.panellist + the two directory-flow seats.
    expect(registered).toHaveLength(4)
  })
})

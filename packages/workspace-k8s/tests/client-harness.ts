/**
 * Boot the SHIPPED client bundle (`lib/client.js`, the artifact the image
 * loads) in Node with a stand-in module loader, and render what it registered.
 *
 * This is the end-to-end harness for the plugin's browser surfaces: it loads
 * the same committed artifact the profile loads, so a spec can assert what the
 * product actually does — which slots `apply()` claims, what a component
 * renders for a given prop share, and which HTTP calls a commit path makes —
 * instead of asserting a source file's shape.
 *
 * React is stood in for, not reimplemented: the bundle treats `react` and
 * `react/jsx-runtime` as externals and receives them through the module
 * loader's `require`, exactly as the browser module table hands them over. The
 * stand-in produces plain `{ type, props }` elements and keeps `useState`
 * values in a per-render scope, so a spec can drive a component (type into an
 * input, click a button, re-render) without a DOM. Effects are deliberately
 * inert: nothing these specs pin is produced by an effect.
 *
 * The bundle is materialized exactly once per spec file (Node caches it), then
 * applied per case against a fresh fake registry.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The committed browser artifact the package exports to the client loader. */
export const BUNDLE = join(ROOT, 'lib', 'client.js')

const require = createRequire(import.meta.url)

/** One slot registration captured from the bundle's `apply()`. */
export interface Registered {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

/** One element produced by the React stand-in. */
export interface Element {
  type: unknown
  props: Record<string, unknown>
}

/** Hook state of one rendered component instance, persisted across re-renders. */
interface HookScope {
  states: unknown[]
  cursor: number
}

let scope: HookScope | undefined

const reactStub = {
  Fragment: Symbol.for('dsh.react.Fragment'),
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
    type,
    props: { ...(props ?? {}), ...(children.length > 0 ? { children } : {}) },
  }),
  jsx: (type: unknown, props: Record<string, unknown> | null): Element => ({ type, props: props ?? {} }),
  jsxs: (type: unknown, props: Record<string, unknown> | null): Element => ({ type, props: props ?? {} }),
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    if (scope === undefined) throw new Error('useState outside a renderComponent() call')
    const index = scope.cursor++
    const current = scope
    if (!(index in current.states)) {
      current.states[index] = typeof initial === 'function' ? (initial as () => T)() : initial
    }
    return [current.states[index] as T, (next: T | ((prev: T) => T)): void => {
      current.states[index] = typeof next === 'function' ? (next as (prev: T) => T)(current.states[index] as T) : next
    }]
  },
  useEffect: (): void => undefined,
  useLayoutEffect: (): void => undefined,
  useSyncExternalStore: <S>(_subscribe: unknown, getSnapshot: () => S): S => getSnapshot(),
}

let cached: { apply: (ctx: unknown) => void } | undefined

/** Materialize the committed bundle once through a stand-in `__ModuleLoader__`. */
export function loadClientBundle(): { apply: (ctx: unknown) => void } {
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

export interface Applied {
  registered: Registered[]
  injected: string[]
  /** Services the bundle asked the client context for while applying. */
  requested: string[]
}

/** Apply the bundle against a fake slot registry that declares every slot. */
export function applyBundle(): Applied {
  const registered: Registered[] = []
  const injected: string[] = []
  const requested: string[] = []
  loadClientBundle().apply({
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

/** The one registration for `slot`, or a failure naming what was registered instead. */
export function registeredIn(applied: Applied, slot: string): Registered {
  const found = applied.registered.filter((entry) => entry.slot === slot)
  if (found.length !== 1) {
    throw new Error(`expected exactly one registration for ${slot}, got ${found.length} ` +
      `(registered: ${applied.registered.map((entry) => entry.slot).join(', ')})`)
  }
  return found[0]
}

const isElement = (value: unknown): value is Element =>
  typeof value === 'object' && value !== null && 'type' in value && 'props' in value

const childrenOf = (element: Element): unknown[] => {
  const raw = element.props.children
  if (raw === undefined || raw === null || typeof raw === 'boolean') return []
  return Array.isArray(raw) ? raw : [raw]
}

const walk = (element: Element | null, visit: (node: Element) => void): void => {
  if (element === null) return
  visit(element)
  for (const child of childrenOf(element)) {
    if (isElement(child)) walk(child, visit)
  }
}

const textOf = (element: Element | null): string => {
  if (element === null) return ''
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return }
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (isElement(node)) {
      for (const child of childrenOf(node)) visit(child)
    }
  }
  visit(element)
  return parts.join('')
}

/** A component rendered with the React stand-in: re-render and query the tree. */
export interface Rendered {
  /** The element the component returned, or null when it rendered nothing. */
  root(): Element | null
  /** Re-invoke the component with the same props; hook state is preserved. */
  rerender(): Rendered
  /** Every element in the tree, depth-first. */
  elements(): Element[]
  find(predicate: (element: Element) => boolean): Element | undefined
  findAll(predicate: (element: Element) => boolean): Element[]
  /** Concatenated text of the tree, for copy assertions. */
  text(): string
}

/**
 * Render one captured component with a prop share, exactly as the frame would.
 * @param component - the component the bundle registered.
 * @param props - the owner share plus the injected share the frame binds.
 * @returns a handle over the rendered tree.
 */
export function renderComponent(component: unknown, props: Record<string, unknown>): Rendered {
  if (typeof component !== 'function') throw new Error('renderComponent: not a component function')
  const hooks: HookScope = { states: [], cursor: 0 }
  let root: Element | null = null
  const draw = (): void => {
    scope = hooks
    hooks.cursor = 0
    root = (component as (share: Record<string, unknown>) => Element | null)(props) ?? null
    scope = undefined
  }
  draw()
  const api: Rendered = {
    root: () => root,
    rerender: () => { draw(); return api },
    elements: () => {
      const found: Element[] = []
      walk(root, (node) => found.push(node))
      return found
    },
    find: (predicate) => api.elements().find(predicate),
    findAll: (predicate) => api.elements().filter(predicate),
    text: () => textOf(root),
  }
  return api
}

/** The element a user reads as the button labelled `label`. */
export const button = (rendered: Rendered, label: string): Element => {
  const found = rendered.find((element) => element.type === 'button' && textOf(element) === label)
  if (found === undefined) throw new Error(`no button labelled ${label}`)
  return found
}

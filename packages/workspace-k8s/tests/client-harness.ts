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
 * values and `useRef` identities in a per-render scope, so a spec can drive a
 * component (type into an input, click a button, re-render) without a DOM.
 * Effects are deliberately inert: nothing these specs pin is produced by an
 * effect.
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
  /**
   * `useRef`, with the identity React guarantees: the same object for every
   * render of one component instance, mutated in place with no re-render. The
   * new-workspace dialog's IME guard needs exactly that — the keydown that ends
   * a composition is dispatched before React could re-render, so a state value
   * would be read stale (which is why the official forms use a ref too).
   */
  useRef<T>(initial: T): { current: T } {
    if (scope === undefined) throw new Error('useRef outside a renderComponent() call')
    const index = scope.cursor++
    const current = scope
    if (!(index in current.states)) current.states[index] = { current: initial }
    return current.states[index] as { current: T }
  },
  useEffect: (): void => undefined,
  useLayoutEffect: (): void => undefined,
  useSyncExternalStore: <S>(_subscribe: unknown, getSnapshot: () => S): S => getSnapshot(),
}

/** The official component family the plugin's dialogs are built from. */
export const PRIMITIVES_MODULE = '@deepseek-ai/dsh-client-ui-primitives'

const element = (type: unknown, props: Record<string, unknown>, ...children: unknown[]): Element => ({
  type,
  props: { ...props, ...(children.length > 0 ? { children: children.length === 1 ? children[0] : children } : {}) },
})

/**
 * Marks a component the tree walk may invoke.
 *
 * Only the harness's own stand-ins carry it. The plugin's sub-components do
 * not: invoking one outside React would need hook state the harness keeps for
 * the component under test alone, and `WorkspaceDetailView`'s row component
 * uses `useState`. The walk therefore expands exactly the official family it
 * provided, and leaves everything else a leaf — the behaviour every existing
 * assertion was written against.
 */
const STAND_IN = Symbol.for('dsh.harness.clientStandIn')

const standIn = <T extends (props: Record<string, unknown>) => unknown>(component: T): T => {
  Object.defineProperty(component, STAND_IN, { value: true })
  return component
}

/**
 * The official primitives, stood in for.
 *
 * The real `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` IS in this
 * composition — it is one of the web shell's static seed words
 * (`dsh-web-frontend/dist/assets/index-*.js` maps the specifier into the
 * browser module table) and every official client bundle `require`s it — but it
 * is a browser module: it imports `react`, `react-dom` and its own
 * `.module.css` files, none of which this workspace installs. So the harness
 * hands the bundle a stand-in for the members it uses, and keeps the parts a
 * spec can assert: WHICH member the dialog rendered (identity, so a return to
 * hand-written `div`s fails the spec), on which element, with which props.
 *
 * Every stand-in marks its output with `data-primitive="<member>"`. That is the
 * HARNESS's marker, not the component's DOM: it is what makes "the dialog used
 * the official member" checkable after the tree walk has expanded the component
 * into its output.
 *
 * Each stand-in's DOM shape is the real component's, because that shape is what
 * the assertions are about:
 *   - `Modal`  → mask/card chrome with the title, the description, the body and
 *                the footer; `null` while `open` is false;
 *   - `Button` → the NATIVE button (variant and disabled ride through);
 *   - `Input`  → a wrapper span around the native input, with `className` on
 *                the wrapper and every other prop on the input (the real
 *                component's split, and the reason a field's width comes from
 *                its container rather than from a class);
 *   - `Tag`    → a tone-carrying span.
 */
export const primitivesStub = {
  Modal: standIn((props: Record<string, unknown>): Element | null => {
    if (props.open !== true) return null
    return element('div', { className: 'official-modal', role: 'dialog', 'aria-label': props.title, 'data-primitive': 'Modal' },
      element('h2', { className: 'official-modal-title' }, props.title),
      props.description === undefined
        ? null
        : element('p', { className: 'official-modal-description' }, props.description),
      element('div', { className: 'official-modal-body' }, props.children),
      element('div', { className: 'official-modal-footer' }, props.footer))
  }),
  Button: standIn((props: Record<string, unknown>): Element =>
    element('button', {
      className: `official-button ${String(props.variant ?? 'ghost')}`,
      disabled: props.disabled,
      onClick: props.onClick,
      'data-primitive': 'Button',
    }, props.children)),
  Input: standIn((props: Record<string, unknown>): Element => {
    const { icon, className, ...rest } = props
    return element('span', { className: `official-input ${String(className ?? '')}`.trim(), 'data-primitive': 'Input' }, element('input', rest))
  }),
  Tag: standIn((props: Record<string, unknown>): Element =>
    element('span', { className: 'official-tag', 'data-tone': props.tone ?? 'outline', 'data-primitive': 'Tag' }, props.children)),
}

let cached: { apply: (ctx: unknown) => void } | undefined

/**
 * Every module specifier the bundle asked the module table for while
 * materializing. A plugin that stops using the official component family stops
 * requiring it, which is a fact about the shipped artifact a spec can assert
 * (the bundle treats those specifiers as externals; see
 * `scripts/build-workspace-ui.mjs`).
 */
const required: string[] = []

/** Every module specifier the committed bundle required at materialization. */
export function requiredModules(): readonly string[] {
  return required
}

/**
 * One `<style>` the bundle appended to `document.head`.
 *
 * The stand-in document keeps these instead of dropping them, because the
 * plugin's stylesheet is a runtime side effect, not a source file: a spec can
 * only tell "the dialog is styled" from "the bundle happens to contain CSS
 * text" by looking at what `apply()` actually appended. The element also
 * answers `querySelector('style[data-dsh-workspace-ui]')`, so the plugin's
 * once-per-document guard is exercised rather than bypassed.
 */
export interface InjectedStyle {
  dataset: Record<string, string>
  textContent: string
}

const injected: InjectedStyle[] = []

/** Every stylesheet the bundle has appended in this spec file, in order. */
export function injectedStyles(): readonly InjectedStyle[] {
  return injected
}

/** Every className the plugin ships a rule for in the injected document. */
function isWorkspaceStyle(element: InjectedStyle): boolean {
  return element.dataset.dshWorkspaceUi !== undefined
}

/** Materialize the committed bundle once through a stand-in `__ModuleLoader__`. */
export function loadClientBundle(): { apply: (ctx: unknown) => void } {
  if (cached !== undefined) return cached
  if (!existsSync(BUNDLE)) throw new Error(`client bundle missing: ${BUNDLE} — run pnpm build first`)
  let exports: { apply?: (ctx: unknown) => void } | undefined
  vi.stubGlobal('window', {
    __ModuleLoader__: {
      load: (definition: { factory: (req: (id: string) => unknown) => unknown }) => {
        exports = definition.factory((id: string) => {
          required.push(id)
          if (id === 'react' || id === 'react/jsx-runtime') return reactStub
          if (id === PRIMITIVES_MODULE) return primitivesStub
          return {}
        }) as typeof exports
      },
    },
  })
  vi.stubGlobal('document', {
    // The guard's exact selector; anything else the plugin might ask for is
    // absent, which is the state a real first mount sees.
    querySelector: (selector: string) =>
      selector === 'style[data-dsh-workspace-ui]' ? injected.find(isWorkspaceStyle) ?? null : null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: {
      appendChild: (element: InjectedStyle) => { injected.push(element) },
    },
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

/**
 * Render one node the way React would — for the HARNESS'S OWN stand-ins.
 *
 * The official primitives the dialog is built from are components (`Modal` →
 * the card tree, `Button` → the native button, `Input` → the wrapper span
 * around the native input), and assertions here are about the DOM a user meets
 * ("is there exactly one input", "is there a button labelled 创建"), so the walk
 * has to reach their output. Only components marked {@link STAND_IN} are
 * invoked: they are hook-free by construction, while the plugin's own
 * sub-components are rendered by the frame with hook state this harness keeps
 * for the component under test alone.
 */
const renderNode = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(renderNode)
  if (isElement(value) && typeof value.type === 'function') {
    const component = value.type as { [STAND_IN]?: true }
    if (component[STAND_IN] === true) {
      return renderNode((value.type as (props: Record<string, unknown>) => unknown)(value.props))
    }
  }
  return value
}

const childrenOf = (element: Element): unknown[] => {
  const raw = element.props.children
  if (raw === undefined || raw === null || typeof raw === 'boolean') return []
  return [raw].flat(Infinity).map(renderNode).flat(Infinity)
}

const walk = (root: Element | null, visit: (node: Element) => void): void => {
  const step = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) step(item)
      return
    }
    if (!isElement(node)) return
    visit(node)
    for (const child of childrenOf(node)) step(child)
  }
  // Start from the RENDERED root: the top-level element is usually a component
  // (`Modal`), and what a user meets is its output, not the element itself.
  step(renderNode(root))
}

const textOf = (root: Element | null): string => {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return }
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (isElement(node)) {
      for (const child of childrenOf(node)) visit(child)
    }
  }
  visit(renderNode(root))
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

/**
 * The new-workspace dialog the SHIPPED bundle registers.
 *
 * Creating a workspace on this platform is "type a name and create": a
 * workspace is a platform record (with its own PVC and anchor directory), not a
 * folder the operator browses to, and the existing workspaces are already
 * listed in the sidebar — there is nothing to pick. This spec pins that against
 * the committed `lib/client.js`, so the guarantee holds for the artifact the
 * profile loads:
 *
 *   - both `directoryFlow` holes are OCCUPIED (priority -100, above the
 *     official directory browser), which is what a hole name means here — a
 *     seat to fill, not an instruction to browse a directory;
 *   - the commit path is `workspaceApi.create(name)` + a catalog poll, and the
 *     HTTP body carries a `name` and nothing else — no `path`, no picker;
 *   - the dialog renders one name input, submits on Enter or 创建, and shows the
 *     API's own error message in place (there is no silent failure path);
 *   - the dialog is built from the OFFICIAL component family
 *     (`@deepseek-ai/dsh-client-ui-primitives`): its chrome is the official
 *     `Modal`, its field the official `Input`, its actions the official
 *     `Button`, and its failure the official `Tag`. Its widths, spacing and
 *     typography are therefore the platform's, not this plugin's invention —
 *     which is what the operator asked for after a hand-written stylesheet left
 *     the name field running past the card.
 *
 * The props are the real owner share the official picker flow hands its hole
 * occupant (`open`, `busy`, `onPicked`, `onCancel`, `onError`); `onPicked` is
 * passed and asserted UNUSED on purpose — a directory-picking implementation
 * would have to call it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBundle,
  button,
  PRIMITIVES_MODULE,
  primitivesStub,
  registeredIn,
  renderComponent,
  requiredModules,
  type Rendered,
} from './client-harness.ts'

interface Call {
  url: string
  init: { method?: string; body?: unknown }
}

/** Record every API call and answer it with `payloads[url]`. */
const stubFetch = (payloads: Record<string, unknown> = {}): Call[] => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: Call['init']) => {
    calls.push({ url: String(url), init })
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, data: payloads[String(url)] ?? {} }),
    })
  })
  return calls
}

/** Click the button labelled `label` and let the handler's promise chain settle. */
const click = async (rendered: Rendered, label: string): Promise<void> => {
  const target = button(rendered, label)
  await (target.props.onClick as () => unknown)()
  await new Promise((resolve) => setImmediate(resolve))
}

const DIALOG_SLOTS = [
  'conversation.hero.workspace.directoryFlow',
  'sidebar.workspaces.directoryFlow',
] as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('new-workspace dialog: slot occupancy', () => {
  it('fills BOTH directory-flow holes, above any directory browser', () => {
    const applied = applyBundle()
    const components = DIALOG_SLOTS.map((slot) => {
      const entry = registeredIn(applied, slot)
      expect(entry.options.priority).toBe(-100)
      expect(typeof entry.options.inject).toBe('function')
      expect(typeof entry.component).toBe('function')
      return entry.component
    })
    // One dialog fills both holes: the two surfaces share the window, not a copy.
    expect(components[0]).toBe(components[1])
    for (const slot of DIALOG_SLOTS) expect(applied.injected).toContain(slot)
  })

  it('advertises nothing on the frame-wide overlay the removed pill used', () => {
    const applied = applyBundle()
    expect(applied.injected).not.toContain('shell.overlay')
  })
})

describe('new-workspace dialog: the commit path', () => {
  it('creates by NAME: the request body carries a name and no path', async () => {
    const calls = stubFetch()
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    const injected = (entry.options.inject as () => { createByName: (name: string) => Promise<void> })()
    expect(typeof injected.createByName).toBe('function')

    await injected.createByName('my-project')

    expect(calls.map((call) => call.url)).toEqual(['/workspaces/api/create', '/workspaces/api/list'])
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'my-project' })
  })

  it('submits the typed name, trimmed, then closes the flow', async () => {
    const calls = stubFetch()
    const entry = registeredIn(applyBundle(), 'conversation.hero.workspace.directoryFlow')
    const injected = (entry.options.inject as () => { createByName: (name: string) => Promise<void> })()
    const createByName = vi.fn(injected.createByName)
    const onCancel = vi.fn()
    const onPicked = vi.fn()
    const onError = vi.fn()

    const rendered = renderComponent(entry.component, {
      open: true,
      busy: false,
      createByName,
      onCancel,
      onPicked,
      onError,
    })
    const input = rendered.find((element) => element.props.id === 'dsh-ws-name')
    expect(input).toBeDefined()
    ;(input?.props.onChange as (event: unknown) => void)({ target: { value: '  my-project  ' } })
    rendered.rerender()
    await click(rendered, '创建')

    expect(createByName).toHaveBeenCalledTimes(1)
    expect(createByName).toHaveBeenCalledWith('my-project')
    expect(onCancel).toHaveBeenCalledTimes(1)
    // The directory half of the owner share is never used: no path is adopted.
    expect(onPicked).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(calls[0].url).toBe('/workspaces/api/create')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'my-project' })
  })

  it('submits on Enter', async () => {
    stubFetch()
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    const createByName = vi.fn(async () => undefined)
    const rendered = renderComponent(entry.component, {
      open: true,
      busy: false,
      createByName,
      onCancel: vi.fn(),
      onPicked: vi.fn(),
      onError: vi.fn(),
    })
    const input = rendered.find((element) => element.props.id === 'dsh-ws-name')
    ;(input?.props.onChange as (event: unknown) => void)({ target: { value: 'alpha' } })
    rendered.rerender()
    const field = rendered.find((element) => element.props.id === 'dsh-ws-name')
    await (field?.props.onKeyDown as (event: unknown) => unknown)({ key: 'Enter' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(createByName).toHaveBeenCalledWith('alpha')
  })

  it('ignores an empty (or blank) name instead of creating a nameless workspace', async () => {
    const calls = stubFetch()
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    const injected = (entry.options.inject as () => { createByName: (name: string) => Promise<void> })()
    const createByName = vi.fn(injected.createByName)
    const onCancel = vi.fn()
    const rendered = renderComponent(entry.component, {
      open: true, busy: false, createByName, onCancel, onPicked: vi.fn(), onError: vi.fn(),
    })
    const input = rendered.find((element) => element.props.id === 'dsh-ws-name')
    ;(input?.props.onChange as (event: unknown) => void)({ target: { value: '   ' } })
    rendered.rerender()
    await click(rendered, '创建')

    expect(createByName).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('shows the API error inside the dialog and reports it to the owner', async () => {
    const entry = registeredIn(applyBundle(), 'conversation.hero.workspace.directoryFlow')
    const createByName = vi.fn(async () => { throw new Error('名字已被占用') })
    const onCancel = vi.fn()
    const onError = vi.fn()
    const rendered = renderComponent(entry.component, {
      open: true, busy: false, createByName, onCancel, onPicked: vi.fn(), onError,
    })
    const input = rendered.find((element) => element.props.id === 'dsh-ws-name')
    ;(input?.props.onChange as (event: unknown) => void)({ target: { value: 'alpha' } })
    rendered.rerender()
    await click(rendered, '创建')
    rendered.rerender()

    expect(rendered.find((element) => element.props['data-tone'] === 'danger')).toBeDefined()
    expect(rendered.text()).toContain('名字已被占用')
    expect(onError).toHaveBeenCalledWith('名字已被占用')
    // A failed create keeps the flow open so the operator can correct the name.
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('new-workspace dialog: what the operator sees', () => {
  const openDialog = (over: Record<string, unknown> = {}): Rendered => {
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    return renderComponent(entry.component, {
      open: true,
      busy: false,
      createByName: vi.fn(async () => undefined),
      onCancel: vi.fn(),
      onPicked: vi.fn(),
      onError: vi.fn(),
      ...over,
    })
  }

  it('carries the original copy and exactly one name field', () => {
    const rendered = openDialog()
    expect(rendered.text()).toContain('新建工作区')
    expect(rendered.text()).toContain('输入工作区名称。创建后会出现在侧边栏工作区组中。')
    const inputs = rendered.findAll((element) => element.type === 'input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0].props.id).toBe('dsh-ws-name')
    expect(inputs[0].props.placeholder).toBe('例如：my-project')
    expect(button(rendered, '取消')).toBeDefined()
    expect(button(rendered, '创建')).toBeDefined()
  })

  it('renders nothing until the owner opens the flow', () => {
    expect(openDialog({ open: false }).root()).toBeNull()
  })
})

/**
 * The dialog is the OFFICIAL one, not a lookalike.
 *
 * The operator's instruction was to reuse the official page styles instead of
 * writing our own, so "the dialog looks right" is not the assertion — "the
 * dialog IS the official components" is. Identity is checkable because the
 * bundle receives them from the module table exactly as the browser does
 * (`@deepseek-ai/dsh-client-ui-primitives` is a seed word of the web shell).
 */
describe('new-workspace dialog: built from the official component family', () => {
  const openDialog = (over: Record<string, unknown> = {}): Rendered => {
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    return renderComponent(entry.component, {
      open: true,
      busy: false,
      createByName: vi.fn(async () => undefined),
      onCancel: vi.fn(),
      onPicked: vi.fn(),
      onError: vi.fn(),
      ...over,
    })
  }

  it('requires the official family from the module table', () => {
    applyBundle()
    expect(requiredModules()).toContain(PRIMITIVES_MODULE)
  })

  it('renders the official Modal as its root, with the official field and actions', () => {
    const rendered = openDialog()
    expect(rendered.root()?.type).toBe(primitivesStub.Modal)
    const input = rendered.find((element) => element.type === 'input')
    expect(input).toBeDefined()
    // The native input sits inside the official Input wrapper, which is what
    // bounds its width by the container instead of by a caller class.
    const field = rendered.find((element) => element.props['data-primitive'] === 'Input')
    expect(field?.props.className).toContain('official-input')
    expect(rendered.find((element) => element.type === 'input')).toBeDefined()
    const actions = rendered.findAll((element) => element.props['data-primitive'] === 'Button')
    expect(actions.map((action) => action.props.className)).toEqual([
      'official-button outline',
      'official-button primary',
    ])
    expect(rendered.text()).toContain('取消')
    expect(rendered.text()).toContain('创建')
  })

  it('shows a failure through the official danger Tag, not a bespoke element', async () => {
    const entry = registeredIn(applyBundle(), 'sidebar.workspaces.directoryFlow')
    const createByName = vi.fn(async () => { throw new Error('"a b" is not a valid workspace name') })
    const rendered = renderComponent(entry.component, {
      open: true, busy: false, createByName, onCancel: vi.fn(), onPicked: vi.fn(), onError: vi.fn(),
    })
    const input = rendered.find((element) => element.type === 'input')
    ;(input?.props.onChange as (event: unknown) => void)({ target: { value: 'a b' } })
    rendered.rerender()
    await click(rendered, '创建')
    rendered.rerender()

    const tag = rendered.find((element) => element.props['data-primitive'] === 'Tag')
    expect(tag?.props['data-tone']).toBe('danger')
    expect(rendered.text()).toContain('"a b" is not a valid workspace name')
    // Announced, not just painted.
    expect(rendered.find((element) => element.props.role === 'alert')).toBeDefined()
  })

  it('carries no plugin-authored class: every element is the official one', () => {
    const rendered = openDialog()
    const own = rendered.elements()
      .map((element) => element.props.className)
      .filter((className): className is string => typeof className === 'string')
      .filter((className) => className.includes('dsh-'))
    expect(own).toEqual([])
  })
})

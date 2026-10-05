/**
 * The workspace detail view ("工作区" tab) the SHIPPED bundle registers.
 *
 * The operator asked for this page back explicitly: it is the session-scoped
 * view of the workspace a session runs in — status, lifecycle, timeline,
 * metrics and the k8s resource it executes on — and it is data the `main`
 * status panel does not replace (that panel is workspace-scoped and has no
 * session).
 *
 * Pinned here, against the committed `lib/client.js`:
 *
 *   - the registration: `conversation.view`, id `workspace`, order 30, label
 *     工作区 — the id and order it has always had, so the tab keeps its seat;
 *   - it renders the workspace the SESSION is accounted to (`sessionIds`), and
 *     the empty state when the session has none;
 *   - the catalog row is joined by the official native workspace id OR the
 *     platform id (the catalog keys by the platform id but carries the native
 *     UUID), which is what makes the phase/countdown/stats land on the row;
 *   - lifecycle actions address the PLATFORM id, not the native UUID — the API
 *     takes the path segment, so sending the official uuid would 404.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBundle,
  button,
  registeredIn,
  renderComponent,
  type Element,
  type Registered,
  type Rendered,
} from './client-harness.ts'
import { registerWorkspaceDetailView, type SlotRegistry } from '../src/client/register.ts'

interface Call {
  url: string
  init: { method?: string; body?: unknown }
}

/** Let every pending promise chain of a click settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const click = async (rendered: Rendered, label: string): Promise<void> => {
  const target = button(rendered, label)
  await (target.props.onClick as () => unknown)()
  await flush()
}

/** Record every API call; a list call answers `rows` unless told otherwise. */
const stubFetch = (payloads: Record<string, unknown> = {}): Call[] => {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: Call['init']) => {
    const key = String(url)
    calls.push({ url: key, init })
    const data = payloads[key] ?? (key === '/workspaces/api/list' ? [] : {})
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) })
  })
  return calls
}

/** The official Workspace registration the frame hands every slot entry. */
const officialWorkspace = (sessionIds: readonly string[]) => ({
  workspaceId: 'native-1',
  path: '/workspaces/ws-alpha',
  title: '平台',
  sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

/** One catalog row exactly as `/workspaces/api/list` serves it. */
const catalogRow = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-alpha',
  path: '/workspaces/ws-alpha',
  nativeWorkspaceId: 'native-1',
  title: '平台',
  phase: 'running',
  hasPod: true,
  hasPvc: true,
  activeSessions: 1,
  openTurns: 0,
  activeCommands: 0,
  wakeCount: 2,
  sleepCount: 1,
  timeline: [{ at: 1_700_000_000_000, type: 'wake', text: '拉起执行 Pod' }],
  k8s: null,
  metrics: null,
  ...over,
})

const detailEntry = (): Registered => registeredIn(applyBundle(), 'conversation.view')

/** Render the detail view for one session, with the official item set given. */
const renderDetail = (sessionIds: readonly string[]): Rendered => {
  const items = sessionIds.length === 0 ? [] : [officialWorkspace(sessionIds)]
  return renderComponent(detailEntry().component, {
    sessionId: 's1',
    useWorkspaces: (selector: (snapshot: { items: unknown[] }) => unknown) => selector({ items }),
  })
}

/**
 * Put the catalog snapshot in a known state: render the status panel (whose 刷新
 * button polls the same module-level store the detail view reads) and click it.
 */
const seedCatalog = async (rows: unknown[]): Promise<Call[]> => {
  const calls = stubFetch({ '/workspaces/api/list': rows })
  const panel = renderComponent(registeredIn(applyBundle(), 'main').component, {})
  await click(panel, '刷新')
  return calls
}

const textOf = (element: Element | undefined): string => {
  let text = ''
  const visit = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { text += String(node); return }
    if (Array.isArray(node)) { for (const item of node) visit(item); return }
    if (typeof node === 'object' && node !== null && 'props' in node) {
      visit((node as Element).props.children)
    }
  }
  visit(element?.props.children)
  return text
}

/**
 * Text of the headline phase line: the phase copy that comes from the CATALOG
 * ROW. It is asserted separately from the body text because the lifecycle strip
 * always prints the four state names, so a plain `text()).toContain('运行中')`
 * would still pass with a broken catalog join.
 */
const phaseLine = (rendered: Rendered): string =>
  textOf(rendered.find((element) => element.props.className === 'dsh-wsd-phase-line'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('workspace detail view: registration', () => {
  it('registers the 工作区 tab on conversation.view with its original identity', () => {
    const entry = detailEntry()
    expect(entry.options.id).toBe('workspace')
    expect(entry.options.order).toBe(30)
    expect((entry.options.label as () => string)()).toBe('工作区')
    expect(typeof entry.component).toBe('function')
  })

  it('does not take the seat from the official browser or the hero', () => {
    const applied = applyBundle()
    const slots = applied.registered.map((entry) => entry.slot)
    expect(slots).not.toContain('sidebar.workspaces')
    expect(slots).not.toContain('conversation.hero.workspace')
  })
})

describe('registerWorkspaceDetailView (source wiring)', () => {
  const fakeRegistry = (declared: string[]) => {
    const calls: Array<{ slot: string; options: Record<string, unknown>; component: unknown }> = []
    const injected: string[] = []
    const registry: SlotRegistry = {
      inject(slot, callback) {
        injected.push(slot)
        if (declared.includes(slot)) callback()
        return () => undefined
      },
      register(options, component) {
        calls.push({ slot: String(options.name), options, component })
        return () => undefined
      },
    }
    return { registry, calls, injected }
  }

  it('waits for the conversation.view declaration and registers one entry', () => {
    const { registry, calls, injected } = fakeRegistry(['conversation.view'])
    const View = () => null
    registerWorkspaceDetailView(registry, View)
    expect(injected).toEqual(['conversation.view'])
    expect(calls).toHaveLength(1)
    expect(calls[0].options.id).toBe('workspace')
    expect(calls[0].options.order).toBe(30)
    expect(calls[0].component).toBe(View)
  })

  it('registers nothing while the slot is not declared', () => {
    const { registry, calls } = fakeRegistry([])
    registerWorkspaceDetailView(registry, () => null)
    expect(calls).toHaveLength(0)
  })
})

describe('workspace detail view: rendering', () => {
  it('shows the workspace the session is accounted to', () => {
    const rendered = renderDetail(['s1'])
    expect(rendered.text()).toContain('平台')
    expect(rendered.text()).not.toContain('该会话未关联工作区')
    expect(rendered.text()).toContain('生命周期')
    expect(rendered.text()).toContain('时间线')
    expect(rendered.text()).toContain('资源指标')
    // No catalog row yet: metrics are reported as unavailable, not invented.
    expect(rendered.text()).toContain('指标不可用（需 metrics-server）')
    expect(button(rendered, '删除')).toBeDefined()
  })

  it('shows the empty state for a session that has no workspace', () => {
    const rendered = renderDetail([])
    expect(rendered.text()).toContain('该会话未关联工作区')
    expect(rendered.text()).not.toContain('生命周期')
  })

  it('ignores a session accounted to no workspace of its own', () => {
    const rendered = renderDetail(['other-session'])
    expect(rendered.text()).toContain('该会话未关联工作区')
  })

  it('renders the catalog row joined by the official native workspace id', async () => {
    await seedCatalog([catalogRow()])
    const rendered = renderDetail(['s1'])

    // The phase copy comes from the catalog row only if the join matched the
    // platform row to the official item; the lifecycle strip prints its four
    // state names regardless, so the phase LINE is asserted on its own.
    expect(phaseLine(rendered)).toContain('运行中')
    expect(rendered.text()).toContain('保留') // PVC
    expect(rendered.text()).toContain('拉起执行 Pod') // newest timeline event
    expect(rendered.text()).toContain('运行时长')
  })

  it('addresses lifecycle actions by the platform id, not the official uuid', async () => {
    const calls = await seedCatalog([catalogRow()])
    const rendered = renderDetail(['s1'])
    await click(rendered, '休眠')

    const sleep = calls.find((call) => call.url === '/workspaces/api/sleep')
    expect(sleep).toBeDefined()
    expect(sleep?.init.method).toBe('POST')
    // The API takes the platform path segment; the official uuid would 404.
    expect(JSON.parse(String(sleep?.init.body))).toEqual({ workspaceId: 'ws-alpha' })
  })

  it('offers 唤醒 for a sleeping workspace and hides 休眠', async () => {
    await seedCatalog([catalogRow({ phase: 'sleep', hasPod: false })])
    const rendered = renderDetail(['s1'])
    expect(phaseLine(rendered)).toContain('休眠中')
    expect(rendered.text()).toContain('休眠中 · PVC 已保留')
    expect(rendered.find((element) => element.type === 'button' && textOf(element) === '唤醒')).toBeDefined()
    expect(rendered.find((element) => element.type === 'button' && textOf(element) === '休眠')).toBeUndefined()
  })
})

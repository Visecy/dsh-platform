/**
 * The panel's slot wiring.
 *
 * The platform no longer owns the sidebar workspace list — the official
 * `ui-workspace` row does — so the only surfaces this plugin may claim are an
 * ADDITIVE `main` panel, its `sidebar.panellist` entry and an optional
 * `shell.overlay` pill. This spec pins that contract against a fake registry,
 * without booting a browser: the failure it guards is a future edit quietly
 * re-claiming `sidebar.workspaces` (or dropping the components, which would
 * register invisible rows).
 */
import { describe, expect, it } from 'vitest'
import { registerWorkspacePanel, type SlotRegistry } from '../src/client/register.ts'

interface Call {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

const fakeRegistry = (declared: string[] = ['main', 'sidebar.panellist', 'shell.overlay']) => {
  const calls: Call[] = []
  const injected: string[] = []
  const registry: SlotRegistry = {
    inject(slot, callback) {
      injected.push(slot)
      // The real registry runs the callback only once the slot is declared.
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

const fakeComponents = () => ({
  Panel: () => null,
  Icon: () => null,
  Pill: () => null,
})

const optionsFor = (calls: Call[], slot: string): Record<string, unknown> => {
  const call = calls.find((c) => c.slot === slot)
  if (call === undefined) throw new Error(`no registration for slot ${slot}`)
  return call.options
}

describe('registerWorkspacePanel', () => {
  it('adds a keyed main panel, a sidebar entry and a shell pill — and replaces nothing', () => {
    const { registry, calls, injected } = fakeRegistry()
    registerWorkspacePanel(registry, fakeComponents())
    expect(injected).toEqual(['main', 'sidebar.panellist', 'shell.overlay'])
    expect(calls.map((c) => c.slot)).toEqual(['main', 'sidebar.panellist', 'shell.overlay'])
  })

  it('keys the main panel and gives the sidebar entry the same id, so the row selects the panel', () => {
    const { registry, calls } = fakeRegistry()
    registerWorkspacePanel(registry, fakeComponents())
    expect(optionsFor(calls, 'main').key).toBe('workspace-status')
    expect(optionsFor(calls, 'sidebar.panellist').id).toBe('workspace-status')
    expect(optionsFor(calls, 'shell.overlay').id).toBe('workspace-status-pill')
  })

  it('titles the panel and its sidebar row', () => {
    const { registry, calls } = fakeRegistry()
    registerWorkspacePanel(registry, fakeComponents())
    for (const slot of ['main', 'sidebar.panellist']) {
      const label = optionsFor(calls, slot).label
      expect(typeof label).toBe('function')
      expect((label as () => string)()).toBe('工作区状态')
    }
  })

  it('registers the components it was handed, so no slot entry is invisible', () => {
    const { registry, calls } = fakeRegistry()
    const components = fakeComponents()
    registerWorkspacePanel(registry, components)
    expect(calls.find((c) => c.slot === 'main')?.component).toBe(components.Panel)
    expect(calls.find((c) => c.slot === 'sidebar.panellist')?.component).toBe(components.Icon)
    expect(calls.find((c) => c.slot === 'shell.overlay')?.component).toBe(components.Pill)
  })

  it('waits for the official declarations instead of registering eagerly', () => {
    const { registry, calls } = fakeRegistry([])
    registerWorkspacePanel(registry, fakeComponents())
    expect(calls).toHaveLength(0)
  })

  it('claims none of the surfaces the official ui-workspace row owns', () => {
    const { registry, calls } = fakeRegistry([
      'main', 'sidebar.panellist', 'shell.overlay', 'sidebar.workspaces',
      'conversation.hero.workspace', 'conversation.view', 'sidebar',
    ])
    registerWorkspacePanel(registry, fakeComponents())
    const slots = calls.map((c) => c.slot)
    expect(slots).not.toContain('sidebar.workspaces')
    expect(slots).not.toContain('conversation.hero.workspace')
    expect(slots).not.toContain('conversation.view')
    expect(slots).not.toContain('sidebar')
  })
})

/**
 * The panel's slot wiring.
 *
 * The platform no longer owns the sidebar workspace list — the official
 * `ui-workspace` row does — so the only surfaces this plugin may claim are an
 * ADDITIVE `main` panel and its `sidebar.panellist` entry. This spec pins that
 * contract against a fake registry, without booting a browser: the failures it
 * guards are a future edit quietly re-claiming `sidebar.workspaces`, dropping
 * the components (which would register invisible rows), or bringing back the
 * `shell.overlay` pill.
 *
 * The pill's removal is a deliberate, tested decision, not an omission: it
 * rendered top-left, over the brand mark, and its copy ("工作区：3 个休眠中")
 * was the only place those numbers appeared. The `main` panel and the sidebar
 * entry already carry the same status, and both sit in layout-owned space, so
 * the overlay was pure overlap. The last two cases pin that: no
 * `shell.overlay` registration, and no always-on fixed-position pill rule in
 * the stylesheet the plugin injects.
 */
import { describe, expect, it } from 'vitest'
import { registerWorkspacePanel, type SlotRegistry } from '../src/client/register.ts'
import { WORKSPACE_UI_CSS } from '../src/client/styles.ts'

interface Call {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

const fakeRegistry = (declared: string[] = ['main', 'sidebar.panellist']) => {
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
})

const optionsFor = (calls: Call[], slot: string): Record<string, unknown> => {
  const call = calls.find((c) => c.slot === slot)
  if (call === undefined) throw new Error(`no registration for slot ${slot}`)
  return call.options
}

describe('registerWorkspacePanel', () => {
  it('adds a keyed main panel and its sidebar entry — and replaces nothing', () => {
    const { registry, calls, injected } = fakeRegistry()
    registerWorkspacePanel(registry, fakeComponents())
    expect(injected).toEqual(['main', 'sidebar.panellist'])
    expect(calls.map((c) => c.slot)).toEqual(['main', 'sidebar.panellist'])
  })

  it('keys the main panel and gives the sidebar entry the same id, so the row selects the panel', () => {
    const { registry, calls } = fakeRegistry()
    registerWorkspacePanel(registry, fakeComponents())
    expect(optionsFor(calls, 'main').key).toBe('workspace-status')
    expect(optionsFor(calls, 'sidebar.panellist').id).toBe('workspace-status')
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
    expect(slots).not.toContain('sidebar')
  })

  it('never registers the frame-wide overlay the pill used to sit in', () => {
    const { registry, calls, injected } = fakeRegistry(['main', 'sidebar.panellist', 'shell.overlay'])
    registerWorkspacePanel(registry, fakeComponents())
    expect(injected).not.toContain('shell.overlay')
    expect(calls.map((c) => c.slot)).not.toContain('shell.overlay')
  })

  it('ships no always-on floating pill rule that could overlap the brand mark', () => {
    // The removed pill was the only ALWAYS-ON overlay this plugin ever
    // rendered; the panel and the sidebar glyph are laid out by their owners,
    // and the new-workspace dialog's mask — the one overlay that used to be
    // allowed here — now comes from the official `Modal` it is built on. So
    // this stylesheet must carry no fixed-position rule whatsoever.
    expect(WORKSPACE_UI_CSS).not.toContain('dsh-wsp-pill')
    const fixed = WORKSPACE_UI_CSS.split('\n').filter((line) => /position:\s*fixed/.test(line))
    expect(fixed).toEqual([])
  })
})

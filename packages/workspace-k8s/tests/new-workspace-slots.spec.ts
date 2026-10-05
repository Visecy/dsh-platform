/**
 * The new-workspace dialog's slot wiring and its stylesheet, asserted against
 * the source wiring module rather than through the bundle.
 *
 * Same contract as `new-workspace-dialog.spec.ts`, one layer down: the two
 * `directoryFlow` holes are a FILLED seat (`priority: -100`, above the official
 * directory browser's default 0), not a request to browse a directory. The
 * dialog is one component in both holes and commits through one injected
 * `createByName` — the owner share's picked-path callback is not part of what
 * the cell is handed.
 *
 * The stylesheet half is here because a dialog that renders unstyled over the
 * frame is a real failure mode: the mask and the card must ship with it, and
 * the mask is the ONLY fixed-position rule this plugin may carry (the removed
 * status pill was the other one, and it covered the brand mark).
 */
import { describe, expect, it } from 'vitest'
import { registerNewWorkspaceDialog, registerWorkspacePanel, type SlotRegistry } from '../src/client/register.ts'
import { WORKSPACE_UI_CSS } from '../src/client/styles.ts'

interface Call {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

const fakeRegistry = (declared: string[] = []) => {
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

const DIALOG_SLOTS = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']

describe('registerNewWorkspaceDialog', () => {
  it('fills both directory-flow holes with one dialog', () => {
    const { registry, calls, injected } = fakeRegistry(DIALOG_SLOTS)
    const Dialog = () => null
    registerNewWorkspaceDialog(registry, Dialog, () => ({ createByName: async () => undefined }))

    expect(injected).toEqual(DIALOG_SLOTS)
    expect(calls.map((call) => call.slot)).toEqual(DIALOG_SLOTS)
    for (const call of calls) {
      // Lowest priority renders: this is what keeps the official directory
      // browser (default 0) out of both holes.
      expect(call.options.priority).toBe(-100)
      expect(call.component).toBe(Dialog)
    }
  })

  it('waits for the official declarations instead of registering eagerly', () => {
    const { registry, calls } = fakeRegistry([])
    registerNewWorkspaceDialog(registry, () => null, () => ({ createByName: async () => undefined }))
    expect(calls).toHaveLength(0)
  })

  it('hands each hole the name-commit share and nothing path-shaped', () => {
    const { registry, calls } = fakeRegistry(DIALOG_SLOTS)
    const createByName = async (): Promise<void> => undefined
    registerNewWorkspaceDialog(registry, () => null, () => ({ createByName }))
    for (const call of calls) {
      const injected = (call.options.inject as () => Record<string, unknown>)()
      expect(Object.keys(injected)).toEqual(['createByName'])
      expect(injected.createByName).toBe(createByName)
    }
  })

  it('leaves the panel registration owning none of the directory holes', () => {
    const { registry, calls, injected } = fakeRegistry([...DIALOG_SLOTS, 'main', 'sidebar.panellist'])
    registerWorkspacePanel(registry, { Panel: () => null, Icon: () => null })
    expect(injected).toEqual(['main', 'sidebar.panellist'])
    expect(calls.map((call) => call.slot)).toEqual(['main', 'sidebar.panellist'])
  })
})

describe('the new-workspace dialog stylesheet', () => {
  it('ships the mask and the card the dialog renders', () => {
    expect(WORKSPACE_UI_CSS).toContain('.dsh-ws-modal-overlay')
    expect(WORKSPACE_UI_CSS).toContain('.dsh-ws-modal-error')
  })

  it('carries exactly one fixed-position rule: the dialog mask', () => {
    const fixed = WORKSPACE_UI_CSS.split('\n').filter((line) => /position:\s*fixed/.test(line))
    expect(fixed).toHaveLength(1)
    expect(fixed[0]).toContain('.dsh-ws-modal-overlay')
  })
})

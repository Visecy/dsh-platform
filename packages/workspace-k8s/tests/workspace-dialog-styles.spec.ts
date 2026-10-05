/**
 * The new-workspace dialog's STYLESHEET, asserted against the SHIPPED bundle.
 *
 * The dialog was restored byte-identical from `bc6689a^` (commit 9d70232) while
 * its stylesheet was rewritten twice in between, and the operator's first click
 * showed a browser-default form. Markup restored verbatim says nothing about
 * whether anything styles it: the class names the component renders and the
 * class names the plugin injects are two independent facts, and only the pair
 * makes a dialog.
 *
 * So this spec does not grep the stylesheet for a selector someone remembered to
 * list. It:
 *
 *   1. applies the committed `lib/client.js` and takes the stylesheet the plugin
 *      ACTUALLY appended to `document.head` (and asserts it carries the
 *      `data-dsh-workspace-ui` guard attribute the injection path keys on);
 *   2. renders the dialog the bundle registered, with the real owner share;
 *   3. requires a rule that matches EVERY element the dialog renders —
 *      including the two footer buttons, whose `dsh-ws-btn` rules were the ones
 *      actually missing while the mask and card were present.
 *
 * A missing class therefore fails here as a user would meet it: as an element
 * with no styling. Adding a class name to the component without a rule for it
 * fails this spec too, which is the point.
 */
import { describe, expect, it } from 'vitest'
import {
  applyBundle,
  injectedStyles,
  registeredIn,
  renderComponent,
  type Element,
  type Rendered,
} from './client-harness.ts'

const DIALOG_SLOT = 'conversation.hero.workspace.directoryFlow'

/** The owner share the official picker flow hands its hole occupant. */
const ownerShare = {
  open: true,
  busy: false,
  onPicked: () => undefined,
  onCancel: () => undefined,
  onError: () => undefined,
}

/**
 * Every selector in a stylesheet, one per comma-separated alternative.
 *
 * Comments are stripped and each rule's prelude is read from its LAST line: a
 * comment directly above a rule belongs to that rule's prelude after a naive
 * `}`-split, and a selector that only looks present because a comment carried
 * its text would be exactly the false pass this spec exists to prevent.
 */
function selectors(css: string): string[] {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((chunk) => (chunk.split('{')[0] ?? '').split('\n').filter((line) => line.trim() !== '').at(-1) ?? '')
    .flatMap((rule) => rule.split(','))
    .map((selector) => selector.trim())
    .filter((selector) => selector.startsWith('.'))
}

/** Whether some rule's selector names every class the element carries. */
function styledBy(css: string, className: string): boolean {
  const classes = className.split(/\s+/).filter((name) => name !== '')
  return selectors(css).some((selector) =>
    classes.every((name) => new RegExp(`\\.${name}(?![A-Za-z0-9_-])`).test(selector)))
}

/** The dialog, open, as the frame renders it. */
function openDialog(): Rendered {
  const applied = applyBundle()
  const registration = registeredIn(applied, DIALOG_SLOT)
  return renderComponent(registration.component, {
    ...ownerShare,
    createByName: async () => undefined,
  })
}

/** Every className in the rendered tree, deduplicated. */
function classNames(rendered: Rendered): string[] {
  const found = new Set<string>()
  for (const element of rendered.elements()) {
    const className = (element as Element).props.className
    if (typeof className === 'string' && className !== '') found.add(className)
  }
  return [...found]
}

describe('the new-workspace dialog stylesheet', () => {
  it('is appended to the document, carrying the plugin guard attribute', () => {
    applyBundle()
    const styles = injectedStyles()
    expect(styles).toHaveLength(1)
    expect(styles[0].dataset.dshWorkspaceUi).toBe('true')
    expect(styles[0].textContent).toContain('.dsh-ws-modal')
  })

  it('is injected once per document, not once per apply', () => {
    // The frame mounts and unmounts slot occupants, and a plugin row can be
    // re-applied by a live profile edit: a second stylesheet per apply would
    // grow the document for the life of the tab.
    applyBundle()
    applyBundle()
    expect(injectedStyles()).toHaveLength(1)
  })

  it('styles every element the dialog renders, footer buttons included', () => {
    const rendered = openDialog()
    const css = injectedStyles()[0]?.textContent ?? ''
    const names = classNames(rendered)
    // The dialog renders the mask, the card, its copy, its input, the footer
    // and the two buttons; an empty tree would make the coverage check vacuous.
    expect(names).toContain('dsh-ws-modal-overlay')
    expect(names).toContain('dsh-ws-btn')
    const unstyled = names.filter((name) => !styledBy(css, name))
    expect(unstyled).toEqual([])
  })

  it('renders the card as a centred overlay and its buttons as buttons', () => {
    const rendered = openDialog()
    const css = injectedStyles()[0]?.textContent ?? ''
    const overlay = rendered.find((element) => element.props.className === 'dsh-ws-modal-overlay')
    expect(overlay).toBeDefined()
    const buttons = rendered.findAll((element) => element.type === 'button')
    expect(buttons).toHaveLength(2)
    // The primary action is visually distinct from the cancel beside it; both
    // are the platform's button, not the user agent's.
    expect(styledBy(css, 'dsh-ws-btn')).toBe(true)
    expect(styledBy(css, 'dsh-ws-btn primary')).toBe(true)
    expect(styledBy(css, 'dsh-ws-modal-footer')).toBe(true)
    // The mask the user closes the dialog with covers the frame.
    expect(css).toMatch(/\.dsh-ws-modal-overlay\s*\{[^}]*position:\s*fixed/)
  })
})

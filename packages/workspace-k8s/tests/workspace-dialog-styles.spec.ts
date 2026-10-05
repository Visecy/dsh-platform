/**
 * The new-workspace dialog no longer has a stylesheet of its own — and that is
 * the assertion.
 *
 * The dialog was restored from `bc6689a^` (commit 9d70232) while the plugin's
 * stylesheet was rewritten in between, so its markup rendered as a
 * browser-default form; commit `ed944c6` then added `dsh-ws-*` rules by hand to
 * make it look like a dialog again. Those rules drifted exactly as hand-written
 * CSS does: the operator's next look found the name field running past the card
 * ("都快顶出窗口了"), because the rules were the plugin's own idea of a modal
 * rather than the platform's.
 *
 * The rebuild takes the platform's own components instead
 * (`@deepseek-ai/dsh-client-ui-primitives`, a static seed word of the web
 * shell's module table — see `new-workspace-dialog.spec.ts` for the identity
 * assertions), so this spec pins the other half of that decision:
 *
 *   1. the plugin's injected stylesheet STILL exists, once per document, with
 *      the `data-dsh-workspace-ui` guard the injection path keys on — the panel
 *      and the detail view are still styled by it;
 *   2. it carries NO rule for the dialog any more (the whole `新建工作区 Modal`
 *      block and the `dsh-ws-btn` rules are deleted, not renamed), while the
 *      panel/detail families it does own survive;
 *   3. nothing the dialog renders carries a plugin-authored class. That is the
 *      mechanical form of "the dialog is the official one": if a future edit
 *      reintroduces a `dsh-ws-*` class to fix a width, this fails.
 *
 * The real width of the field is the official `Input` wrapper's, inside the
 * official `Modal`'s 24px content column (`Modal.module.css`: card
 * `width: min(380px, 100%)`, body `padding: 0 24px`; `Input.module.css`: the
 * wrapper is an inline-flex span with no width of its own, so a flex-column
 * parent stretches it to exactly that column). No unit test here can measure
 * that — it is asserted in the browser, on the live cluster, against the
 * computed style of the rendered input.
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

/** The stylesheet the plugin actually appended. */
const pluginCss = (): string => injectedStyles()[0]?.textContent ?? ''

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

describe('the new-workspace dialog and the plugin stylesheet', () => {
  it('still injects the plugin stylesheet, guarded the same way', () => {
    applyBundle()
    const styles = injectedStyles()
    expect(styles).toHaveLength(1)
    expect(styles[0].dataset.dshWorkspaceUi).toBe('true')
    // The stylesheet is still the panel's and the detail view's home.
    expect(styles[0].textContent).toContain('.dsh-wsp')
    expect(styles[0].textContent).toContain('.dsh-wsd')
  })

  it('is injected once per document, not once per apply', () => {
    // The frame mounts and unmounts slot occupants, and a plugin row can be
    // re-applied by a live profile edit: a second stylesheet per apply would
    // grow the document for the life of the tab.
    applyBundle()
    applyBundle()
    expect(injectedStyles()).toHaveLength(1)
  })

  it('no longer carries a single rule for the dialog it replaced', () => {
    applyBundle()
    const css = pluginCss()
    // The whole bespoke block: the mask/card/field/footer rules AND the button
    // rules `ed944c6` added after their absence rendered user-agent buttons.
    expect(css).not.toContain('dsh-ws-modal')
    expect(css).not.toContain('dsh-ws-btn')
    const dialogRules = selectors(css).filter((selector) =>
      /\.dsh-ws-(?:modal|btn)(?![A-Za-z0-9_-])/.test(selector))
    expect(dialogRules).toEqual([])
    // The panel/detail families are NOT collateral damage: `dsh-wsd-btn` is a
    // different class from the deleted `dsh-ws-btn` and must survive.
    expect(selectors(css).some((selector) => selector.includes('.dsh-wsd-btn'))).toBe(true)
  })

  it('renders no element carrying a plugin-authored class', () => {
    const rendered = openDialog()
    const names = classNames(rendered)
    // The dialog renders the official family's elements; an empty tree would
    // make this vacuous, so pin the ones that exist.
    expect(names.length).toBeGreaterThan(0)
    const own = names.filter((name) => name.includes('dsh-'))
    expect(own).toEqual([])
    // …and none of the classes it does carry is addressed by the plugin's CSS.
    const css = pluginCss()
    const addressed = names.filter((name) =>
      selectors(css).some((selector) => selector.includes(`.${name}`)))
    expect(addressed).toEqual([])
  })
})

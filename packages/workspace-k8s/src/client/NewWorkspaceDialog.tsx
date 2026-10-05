/**
 * The platform's name-based "新建工作区" dialog.
 *
 * A workspace here is a platform RECORD (its own PVC, pod and anchor
 * directory) created by typing a name — there is no directory to browse and
 * nothing to pick from a list the sidebar already shows. So this dialog fills
 * the two `directoryFlow` seats the official picker/browser declare and commits
 * a NAME instead of a path (see `register.ts`).
 *
 * It is built from the OFFICIAL component family
 * (`@deepseek-ai/dsh-client-ui-primitives`) rather than from this plugin's own
 * markup and stylesheet. That family is already in the composition: it is one
 * of the web shell's static seed words (the shell's module table maps
 * `@deepseek-ai/dsh-client-ui-primitives` alongside `react` and
 * `dsh-client-ui-slots`) and every official client bundle requires it, which is
 * why this module — and not a vendored copy or a new dependency — is where the
 * dialog's chrome comes from:
 *
 *   - `Modal`  gives the mask, the card, the title/description typography, the
 *              24px content column, Escape/mask close and focus handling;
 *   - `Input`  gives the field, sized by its container (the card's content
 *              column) instead of by a width this plugin invented;
 *   - `Button` gives both actions the platform's own outline/primary pair;
 *   - `Tag`    gives a failure the platform's danger tone.
 *
 * The shape follows the official rename dialogs in
 * `@deepseek-ai/dsh-client-ui-workspace` (`Modal` + a footer of
 * outline/primary `Button`s + one labelled field marked `data-modal-autofocus`),
 * because those are the dialogs the operator sees elsewhere in this product.
 * The FIELD's behaviour follows them too — the operator's ruling is "where our
 * field differs from the official one, match the official one":
 *
 *   - the field is sized by the official `Input` wrapper inside the official
 *     card (this plugin passes no `className` and ships no rule for it, so
 *     there is nothing local to override the layout);
 *   - an Enter that belongs to an IME composition does NOT commit: the
 *     official forms track `onCompositionStart/End` in a ref and guard the
 *     keydown with `!composingRef.current`, and the shared primitives also
 *     treat a keydown that reports itself as composing as non-committing
 *     (`event.isComposing || event.keyCode === 229`). Without this, a CJK
 *     operator choosing a candidate created the workspace with a
 *     half-composed name;
 *   - the primary action is disabled while the name is blank
 *     (`blocked = busy || creating || trimmed === ""`, not `busy` alone — the
 *     official create-folder dialog keeps its own `creatingFolder` state beside
 *     the owner's `busy`), and a second Enter while our request is in flight
 *     starts no second create;
 *   - Escape, a mask click and 取消 do not dismiss the dialog mid-create
 *     (the official `close()` is `if (creating) return;`);
 *   - editing the name clears the previous failure;
 *   - the field takes focus on open through `data-modal-autofocus` and selects
 *     its content when focused.
 *
 * The plugin therefore ships no CSS for this dialog at all: the `dsh-ws-*`
 * rules that used to style it were deleted with this rewrite (they had already
 * drifted once and left the name field running past the card).
 */
import { createElement, useEffect, useRef, useState } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

export interface NewWorkspaceDialogInjected {
  createByName: (name: string) => Promise<void>
}

export type NewWorkspaceDialogProps = DirectoryFlowOwnerProps & NewWorkspaceDialogInjected

/** The field's accessible name; it labels the one control the dialog has. */
const FIELD_LABEL = '工作区名称'

/**
 * The slice of a React keydown this field acts on. Loose on purpose: the
 * browser delivers a full synthetic event, while the client harness drives the
 * handler directly, and both must reach the same guard.
 */
interface KeydownLike {
  key?: string
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: { isComposing?: boolean }
  preventDefault?: () => void
}

/**
 * Is this keydown part of an IME composition, as the official code decides it?
 *
 * Two spellings, both official: the React callers read the synthetic event's
 * `nativeEvent.isComposing` (`dsh-client-ui-model-selection`), and the shared
 * primitives read the event's own flags, including the legacy 229 keyCode that
 * some browsers report while a candidate list is open
 * (`dsh-client-ui-primitives`: `event.isComposing || event.keyCode === 229`).
 * A field that only tracked `compositionstart/end` would still commit on a
 * browser that fires the keydown after `compositionend` without a flag, and one
 * that only read the flags would commit on a browser that omits them — the two
 * together are what makes selecting a candidate safe.
 */
function composingKeydown(e: KeydownLike): boolean {
  return e.nativeEvent?.isComposing === true || e.isComposing === true || e.keyCode === 229
}

export function NewWorkspaceDialog(props: NewWorkspaceDialogProps) {
  const { open, busy, onCancel, onError, createByName } = props
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  /**
   * This dialog's OWN in-flight state, exactly like the official create-folder
   * dialog's `creatingFolder`: the owner's `busy` is the frame's state (a
   * listing in progress), not ours, and without a local flag the primary
   * action stays live during our own request.
   */
  const [creating, setCreating] = useState(false)
  /**
   * A ref, not state: the keydown that ends a composition is dispatched in the
   * same tick as the composition events, so the guard must read the flag
   * immediately rather than after a re-render (the official forms use a ref for
   * exactly this reason).
   */
  const composingRef = useRef(false)

  useEffect(() => {
    if (open) {
      setName('')
      setError('')
      setCreating(false)
      composingRef.current = false
    }
  }, [open])

  if (!open) return null

  const trimmed = name.trim()
  // The official rule: a blank name means the primary action is unavailable,
  // and an in-flight create blocks everything (including a second Enter).
  const blocked = busy || creating || trimmed === ''

  const submit = async () => {
    if (blocked) return
    setCreating(true)
    setError('')
    try {
      await createByName(trimmed)
      onCancel()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      onError?.(message)
    } finally {
      setCreating(false)
    }
  }

  /** Escape, the mask and 取消 all land here; none may interrupt a create. */
  const close = () => {
    if (busy || creating) return
    onCancel()
  }

  return createElement(Modal, {
    open,
    onClose: close,
    closeLabel: '关闭',
    title: '新建工作区',
    description: '输入工作区名称。创建后会出现在侧边栏工作区组中。',
    footer: [
      createElement(Button, {
        key: 'cancel',
        variant: 'outline',
        disabled: busy || creating,
        onClick: close,
      }, '取消'),
      createElement(Button, {
        key: 'create',
        variant: 'primary',
        disabled: blocked,
        onClick: () => void submit(),
      }, '创建'),
    ],
  },
    createElement(Input, {
      key: 'name',
      id: 'dsh-ws-name',
      'aria-label': FIELD_LABEL,
      placeholder: '例如：my-project',
      // The Modal's documented initial-focus hook. React's `autoFocus` is
      // deliberately NOT used: it would fight the dialog's own focus restore.
      'data-modal-autofocus': true,
      value: name,
      disabled: busy,
      onChange: (e: { target: { value: string } }) => {
        setName(e.target.value)
        // The official onChange clears the previous failure: a corrected name
        // must not sit under a stale error.
        setError('')
      },
      // The official forms select the field's content when it takes focus.
      onFocus: (e: { target: { select: () => void } }) => { e.target.select() },
      onCompositionStart: () => { composingRef.current = true },
      onCompositionEnd: () => { composingRef.current = false },
      onKeyDown: (e: KeydownLike) => {
        if (e.key === 'Enter' && !composingRef.current && !composingKeydown(e)) {
          // The official handler prevents the default (a form submit) before
          // committing.
          e.preventDefault?.()
          void submit()
        }
      },
    }),
    // The API's own message, verbatim, in the platform's danger tone. A failed
    // create keeps the flow open so the operator can correct the name.
    error === ''
      ? null
      : createElement('div', { key: 'error', role: 'alert' },
          createElement(Tag, { tone: 'danger' }, error)),
  )
}

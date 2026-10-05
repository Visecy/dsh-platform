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
 *
 * The plugin therefore ships no CSS for this dialog at all: the `dsh-ws-*`
 * rules that used to style it were deleted with this rewrite (they had already
 * drifted once and left the name field running past the card).
 */
import { createElement, useEffect, useState } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

export interface NewWorkspaceDialogInjected {
  createByName: (name: string) => Promise<void>
}

export type NewWorkspaceDialogProps = DirectoryFlowOwnerProps & NewWorkspaceDialogInjected

/** The field's accessible name; it labels the one control the dialog has. */
const FIELD_LABEL = '工作区名称'

export function NewWorkspaceDialog(props: NewWorkspaceDialogProps) {
  const { open, busy, onCancel, onError, createByName } = props
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setName('')
      setError('')
    }
  }, [open])

  if (!open) return null

  const submit = async () => {
    const value = name.trim()
    if (value === '') return
    setError('')
    try {
      await createByName(value)
      onCancel()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      onError?.(message)
    }
  }

  return createElement(Modal, {
    open,
    onClose: onCancel,
    closeLabel: '关闭',
    title: '新建工作区',
    description: '输入工作区名称。创建后会出现在侧边栏工作区组中。',
    footer: [
      createElement(Button, {
        key: 'cancel',
        variant: 'outline',
        disabled: busy,
        onClick: onCancel,
      }, '取消'),
      createElement(Button, {
        key: 'create',
        variant: 'primary',
        disabled: busy,
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
      onChange: (e: { target: { value: string } }) => setName(e.target.value),
      onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') void submit() },
    }),
    // The API's own message, verbatim, in the platform's danger tone. A failed
    // create keeps the flow open so the operator can correct the name.
    error === ''
      ? null
      : createElement('div', { key: 'error', role: 'alert' },
          createElement(Tag, { tone: 'danger' }, error)),
  )
}

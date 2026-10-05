import { createElement, useEffect, useState } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { workspaceApi } from './api.ts'

export interface NewWorkspaceDialogInjected {
  createByName: (name: string) => Promise<void>
}

export type NewWorkspaceDialogProps = DirectoryFlowOwnerProps & NewWorkspaceDialogInjected

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

  return createElement('div', { className: 'dsh-ws-modal-overlay', onClick: (e: any) => { if (e.target === e.currentTarget) onCancel() } },
    createElement('div', { className: 'dsh-ws-modal' },
      createElement('h3', null, '新建工作区'),
      createElement('p', { className: 'dsh-ws-modal-desc' }, '输入工作区名称。创建后会出现在侧边栏工作区组中。'),
      createElement('label', { htmlFor: 'dsh-ws-name' }, '工作区名称'),
      createElement('input', {
        id: 'dsh-ws-name',
        placeholder: '例如：my-project',
        autoFocus: true,
        value: name,
        disabled: busy,
        onChange: (e: any) => setName(e.target.value),
        onKeyDown: (e: any) => { if (e.key === 'Enter') void submit() },
      }),
      error === '' ? null : createElement('div', { className: 'dsh-ws-modal-error' }, error),
      createElement('div', { className: 'dsh-ws-modal-footer' },
        createElement('button', { className: 'dsh-ws-btn', onClick: onCancel, disabled: busy }, '取消'),
        createElement('button', { className: 'dsh-ws-btn primary', onClick: () => void submit(), disabled: busy }, '创建'),
      ),
    ),
  )
}

import { createElement, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceApi, type CatalogWorkspace } from './api.ts'

type Props = PropsRuntime<'conversation.hero.workspace'> & { startSession?: (workspaceId?: string) => void }

const phaseMap: Record<CatalogWorkspace['phase'], string> = {
  running: '运行中', sleep: '休眠中', provision: '创建中', orphan: '待清理', deleted: '已删除', unknown: '未知',
}

const visible = (rows: CatalogWorkspace[]) => rows.filter((ws) => ws.path.startsWith('/workspaces/') && ws.path !== '/workspaces')

export function WorkspacePicker(props: Props) {
  const { useWorkspaces } = props
  const native = useWorkspaces((s) => s.items)
  const [rows, setRows] = useState<CatalogWorkspace[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const refresh = async () => {
    try { setRows(visible(await workspaceApi.list())) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const create = async () => {
    if (!name.trim()) return
    setError('')
    try {
      await workspaceApi.create(name.trim())
      setName('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void refresh() }, [])
  return createElement('div', { className: 'dsh-workspace-ui dsh-ws-hero' },
    createElement('h2', null, '选择或新建工作区'),
    createElement('div', { className: 'dsh-ws-create' },
      createElement('input', {
        value: name,
        placeholder: '输入新工作区名称',
        onChange: (e: any) => setName(e.target.value),
        onKeyDown: (e: any) => { if (e.key === 'Enter') void create() },
      }),
      createElement('button', { onClick: () => void create() }, '创建'),
    ),
    error === '' ? null : createElement('div', { className: 'dsh-ws-error' }, error),
    createElement('ul', { className: 'dsh-ws-list' },
      rows.map((ws) => createElement('li', { key: ws.workspaceId, className: 'dsh-ws-item' },
        createElement('div', { className: 'dsh-ws-head' },
          createElement('span', { className: 'dsh-ws-name' }, ws.workspaceId),
          createElement('span', { className: `dsh-ws-badge ${ws.phase}` }, phaseMap[ws.phase] ?? ws.phase),
        ),
        createElement('div', { className: 'dsh-ws-actions' },
          createElement('button', {
            className: 'dsh-ws-btn primary',
            onClick: () => { props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId as any) },
          }, ws.phase === 'sleep' ? '唤醒并打开' : '打开'),
        ),
      )),
    ),
  )
}

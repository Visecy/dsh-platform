import { createElement, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceApi, type CatalogWorkspace } from './api.ts'

type Props = PropsRuntime<'sidebar.workspaces'> & { startSession?: (workspaceId?: string) => void }

const phaseMap: Record<CatalogWorkspace['phase'], string> = {
  running: '运行中',
  sleep: '休眠中',
  provision: '创建中',
  orphan: '异常/待清理',
  deleted: '已删除',
  unknown: '未知',
}

export function WorkspaceBrowser(props: Props) {
  const { useWorkspaces } = props
  const native = useWorkspaces((s) => s.items)
  const [rows, setRows] = useState<CatalogWorkspace[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      const list = await workspaceApi.list()
      setRows(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

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

  return createElement('div', { style: { padding: 12 } },
    createElement('h3', null, '工作区'),
    createElement('div', null,
      createElement('input', {
        value: name,
        placeholder: '输入新工作区名称',
        onChange: (e: any) => setName(e.target.value),
        onKeyDown: (e: any) => { if (e.key === 'Enter') void create() },
      }),
      createElement('button', { onClick: () => void create() }, '创建'),
    ),
    error === '' ? null : createElement('div', { style: { color: 'red' } }, error),
    loading ? createElement('div', null, '加载中…') : createElement('ul', null,
      rows.map((ws) => createElement('li', { key: ws.workspaceId, style: { margin: '4px 0' } },
        createElement('span', null, `${ws.workspaceId} · ${phaseMap[ws.phase] ?? ws.phase}`),
        createElement('br'),
        createElement('button', {
          onClick: async () => {
            try {
              await workspaceApi.ensure(ws.workspaceId)
              props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId as any)
            } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          },
        }, ws.phase === 'sleep' ? '唤醒并打开' : '打开'),
        createElement('button', {
          onClick: async () => {
            if (!confirm(`删除工作区 ${ws.workspaceId}？会删除 Pod 和 PVC。`)) return
            try { await workspaceApi.delete(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          },
        }, '删除'),
        ws.phase === 'orphan' ? createElement('button', {
          onClick: async () => {
            try { await workspaceApi.cleanup(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
          },
        }, '清理') : null,
      )),
    ),
    createElement('div', { style: { color: '#666' } }, `原生工作区 ${native.length} 个`),
  )
}

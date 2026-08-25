import { createElement, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceApi, type CatalogWorkspace } from './api.ts'

type Props = PropsRuntime<'sidebar.workspaces'> & { startSession?: (workspaceId?: string) => void }

const phaseMap: Record<CatalogWorkspace['phase'], string> = {
  running: '运行中',
  sleep: '休眠中',
  provision: '创建中',
  orphan: '待清理',
  deleted: '已删除',
  unknown: '未知',
}

const visible = (rows: CatalogWorkspace[]) => rows.filter((ws) => ws.path.startsWith('/workspaces/') && ws.path !== '/workspaces')

export function WorkspaceBrowser(props: Props) {
  const { useWorkspaces } = props
  const native = useWorkspaces((s) => s.items)
  const [rows, setRows] = useState<CatalogWorkspace[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      setRows(visible(await workspaceApi.list()))
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

  return createElement('div', { className: 'dsh-workspace-ui' },
    createElement('h3', null, '工作区'),
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
    loading ? createElement('div', null, '加载中…') : createElement('ul', { className: 'dsh-ws-list' },
      rows.map((ws) => createElement('li', { key: ws.workspaceId, className: 'dsh-ws-item' },
        createElement('div', { className: 'dsh-ws-head' },
          createElement('span', { className: 'dsh-ws-name' }, ws.workspaceId),
          createElement('span', { className: `dsh-ws-badge ${ws.phase}` }, phaseMap[ws.phase] ?? ws.phase),
        ),
        createElement('div', { className: 'dsh-ws-actions' },
          createElement('button', {
            className: 'dsh-ws-btn primary',
            onClick: async () => {
              try {
                await workspaceApi.ensure(ws.workspaceId)
                props.startSession?.(ws.nativeWorkspaceId ?? ws.workspaceId as any)
              } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
            },
          }, ws.phase === 'sleep' ? '唤醒并打开' : '打开'),
          ws.phase === 'orphan' ? createElement('button', {
            className: 'dsh-ws-btn',
            onClick: async () => {
              try { await workspaceApi.cleanup(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
            },
          }, '清理') : null,
          createElement('button', {
            className: 'dsh-ws-btn danger',
            onClick: async () => {
              if (!confirm(`删除工作区 ${ws.workspaceId}？会删除 Pod 和 PVC。`)) return
              try { await workspaceApi.delete(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
            },
          }, '删除'),
        ),
        ws.hasPod || ws.hasPvc ? createElement('div', { className: 'dsh-ws-meta' },
          ws.hasPod && ws.hasPvc ? '运行中' : ws.hasPvc ? '数据已保留' : '残留资源'
        ) : null,
      )),
    ),
  )
}

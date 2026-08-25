import { createElement, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceApi, type CatalogWorkspace } from './api.ts'

export type Props = PropsRuntime<'sidebar.footer.action'> & {
  createByName?: (name: string) => Promise<void>
}

const phaseMap: Record<CatalogWorkspace['phase'], string> = {
  running: '运行中', sleep: '休眠中', provision: '创建中', orphan: '待清理', deleted: '已删除', unknown: '未知',
}

export function WorkspaceFooterAction(props: Props) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CatalogWorkspace[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      setRows((await workspaceApi.list()).filter((ws) => ws.path.startsWith('/workspaces/') && ws.path !== '/workspaces'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (open) { void refresh(); setName(''); setError('') }
  }, [open])

  const create = async () => {
    const value = name.trim()
    if (!value) return
    setError('')
    try {
      if (props.createByName) await props.createByName(value)
      else await workspaceApi.create(value)
      setName('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return createElement('div', { className: 'dsh-workspace-ui' },
    createElement('button', {
      className: 'dsh-ws-btn',
      onClick: () => setOpen(true),
      style: { width: '100%', textAlign: 'left' },
    }, '🖥 工作区状态'),
    open ? createElement('div', { className: 'dsh-ws-modal-overlay', onClick: (e: any) => { if (e.target === e.currentTarget) setOpen(false) } },
      createElement('div', { className: 'dsh-ws-modal dsh-ws-modal-wide' },
        createElement('h3', null, '工作区状态'),
        createElement('div', { className: 'dsh-ws-footer-list' },
          rows.map((ws) => createElement('div', { key: ws.workspaceId, className: 'dsh-ws-item' },
            createElement('div', { className: 'dsh-ws-head' },
              createElement('span', { className: 'dsh-ws-name' }, ws.workspaceId),
              createElement('span', { className: `dsh-ws-badge ${ws.phase}` }, phaseMap[ws.phase] ?? ws.phase),
            ),
            createElement('div', { className: 'dsh-ws-actions' },
              ws.phase === 'sleep'
                ? createElement('button', { className: 'dsh-ws-btn primary', onClick: async () => { try { await workspaceApi.ensure(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } } }, '唤醒')
                : null,
              ws.phase === 'orphan'
                ? createElement('button', { className: 'dsh-ws-btn', onClick: async () => { try { await workspaceApi.cleanup(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } } }, '清理')
                : null,
              createElement('button', { className: 'dsh-ws-btn danger', onClick: async () => { if (!confirm(`删除工作区 ${ws.workspaceId}？会删除 Pod 和 PVC。`)) return; try { await workspaceApi.delete(ws.workspaceId); await refresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } } }, '删除'),
            ),
          )),
          rows.length === 0 ? createElement('div', { className: 'dsh-ws-meta' }, '暂无工作区') : null,
        ),
        createElement('div', { className: 'dsh-ws-create' },
          createElement('input', { value: name, placeholder: '新工作区名称', onChange: (e: any) => setName(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') void create() } }),
          createElement('button', { className: 'dsh-ws-btn primary', onClick: () => void create() }, '创建'),
        ),
        error === '' ? null : createElement('div', { className: 'dsh-ws-error' }, error),
        createElement('div', { className: 'dsh-ws-modal-footer' },
          createElement('button', { className: 'dsh-ws-btn', onClick: () => setOpen(false) }, '关闭'),
        ),
      ),
    ) : null,
  )
}

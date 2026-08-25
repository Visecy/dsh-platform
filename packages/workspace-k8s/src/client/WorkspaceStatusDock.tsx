import { createElement, useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { workspaceApi, type CatalogWorkspace } from './api.ts'

type Props = PropsRuntime<'conversation.input.dock'>

const phaseMap: Record<CatalogWorkspace['phase'], string> = {
  running: '运行中', sleep: '休眠中', provision: '创建中', orphan: '待清理', deleted: '已删除', unknown: '未知',
}

export function WorkspaceStatusDock(props: Props) {
  const { sessionId } = props
  const [row, setRow] = useState<CatalogWorkspace | undefined>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!sessionId) return
    const w = props.useWorkspaces((s) => s.items.find((x) => x.sessionIds.includes(sessionId as any)))
    const nativeId = w?.workspaceId
    if (nativeId === undefined) return
    let cancelled = false
    void workspaceApi.list().then((rows) => {
      if (cancelled) return
      const found = rows.find((r) => r.nativeWorkspaceId === nativeId && r.path.startsWith('/workspaces/'))
      setRow(found ?? undefined)
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [sessionId, props.useWorkspaces])
  if (row === undefined) return null
  return createElement('div', { className: 'dsh-workspace-ui dsh-ws-status' },
    createElement('span', null, `工作区：${row.workspaceId}`),
    createElement('span', { className: `dsh-ws-badge ${row.phase}` }, phaseMap[row.phase] ?? row.phase),
    row.phase === 'sleep' ? createElement('button', {
      className: 'dsh-ws-btn primary',
      onClick: async () => { try { setRow(await workspaceApi.ensure(row.workspaceId)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } },
    }, '唤醒') : null,
    error === '' ? null : createElement('span', { className: 'dsh-ws-error' }, error),
  )
}

/**
 * Workspace status panel — the platform's k8s lifecycle surface on OFFICIAL
 * client slots.
 *
 * The official `ui-workspace` row owns the sidebar workspace/session list, the
 * conversation hero and the `sidebar.workspaces` contract; this plugin adds a
 * keyed `main` panel with its `sidebar.panellist` entry and an optional
 * `shell.overlay` pill. Nothing here patches or replaces an official surface,
 * and nothing here knows about users or permissions.
 *
 * Every action failure renders the API's own `error.message`: the panel must
 * never look idle while a wake/sleep/delete silently failed.
 */
import { createElement, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import {
  actionsFor,
  confirmLabel,
  metricsText,
  overlayText,
  overlayVisible,
  phaseText,
  statusDetail,
  timelineHead,
  WORKSPACE_POLL_MS,
  type StatusAction,
} from './panel-model.ts'
import { getSnapshot, poll, runStatusAction, startPolling, subscribeStatus } from './store.ts'
import { injectPanelStyles } from './styles.ts'

/** Subscribe to the shared catalog snapshot. */
function useStatus() {
  return useSyncExternalStore(subscribeStatus, getSnapshot)
}

/** Start the catalog poller for the lifetime of the nearest mounted surface. */
function usePolling(): void {
  useEffect(() => startPolling(WORKSPACE_POLL_MS), [])
}

export function WorkspaceStatusPanel() {
  injectPanelStyles()
  usePolling()
  const status = useStatus()
  const rows = status.rows
  const now = status.at

  return createElement('div', { className: 'dsh-wsp' },
    createElement('div', { className: 'dsh-wsp-head' },
      createElement('h3', { className: 'dsh-wsp-title' }, '工作区状态'),
      createElement('span', { className: 'dsh-wsp-count' },
        rows.length === 0 ? '' : `${rows.length} 个工作区`),
      createElement('button', {
        className: 'dsh-wsp-refresh',
        type: 'button',
        onClick: () => { void poll() },
      }, '刷新'),
    ),
    status.error === ''
      ? null
      : createElement('div', { className: 'dsh-wsp-error', role: 'alert' },
          createElement('span', { className: 'k' }, 'API 错误'),
          createElement('span', { className: 'v' }, status.error),
        ),
    rows.length === 0
      ? createElement('div', { className: 'dsh-wsp-empty' },
          status.loading ? '加载中…' : '暂无工作区')
      : createElement('div', { className: 'dsh-wsp-list' }, rows.map((row) => createElement(RowView, {
          key: row.workspaceId,
          row,
          now,
          pending: status.pendingId === row.workspaceId,
        }))),
  )
}

interface RowViewProps {
  row: ReturnType<typeof getSnapshot>['rows'][number]
  now: number
  pending: boolean
}

function RowView({ row, now, pending }: RowViewProps) {
  const [confirming, setConfirming] = useState<StatusAction | null>(null)
  const detail = statusDetail(row, now)
  const head = timelineHead(row, now)
  const actions = actionsFor(row.phase)

  const dispatch = (action: StatusAction): void => {
    if (action === 'delete' && confirming !== 'delete') {
      setConfirming('delete')
      return
    }
    setConfirming(null)
    // The store records the failure text in the snapshot before this settles,
    // so the banner above renders it without any extra state here.
    void runStatusAction(row.workspaceId, action).catch(() => undefined)
  }

  return createElement('div', { className: `dsh-wsp-row${pending ? ' pending' : ''}` },
    createElement('div', { className: 'dsh-wsp-rowhead' },
      createElement('span', { className: `dsh-wsb-dot ${row.phase}` }),
      createElement('span', { className: 'dsh-wsp-name' }, detail.name),
      createElement('span', { className: `dsh-wsp-phase ${detail.tone}` }, phaseText(row.phase)),
      createElement('span', { className: 'dsh-wsp-actions' },
        actions.map((action) => createElement('button', {
          key: action.id,
          type: 'button',
          className: `dsh-wsd-btn${action.danger === true ? ' danger' : ''}`,
          disabled: pending,
          onClick: () => dispatch(action.id),
        }, confirming === action.id ? confirmLabel(action.id) : action.label)),
        confirming === null
          ? null
          : createElement('button', {
              type: 'button',
              className: 'dsh-wsd-btn',
              disabled: pending,
              onClick: () => setConfirming(null),
            }, '取消'),
      ),
    ),
    createElement('div', { className: `dsh-wsp-line ${detail.tone}` }, detail.text),
    createElement('div', { className: 'dsh-wsp-meta' },
      createElement('span', { className: 'cpu' }, metricsText(row)),
      createElement('span', { className: 'pod' }, row.hasPod ? 'Pod 运行' : 'Pod 停止'),
      createElement('span', { className: 'pvc' }, row.hasPvc ? 'PVC 保留' : 'PVC 无'),
      createElement('span', { className: 'sessions' }, `会话 ${row.activeSessions}`),
      createElement('span', { className: 'cycles' }, `唤醒 ${row.wakeCount} · 休眠 ${row.sleepCount}`),
    ),
    head === undefined
      ? null
      : createElement('div', { className: 'dsh-wsp-timeline' },
          createElement('span', { className: 't' }, head.ago),
          createElement('span', { className: 'e' }, head.text),
        ),
  )
}

/** `sidebar.panellist` glyph: one phase dot, including the collapsed rail. */
export function WorkspacePanelIcon({ size = 16, active = false }: { size?: number; active?: boolean }) {
  const status = useStatus()
  const worst = status.rows.find((row) => row.phase === 'orphan' || row.phase === 'waking' || row.phase === 'provision')
  const phase = worst?.phase ?? status.rows[0]?.phase ?? 'unknown'
  const dot: CSSProperties = { width: size / 2, height: size / 2 }
  return createElement('span', {
    className: `dsh-wsp-icon${active ? ' active' : ''}`,
    style: { width: size, height: size },
    title: overlayVisible(status.rows) ? overlayText(status.rows) : '工作区状态',
  }, createElement('span', { className: `dsh-wsb-dot ${phase}`, style: dot }))
}

/** `shell.overlay` pill: only while something is cold-starting or asleep. */
export function WorkspaceStatusPill() {
  const status = useStatus()
  if (!overlayVisible(status.rows)) return null
  const text = overlayText(status.rows)
  const busy = status.rows.some((row) => row.phase === 'waking' || row.phase === 'provision')
  return createElement('div', { className: `dsh-wsp-pill${busy ? ' busy' : ''}`, role: 'status' },
    createElement('span', { className: 'dot' }),
    createElement('span', { className: 'text' }, text),
  )
}

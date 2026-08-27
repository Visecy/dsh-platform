/**
 * Workspace detail view: the "工作区" tab in the conversation view ring.
 * Two-column layout (dsh-context style): status + lifecycle + timeline on the
 * left; metrics + k8s details on the right.
 */
import { createElement, Fragment, useState, useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { statusSource, runStatusAction } from './store.ts'
import type { StatusRow } from './store.ts'

type Props = PropsRuntime<'conversation.view'>

const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

const fmtAgo = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

const spark = (history: number[], w: number, h: number): string => {
  if (history.length === 0) return ''
  const max = Math.max(...history)
  const min = Math.min(...history)
  const range = (max - min) || 1
  return history.map((v, i) => {
    const x = history.length === 1 ? 0 : (i / (history.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

export function WorkspaceDetailView(props: Props) {
  const { sessionId, useWorkspaces } = props
  const status = useSyncExternalStore(statusSource.subscribe, statusSource.getSnapshot)
  const workspaces = useWorkspaces((s) => s.items) ?? []
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const ws = workspaces.find((w) => (w.sessionIds ?? []).includes(sessionId))
  if (ws === undefined) {
    return (
      <div className="dsh-wsd">
        <div className="dsh-wsd-inner">
          <div className="dsh-wsd-empty">该会话未关联工作区</div>
        </div>
      </div>
    )
  }
  const row: StatusRow | undefined = status.rows.find((r) => r.workspaceId === ws.workspaceId)
  const phase = row?.phase ?? 'unknown'
  const label = row?.label ?? '未知'

  let countdown: string | null = null
  let countdownOk = false
  if (row !== undefined) {
    if (phase === 'waking' || phase === 'provision') countdown = '⏳ 拉起中…'
    else if (phase === 'running' && row.idleDeadlineAt !== undefined) countdown = `⏳ ${fmtDur(row.idleDeadlineAt - status.at)} 后休眠`
    else if (phase === 'running' && row.graceDeadlineAt !== undefined) countdown = `⏳ ${fmtDur(row.graceDeadlineAt - status.at)} 后休眠（宽限）`
    else if (phase === 'running') { countdown = '运行中 · 会话活跃'; countdownOk = true }
    else if (phase === 'sleep') countdown = '休眠中 · PVC 已保留'
    else if (phase === 'orphan') countdown = '残留资源 · 有 Pod 无 PVC'
  }

  const stats: Array<[string, string | number]> = [
    ['会话', row?.activeSessions ?? 0],
    ['turn', row?.openTurns ?? 0],
    ['命令', row?.activeCommands ?? 0],
    ['执行 Pod', row === undefined ? '—' : row.hasPod ? '运行' : '停止'],
    ['PVC', row === undefined ? '—' : row.hasPvc ? '保留' : '无'],
    ['运行时长', row?.lastWakeAt !== undefined ? fmtDur(status.at - row.lastWakeAt) : '—'],
    ['上次休眠', row?.lastSleepAt !== undefined ? fmtAgo(status.at - row.lastSleepAt) : '—'],
    ['唤醒 · 休眠', `${row?.wakeCount ?? 0} · ${row?.sleepCount ?? 0}`],
    ['创建时间', row?.createdAt !== undefined ? fmtAgo(status.at - row.createdAt) : '—'],
  ]

  const smStates = [
    { key: 'provision', label: '创建中' },
    { key: 'running', label: '运行中' },
    { key: 'sleep', label: '休眠中' },
    { key: 'deleted', label: '已删除' },
  ]

  const doAction = async (action: string): Promise<void> => {
    setBusy(true)
    try {
      await runStatusAction(ws.workspaceId, action)
      setConfirmDelete(false)
    } catch (e) {
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  const metrics = row?.metrics ?? null
  const metricsFrozen = phase === 'sleep' || phase === 'deleted'
  const k8s = row?.k8s ?? null
  const timeline = (row?.timeline ?? []).slice().reverse()

  return (
    <div className="dsh-wsd">
      <div className="dsh-wsd-inner">
        <div className="dsh-wsd-head">
          <span className="dsh-wsd-name">{ws.title || ws.workspaceId}</span>
          <span className={`dsh-wsb-dot ${phase}`} />
          <span className={`dsh-wsb-phase ${phase}`}>{label}</span>
          <div className="dsh-wsd-actions">
            {(phase === 'sleep' || phase === 'unknown')
              ? <button className="dsh-wsd-btn primary" disabled={busy} onClick={() => void doAction('ensure')}>唤醒</button>
              : null}
            {phase === 'running'
              ? <button className="dsh-wsd-btn" disabled={busy} onClick={() => void doAction('sleep')}>休眠</button>
              : null}
            {confirmDelete
              ? <>
                  <button className="dsh-wsd-btn danger" disabled={busy} onClick={() => void doAction('delete')}>确认删除</button>
                  <button className="dsh-wsd-btn" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
                </>
              : <button className="dsh-wsd-btn danger" onClick={() => setConfirmDelete(true)}>删除</button>}
          </div>
        </div>

        <div className="dsh-wsd-cols">
          <div className="dsh-wsd-col">
            <div className="dsh-wsd-card">
              <div className="dsh-wsd-status">
                <div className="dsh-wsd-phase-line">
                  <span className={`dsh-wsb-dot ${phase}`} />
                  <span>{label}</span>
                </div>
                {countdown !== null
                  ? <div className={`dsh-wsd-countdown${countdownOk ? ' ok' : ''}`}>{countdown}</div>
                  : null}
                <div className="dsh-wsd-statgrid">
                  {stats.map(([k, v]) => (
                    <div key={k} className="dsh-wsd-stat">
                      <div className="k">{k}</div>
                      <div className="v">{String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="dsh-wsd-card">
              <h4>生命周期</h4>
              <div className="dsh-wsd-sm">
                {smStates.map((s, i) => {
                  const isWakingEdge = phase === 'waking' && s.key === 'sleep'
                  return (
                    <Fragment key={s.key}>
                      {i === 0 ? null : <span className="arrow">{isWakingEdge ? null : (s.key === 'sleep' ? '⇄' : '→')}</span>}
                      {isWakingEdge
                        ? <span className="node waking">唤醒中…</span>
                        : <span className={`node${phase === s.key ? ' current' : ''}`}>{s.label}</span>}
                    </Fragment>
                  )
                })}
              </div>
            </div>

            <div className="dsh-wsd-card">
              <h4>时间线</h4>
              <div className="dsh-wsd-tl">
                {timeline.length === 0
                  ? <div className="dsh-wsd-empty">暂无事件</div>
                  : timeline.map((e, i) => (
                      <div key={i} className="ev">
                        <span className="t">{fmtAgo(status.at - e.at)}</span>
                        <span>{e.text}</span>
                      </div>
                    ))}
              </div>
            </div>
          </div>

          <div className="dsh-wsd-col">
            <div className="dsh-wsd-card">
              <h4>资源指标</h4>
              {metrics === null
                ? <div className="dsh-wsd-metric-note">指标不可用（需 metrics-server）</div>
                : <div className="dsh-wsd-metrics">
                    {(['cpu', 'mem'] as const).map((key) => {
                      const m = metrics[key]
                      const name = key === 'cpu' ? 'CPU' : '内存'
                      const value = key === 'cpu'
                        ? `${Math.round(m.value * 1000) / 1000} 核`
                        : `${m.value} MB`
                      return (
                        <div key={key} className={`dsh-wsd-metric${metricsFrozen ? ' frozen' : ''}`}>
                          <div className="mk">{name}</div>
                          <div className="mv">{m.pct === null ? value : `${value} · ${m.pct}%`}</div>
                          {m.history.length > 1
                            ? <svg viewBox="0 0 120 26" preserveAspectRatio="none">
                                <polyline
                                  points={spark(m.history, 120, 24)}
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            : null}
                        </div>
                      )
                    })}
                    {!metrics.available
                      ? <div className="dsh-wsd-metric-note">metrics-server 无响应，显示最近采样</div>
                      : null}
                  </div>}
            </div>

            {k8s !== null
              ? <div className="dsh-wsd-card">
                  <h4>k8s 资源</h4>
                  <div className="dsh-wsd-k8s">
                    {[
                      ['执行 Pod', k8s.podName],
                      ['数据卷 PVC', k8s.pvcName],
                      ['命名空间', k8s.namespace],
                      ['镜像', k8s.image],
                      ['RuntimeClass', k8s.runtimeClass ?? '—'],
                      ['资源限额', `${k8s.cpuLimit ?? '—'} / ${k8s.memLimit ?? '—'}`],
                      ['存储类', k8s.storageClass ?? '—'],
                      ['容量', `${k8s.capacityGB} GB`],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <div className="k">{k}</div>
                        <div className="v">{String(v)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              : null}
          </div>
        </div>
      </div>
    </div>
  )
}

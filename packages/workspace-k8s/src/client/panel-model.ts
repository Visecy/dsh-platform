/**
 * Pure view model for the workspace status panel.
 *
 * Every decision the panel makes — the copy for a phase, which lifecycle verb a
 * phase offers, which API method that verb reaches, and whether the shell pill
 * is worth showing — is derived here, with no React and no I/O, so it can be
 * asserted directly. `panel.tsx` only renders these values.
 */
import type { CatalogPhase, CatalogWorkspace } from './api.ts'

/** Slot id shared by the `main` panel key and its `sidebar.panellist` row. */
export const WORKSPACE_PANEL_ID = 'workspace-status'
/** Sidebar row / panel title. */
export const WORKSPACE_PANEL_LABEL = '工作区状态'
/** Catalog poll cadence. */
export const WORKSPACE_POLL_MS = 2000

/** The lifecycle verbs the panel can dispatch. */
export type StatusAction = 'ensure' | 'sleep' | 'delete' | 'cleanup'

/** One offered action: its verb, its button copy, and whether it destroys data. */
export interface StatusActionSpec {
  id: StatusAction
  label: string
  danger?: boolean
}

/** Visual weight of a phase line. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'muted'

const PHASE_TEXT: Record<CatalogPhase, string> = {
  running: '运行中',
  sleep: '休眠中',
  provision: '创建中',
  waking: '唤醒中',
  orphan: '待清理',
  deleted: '已删除',
  unknown: '未知',
}

const DANGER_CONFIRM = '确认删除'

/**
 * Human copy for a catalog phase. Unknown phases keep their raw value: a phase
 * the platform has not modelled is a bug worth seeing, not one worth hiding
 * behind a generic label.
 * @param phase - catalog phase.
 * @returns display copy.
 */
export function phaseText(phase: CatalogPhase): string {
  return PHASE_TEXT[phase] ?? String(phase)
}

/**
 * Which lifecycle verbs a phase offers.
 *
 * `ensure` (wake) appears exactly where the pod is absent or ambiguous, `sleep`
 * only on a confirmed running pod, and `cleanup` only on the pod-without-PVC
 * residue the reconciler refuses to reclaim by itself. Cancel is the panel's
 * own concern, not a catalog action; the confirm label is offered here so the
 * two-step control cannot drift from the verb it commits.
 * @param phase - catalog phase.
 * @returns ordered action specs; empty when the workspace is gone.
 */
export function actionsFor(phase: CatalogPhase): StatusActionSpec[] {
  const actions: StatusActionSpec[] = []
  if (phase === 'sleep' || phase === 'unknown') actions.push({ id: 'ensure', label: actionLabel('ensure') })
  if (phase === 'running') actions.push({ id: 'sleep', label: actionLabel('sleep') })
  if (phase === 'orphan') actions.push({ id: 'cleanup', label: actionLabel('cleanup') })
  if (phase === 'deleted') return actions
  actions.push({ id: 'delete', label: actionLabel('delete'), danger: true })
  return actions
}

/**
 * Button copy for one action verb.
 * @param action - lifecycle verb.
 * @returns display label.
 */
export function actionLabel(action: StatusAction): string {
  switch (action) {
    case 'ensure': return '唤醒'
    case 'sleep': return '休眠'
    case 'cleanup': return '清理'
    case 'delete': return '删除'
  }
}

/**
 * Copy for the destructive action's second press.
 * @param action - lifecycle verb.
 * @returns display label.
 */
export function confirmLabel(action: StatusAction): string {
  return action === 'delete' ? DANGER_CONFIRM : actionLabel(action)
}

/** Duration as `m:ss` (or `h:mm:ss`), never negative. */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`
}

/** Elapsed time as coarse Chinese copy. */
export function fmtAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** One workspace's rendered status line. */
export interface StatusDetail {
  name: string
  text: string
  tone: StatusTone
}

/**
 * The status line for one workspace: what the phase means right now, including
 * the pending idle/grace shutdown and its countdown.
 * @param row - catalog row.
 * @param now - snapshot timestamp the countdown is measured against.
 * @returns name, line and tone.
 */
export function statusDetail(row: CatalogWorkspace, now: number): StatusDetail {
  const name = row.title !== undefined && row.title !== '' ? row.title : row.workspaceId
  const { phase } = row
  if (phase === 'waking' || phase === 'provision') return { name, text: '⏳ 拉起中…', tone: 'warn' }
  if (phase === 'running') {
    if (row.idleDeadlineAt !== undefined) {
      return { name, text: `⏳ ${fmtDur(row.idleDeadlineAt - now)} 后休眠`, tone: 'warn' }
    }
    if (row.graceDeadlineAt !== undefined) {
      return { name, text: `⏳ ${fmtDur(row.graceDeadlineAt - now)} 后休眠（宽限）`, tone: 'warn' }
    }
    return { name, text: '运行中 · 会话活跃', tone: 'ok' }
  }
  if (phase === 'sleep') return { name, text: '休眠中 · PVC 已保留', tone: 'muted' }
  if (phase === 'orphan') return { name, text: '残留资源 · 有 Pod 无 PVC', tone: 'bad' }
  return { name, text: phaseText(phase), tone: 'muted' }
}

/**
 * The newest timeline event, as a line plus how long ago it landed.
 * @param row - catalog row.
 * @param now - snapshot timestamp.
 * @returns the head event, or undefined when the workspace has no history.
 */
export function timelineHead(row: CatalogWorkspace, now: number): { text: string; ago: string } | undefined {
  const newest = row.timeline.reduce<CatalogWorkspace['timeline'][number] | undefined>(
    (best, event) => (best === undefined || event.at > best.at ? event : best),
    undefined,
  )
  if (newest === undefined) return undefined
  return { text: newest.text, ago: fmtAgo(now - newest.at) }
}

/**
 * The status surface's OWN summary line: what the sidebar entry says about the
 * fleet in a tooltip.
 *
 * It is deliberately the only aggregate copy this plugin renders. It used to
 * also feed a frame-wide `shell.overlay` pill, which was removed: the pill
 * rendered top-left over the brand mark, and the numbers it carried are
 * already on the `main` panel and this sidebar row — both in layout-owned
 * space. A summary that cannot cover anything is a tooltip, not an overlay.
 * @param rows - catalog rows.
 * @returns one line naming whichever half the operator is waiting on.
 */
export function statusSummary(rows: readonly CatalogWorkspace[]): string {
  const sleeping = rows.filter((row) => row.phase === 'sleep').length
  const starting = rows.filter((row) => row.phase === 'provision' || row.phase === 'waking').length
  const parts: string[] = []
  if (starting > 0) parts.push(`${starting} 个拉起中`)
  if (sleeping > 0) parts.push(`${sleeping} 个休眠中`)
  if (parts.length > 0) return `工作区状态：${parts.join(' · ')}`
  return rows.length === 0 ? '工作区状态：暂无工作区' : '工作区状态：运行中'
}

/**
 * CPU/memory summary for one row, or an explicit note when the sampler has
 * nothing. Never renders a blank cell: "no metrics" and "0 cores" are
 * different facts on this platform.
 * @param row - catalog row.
 * @returns display text for the metrics cell.
 */
export function metricsText(row: CatalogWorkspace): string {
  const metrics = row.metrics
  if (metrics === null) return '指标不可用'
  const cpu = `${Math.round(metrics.cpu.value * 1000) / 1000} 核`
  const mem = `${metrics.mem.value} MB`
  return metrics.available ? `${cpu} · ${mem}` : `${cpu} · ${mem}（最近采样）`
}

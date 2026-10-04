/**
 * The workspace status panel's view logic and its API dispatch.
 *
 * The React component (src/client/panel.tsx) is deliberately thin: every
 * decision that can be wrong — which action a phase offers, which action id
 * maps to which `/workspaces/api/*` method, what the row reads as, and whether
 * a failed call is visible at all — lives in the model/store modules asserted
 * here. A silent failure path is the specific regression this file guards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  actionLabel,
  actionsFor,
  confirmLabel,
  overlayVisible,
  phaseText,
  statusDetail,
  timelineHead,
  type StatusAction,
} from '../src/client/panel-model.ts'
import type { CatalogWorkspace } from '../src/client/api.ts'

const NOW = 1_700_000_000_000

const row = (over: Partial<CatalogWorkspace> = {}): CatalogWorkspace => ({
  workspaceId: 'ws-alpha',
  path: '/workspaces/ws-alpha',
  phase: 'running',
  hasPod: true,
  hasPvc: true,
  activeSessions: 1,
  openTurns: 0,
  activeCommands: 0,
  wakeCount: 2,
  sleepCount: 1,
  timeline: [],
  k8s: null,
  metrics: null,
  ...over,
})

const ids = (actions: StatusAction[]): string[] => actions.map((a) => a.id)

describe('phase copy', () => {
  it('labels every catalog phase', () => {
    expect(phaseText('running')).toBe('运行中')
    expect(phaseText('sleep')).toBe('休眠中')
    expect(phaseText('provision')).toBe('创建中')
    expect(phaseText('waking')).toBe('唤醒中')
    expect(phaseText('orphan')).toBe('待清理')
    expect(phaseText('deleted')).toBe('已删除')
    expect(phaseText('unknown')).toBe('未知')
  })

  it('falls back to the raw phase for a phase the catalog did not model', () => {
    expect(phaseText('hibernating' as CatalogWorkspace['phase'])).toBe('hibernating')
  })

  it('prefers the workspace title and shows the name otherwise', () => {
    expect(statusDetail(row({ title: '平台' }), NOW).name).toBe('平台')
    expect(statusDetail(row({ title: undefined }), NOW).name).toBe('ws-alpha')
  })
})

describe('statusDetail line per phase', () => {
  it('running without a deadline reads as an active session', () => {
    const detail = statusDetail(row({ phase: 'running' }), NOW)
    expect(detail.text).toBe('运行中 · 会话活跃')
    expect(detail.tone).toBe('ok')
  })

  it('running with an idle deadline counts down to sleep', () => {
    const detail = statusDetail(row({ phase: 'running', idleDeadlineAt: NOW + 5 * 60_000 }), NOW)
    expect(detail.text).toBe('⏳ 5:00 后休眠')
    expect(detail.tone).toBe('warn')
  })

  it('running inside the grace window counts down to the grace deadline', () => {
    const detail = statusDetail(row({ phase: 'running', graceDeadlineAt: NOW + 90_000 }), NOW)
    expect(detail.text).toBe('⏳ 1:30 后休眠（宽限）')
  })

  it('a spent deadline never renders a negative countdown', () => {
    const detail = statusDetail(row({ phase: 'running', idleDeadlineAt: NOW - 1_000 }), NOW)
    expect(detail.text).toBe('⏳ 0:00 后休眠')
  })

  it('waking and provisioning read as work in progress', () => {
    expect(statusDetail(row({ phase: 'waking' }), NOW).text).toBe('⏳ 拉起中…')
    expect(statusDetail(row({ phase: 'provision' }), NOW).text).toBe('⏳ 拉起中…')
  })

  it('sleeping and orphan states explain what survives', () => {
    expect(statusDetail(row({ phase: 'sleep', hasPod: false }), NOW).text).toBe('休眠中 · PVC 已保留')
    expect(statusDetail(row({ phase: 'orphan' }), NOW).text).toBe('残留资源 · 有 Pod 无 PVC')
  })

  it('an unknown phase still says something rather than rendering nothing', () => {
    const detail = statusDetail(row({ phase: 'unknown' }), NOW)
    expect(detail.text).toBe('未知')
    expect(detail.tone).toBe('muted')
  })
})

describe('actionsFor', () => {
  it('offers wake on a sleeping workspace', () => {
    expect(ids(actionsFor('sleep'))).toEqual(['ensure', 'delete'])
  })

  it('offers wake on an unknown workspace (the catalog has not agreed with k8s yet)', () => {
    expect(ids(actionsFor('unknown'))).toEqual(['ensure', 'delete'])
  })

  it('offers sleep on a running workspace', () => {
    expect(ids(actionsFor('running'))).toEqual(['sleep', 'delete'])
  })

  it('offers cleanup on an orphan and no lifecycle verb', () => {
    expect(ids(actionsFor('orphan'))).toEqual(['cleanup', 'delete'])
  })

  it('offers nothing on a workspace that is already gone', () => {
    expect(ids(actionsFor('deleted'))).toEqual([])
  })

  it('never offers wake and sleep together', () => {
    for (const phase of ['provision', 'waking', 'running', 'sleep', 'deleted', 'orphan', 'unknown'] as const) {
      const offered = ids(actionsFor(phase))
      expect(offered.includes('ensure') && offered.includes('sleep')).toBe(false)
    }
  })

  it('offers wake/sleep/cleanup actions in the side-effect-free order the panel renders', () => {
    expect(actionsFor('running').map((a) => a.label)).toEqual(['休眠', '删除'])
    expect(actionLabel('ensure')).toBe('唤醒')
    expect(actionLabel('cleanup')).toBe('清理')
    expect(actionLabel('delete')).toBe('删除')
    expect(confirmLabel('delete')).toBe('确认删除')
  })

  it('marks delete as destructive so the panel asks for confirmation', () => {
    const byId = new Map(actionsFor('running').map((a) => [a.id, a]))
    expect(byId.get('delete')?.danger).toBe(true)
    expect(byId.get('sleep')?.danger).toBeUndefined()
  })
})

describe('timelineHead', () => {
  it('returns the newest event and how long ago it happened', () => {
    const head = timelineHead(row({ timeline: [
      { at: NOW - 3_600_000, type: 'sleep', text: '已休眠' },
      { at: NOW - 30_000, type: 'wake', text: '已唤醒' },
    ] }), NOW)
    expect(head).toEqual({ text: '已唤醒', ago: '刚刚' })
  })

  it('returns undefined without a timeline instead of inventing one', () => {
    expect(timelineHead(row({ timeline: [] }), NOW)).toBeUndefined()
  })
})

describe('overlayVisible', () => {
  it('shows the pill while a workspace is waking up or asleep', () => {
    expect(overlayVisible([row({ phase: 'sleep', hasPod: false })])).toBe(true)
    expect(overlayVisible([row({ phase: 'waking' })])).toBe(true)
    expect(overlayVisible([row({ phase: 'provision' })])).toBe(true)
  })

  it('stays out of the way when everything is simply running', () => {
    expect(overlayVisible([row({ phase: 'running' }), row({ workspaceId: 'b', phase: 'waking' })])).toBe(true)
    expect(overlayVisible([row({ phase: 'running' })])).toBe(false)
    expect(overlayVisible([])).toBe(false)
  })
})

describe('runStatusAction dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  /** Load a fresh store over a stubbed fetch and report the calls it made. */
  const loadWithFetch = async (payload: unknown, ok = true) => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => (ok ? { ok: true, data: payload } : payload) }
    }))
    const store = await import('../src/client/store.ts')
    return { store, calls }
  }

  it('calls ensure for wake, sleep for sleep, cleanup for cleanup and delete for delete', async () => {
    const cases: Array<[StatusAction, string]> = [
      ['ensure', '/workspaces/api/ensure'],
      ['sleep', '/workspaces/api/sleep'],
      ['cleanup', '/workspaces/api/cleanup'],
      ['delete', '/workspaces/api/delete'],
    ]
    for (const [action, endpoint] of cases) {
      const { store, calls } = await loadWithFetch({ ok: true })
      await store.runStatusAction('ws-alpha', action)
      expect(calls[0]?.url).toBe(endpoint)
      expect(calls[0]?.body).toEqual({ workspaceId: 'ws-alpha' })
      vi.resetModules()
      vi.unstubAllGlobals()
    }
  })

  it('dispatches synchronously and refreshes the snapshot by polling the list again', async () => {
    const { store, calls } = await loadWithFetch([])
    store.runStatusAction('ws-alpha', 'ensure')
    await vi.waitFor(() => { expect(calls.map((c) => c.url)).toEqual(['/workspaces/api/ensure', '/workspaces/api/list']) })
  })

  it('keeps the API error message in the snapshot and never swallows it', async () => {
    const { store } = await loadWithFetch({ ok: false, error: { message: 'pod limit reached' } }, false)
    // The panel consumes the snapshot and ignores the rejection; the handler is
    // attached here the same way so this spec observes the same contract.
    const settled = store.runStatusAction('ws-alpha', 'ensure').catch((error: unknown) => String(error))
    await vi.waitFor(() => { expect(store.getSnapshot().error).toBe('pod limit reached') })
    expect(await settled).toContain('pod limit reached')
  })

  it('reports a failed action to its caller as well as to the snapshot', async () => {
    const { store } = await loadWithFetch({ ok: false, error: { message: 'forbidden' } }, false)
    const message = await store.runStatusAction('ws-alpha', 'sleep').then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(message).toBe('forbidden')
    expect(store.getSnapshot().error).toBe('forbidden')
  })

  it('surfaces a failed list poll as snapshot error text', async () => {
    const { store } = await loadWithFetch({ ok: false, error: { message: 'kubeconfig expired' } }, false)
    await store.poll()
    expect(store.getSnapshot().error).toBe('kubeconfig expired')
  })

  it('clears the error once a poll succeeds', async () => {
    const { store } = await loadWithFetch({ ok: false, error: { message: 'kubeconfig expired' } }, false)
    await store.poll()
    expect(store.getSnapshot().error).toBe('kubeconfig expired')

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: [row()] }) })))
    await store.poll()
    expect(store.getSnapshot().error).toBe('')
    expect(store.getSnapshot().rows).toHaveLength(1)
  })

  it('runs the action before it reports the refresh, so the panel sees the new snapshot', async () => {
    const seen: string[] = []
    const { store } = await loadWithFetch([])
    const unsubscribe = store.subscribeStatus(() => { seen.push(store.getSnapshot().error) })
    await store.runStatusAction('ws-alpha', 'sleep')
    unsubscribe()
    expect(seen.at(-1)).toBe('')
  })
})

describe('startPolling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.useRealTimers()
  })

  it('polls once immediately and then on the interval until disposed', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({ ok: true, data: [] }) }
    }))
    const store = await import('../src/client/store.ts')
    const stop = store.startPolling(2000)
    await vi.advanceTimersByTimeAsync(0)
    expect(urls).toEqual(['/workspaces/api/list'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(urls).toHaveLength(2)
    stop()
    await vi.advanceTimersByTimeAsync(6000)
    expect(urls).toHaveLength(2)
  })
})

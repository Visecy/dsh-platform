/**
 * WorkspaceMetricsSampler: polls metrics.k8s.io for running workspace pods and
 * keeps a bounded per-workspace ring buffer (frozen while the pod is absent,
 * so the status UI does not jump when a workspace sleeps).
 */
import { parseCpuQuantity, parseMemoryQuantity, type PodController, type PodMetrics } from './k8s-client.ts'

export interface WorkspaceMetricSample {
  cpuCores: number
  cpuPct: number | null
  memoryBytes: number
  memoryPct: number | null
}

export interface WorkspaceMetricSeries {
  sample: WorkspaceMetricSample
  /** Newest last; capped at {@link METRIC_HISTORY_CAP}. */
  history: WorkspaceMetricSample[]
}

export interface MetricsSamplerOptions {
  controller: PodController
  namespace: string
  /** Sampling interval; default 15s. */
  intervalMs?: number
  /** Pod limits (for percentages); optional. */
  limits?: { cpu?: string; memory?: string }
}

export const METRIC_HISTORY_CAP = 30

export class WorkspaceMetricsSampler {
  private controller: PodController
  private namespace: string
  private intervalMs: number
  private limits: { cpuCores: number | null; memoryBytes: number | null }
  private series = new Map<string, WorkspaceMetricSeries>()
  private timer: NodeJS.Timeout | undefined
  private failureStreak = 0
  private _available = true

  constructor(opts: MetricsSamplerOptions) {
    this.controller = opts.controller
    this.namespace = opts.namespace
    this.intervalMs = opts.intervalMs ?? 15_000
    this.limits = {
      cpuCores: opts.limits?.cpu !== undefined ? parseCpuQuantity(opts.limits.cpu) : null,
      memoryBytes: opts.limits?.memory !== undefined ? parseMemoryQuantity(opts.limits.memory) : null,
    }
  }

  /** Whether metrics-server answered on the latest poll round. */
  get available(): boolean {
    return this._available
  }

  /** Latest series for a workspace (frozen while the pod is gone), or undefined. */
  get(workspaceId: string): WorkspaceMetricSeries | undefined {
    return this.series.get(workspaceId)
  }

  /** All known series (frozen values included). */
  all(): Map<string, WorkspaceMetricSeries> {
    return this.series
  }

  start(): void {
    if (this.timer !== undefined) return
    void this.poll()
    this.timer = setInterval(() => { void this.poll() }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async poll(): Promise<void> {
    if (this.controller.listPods === undefined || this.controller.getPodMetrics === undefined) return
    let pods: string[]
    try {
      pods = await this.controller.listPods(this.namespace)
    } catch {
      return
    }
    let failures = 0
    let successes = 0
    for (const pod of pods) {
      let m: PodMetrics | undefined
      try {
        m = await this.controller.getPodMetrics(this.namespace, pod)
      } catch {
        m = undefined
      }
      if (m === undefined) {
        failures += 1
        continue
      }
      successes += 1
      this.record(pod, m)
    }
    if (successes === 0 && failures > 0) {
      this.failureStreak += 1
      if (this.failureStreak >= 3) this._available = false
    } else {
      this.failureStreak = 0
      this._available = true
    }
  }

  private record(workspaceId: string, m: PodMetrics): void {
    const cpuPct = this.limits.cpuCores !== null && this.limits.cpuCores > 0
      ? Math.min(99, Math.round((m.cpuCores / this.limits.cpuCores) * 100))
      : null
    const memoryPct = this.limits.memoryBytes !== null && this.limits.memoryBytes > 0
      ? Math.min(99, Math.round((m.memoryBytes / this.limits.memoryBytes) * 100))
      : null
    const sample: WorkspaceMetricSample = { cpuCores: m.cpuCores, cpuPct, memoryBytes: m.memoryBytes, memoryPct }
    const existing = this.series.get(workspaceId)
    if (existing === undefined) {
      this.series.set(workspaceId, { sample, history: [sample] })
      return
    }
    existing.sample = sample
    existing.history.push(sample)
    if (existing.history.length > METRIC_HISTORY_CAP) existing.history.shift()
  }
}

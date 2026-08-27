import { describe, expect, it } from 'vitest'
import { WorkspaceMetricsSampler, METRIC_HISTORY_CAP } from '../src/metrics.ts'
import { parseCpuQuantity, parseMemoryQuantity, type PodController, type WorkspacePodSpec } from '../src/k8s-client.ts'

class FakeMetricsController implements PodController {
  pods: string[] = []
  metrics: Record<string, { cpu: string; memory: string }> = {}
  failAll = false
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  podName(id: string): string { return id }
  pvcName(id: string): string { return id + '-data' }
  async listPods(): Promise<string[]> { return this.pods }
  async getPodMetrics(_ns: string, name: string) {
    if (this.failAll) return undefined
    const m = this.metrics[name]
    if (m === undefined) return undefined
    return { cpuCores: parseCpuQuantity(m.cpu), memoryBytes: parseMemoryQuantity(m.memory) }
  }
}

describe('WorkspaceMetricsSampler', () => {
  it('records samples and keeps a bounded history', async () => {
    const ctrl = new FakeMetricsController()
    ctrl.pods = ['ws-a']
    ctrl.metrics['ws-a'] = { cpu: '500m', memory: '256Mi' }
    const sampler = new WorkspaceMetricsSampler({ controller: ctrl, namespace: 'dsh', intervalMs: 0, limits: { cpu: '2', memory: '4Gi' } })
    await (sampler as unknown as { poll(): Promise<void> }).poll()
    const series = sampler.get('ws-a')
    expect(series).toBeDefined()
    expect(series?.sample.cpuCores).toBeCloseTo(0.5)
    expect(series?.sample.cpuPct).toBe(25)
    expect(series?.sample.memoryBytes).toBe(256 * 1024 * 1024)
    expect(series?.sample.memoryPct).toBe(6)
    expect(series?.history.length).toBe(1)
    expect(sampler.available).toBe(true)
  })

  it('keeps frozen values for pods that stopped reporting', async () => {
    const ctrl = new FakeMetricsController()
    ctrl.pods = ['ws-a']
    ctrl.metrics['ws-a'] = { cpu: '200m', memory: '64Mi' }
    const sampler = new WorkspaceMetricsSampler({ controller: ctrl, namespace: 'dsh', intervalMs: 0 })
    const p = sampler as unknown as { poll(): Promise<void> }
    await p.poll()
    ctrl.pods = [] // pod gone (sleep)
    await p.poll()
    const series = sampler.get('ws-a')
    expect(series?.sample.cpuCores).toBeCloseTo(0.2) // frozen
  })

  it('marks itself unavailable after repeated metrics failures', async () => {
    const ctrl = new FakeMetricsController()
    ctrl.pods = ['ws-a']
    ctrl.failAll = true
    const sampler = new WorkspaceMetricsSampler({ controller: ctrl, namespace: 'dsh', intervalMs: 0 })
    const p = sampler as unknown as { poll(): Promise<void> }
    await p.poll()
    expect(sampler.available).toBe(true) // streak not reached
    await p.poll()
    expect(sampler.available).toBe(true) // streak 2 still not reached
    await p.poll()
    expect(sampler.available).toBe(false) // 3 consecutive failures -> unavailable
  })

  it('caps history at METRIC_HISTORY_CAP', () => {
    expect(METRIC_HISTORY_CAP).toBe(30)
    const ctrl = new FakeMetricsController()
    ctrl.pods = ['ws-a']
    ctrl.metrics['ws-a'] = { cpu: '100m', memory: '32Mi' }
    const sampler = new WorkspaceMetricsSampler({ controller: ctrl, namespace: 'dsh', intervalMs: 0 })
    const p = sampler as unknown as { poll(): Promise<void> }
    const run = async () => { for (let i = 0; i < 40; i++) await p.poll() }
    return run().then(() => {
      expect(sampler.get('ws-a')?.history.length).toBe(METRIC_HISTORY_CAP)
    })
  })
})

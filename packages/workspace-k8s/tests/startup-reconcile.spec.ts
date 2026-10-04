/**
 * Plugin-load behaviour of the workspace reconciler.
 *
 * The registry's history bootstrap in `@deepseek-ai/dsh-workspace` is
 * one-shot: it groups stored session headers by their canonical `cwd` into
 * workspace records, and it runs exactly once, at registry init. That init
 * validates every session `cwd` with realpath+stat against the CONTROL-PLANE
 * filesystem, so a `/workspaces/<id>` anchor that does not exist yet makes the
 * session un-groupable — and afterwards the association can only be repaired
 * by re-attaching the session to its record.
 *
 * The reconciler is the only creator of those anchors. It used to run only
 * from its 60s interval, so the anchors always lost that race. These tests pin
 * the load-time pass that closes the window, and the retry that covers it when
 * the official registry has not finished its asynchronous init yet.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, name } from '../src/index.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'

/** The smallest PodController the reconciler can list a PVC from. */
class FakeController implements PodController {
  listPodsCalls = 0
  listPvcsCalls = 0
  constructor(readonly pvcs: string[] = [], readonly pods: string[] = []) {}
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { return spec.workspaceId }
  async deletePod(): Promise<void> {}
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(): Promise<string> { return 'pvc' }
  async deletePvc(): Promise<void> {}
  async listPods(): Promise<string[]> { this.listPodsCalls += 1; return [...this.pods] }
  async listPvcs(): Promise<string[]> { this.listPvcsCalls += 1; return [...this.pvcs] }
}

/** A duck-typed official `ctx.workspaceRegistry` that records creation calls. */
class FakeRegistry extends Service {
  readonly created: string[] = []
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }
  async create(path: string, title?: string) {
    this.created.push(path)
    return { id: `uuid-${path}`, path, title: title ?? path }
  }
  list() { return [] }
  async delete() { return true }
  async resolveByPath() { return undefined }
  async rebind() { return [] }
}

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-startup-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Poll instead of sleeping a fixed number of ticks: the pass touches the fs. */
const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the reconcile pass')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('workspace-k8s plugin load', () => {
  it('runs one reconcile pass at load, without waiting for the interval timer', async () => {
    const ctrl = new FakeController(['ws-a-data'])
    const ctx = new Context()
    // Never await the fiber: the pass must happen as part of loading. Awaiting
    // the fiber would let a 60s timer cover for a missing load-time pass, and
    // this assertion has to fail if the pass moves back onto the timer.
    void ctx.plugin(
      { name, apply },
      { namespace: 'dsh', image: 'visecy/dsh-sandbox-daemon:test', controller: ctrl, hostRoot: tempRoot() },
    )
    await until(() => ctrl.listPvcsCalls > 0)
  })

  it('retries the pass once the official registry finishes its async init', async () => {
    const ctrl = new FakeController(['ws-late-data'])
    const ctx = new Context()
    const hostRoot = tempRoot()
    void ctx.plugin(
      { name, apply },
      { namespace: 'dsh', image: 'visecy/dsh-sandbox-daemon:test', controller: ctrl, hostRoot },
    )
    // The load-time pass is already done and could not register anything: the
    // official registry registers its service name in its constructor, but
    // `ctx.get` only exposes it after its async `Service.init()` (storage open,
    // header index, history bootstrap) resolves.
    await until(() => ctrl.listPvcsCalls > 0)

    const registry = new FakeRegistry(ctx)
    await until(() => registry.created.length > 0)
    expect(registry.created).toEqual([`${hostRoot}/ws-late`])
  })

  it('keeps loading when the reconcile pass throws', async () => {
    const ctrl = new FakeController(['ws-boom-data'])
    ctrl.listPvcs = async () => { throw new Error('k8s api unavailable') }
    const ctx = new Context()
    void ctx.plugin(
      { name, apply },
      { namespace: 'dsh', image: 'visecy/dsh-sandbox-daemon:test', controller: ctrl, hostRoot: tempRoot() },
    )
    // A failing reconcile must not fail plugin load: the service stays provided
    // and the interval keeps retrying.
    await until(() => ctx.get('workspaceReconciler') !== undefined)
  })
})

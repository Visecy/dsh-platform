/**
 * The endpoint resolver is the platform's ON-DEMAND WAKE path.
 *
 * Every fs and subprocess operation on a workspace resolves its daemon endpoint
 * through `workspaceEndpointResolver.resolve`, which calls `runtime.ensure` and
 * therefore creates the pod when it is absent. That is a wake, and it does NOT
 * pass through `management.ensure` — so if the lifecycle is not told, the
 * workspace keeps whatever phase its in-memory state machine holds while its pod
 * is up and serving: the operator's "workspace `agents` shows as 休眠 in the
 * panel yet is actually usable".
 *
 * The catalog now reports the OBSERVED cluster state (see the phase cases in
 * `management.spec.ts`), which is what makes the panel truthful; this spec pins
 * the other half — that the state machine itself catches up, so the workspace
 * also gets its idle timer again instead of running forever untracked as
 * `sleep`.
 */
import { describe, expect, it } from 'vitest'
import { wireWorkspaceLifecycle, type WorkspaceStatusService } from '../src/wire.ts'
import type { PodController, WorkspacePodSpec } from '../src/k8s-client.ts'
import type { WorkspaceRuntime } from '../src/index.ts'

class FakeController implements PodController {
  pods = new Set<string>()
  pvcs = new Set<string>()
  /** Provisions the LIFECYCLE performed (the runtime's own ensure is not this). */
  provisions: string[] = []
  async ensurePod(spec: WorkspacePodSpec): Promise<string> { this.pods.add(spec.workspaceId); return spec.workspaceId }
  async deletePod(_ns: string, workspaceId: string): Promise<void> { this.pods.delete(workspaceId) }
  async waitReady(): Promise<void> {}
  endpoint(): string { return 'http://daemon' }
  async ensurePvc(workspaceId: string): Promise<string> {
    this.provisions.push(workspaceId)
    this.pvcs.add(workspaceId)
    return workspaceId + '-data'
  }
  async deletePvc(workspaceId: string): Promise<void> { this.pvcs.delete(workspaceId) }
  podName(workspaceId: string): string { return workspaceId }
  pvcName(workspaceId: string): string { return workspaceId + '-data' }
}

const harness = (known?: (workspaceId: string) => Promise<boolean>) => {
  const ctrl = new FakeController()
  const ensured: string[] = []
  const runtime: WorkspaceRuntime = {
    ensure: async (workspaceId: string) => { ensured.push(workspaceId); ctrl.pods.add(workspaceId); return 'http://pod' },
    dispose: async () => undefined,
    getEndpoint: () => 'http://pod',
    isRunning: () => true,
  }
  const wired = wireWorkspaceLifecycle(
    { on: () => undefined } as never,
    {
      lifecycle: { controller: ctrl, namespace: 'dsh', image: 'test-image:v1' },
      runtime,
      knownWorkspace: known,
    },
  )
  return { ctrl, ensured, wired, status: wired.status as WorkspaceStatusService }
}

/** Let the detached lifecycle actions run to completion. */
const until = async (predicate: () => boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return predicate()
}

describe('workspace endpoint resolution', () => {
  it('wakes a slept workspace out of the sleep phase an on-demand ensure left behind', async () => {
    const { ensured, wired, status } = harness()

    // The workspace is asleep: the panel reads exactly this phase.
    await wired.sleepWorkspace('ws-a')
    expect(status.get('ws-a')?.phase).toBe('sleep')

    // An fs or subprocess operation resolves the endpoint, creating the pod.
    await wired.resolveEndpoint('ws-a')

    expect(ensured).toEqual(['ws-a'])
    expect(await until(() => status.get('ws-a')?.phase === 'running')).toBe(true)
  })

  it('reports a workspace woken for the first time this process as running', async () => {
    const { wired, status } = harness()

    await wired.resolveEndpoint('ws-b')

    expect(await until(() => status.get('ws-b')?.phase === 'running')).toBe(true)
  })

  it('does not re-provision a workspace on every operation once it is running', async () => {
    const { ctrl, wired, status } = harness()
    await wired.resolveEndpoint('ws-c')
    expect(await until(() => status.get('ws-c')?.phase === 'running')).toBe(true)
    expect(ctrl.provisions).toEqual(['ws-c'])

    // A second operation on the running workspace: the resolver still resolves,
    // and the lifecycle records the activity, but it must not run another
    // provision for a pod that is already up.
    await wired.resolveEndpoint('ws-c')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(ctrl.provisions).toEqual(['ws-c'])
    expect(status.get('ws-c')?.phase).toBe('running')
  })

  /**
   * The other half of "a workspace appeared that the operator never created".
   *
   * A workspace id on this platform is the FIRST path segment under the host
   * root: any absolute path `/workspaces/<name>/...` names the workspace
   * `<name>`. The resolver used to `ensure` whatever id that produced, so one
   * file operation on an ordinary directory under the workspace root — a path a
   * shell command or an agent created, never a workspace anyone registered —
   * would create that workspace's PVC and pod, and the reconcile pass would
   * adopt the PVC into a sidebar record a moment later. An fs or subprocess
   * operation may WAKE a workspace; it must never CREATE one.
   */
  describe('a path that names no registered workspace', () => {
    it('refuses to provision it instead of materializing a workspace', async () => {
      const { ensured, wired, status } = harness(async (id) => id === 'ws-known')

      await expect(wired.resolveEndpoint('agents-local-md')).rejects.toThrow(/agents-local-md/)

      // Nothing was created: no ensure, no lifecycle state, no PVC/pod.
      expect(ensured).toEqual([])
      expect(status.get('agents-local-md')).toBeUndefined()
    })

    it('still wakes a workspace the registry knows', async () => {
      const { ensured, wired, status } = harness(async (id) => id === 'ws-known')

      await wired.resolveEndpoint('ws-known')

      expect(ensured).toEqual(['ws-known'])
      expect(await until(() => status.get('ws-known')?.phase === 'running')).toBe(true)
    })

    it('provisions anyway when the registry cannot be listed', async () => {
      // The fence is a guard against a phantom workspace, not an authorization
      // boundary: refusing every file operation because a listing blipped would
      // cost the whole file view, so only a POSITIVE "no such record" refuses.
      const { ensured, wired } = harness(async () => { throw new Error('registry unavailable') })

      await wired.resolveEndpoint('ws-unknown')

      expect(ensured).toEqual(['ws-unknown'])
    })
  })
})

/**
 * The REAL `K8sPodController`'s pod shape.
 *
 * These assert the object actually sent to the API server, not a helper's
 * return value: the controller builds the pod inline, so a recording fake API
 * client is the only place the final shape exists.
 *
 * What is pinned here, and why:
 *   - `runtimeClassName`: the deployment's isolation escalation (runc -> gvisor
 *     -> kata) is advertised by the reference chart and the deployment guide.
 *     It used to be accepted in config and never written to the pod.
 *   - `seccompProfile: RuntimeDefault`: required by the `restricted`
 *     PodSecurity standard, which rejects the pod without it.
 *   - the opt-in per-workspace NetworkPolicy: the sandbox daemon has no
 *     authentication of its own, so "who may reach 4390" is a deployment
 *     decision the platform has to be able to express.
 */
import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { ObjectSerializer } from '@kubernetes/client-node/dist/gen/models/ObjectSerializer.js'
import {
  DEFAULT_CONTROL_PLANE_POD_LABELS,
  K8sPodController,
  parsePodLabels,
} from '../src/k8s-client.ts'

interface Recorded {
  pods: k8s.V1Pod[]
  netpols: k8s.V1NetworkPolicy[]
  deletedNetpols: string[]
}

function recorder(): { rec: Recorded; kc: k8s.KubeConfig } {
  const rec: Recorded = { pods: [], netpols: [], deletedNetpols: [] }
  const core = {
    createNamespacedPod: async ({ body }: { body: k8s.V1Pod }) => {
      rec.pods.push(body)
      return body
    },
    createNamespacedService: async ({ body }: { body: k8s.V1Service }) => body,
    deleteNamespacedPod: async () => ({}),
    deleteNamespacedService: async () => ({}),
  }
  const networking = {
    createNamespacedNetworkPolicy: async ({ body }: { body: k8s.V1NetworkPolicy }) => {
      rec.netpols.push(body)
      return body
    },
    deleteNamespacedNetworkPolicy: async ({ name }: { name: string }) => {
      rec.deletedNetpols.push(name)
      return {}
    },
  }
  const kc = {
    makeApiClient: (api: unknown) => (api === k8s.NetworkingV1Api ? networking : core),
  } as unknown as k8s.KubeConfig
  return { rec, kc }
}

const SPEC = {
  namespace: 'dsh-platform',
  workspaceId: 'agents',
  image: 'example/daemon:v1',
  daemonPort: 4390,
  pvcName: 'agents-data',
}

describe('K8sPodController pod shape', () => {
  it('carries the configured RuntimeClass into the pod spec', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, { namespace: 'dsh-platform' })
    await controller.ensurePod({ ...SPEC, runtimeClassName: 'gvisor' })
    expect(rec.pods).toHaveLength(1)
    expect(rec.pods[0].spec?.runtimeClassName).toBe('gvisor')
  })

  it('omits RuntimeClass when the deployment does not ask for one', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, { namespace: 'dsh-platform' })
    await controller.ensurePod(SPEC)
    expect(rec.pods[0].spec?.runtimeClassName).toBeUndefined()
  })

  it('sets a RuntimeDefault seccomp profile so restricted PodSecurity accepts the pod', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, { namespace: 'dsh-platform' })
    await controller.ensurePod(SPEC)
    expect(rec.pods[0].spec?.securityContext?.seccompProfile?.type).toBe('RuntimeDefault')
  })

  it('creates no NetworkPolicy unless the deployment opts in', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, { namespace: 'dsh-platform' })
    await controller.ensurePod(SPEC)
    expect(rec.netpols).toHaveLength(0)
  })

  it('fences the daemon to the control plane when the NetworkPolicy is enabled', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, {
      namespace: 'dsh-platform',
      networkPolicy: { controlPlanePodLabels: { 'app.kubernetes.io/name': 'dsh-control-plane' } },
    })
    await controller.ensurePod(SPEC)

    expect(rec.netpols).toHaveLength(1)
    const policy = rec.netpols[0]
    expect(policy.metadata?.namespace).toBe('dsh-platform')
    expect(policy.metadata?.name).toBe('agents-netpol')
    expect(policy.spec?.podSelector?.matchLabels).toEqual({ app: 'dsh-workspace', workspace: 'agents' })
    expect(policy.spec?.policyTypes).toEqual(['Ingress'])
    const rule = policy.spec?.ingress?.[0]
    // The generated client renames the API's `from` to `_from`; see the
    // serialization test below for why that distinction is load-bearing.
    expect(rule?._from?.[0].podSelector?.matchLabels).toEqual({ 'app.kubernetes.io/name': 'dsh-control-plane' })
    expect(rule?.ports?.[0]).toMatchObject({ protocol: 'TCP', port: 4390 })
  })

  it('serializes the fence the way the API server reads it (wire `from`, not the model key)', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, {
      namespace: 'dsh-platform',
      networkPolicy: { controlPlanePodLabels: DEFAULT_CONTROL_PLANE_POD_LABELS },
    })
    await controller.ensurePod(SPEC)

    // A recorded object proves nothing about the wire: this model's TypeScript
    // key for the API field `from` is `_from` (a reserved word upstream), so a
    // plain `from:` property is silently dropped by the client's serializer and
    // the ingress rule degenerates into "allow from ANY source". That is exactly
    // what the live cluster showed, so the test now goes through the real
    // serializer the API client uses.
    // `serialize` returns the wire-shaped object (the client hands it to JSON).
    const wire = ObjectSerializer.serialize(rec.netpols[0], 'V1NetworkPolicy', '')
    expect(wire.spec.ingress[0].from[0].podSelector.matchLabels).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
    expect(wire.spec.ingress[0].ports[0]).toMatchObject({ protocol: 'TCP', port: 4390 })
  })

  it('deletes the workspace NetworkPolicy together with the pod', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, {
      namespace: 'dsh-platform',
      networkPolicy: { controlPlanePodLabels: DEFAULT_CONTROL_PLANE_POD_LABELS },
    })
    await controller.deletePod('dsh-platform', 'agents')
    expect(rec.deletedNetpols).toEqual(['agents-netpol'])
  })

  it('does not touch the networking API when the NetworkPolicy is off', async () => {
    const { rec, kc } = recorder()
    const controller = new K8sPodController(kc, { namespace: 'dsh-platform' })
    await controller.deletePod('dsh-platform', 'agents')
    expect(rec.deletedNetpols).toEqual([])
  })
})

describe('parsePodLabels', () => {
  it('parses a JSON label selector', () => {
    expect(parsePodLabels('{"app.kubernetes.io/name":"dsh-control-plane"}')).toEqual({
      'app.kubernetes.io/name': 'dsh-control-plane',
    })
  })

  it('falls back to the shipped chart default for empty input', () => {
    expect(parsePodLabels(undefined)).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
    expect(parsePodLabels('')).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
  })

  it('falls back instead of throwing on malformed input (a boot-time throw would be invisible)', () => {
    expect(parsePodLabels('not json')).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
    expect(parsePodLabels('[]')).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
    expect(parsePodLabels('{"a":1}')).toEqual(DEFAULT_CONTROL_PLANE_POD_LABELS)
  })
})

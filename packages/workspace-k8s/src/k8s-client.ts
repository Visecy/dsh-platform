/**
 * Thin k8s client wrapper: create/wait/delete the workspace pod + headless
 * service, and resolve the daemon endpoint. Injectable for tests.
 */
import * as k8s from '@kubernetes/client-node'

export interface WorkspacePodSpec {
  namespace: string
  workspaceId: string
  image: string
  daemonPort: number
  pvcName?: string
  resources?: { cpu?: string; memory?: string }
  storageClassName?: string
  storageSize?: string
}

export interface PvcOptions {
  namespace?: string
  storageClassName?: string
  storageSize?: string
}

export interface PodController {
  ensurePod(spec: WorkspacePodSpec): Promise<string>
  deletePod(namespace: string, name: string): Promise<void>
  waitReady(namespace: string, name: string, timeoutMs?: number): Promise<void>
  endpoint(namespace: string, name: string, port: number): string
  ensurePvc(workspaceId: string): Promise<string>
  deletePvc(workspaceId: string): Promise<void>
  /** Optional reconciliation support. */
  listPods?(namespace: string): Promise<string[]>
  listPvcs?(namespace: string): Promise<string[]>
  /** Optional direct pod-IP lookup (used to avoid flaky cluster DNS). */
  getPodIp?(namespace: string, name: string): Promise<string>
}

export const MANAGED_ANNOTATION = 'dsh-platform/managed'
export const WORKSPACE_LABEL = 'app=dsh-workspace'

export class K8sPodController implements PodController {
  constructor(
    private kc: k8s.KubeConfig,
    private pvc: PvcOptions = {},
  ) {}

  /** Sanitize a workspace id into a k8s-compatible resource name (as-is). */
  private safeName(workspaceId: string): string {
    // One name throughout: /workspaces/<id> -> pod <id> -> svc <id>-svc ->
    // pvc <id>-data. Never add a second dsh-ws- prefix.
    let safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
    if (safe === '') safe = 'ws'
    return safe.slice(0, 50)
  }

  podName(workspaceId: string): string {
    return this.safeName(workspaceId)
  }

  svcName(workspaceId: string): string {
    return this.podName(workspaceId) + '-svc'
  }

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = this.podName(spec.workspaceId)
    const labels = { app: 'dsh-workspace', workspace: name }
    const annotations = { [MANAGED_ANNOTATION]: 'true' }
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: spec.namespace,
        labels,
        annotations,
      },
      spec: {
        containers: [
          {
            name: 'sandbox-daemon',
            image: spec.image,
            ports: [{ containerPort: spec.daemonPort, name: 'daemon' }],
            readinessProbe: {
              httpGet: { path: '/healthz', port: spec.daemonPort },
              initialDelaySeconds: 1,
              periodSeconds: 2,
            },
            securityContext: {
              runAsNonRoot: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ['ALL'] },
            },
            env: [{ name: 'DAEMON_ROOT', value: '/workspace' }, { name: 'DAEMON_PORT', value: String(spec.daemonPort) }],
            resources: spec.resources !== undefined
              ? { requests: spec.resources, limits: spec.resources }
              : undefined,
            volumeMounts: [
              { name: 'workspace', mountPath: '/workspace' },
            ],
          },
        ],
        securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
        volumes: [
          spec.pvcName !== undefined
            ? { name: 'workspace', persistentVolumeClaim: { claimName: spec.pvcName } }
            : { name: 'workspace', emptyDir: {} },
        ],
      },
    }

    try {
      await core.createNamespacedPod({ namespace: spec.namespace, body: pod })
    } catch (e: unknown) {
      const status = (e as { body?: { message?: string } }).body?.message ?? String(e)
      if (!status.includes('already exists')) throw e
    }

    // headless service for stable in-cluster DNS
    const svc: k8s.V1Service = {
      metadata: { name: this.svcName(spec.workspaceId), namespace: spec.namespace, labels, annotations },
      spec: {
        clusterIP: 'None',
        selector: labels,
        ports: [{ port: spec.daemonPort, targetPort: spec.daemonPort, name: 'daemon' }],
      },
    }
    try {
      await core.createNamespacedService({ namespace: spec.namespace, body: svc })
    } catch (e: unknown) {
      const status = (e as { body?: { message?: string } }).body?.message ?? String(e)
      if (!status.includes('already exists')) throw e
    }
    return name
  }

  async listPods(namespace: string): Promise<string[]> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const res = await core.listNamespacedPod({
      namespace,
      labelSelector: WORKSPACE_LABEL,
    }) as unknown as { body?: { items?: Array<{ metadata?: { name?: string } }> }; items?: Array<{ metadata?: { name?: string } }> }
    const items = res.body?.items ?? res.items ?? []
    return items.map((pod) => pod.metadata?.name).filter((n): n is string => typeof n === 'string')
  }

  async listPvcs(namespace: string): Promise<string[]> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const res = await core.listNamespacedPersistentVolumeClaim({
      namespace,
      labelSelector: 'app=dsh-workspace',
    }) as unknown as { body?: { items?: Array<{ metadata?: { name?: string } }> }; items?: Array<{ metadata?: { name?: string } }> }
    const items = res.body?.items ?? res.items ?? []
    return items.map((pvc) => pvc.metadata?.name).filter((n): n is string => typeof n === 'string')
  }

  async getPodIp(namespace: string, name: string): Promise<string> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const raw = await core.readNamespacedPod({ name, namespace }) as unknown as { body?: { status?: { podIP?: string } }; status?: { podIP?: string } }
    const pod = raw.body ?? raw
    const ip = pod.status?.podIP
    if (!ip) throw new Error(`workspace pod ${name} has no IP`)
    return ip
  }

  async deletePod(namespace: string, workspaceId: string): Promise<void> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = this.podName(workspaceId)
    try {
      await core.deleteNamespacedPod({ name, namespace })
    } catch {
      // already gone
    }
    try {
      await core.deleteNamespacedService({ name: this.svcName(workspaceId), namespace })
    } catch {
      // already gone
    }
  }

  async waitReady(namespace: string, name: string, timeoutMs = 180_000): Promise<void> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const raw = await core.readNamespacedPod({ name, namespace }) as unknown as { body?: { status?: { conditions?: Array<{ type: string; status: string }> } }; status?: { conditions?: Array<{ type: string; status: string }> } }
      // v2 client returns the V1Pod directly for reads (no body wrapper)
      const pod = raw.body ?? raw
      const ready = pod.status?.conditions?.some(
        (c) => c.type === 'Ready' && c.status === 'True',
      )
      if (ready === true) return
      if (Date.now() > deadline) throw new Error(`workspace pod not ready in ${timeoutMs}ms: ${name}`)
      await new Promise((res) => setTimeout(res, 500))
    }
  }

  endpoint(namespace: string, workspaceId: string, port: number): string {
    return `http://${this.svcName(workspaceId)}.${namespace}.svc.cluster.local:${port}`
  }

  pvcName(workspaceId: string): string {
    return `${this.podName(workspaceId)}-data`
  }

  async ensurePvc(workspaceId: string): Promise<string> {
    const ns = this.pvc.namespace ?? this.requireNamespace()
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = this.pvcName(workspaceId)
    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name,
        namespace: ns,
        labels: { app: 'dsh-workspace' },
        annotations: { [MANAGED_ANNOTATION]: 'true' },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: this.pvc.storageSize ?? '10Gi' } },
        storageClassName: this.pvc.storageClassName,
      },
    }
    try {
      await core.createNamespacedPersistentVolumeClaim({ namespace: ns, body: pvc })
    } catch (e: unknown) {
      const status = (e as { body?: { message?: string } }).body?.message ?? String(e)
      if (!status.includes('already exists')) throw e
    }
    return name
  }

  private requireNamespace(): string {
    throw new Error('workspace PVC namespace not configured')
  }

  async deletePvc(workspaceId: string): Promise<void> {
    const ns = this.pvc.namespace ?? this.requireNamespace()
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    try {
      await core.deleteNamespacedPersistentVolumeClaim({ name: this.pvcName(workspaceId), namespace: ns })
    } catch {
      // already gone
    }
  }
}

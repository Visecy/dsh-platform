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
}

export class K8sPodController implements PodController {
  constructor(
    private kc: k8s.KubeConfig,
    private pvc: PvcOptions = {},
  ) {}

  podName(workspaceId: string): string {
    // sanitize: dsh-ws-<uuid-ish> (max 63 chars, lowercase alnum + '-')
    const safe = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50)
    return `dsh-ws-${safe}`
  }

  svcName(workspaceId: string): string {
    return this.podName(workspaceId) + '-svc'
  }

  async ensurePod(spec: WorkspacePodSpec): Promise<string> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = this.podName(spec.workspaceId)
    const labels = { app: 'dsh-workspace', workspace: name }
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: spec.namespace,
        labels,
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
      metadata: { name: this.svcName(spec.workspaceId), namespace: spec.namespace, labels },
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

  async waitReady(namespace: string, name: string, timeoutMs = 60_000): Promise<void> {
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
    return `dsh-ws-${workspaceId}-data`
  }

  async ensurePvc(workspaceId: string): Promise<string> {
    const ns = this.pvc.namespace ?? this.requireNamespace()
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = this.pvcName(workspaceId)
    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: { name, namespace: ns },
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

/**
 * dsh-workspace-picker: replaces the host directory picker with a WORKSPACE
 * picker for the web UI. The browse-format capability is preserved (same
 * front-end surface), but the directory tree is mapped:
 *
 *   /workspaces                  root: one row per registered workspace
 *                                (running pods and sleeping PVCs both show)
 *   /workspaces/<id>             workspace detail (empty; no subdirectory
 *                                selection — a workspace is an atomic unit)
 *
 * Selecting a workspace yields /workspaces/<id>, the host-side logical cwd
 * that the fs-k8s / subprocess-k8s providers route to that workspace's pod.
 * Creating a directory at the root anchors a new workspace for workspace.create.
 * Rows carry a `state` hint ('running' | 'sleep' | 'orphan'); a future custom
 * workspace UI can render badges/cleanup actions without re-listing k8s.
 */
import { Context } from '@deepseek-ai/cordis'
import * as k8s from '@kubernetes/client-node'
import { mkdir } from 'node:fs/promises'
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'

export const name = '@visecy/dsh-workspace-picker'

export interface Config {
  /** Namespace where workspace pods live. */
  namespace: string
  /** Label selector for workspace pods. */
  podLabel?: string
  /** Daemon port inside the pod. */
  daemonPort?: number
  /** Host-side root path that maps to the workspace list. */
  hostRoot?: string
  /** Injectable k8s client for tests. */
  kc?: k8s.KubeConfig
}

interface WorkspaceRow {
  name: string
  path: string
  hidden: boolean
  /** Lifecycle hint for future UI badges/actions. */
  state?: 'running' | 'sleep' | 'orphan'
}

export class WorkspacePicker extends DirectoryPicker {
  private kc: k8s.KubeConfig
  private config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config
    this.kc = config.kc ?? new k8s.KubeConfig()
    if (config.kc === undefined) this.kc.loadFromDefault()
  }

  /** Stable capability object (browse format → same front-end surface). */
  private browseCapability = {
    kind: 'browse' as const,
    list: (path: string | undefined, signal?: AbortSignal) => this.list(path, signal),
    createDirectory: (path: string, name: string) => this.createDirectory(path, name),
    // Extra host action for a future workspace-management UI: removes stale
    // pod-only resources without touching a real PVC-backed workspace.
    deleteOrphan: (workspaceId: string) => this.deleteOrphan(workspaceId),
  }

  capability(): unknown {
    return this.browseCapability
  }

  private get hostRoot(): string {
    return this.config.hostRoot ?? '/workspaces'
  }

  /** Split a host path into [workspaceId?, rest...]. */
  private parsePath(hostPath: string): { workspaceId?: string; rest: string[] } {
    const root = this.hostRoot
    if (hostPath === root) return { rest: [] }
    if (!hostPath.startsWith(root + '/')) return { rest: [] }
    const segs = hostPath.slice(root.length + 1).split('/').filter(Boolean)
    return { workspaceId: segs[0], rest: segs.slice(1) }
  }

  /** List workspace resources: running pods and sleeping PVCs. */
  private async listWorkspaces(signal?: AbortSignal): Promise<WorkspaceRow[]> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const [podRes, pvcRes] = await Promise.all([
      core.listNamespacedPod({
        namespace: this.config.namespace,
        labelSelector: this.config.podLabel ?? 'app=dsh-workspace',
      }),
      core.listNamespacedPersistentVolumeClaim({
        namespace: this.config.namespace,
        labelSelector: 'app=dsh-workspace',
      }),
    ]) as unknown as [
      { body?: { items?: Array<{ metadata?: { name?: string } }> }; items?: Array<{ metadata?: { name?: string } }> },
      { body?: { items?: Array<{ metadata?: { name?: string } }> }; items?: Array<{ metadata?: { name?: string } }> },
    ]
    signal?.throwIfAborted()
    // v2 client returns list objects directly for list calls (no body wrapper)
    const pods = new Set((podRes.body?.items ?? podRes.items ?? []).map((p) => p.metadata?.name).filter((n): n is string => typeof n === 'string'))
    const pvcs = new Set(
      (pvcRes.body?.items ?? pvcRes.items ?? [])
        .map((p) => p.metadata?.name)
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.endsWith('-data') ? n.slice(0, -5) : n),
    )
    const ids = new Set([...pods, ...pvcs])
    // The official workspace.create validates with fs.realpath, so every
    // selectable workspace needs a host-side anchor directory. Existing pods
    // (including old/orphan ones) must not surface as ENOENT when picked.
    await Promise.all([...ids].map((id) => mkdir(`${this.hostRoot}/${id}`, { recursive: true }).catch(() => undefined)))
    const rows: WorkspaceRow[] = []
    for (const name of ids) {
      rows.push({
        name,
        path: `${this.hostRoot}/${name}`,
        hidden: false,
        // An orphan pod without a PVC is a stale resource that should be
        // cleaned up before it can be used as a new workspace.
        state: pods.has(name) ? (pvcs.has(name) ? 'running' : 'orphan') : 'sleep',
      })
    }
    rows.sort((a, b) => a.name.localeCompare(b.name))
    return rows
  }

  async list(path: string | undefined, signal?: AbortSignal): Promise<{
    path: string
    home: string
    crumbs: Array<{ name: string; path: string; hidden: boolean }>
    entries: WorkspaceRow[]
    truncated: boolean
  }> {
    const target = path ?? this.hostRoot
    const root = this.hostRoot
    const { workspaceId, rest } = this.parsePath(target)

    let entries: WorkspaceRow[]
    if (workspaceId === undefined) {
      entries = await this.listWorkspaces(signal)
    } else {
      // Confirmed UX: a workspace is an atomic unit, not a file tree. The
      // picker must not let the user select a subdirectory inside a workspace.
      entries = []
    }

    const crumbs: Array<{ name: string; path: string; hidden: boolean }> = [
      { name: 'workspaces', path: root, hidden: false },
    ]
    if (workspaceId !== undefined) {
      crumbs.push({ name: workspaceId, path: `${root}/${workspaceId}`, hidden: false })
      let acc = workspaceId
      for (const seg of rest) {
        acc = acc + '/' + seg
        crumbs.push({ name: seg, path: `${root}/${acc}`, hidden: false })
      }
    }

    return {
      path: target,
      home: root,
      crumbs,
      entries,
      truncated: false,
    }
  }

  /** Normalize a human-entered workspace name into the one id used in paths/pods/PVCs. */
  private sanitizeWorkspaceName(name: string): string {
    const safe = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
    if (safe === '' || safe === '.' || safe === '..') {
      throw new DirectoryPickerError('directory-create-failed', name, `"${name}" is not a valid workspace name`)
    }
    return safe.slice(0, 50)
  }

  /** Delete a pod-only stale workspace resource (pod + headless service). */
  async deleteOrphan(workspaceId: string): Promise<void> {
    const core = this.kc.makeApiClient(k8s.CoreV1Api)
    const name = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'ws'
    try {
      await core.deleteNamespacedPod({ name, namespace: this.config.namespace })
    } catch {
      // already gone
    }
    try {
      await core.deleteNamespacedService({ name: `${name}-svc`, namespace: this.config.namespace })
    } catch {
      // already gone
    }
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const { workspaceId } = this.parsePath(path)
    // New workspaces are created at the workspace-list root. Creating folders
    // inside an existing workspace is intentionally disallowed.
    if (workspaceId !== undefined) throw new DirectoryPickerError('directory-create-failed', path, 'cannot create directories inside a workspace')
    const targetName = this.sanitizeWorkspaceName(name)
    const target = `${this.hostRoot}/${targetName}`
    // Create the host-side anchor path so a later workspace.create({path})
    // (which uses fs.realpath) can resolve it.
    await mkdir(target, { recursive: true })
    return target
  }
}

export function apply(ctx: Context, config: Config): void {
  // DirectoryPicker base constructor registers under 'directoryPicker';
  // providing again would collide.
  new WorkspacePicker(ctx, config)
}

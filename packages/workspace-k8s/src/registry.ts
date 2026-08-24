/**
 * Workspace registry bridge.
 *
 * Frontend menus and session.create use the OFFICIAL dsh workspace registry
 * (`apiProxy.workspace.*`), so the platform keeps it as a thin bridge while
 * k8s remains the source of truth for execution resources. Both directions
 * are reconciled by the reconciler.
 */
import { randomUUID } from 'node:crypto'

export interface RegistryWorkspace {
  workspaceId: string
  path: string
  title?: string
}

export interface WorkspaceRegistry {
  list(): Promise<RegistryWorkspace[]>
  create(path: string): Promise<RegistryWorkspace>
  delete(workspaceId: string): Promise<void>
}

interface ApiProxyChannel {
  get(name: 'apiProxy'): {
    workspace: Record<string, (req: { rpcId: string; payload: unknown }) => Promise<unknown>>
  }
}

/** Normalize the server-response envelope used by the dsh RPC surface. */
function unwrap(raw: unknown): any {
  const root = raw as any
  if (root?.result !== undefined) {
    const result = root.result
    if (result?.ok !== undefined && result?.value !== undefined) return result.value
    return result
  }
  if (root?.ok !== undefined && root?.data !== undefined) return root.data
  if (root?.value !== undefined) return root.value
  return root
}

function idOf(workspace: any, hostRoot: string): string {
  // Platform workspaces are identified by the stable path segment
  // (/workspaces/<id>). The official registry may attach an opaque internal
  // workspaceId (UUID); we must never let that replace the id that is also
  // the pod name, cwd segment, and PVC name.
  const path: unknown = workspace?.path ?? workspace?.cwd
  if (typeof path === 'string' && path.startsWith(hostRoot + '/')) {
    const rest = path.slice(hostRoot.length + 1)
    const id = rest.split('/')[0]
    if (id !== '') return id
  }
  const raw = workspace?.workspaceId ?? workspace?.id ?? workspace?.key
  if (typeof raw === 'string' && raw !== '') return raw
  if (typeof path !== 'string') return String(workspace?.name ?? '')
  const m = path.startsWith(hostRoot + '/') ? path.slice(hostRoot.length + 1) : path
  return m.split('/')[0]
}

export class ApiProxyWorkspaceRegistry implements WorkspaceRegistry {
  constructor(
    private channel: ApiProxyChannel,
    private hostRoot: string,
  ) {}

  async list(): Promise<RegistryWorkspace[]> {
    const raw = await this.call('list', {})
    const value = unwrap(raw)
    const items = Array.isArray(value)
      ? value
      : (value?.workspaces ?? value?.items ?? [])
    return (Array.isArray(items) ? items : []).map((item: any) => {
      const path = typeof item?.path === 'string' ? item.path : `${this.hostRoot}/${idOf(item, this.hostRoot)}`
      return {
        workspaceId: idOf(item, this.hostRoot),
        path,
        title: item?.title,
      }
    }).filter((ws: RegistryWorkspace) => ws.workspaceId !== '')
  }

  async create(path: string): Promise<RegistryWorkspace> {
    const raw = await this.call('create', { path })
    const value = unwrap(raw)
    const workspace = value?.workspace ?? value
    const workspaceId = idOf(workspace, this.hostRoot)
    return {
      workspaceId,
      path: typeof workspace?.path === 'string' ? workspace.path : path,
      title: workspace?.title,
    }
  }

  async delete(workspaceId: string): Promise<void> {
    await this.call('delete', { workspaceId })
  }

  private async call(method: string, payload: unknown): Promise<unknown> {
    const apiProxy = this.channel.get('apiProxy')
    if (apiProxy?.workspace?.[method] === undefined) {
      // The official workspace domain is optional (headless/dev/test hosts).
      return method === 'list' ? { value: [] } : { value: {} }
    }
    return apiProxy.workspace[method]({
      rpcId: randomUUID(),
      payload,
    })
  }
}

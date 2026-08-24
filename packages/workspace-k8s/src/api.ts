/**
 * Host HTTP API for workspace management.
 *
 * Mounted only when `ctx.webServer` exists (web profiles). The client
 * workspace panel calls POST /workspaces/api/<method>. The OIDC/web-auth gate
 * is assumed in front of the webServer; this module only encodes/decodes the
 * management payloads.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorkspaceManagementService } from './management.ts'

interface WebRouteHandler {
  (req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

interface WebServerLike {
  register(route: { kind: 'prefix' | 'exact'; path: string; handler: WebRouteHandler }): () => void
}

const MAX_BODY = 1024 * 1024

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function ok(res: ServerResponse, data: unknown): void {
  json(res, 200, { ok: true, data })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { ok: false, error: { code, message } })
}

export function registerWorkspaceApi(
  webServer: WebServerLike,
  management: WorkspaceManagementService,
): () => void {
  return webServer.register({
    kind: 'prefix',
    path: '/workspaces/api',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          fail(res, 405, 'method-not-allowed', 'POST required')
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const method = url.pathname.slice('/workspaces/api/'.length)
        if (method === '' || method.includes('/')) {
          fail(res, 404, 'not-found', `unknown workspace API method: ${method}`)
          return
        }
        const body = await readJsonBody(req) as Record<string, unknown>
        let data: unknown
        switch (method) {
          case 'list': {
            data = await management.list()
            break
          }
          case 'create': {
            const name = typeof body.name === 'string' ? body.name : ''
            if (name.trim() === '') {
              fail(res, 400, 'bad-request', 'name is required')
              return
            }
            data = await management.create(name)
            break
          }
          case 'status': {
            const id = typeof body.workspaceId === 'string' ? body.workspaceId : ''
            data = id === '' ? undefined : await management.get(id)
            break
          }
          case 'ensure': {
            const id = typeof body.workspaceId === 'string' ? body.workspaceId : ''
            if (id === '') {
              fail(res, 400, 'bad-request', 'workspaceId is required')
              return
            }
            data = await management.ensure(id)
            break
          }
          case 'delete': {
            const id = typeof body.workspaceId === 'string' ? body.workspaceId : ''
            if (id === '') {
              fail(res, 400, 'bad-request', 'workspaceId is required')
              return
            }
            await management.delete(id)
            data = { ok: true }
            break
          }
          case 'cleanup': {
            const id = typeof body.workspaceId === 'string' ? body.workspaceId : ''
            if (id === '') {
              fail(res, 400, 'bad-request', 'workspaceId is required')
              return
            }
            await management.cleanupOrphan(id)
            data = { ok: true }
            break
          }
          default:
            fail(res, 404, 'not-found', `unknown workspace API method: ${method}`)
            return
        }
        ok(res, data ?? {})
      } catch (e) {
        fail(res, 400, 'workspace-api-error', e instanceof Error ? e.message : String(e))
      }
    },
  })
}

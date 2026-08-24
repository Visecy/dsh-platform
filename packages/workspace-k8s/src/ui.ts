/**
 * Minimal workspace management page served by the platform host.
 *
 * This is the first usable HTML surface for the workspace product: list,
 * create-by-name, state badges, delete, and orphan cleanup. It talks to the
 * /workspaces/api routes mounted by api.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

const CELL_STYLES = `
  body { font-family: system-ui, sans-serif; margin: 0; background: #f5f6f8; color: #1f2328; }
  main { max-width: 860px; margin: 32px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  .create-row { display: flex; gap: 8px; margin: 16px 0; }
  .create-row input { flex: 1; max-width: 320px; padding: 8px 10px; border: 1px solid #d0d7de; border-radius: 6px; }
  button { padding: 7px 12px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; cursor: pointer; }
  button.primary { background: #0969da; border-color: #0969da; color: #fff; }
  button.danger { color: #cf222e; border-color: #cf222e; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f6f8fa; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #57606a; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 12px; }
  .running { background: #dafbe1; color: #116329; }
  .sleep { background: #eaeef2; color: #57606a; }
  .provision { background: #fff8c5; color: #7d4e00; }
  .orphan { background: #ffebe9; color: #cf222e; }
  .deleted { background: #eaeef2; color: #57606a; }
  .muted { color: #6e7781; font-size: 12px; }
  .error { color: #cf222e; margin: 8px 0; }
`

export function registerWorkspaceUi(webServer: WebServerLike): () => void {
  return webServer.register({
    kind: 'exact',
    path: '/workspaces/ui',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' })
        res.end('method not allowed')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    },
  })
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>工作区管理</title>
<style>${CELL_STYLES}</style>
</head>
<body>
<main>
  <h1>工作区管理</h1>
  <div class="create-row">
    <input id="name" placeholder="输入新工作区名称" autocomplete="off" />
    <button class="primary" id="create">新建工作区</button>
  </div>
  <div class="error" id="error"></div>
  <div id="list"><p class="muted">加载中…</p></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const phaseText = { running: '运行中', sleep: '休眠中', provision: '创建中', orphan: '异常/待清理', deleted: '已删除', unknown: '未知' }
async function api(method, body) {
  const res = await fetch('/workspaces/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const payload = await res.json()
  if (!payload.ok) throw new Error(payload.error?.message ?? '请求失败')
  return payload.data
}
async function refresh() {
  try {
    const rows = await api('list')
    const list = $('list')
    if (!rows.length) {
      list.innerHTML = '<p class="muted">还没有工作区，先在上面输入名称新建。</p>'
      return
    }
    list.innerHTML = '<table><thead><tr><th>工作区</th><th>状态</th><th>路径</th><th>操作</th></tr></thead><tbody>' +
      rows.map((ws) => {
        const isOrphan = ws.phase === 'orphan'
        const status = ws.hasPvc && !ws.hasPod ? 'sleep' : ws.phase
        const actions = isOrphan
          ? '<button class="danger" onclick="cleanup(' + JSON.stringify(ws.workspaceId) + ')">清理</button>'
          : '<button class="danger" onclick="del(' + JSON.stringify(ws.workspaceId) + ')">删除</button>'
        const meta = ws.activeSessions || ws.openTurns || ws.activeCommands
          ? ' · 会话 ' + ws.activeSessions + ' · turn ' + ws.openTurns + ' · 命令 ' + ws.activeCommands
          : ''
        return '<tr><td><strong>' + esc(ws.workspaceId) + '</strong>' + (ws.title ? '<div class="muted">' + esc(ws.title) + '</div>' : '') + '</td>' +
          '<td><span class="badge ' + esc(status) + '">' + esc(phaseText[status] ?? status) + '</span><div class="muted">' + esc(meta) + '</div></td>' +
          '<td class="muted">' + esc(ws.path) + '</td><td>' + actions + '</td></tr>'
      }).join('') + '</tbody></table>'
  } catch (e) {
    $('error').textContent = e instanceof Error ? e.message : String(e)
  }
}
async function create() {
  const name = $('name').value.trim()
  if (!name) return
  $('error').textContent = ''
  try {
    await api('create', { name })
    $('name').value = ''
    await refresh()
  } catch (e) {
    $('error').textContent = e instanceof Error ? e.message : String(e)
  }
}
async function del(id) {
  if (!confirm('删除工作区 ' + id + '？会同时删除执行 Pod 和 PVC 数据。')) return
  $('error').textContent = ''
  try { await api('delete', { workspaceId: id }); await refresh() } catch (e) { $('error').textContent = e instanceof Error ? e.message : String(e) }
}
async function cleanup(id) {
  if (!confirm('清理孤立工作区 ' + id + '？只会删除残留 Pod，不删除数据。')) return
  $('error').textContent = ''
  try { await api('cleanup', { workspaceId: id }); await refresh() } catch (e) { $('error').textContent = e instanceof Error ? e.message : String(e) }
}
$('create').addEventListener('click', create)
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') create() })
refresh()
</script>
</body>
</html>`

/** Plain stylesheet injected by the native workspace UI client plugin. */
export const WORKSPACE_UI_CSS = `
.dsh-workspace-ui { color: #1f2328; font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; }
.dsh-workspace-ui * { box-sizing: border-box; }
.dsh-workspace-ui h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.dsh-ws-create { display: flex; gap: 6px; margin-bottom: 12px; }
.dsh-ws-create input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; font-size: 13px; background: #fff; }
.dsh-ws-create button, .dsh-ws-btn { padding: 5px 9px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; font-size: 12px; cursor: pointer; }
.dsh-ws-create button:hover, .dsh-ws-btn:hover { background: #f6f8fa; }
.dsh-ws-btn.primary { border-color: #0969da; color: #0969da; }
.dsh-ws-btn.primary:hover { background: #ddf4ff; }
.dsh-ws-btn.danger { border-color: #cf222e; color: #cf222e; }
.dsh-ws-btn.danger:hover { background: #ffebe9; }
.dsh-ws-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dsh-ws-item { padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
.dsh-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-ws-name { font-size: 13px; font-weight: 600; word-break: break-all; }
.dsh-ws-badge { flex: none; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
.dsh-ws-badge.running { background: #dafbe1; color: #116329; }
.dsh-ws-badge.sleep { background: #eaeef2; color: #57606a; }
.dsh-ws-badge.provision { background: #fff8c5; color: #7d4e00; }
.dsh-ws-badge.orphan { background: #ffebe9; color: #cf222e; }
.dsh-ws-badge.deleted { background: #eaeef2; color: #57606a; }
.dsh-ws-badge.unknown { background: #eaeef2; color: #57606a; }
.dsh-ws-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.dsh-ws-meta { font-size: 11px; color: #57606a; margin-top: 4px; }
.dsh-ws-error { color: #cf222e; font-size: 12px; margin: 6px 0; }
.dsh-ws-hero { max-width: 520px; margin: 0 auto; padding: 20px; }
.dsh-ws-hero h2 { font-size: 18px; margin: 0 0 12px; }
.dsh-ws-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 12px; font-size: 12px; color: #57606a; border-top: 1px solid #e5e7eb; }
.dsh-ws-status .dsh-ws-badge { font-size: 11px; }
`

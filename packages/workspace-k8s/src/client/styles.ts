export const WORKSPACE_UI_CSS = `
/* ── 工作区状态面板（main 面板 + sidebar.panellist）── */
.dsh-wsp { flex: 1 1 auto; box-sizing: border-box; width: 100%; min-width: 0; min-height: 0; overflow-y: auto; padding: 24px 32px 96px; }
.dsh-wsp-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
.dsh-wsp-title { margin: 0; font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsp-count { font-size: 13px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-refresh { margin-left: auto; cursor: pointer; padding: 5px 14px; font-size: 13px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 8px; background: var(--dsw-alias-button-elevated-fill, #fff); color: var(--dsw-alias-label-primary, #111); }
.dsh-wsp-refresh:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }
/* Failures are loud on purpose: a silent client error is how this platform got
   burned. The API's own message is rendered verbatim. */
.dsh-wsp-error { display: flex; flex-direction: column; gap: 2px; margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent); }
.dsh-wsp-error .k { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-error .v { font-size: 14px; color: var(--dsw-alias-label-primary, #111); overflow-wrap: anywhere; }
.dsh-wsp-empty { padding: 28px 0; text-align: center; font-size: 14px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-list { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsp-row { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-2, #fff); display: flex; flex-direction: column; gap: 8px; }
.dsh-wsp-row.pending { opacity: .6; }
.dsh-wsp-rowhead { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-wsp-name { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wsp-phase { font-size: 13px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-phase.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsp-phase.bad { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-phase.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsp-actions { margin-left: auto; display: flex; gap: 8px; }
.dsh-wsp-line { font-size: 14px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-line.warn { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsp-line.bad { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsp-line.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsp-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-timeline { display: flex; gap: 10px; font-size: 13px; color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsp-timeline .t { flex: none; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsp-icon { display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; }
.dsh-wsp-icon.active { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }

/* ── 工作区相位指示点（面板行 / 侧栏图标共用）── */
.dsh-wsb-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsb-dot.running { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsb-dot.sleep { background: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsb-dot.provision, .dsh-wsb-dot.waking { background: var(--dsw-alias-state-warn-primary, #f59e0b); animation: dsh-wsb-blink 1.2s ease-in-out infinite; }
.dsh-wsb-dot.orphan { background: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsb-dot.deleted, .dsh-wsb-dot.unknown { background: var(--dsw-alias-label-tertiary, #888); }
@keyframes dsh-wsb-blink { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* ── 按钮 ── */
.dsh-wsd-btn { cursor: pointer; padding: 7px 16px; font-size: 14px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 10px; background: var(--dsw-alias-button-elevated-fill, #fff); color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }
.dsh-wsd-btn.primary { background: var(--dsw-alias-button-primary-fill, #111); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-wsd-btn.danger { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsd-btn:disabled { opacity: .5; cursor: default; }
`

/**
 * Inject the panel stylesheet once per document. Slot components are mounted
 * and unmounted by the frame, so this is guarded rather than one-shot.
 */
export function injectPanelStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-workspace-ui]') !== null) return
  const style = document.createElement('style')
  style.dataset.dshWorkspaceUi = 'true'
  style.textContent = WORKSPACE_UI_CSS
  document.head.appendChild(style)
}

export const WORKSPACE_UI_CSS = `
/* ── 侧边栏工作区行内状态（vendored 浏览器注入）── */
.dsh-wsb-titlerow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-wsb-titlerow .dsh-wsb-title { flex: 1; min-width: 0; }
.dsh-wsb-titlerow .dsh-wsb-inline { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 20px; white-space: nowrap; }
.dsh-wsb-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
.dsh-wsb-dot.running { background: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsb-dot.sleep { background: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsb-dot.provision, .dsh-wsb-dot.waking { background: var(--dsw-alias-state-warn-primary, #f59e0b); animation: dsh-wsb-blink 1.2s ease-in-out infinite; }
.dsh-wsb-dot.orphan { background: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsb-dot.deleted, .dsh-wsb-dot.unknown { background: var(--dsw-alias-label-tertiary, #888); }
@keyframes dsh-wsb-blink { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.dsh-wsb-phase { color: var(--dsw-alias-label-secondary, #666); }
.dsh-wsb-phase.provision, .dsh-wsb-phase.waking { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsb-phase.orphan { color: var(--dsw-alias-state-error-primary, #ef4444); }

/* ── 工作区详情页（双列，参考 dsh-context）── */
.dsh-wsd { flex: 1 1 auto; box-sizing: border-box; width: 100%; min-width: 0; min-height: 0; overflow-y: auto; display: flex; }
.dsh-wsd-inner { width: 100%; max-width: 1080px; margin: 0 auto; padding: 28px 40px 96px; display: flex; flex-direction: column; gap: 16px; align-items: stretch; }
.dsh-wsd-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.dsh-wsd-name { font-size: 24px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.dsh-wsd-head .dsh-wsb-dot { width: 12px; height: 12px; }
.dsh-wsd-head .dsh-wsb-phase { font-size: 16px; }
.dsh-wsd-actions { display: flex; gap: 10px; }
.dsh-wsd-cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.dsh-wsd-col { flex: 1; min-width: 340px; display: flex; flex-direction: column; gap: 16px; }
.dsh-wsd-card { background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06)); border-radius: 12px; padding: 18px 20px; }
.dsh-wsd-card h4 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); display: flex; align-items: baseline; gap: 8px; }
.dsh-wsd-status { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsd-phase-line { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-phase-line .dsh-wsb-dot { width: 12px; height: 12px; }
.dsh-wsd-countdown { font-size: 24px; font-weight: 600; color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dsh-wsd-countdown.ok { color: var(--dsw-alias-state-success-primary, #22c55e); }
.dsh-wsd-statgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px 16px; }
.dsh-wsd-stat .k { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-stat .v { font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-metrics { display: flex; flex-direction: column; gap: 12px; }
.dsh-wsd-metric .mk { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-metric .mv { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-metric svg { display: block; width: 100%; height: 30px; color: var(--dsw-alias-state-business-primary, #4176e6); margin-top: 2px; }
.dsh-wsd-metric.frozen svg { opacity: .45; }
.dsh-wsd-metric-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-sm { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.dsh-wsd-sm .node { padding: 5px 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); color: var(--dsw-alias-label-secondary, #666); background: transparent; }
.dsh-wsd-sm .node.current { border-color: var(--dsw-alias-brand-primary, #111); color: var(--dsw-alias-brand-primary, #111); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #111) 10%, transparent); font-weight: 600; }
.dsh-wsd-sm .node.waking { border-color: var(--dsw-alias-state-warn-primary, #f59e0b); color: var(--dsw-alias-state-warn-primary, #f59e0b); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 10%, transparent); font-weight: 600; }
.dsh-wsd-sm .arrow { color: var(--dsw-alias-label-tertiary, #888); font-size: 14px; }
.dsh-wsd-tl { display: flex; flex-direction: column; gap: 0; max-height: 380px; overflow-y: auto; scrollbar-width: thin; }
.dsh-wsd-tl .ev { display: flex; align-items: baseline; gap: 12px; padding: 6px 2px; font-size: 14px; color: var(--dsw-alias-label-primary, #111); border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.dsh-wsd-tl .ev:last-child { border-bottom: none; }
.dsh-wsd-tl .t { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); min-width: 66px; }
.dsh-wsd-k8s { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; }
.dsh-wsd-k8s .k { font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }
.dsh-wsd-k8s .v { font-size: 14px; color: var(--dsw-alias-label-primary, #111); overflow-wrap: anywhere; }
.dsh-wsd-btn { cursor: pointer; padding: 7px 16px; font-size: 14px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)); border-radius: 10px; background: var(--dsw-alias-button-elevated-fill, #fff); color: var(--dsw-alias-label-primary, #111); }
.dsh-wsd-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08)); }
.dsh-wsd-btn.primary { background: var(--dsw-alias-button-primary-fill, #111); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-wsd-btn.danger { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dsh-wsd-btn:disabled { opacity: .5; cursor: default; }
.dsh-wsd-empty { font-size: 14px; color: var(--dsw-alias-label-tertiary, #888); padding: 24px 0; text-align: center; }
`

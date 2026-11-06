// Styling for the Cortex page. Uses ONLY the DSH theme tokens confirmed by
// cordis_inspect_query (Theme.listTokens); no literal colors for UI chrome.
const CSS = `
.dshc-scope {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  container-type: inline-size;
}
.dshc-scope *, .dshc-scope *::before, .dshc-scope *::after { box-sizing: border-box; }
.dshc-scope button, .dshc-scope input, .dshc-scope select, .dshc-scope textarea { font: inherit; color: inherit; }
.dshc-scope a { color: var(--dsw-alias-brand-primary); }

.dshc-header {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.dshc-title { font-size: 16px; font-weight: 650; letter-spacing: .01em; display: flex; align-items: center; gap: 8px; }
.dshc-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-spacer { flex: 1 1 auto; }
.dshc-header-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.dshc-tabs {
  display: flex; gap: 2px; overflow-x: auto; padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  scrollbar-width: thin;
}
.dshc-tab {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 8px 10px 9px; border-bottom: 2px solid transparent; cursor: pointer;
  white-space: nowrap; border-radius: 6px 6px 0 0; font-size: 13px;
}
.dshc-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.dshc-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.dshc-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }

.dshc-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px 20px; }
.dshc-page { min-height: 100%; }

.dshc-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 10px 16px 0; padding: 8px 10px; border-radius: 8px; font-size: 12px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.dshc-banner-error { border-color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }

.dshc-grid { display: grid; gap: 12px; }
.dshc-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.dshc-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@container (max-width: 860px) { .dshc-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 560px) { .dshc-grid-4, .dshc-grid-2 { grid-template-columns: minmax(0, 1fr); } }

.dshc-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  min-width: 0;
}
.dshc-card-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dshc-card-title { font-size: 13px; font-weight: 600; }
.dshc-card-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshc-card-body { padding: 12px; min-width: 0; }
.dshc-card-body-flush { padding: 0; }

.dshc-metric { display: flex; flex-direction: column; gap: 2px; padding: 12px; }
.dshc-metric-value { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.dshc-metric-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }

.dshc-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.dshc-toolbar-right { margin-left: auto; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.dshc-btn {
  appearance: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 4px 10px; font-size: 12px;
  min-height: 26px; white-space: nowrap;
}
.dshc-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dshc-btn:active { transform: translateY(.5px); }
.dshc-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshc-btn[disabled] { opacity: .55; cursor: default; pointer-events: none; }
.dshc-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dshc-btn-primary:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 86%, var(--dsw-alias-label-primary)); }
.dshc-btn-ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dshc-btn-ghost:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dshc-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dshc-btn-sm { padding: 2px 8px; min-height: 22px; font-size: 12px; }

.dshc-badge {
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
  padding: 0 7px; min-height: 18px; border-radius: 999px; font-size: 11px; font-weight: 550;
  border: 1px solid var(--dshc-tone, var(--dsw-alias-border-l2));
  color: var(--dshc-tone, var(--dsw-alias-label-secondary));
  background: color-mix(in srgb, var(--dshc-tone, var(--dsw-alias-label-secondary)) 12%, transparent);
}
.dshc-badge-neutral { --dshc-tone: var(--dsw-alias-label-secondary); }
.dshc-badge-brand { --dshc-tone: var(--dsw-alias-brand-primary); }
.dshc-badge-success { --dshc-tone: var(--dsw-alias-state-success-primary); }
.dshc-badge-warn { --dshc-tone: var(--dsw-alias-state-warn-primary); }
.dshc-badge-error { --dshc-tone: var(--dsw-alias-state-error-primary); }
.dshc-badge-idle { --dshc-tone: var(--dsw-alias-state-idle-primary); }

.dshc-input, .dshc-select {
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  border-radius: 7px; padding: 4px 8px; min-height: 26px; min-width: 0; color: var(--dsw-alias-label-primary);
}
.dshc-input:focus-visible, .dshc-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: transparent; }
.dshc-input::placeholder { color: var(--dsw-alias-label-secondary); }
.dshc-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dshc-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshc-field-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }

.dshc-table-wrap { width: 100%; overflow: auto; }
.dshc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dshc-table th {
  text-align: left; font-weight: 550; color: var(--dsw-alias-label-secondary); font-size: 11.5px; text-transform: none;
  padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; background: var(--dsw-alias-bg-layer-1);
  position: sticky; top: 0; z-index: 1;
}
.dshc-table td { padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; }
.dshc-table tbody tr:last-child td { border-bottom: 0; }
.dshc-table tbody tr[data-clickable="true"] { cursor: pointer; }
.dshc-table tbody tr[data-clickable="true"]:hover td { background: var(--dsw-alias-bg-layer-2); }
.dshc-table tbody tr[data-active="true"] td { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.dshc-table tbody tr:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshc-table .dshc-num { text-align: right; font-variant-numeric: tabular-nums; }
.dshc-table-dense th, .dshc-table-dense td { padding: 5px 8px; }

.dshc-mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.dshc-pre {
  margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); overflow: auto; max-height: 420px;
  font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 11.5px;
  white-space: pre-wrap; word-break: break-word;
}
.dshc-iframe { width: 100%; min-height: 320px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: #fff; }

.dshc-split { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 12px; align-items: start; }
@container (max-width: 860px) { .dshc-split { grid-template-columns: minmax(0, 1fr); } }
.dshc-list { display: flex; flex-direction: column; }
.dshc-list-item {
  appearance: none; text-align: left; border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent; padding: 8px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  color: var(--dsw-alias-label-primary); width: 100%;
}
.dshc-list-item:last-child { border-bottom: 0; }
.dshc-list-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dshc-list-item[aria-current="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.dshc-list-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshc-list-main { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshc-list-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.dshc-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; font-size: 12.5px; }
.dshc-kv-k { color: var(--dsw-alias-label-secondary); }
.dshc-kv-v { min-width: 0; overflow-wrap: anywhere; }
.dshc-kv-list { display: flex; flex-direction: column; gap: 6px; }

.dshc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.dshc-empty-title { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }
.dshc-empty-hint { font-size: 12px; max-width: 480px; }

.dshc-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.dshc-error-title { font-weight: 600; color: var(--dsw-alias-state-error-primary); font-size: 12.5px; }
.dshc-error-detail { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }

.dshc-spinner { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 14px; }
.dshc-spinner-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: dshc-spin .8s linear infinite; }
@keyframes dshc-spin { to { transform: rotate(360deg); } }

.dshc-pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.dshc-modal-backdrop { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, #000 32%, transparent); display: flex; align-items: center; justify-content: center; padding: 20px; }
.dshc-modal {
  width: min(560px, 100%); max-height: min(80vh, 720px); overflow: auto;
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0,0,0,.28);
}
.dshc-modal-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshc-modal-title { font-weight: 600; font-size: 14px; flex: 1; }
.dshc-modal-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dshc-modal-foot { padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; justify-content: flex-end; gap: 8px; }

.dshc-section { display: flex; flex-direction: column; gap: 8px; }
.dshc-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshc-section-title { font-size: 12.5px; font-weight: 600; }
.dshc-hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 10px 0; }
.dshc-md h1, .dshc-md h2, .dshc-md h3, .dshc-md h4 { font-size: 13px; margin: 12px 0 6px; }
.dshc-md h1:first-child, .dshc-md h2:first-child, .dshc-md h3:first-child { margin-top: 0; }
.dshc-md p { margin: 6px 0; }
.dshc-md ul, .dshc-md ol { margin: 6px 0; padding-left: 20px; }
.dshc-md li { margin: 2px 0; }
.dshc-md code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; background: var(--dsw-alias-bg-layer-2); padding: 1px 4px; border-radius: 4px; }
.dshc-md pre { margin: 8px 0; }
.dshc-md table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.dshc-md th, .dshc-md td { border: 1px solid var(--dsw-alias-border-l1); padding: 4px 8px; text-align: left; }
.dshc-md blockquote { margin: 8px 0; padding: 2px 10px; border-left: 3px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dshc-clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dshc-clickable { cursor: pointer; }
.dshc-clickable:hover { color: var(--dsw-alias-brand-primary); }
.dshc-scroll-y { overflow-y: auto; }
.dshc-muted { color: var(--dsw-alias-label-secondary); }
.dshc-small { font-size: 11.5px; }
.dshc-nowrap { white-space: nowrap; }
.dshc-break { overflow-wrap: anywhere; }
.dshc-flex { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dshc-flex-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dshc-col { display: flex; flex-direction: column; gap: 8px; }
.dshc-grow { flex: 1 1 auto; min-width: 0; }
.dshc-hidden { display: none !important; }
.dshc-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  .dshc-scope *, .dshc-scope *::before, .dshc-scope *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
}
`
module.exports = { CSS }

export const LIVE_CONSOLE_CSS = `
/* Mimamori: minimal care-operations UI. No dependency or hidden action logic. */
.mco-shell {
  --mco-ink: #172c3a;
  --mco-muted: #536c7a;
  --mco-border: #d5e1e7;
  --mco-brand: #0c746d;
  color: var(--mco-ink);
  background: #f5f8fa;
  min-height: 100%;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.5;
}
.mco-shell * { box-sizing: border-box; }
.mco-shell button, .mco-shell input, .mco-shell select,
.mco-shell textarea { font: inherit; }
.mco-topbar {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; padding: 20px 24px; background: #fff;
  border-bottom: 1px solid var(--mco-border);
}
.mco-title { margin: 0; font-size: 22px; letter-spacing: -.025em; }
.mco-subtle { font-size: 13px; color: var(--mco-muted); }
.mco-operator { text-align: right; overflow-wrap: anywhere; }
.mco-toolbar {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 20px; flex-wrap: wrap;
}
.mco-button {
  min-height: 44px; border: 1px solid #acbec8; border-radius: 10px;
  padding: 9px 16px; background: #fff; color: var(--mco-ink);
  cursor: pointer; font-weight: 600;
}
.mco-button:hover { border-color: var(--mco-brand); }
.mco-button:disabled { opacity: .55; cursor: not-allowed; }
.mco-button-primary {
  background: var(--mco-brand); border-color: var(--mco-brand); color: #fff;
}
.mco-button-danger { color: #9c2640; border-color: #e3bdc4; }
.mco-banner {
  margin: 12px 20px; padding: 12px 14px; border-radius: 10px;
  background: #fff; border: 1px solid var(--mco-border);
}
.mco-banner-error { background: #fff2f4; border-color: #dd98a6; color: #8d1736; }
.mco-banner-warn { background: #fff7e7; border-color: #d0ad69; color: #76500f; }
.mco-metrics {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px; padding: 8px 20px 18px;
}
.mco-metric { background: #fff; border: 1px solid var(--mco-border); border-radius: 12px; padding: 13px 16px; }
.mco-metric strong { display: block; margin-top: 3px; font-size: 27px; font-variant-numeric: tabular-nums; }
.mco-label { display: block; color: var(--mco-muted); font-size: 12px; font-weight: 600; }
.mco-grid {
  display: grid; grid-template-columns: minmax(240px, .75fr) minmax(0, 1.25fr);
  gap: 14px; align-items: start; padding: 0 20px 24px;
}
.mco-panel {
  min-width: 0; background: #fff; border: 1px solid var(--mco-border);
  border-radius: 14px; overflow: hidden;
}
.mco-grid > .mco-panel:nth-child(1) { grid-column: 1; grid-row: 1 / span 2; }
.mco-grid > .mco-panel:nth-child(2) { grid-column: 2; grid-row: 1; }
.mco-grid > .mco-panel:nth-child(3) { grid-column: 2; grid-row: 2; }
.mco-panel-head { padding: 16px; border-bottom: 1px solid var(--mco-border); }
.mco-panel-head h2 { margin: 0; font-size: 17px; }
.mco-list { padding: 12px; }
.mco-card {
  display: block; width: 100%; min-height: 80px; padding: 14px;
  margin-bottom: 9px; border: 1px solid var(--mco-border); border-radius: 10px;
  background: #fff; color: var(--mco-ink); text-align: left;
  cursor: pointer; overflow-wrap: anywhere;
}
.mco-card:hover { border-color: var(--mco-brand); }
.mco-card-selected { border-color: var(--mco-brand); background: #edf8f6; }
.mco-card-breach { box-shadow: inset 4px 0 #c13b50; }
.mco-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.mco-tag {
  display: inline-flex; align-items: center; padding: 3px 8px;
  font-size: 11px; font-weight: 700; border: 1px solid var(--mco-border);
  background: #fff; border-radius: 100px; white-space: nowrap;
}
.mco-tag-breach { color: #96283d; border-color: #db9aa5; margin-left: 5px; }
.mco-facts {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px; border-radius: 10px; border: 1px solid var(--mco-border);
  background: var(--mco-border); overflow: hidden;
}
.mco-fact { background: #fff; padding: 12px; min-width: 0; }
.mco-value { display: block; font-size: 14px; margin-top: 4px; overflow-wrap: anywhere; }
.mco-next-step {
  margin: 14px; padding: 16px; border-radius: 12px;
  border: 1px solid #81c3ba; background: #effaf8;
}
.mco-next-step strong { display: block; font-size: 14px; }
.mco-next-step p { margin: 6px 0 0; font-size: 15px; }
.mco-actions { display: grid; gap: 10px; padding: 0 14px 14px; }
.mco-action { padding: 16px; background: #fff; border: 1px solid var(--mco-border); border-radius: 12px; }
.mco-action h3 { margin: 0 0 12px; font-size: 16px; }
.mco-actions > .mco-action > .mco-button-primary { width: 100%; }
.mco-field { display: grid; gap: 6px; margin: 10px 0; }
.mco-field input, .mco-field select, .mco-field textarea {
  width: 100%; min-height: 44px; padding: 9px 10px;
  border: 1px solid #a4bbc6; border-radius: 9px; color: var(--mco-ink);
  background: #fff;
}
.mco-field textarea { min-height: 90px; resize: vertical; }
.mco-disclosure { margin: 14px; border: 1px solid var(--mco-border); border-radius: 10px; background: #fff; }
.mco-disclosure summary { cursor: pointer; padding: 14px; font-weight: 600; min-height: 44px; }
.mco-disclosure[open] summary { border-bottom: 1px solid var(--mco-border); }
.mco-disclosure-body { display: grid; gap: 12px; padding: 12px; }
.mco-secondary-actions { margin: 0; }
.mco-secondary-actions .mco-action { padding: 12px; }
.mco-timeline { list-style: none; margin: 0; padding: 8px 14px; }
.mco-timeline li { border-left: 2px solid #b5dcd5; padding: 4px 0 12px 12px; }
.mco-timeline strong, .mco-timeline small { display: block; }
.mco-timeline small { color: var(--mco-muted); margin-top: 3px; }
.mco-empty { padding: 24px 16px; color: var(--mco-muted); text-align: center; }
.mco-shell button:focus-visible, .mco-shell summary:focus-visible,
.mco-shell input:focus-visible, .mco-shell select:focus-visible,
.mco-shell textarea:focus-visible { outline: 3px solid #077870; outline-offset: 3px; }
@media (max-width: 800px) {
  .mco-grid { display: flex; flex-direction: column; padding: 0 12px 18px; }
  .mco-grid > .mco-panel { width: 100%; }
  .mco-has-selection > .mco-panel:nth-child(2) { order: -1; }
  .mco-topbar { padding: 16px; }
  .mco-toolbar { padding: 10px 12px; }
  .mco-metrics { padding: 8px 12px 14px; }
}
@media (max-width: 500px) {
  .mco-topbar { align-items: flex-start; }
  .mco-operator { max-width: 48%; }
  .mco-metrics { gap: 5px; }
  .mco-metric { padding: 10px; }
  .mco-metric strong { font-size: 23px; }
  .mco-facts { grid-template-columns: 1fr; }
}
`;

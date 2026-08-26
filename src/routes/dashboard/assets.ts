export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ghc-proxy Dashboard</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/dashboard/styles.css">
</head>
<body>
  <header class="app-header">
    <div class="brand-block">
      <div class="brand">ghc-proxy</div>
      <div class="status-line">
        <span id="health-dot" class="status-dot unknown"></span>
        <span id="health-label">Connecting</span>
        <span id="version-label"></span>
      </div>
    </div>
    <nav class="tabs" aria-label="Dashboard views">
      <button type="button" class="tab active" data-tab="overview">Overview</button>
      <button type="button" class="tab" data-tab="models">Models</button>
      <button type="button" class="tab" data-tab="behavior">Behavior</button>
      <button type="button" class="tab" data-tab="requests">Requests</button>
    </nav>
    <div class="header-actions">
      <label class="toggle"><input id="live-refresh" type="checkbox" checked> Live</label>
      <label class="theme-toggle">
        <input id="theme-toggle" type="checkbox" role="switch" aria-label="Use dark theme">
        <span id="theme-label">Light</span>
      </label>
      <button id="refresh-button" type="button" class="command">Refresh</button>
    </div>
  </header>

  <main>
    <section id="view-overview" class="view active" data-view="overview">
      <div class="metric-strip" aria-label="Runtime summary">
        <div><span class="metric-label">Uptime</span><strong id="metric-uptime">-</strong></div>
        <div><span class="metric-label">Active</span><strong id="metric-active">0</strong></div>
        <div><span class="metric-label">Completed</span><strong id="metric-completed">0</strong></div>
        <div><span class="metric-label">Failed</span><strong id="metric-failed">0</strong></div>
        <div><span class="metric-label">Aborted</span><strong id="metric-aborted">0</strong></div>
        <div><span class="metric-label">Queue</span><strong id="metric-queue">0 / 0</strong></div>
      </div>

      <div class="overview-grid">
        <section class="panel">
          <div class="section-heading"><h1>Runtime</h1><span id="overview-updated" class="muted"></span></div>
          <dl id="runtime-details" class="kv-list"></dl>
        </section>
        <section class="panel">
          <div class="section-heading"><h1>Authentication</h1></div>
          <div class="table-scroll"><table><thead><tr><th>Service</th><th>Status</th><th>Identity</th><th>Last check</th></tr></thead><tbody id="auth-body"></tbody></table></div>
        </section>
      </div>

      <section class="panel full-width">
        <div class="section-heading"><h1>Quota</h1><span id="quota-status" class="muted"></span></div>
        <div class="table-scroll"><table><thead><tr><th>Pool</th><th>Remaining</th><th>Entitlement</th><th>Percent</th><th>Overage</th></tr></thead><tbody id="quota-body"></tbody></table></div>
      </section>
    </section>

    <section id="view-models" class="view" data-view="models" hidden>
      <div class="toolbar model-toolbar">
        <div><h1>Models</h1><span id="model-count" class="muted"></span></div>
        <div class="model-controls">
          <label class="toggle"><input id="model-group-vendor" type="checkbox" checked> Group vendor</label>
          <select id="model-sort" aria-label="Order models by name">
            <option value="asc">Name A-Z</option>
            <option value="desc">Name Z-A</option>
          </select>
          <input id="model-filter" type="search" placeholder="Filter models" autocomplete="off">
          <button id="copy-models" type="button" class="command" disabled>Copy selected (0)</button>
        </div>
      </div>
      <div id="model-copy-status" class="muted model-copy-status" role="status" aria-live="polite"></div>
      <div class="table-scroll model-table"><table><thead><tr><th class="model-select-header" aria-label="Select model"></th><th>Model</th><th>Vendor</th><th>Messages route</th><th>Upstream endpoints</th><th>Limits</th><th>Capabilities</th><th>Proxy compatibility</th></tr></thead><tbody id="models-body"></tbody></table></div>
    </section>

    <section id="view-behavior" class="view" data-view="behavior" hidden>
      <div class="toolbar"><div><h1>Behavior</h1><span class="muted">Current process configuration</span></div></div>
      <div class="behavior-grid">
        <section class="panel"><div class="section-heading"><h2>Model routing</h2></div><dl id="behavior-routing" class="kv-list"></dl></section>
        <section class="panel"><div class="section-heading"><h2>Parameters and context</h2></div><dl id="behavior-parameters" class="kv-list"></dl></section>
      </div>
      <section class="panel full-width">
        <div class="section-heading"><h2>Effects since startup</h2></div>
        <div class="table-scroll"><table><thead><tr><th>Category</th><th>Effect</th><th>Count</th></tr></thead><tbody id="effects-body"></tbody></table></div>
      </section>
    </section>

    <section id="view-requests" class="view requests-view" data-view="requests" hidden>
      <div class="toolbar"><div><h1>Requests</h1><span id="request-count" class="muted"></span></div><span class="muted">256 finished max</span></div>
      <div class="request-layout">
        <div class="request-list table-scroll"><table><thead><tr><th>State</th><th>Endpoint</th><th>Model</th><th>Strategy</th><th>Status</th><th>Duration</th><th>Started</th></tr></thead><tbody id="requests-body"></tbody></table></div>
        <aside class="request-detail" aria-label="Selected request details">
          <div class="section-heading"><h2>Request detail</h2></div>
          <pre id="request-detail">No request selected</pre>
        </aside>
      </div>
    </section>
  </main>

  <div id="error-banner" class="error-banner" role="status" hidden></div>
  <script src="/dashboard/app.js" defer></script>
</body>
</html>`

export const DASHBOARD_CSS = String.raw`:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background: var(--page);
  font-size: 14px;
  line-height: 1.45;
  letter-spacing: 0;
  --page: #f7f8f8;
  --border: #d9dddf;
  --border-strong: #bcc3c7;
  --surface: #ffffff;
  --surface-subtle: #f1f3f3;
  --surface-hover: #f6f8f8;
  --surface-selected: #eaf4f7;
  --header: rgba(255, 255, 255, 0.98);
  --table-header: #eef1f1;
  --text: #202124;
  --text-strong: #17191a;
  --text-secondary: #4d5559;
  --text-muted: #687176;
  --accent: #176b87;
  --ok: #16825d;
  --warn: #b06a00;
  --bad: #b63f36;
  --ok-bg: #edf8f4;
  --ok-border: #acd7c7;
  --warn-bg: #fff7e8;
  --warn-border: #e5c790;
  --bad-bg: #fff0ef;
  --bad-border: #e1b0ac;
  --error-bg: #fff1f0;
  --focus-ring: rgba(23, 107, 135, 0.2);
  --shadow: rgba(31, 35, 37, 0.14);
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --page: #111416;
  --border: #333b40;
  --border-strong: #4a555b;
  --surface: #181c1f;
  --surface-subtle: #22282c;
  --surface-hover: #20262a;
  --surface-selected: #19313a;
  --header: rgba(20, 24, 27, 0.98);
  --table-header: #20262a;
  --text: #e4e9eb;
  --text-strong: #f5f7f8;
  --text-secondary: #b7c0c4;
  --text-muted: #929da2;
  --accent: #66bad6;
  --ok: #58cfa3;
  --warn: #f0ad4e;
  --bad: #f07b72;
  --ok-bg: #15342a;
  --ok-border: #2f725b;
  --warn-bg: #382a15;
  --warn-border: #80602e;
  --bad-bg: #3a2020;
  --bad-border: #814844;
  --error-bg: #3a2020;
  --focus-ring: rgba(102, 186, 214, 0.28);
  --shadow: rgba(0, 0, 0, 0.35);
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--page); }
button, input { font: inherit; letter-spacing: 0; }
button { cursor: pointer; }

.app-header {
  position: sticky;
  top: 0;
  z-index: 10;
  min-height: 64px;
  display: grid;
  grid-template-columns: minmax(190px, 0.8fr) minmax(360px, 1.5fr) minmax(180px, 0.7fr);
  align-items: center;
  gap: 18px;
  padding: 10px 22px;
  border-bottom: 1px solid var(--border-strong);
  background: var(--header);
}

.brand { font-size: 18px; font-weight: 700; color: var(--text-strong); }
.status-line { display: flex; align-items: center; gap: 7px; color: var(--text-muted); font-size: 12px; min-height: 20px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #8b9499; flex: 0 0 auto; }
.status-dot.ok { background: var(--ok); }
.status-dot.degraded { background: var(--warn); }
.status-dot.failed { background: var(--bad); }

.tabs { display: flex; align-items: stretch; justify-content: center; min-width: 0; }
.tab {
  min-width: 88px;
  height: 36px;
  padding: 0 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
}
.tab:hover { color: var(--text-strong); background: var(--surface-subtle); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 650; }

.header-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
.toggle, .theme-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); white-space: nowrap; }
.theme-toggle input { width: 34px; height: 20px; margin: 0; appearance: none; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface-subtle); cursor: pointer; }
.theme-toggle input::after { content: ''; display: block; width: 14px; height: 14px; margin: 2px; border-radius: 50%; background: var(--text-muted); transition: transform 120ms ease, background 120ms ease; }
.theme-toggle input:checked { border-color: var(--accent); background: var(--accent); }
.theme-toggle input:checked::after { transform: translateX(14px); background: var(--surface); }
.theme-toggle input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.command {
  height: 34px;
  padding: 0 13px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--text);
  background: var(--surface);
}
.command:hover { border-color: var(--text-muted); background: var(--surface-hover); }

main { width: min(1600px, 100%); margin: 0 auto; padding: 18px 22px 32px; }
.view { min-height: calc(100vh - 115px); }
.view[hidden] { display: none; }
h1, h2 { margin: 0; color: var(--text-strong); font-weight: 680; }
h1 { font-size: 17px; }
h2 { font-size: 15px; }
.muted { color: var(--text-muted); font-size: 12px; }

.metric-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(100px, 1fr));
  margin-bottom: 18px;
  border: 1px solid var(--border);
  background: var(--surface);
}
.metric-strip > div { min-width: 0; padding: 13px 16px; border-right: 1px solid var(--border); }
.metric-strip > div:last-child { border-right: 0; }
.metric-label { display: block; margin-bottom: 3px; color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
.metric-strip strong { display: block; font-size: 21px; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.overview-grid, .behavior-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.panel { min-width: 0; padding: 0; border-top: 2px solid #8b969b; background: transparent; }
.panel.full-width { margin-top: 22px; }
.section-heading { min-height: 42px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 2px; }
.kv-list { margin: 0; border: 1px solid var(--border); background: var(--surface); }
.kv-list > div { display: grid; grid-template-columns: minmax(120px, 0.45fr) minmax(0, 1fr); gap: 16px; padding: 9px 12px; border-bottom: 1px solid var(--border); }
.kv-list > div:last-child { border-bottom: 0; }
.kv-list dt { color: var(--text-muted); }
.kv-list dd { margin: 0; text-align: right; overflow-wrap: anywhere; }

.toolbar { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.toolbar input[type='search'], .toolbar select { height: 34px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--surface); color: var(--text); }
.toolbar input[type='search'] { width: min(280px, 34vw); }
.toolbar input[type='search']:focus, .toolbar select:focus { outline: 2px solid var(--focus-ring); border-color: var(--accent); }
.model-controls { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px 12px; }
.model-copy-status { min-height: 18px; margin: -6px 0 6px; text-align: right; }

.table-scroll { width: 100%; overflow: auto; border: 1px solid var(--border); background: var(--surface); }
table { width: 100%; border-collapse: collapse; min-width: 680px; }
th { position: sticky; top: 0; z-index: 1; padding: 9px 11px; border-bottom: 1px solid var(--border-strong); background: var(--table-header); color: var(--text-secondary); font-size: 11px; font-weight: 700; text-align: left; text-transform: uppercase; white-space: nowrap; }
td { padding: 9px 11px; border-bottom: 1px solid var(--border); vertical-align: top; color: var(--text); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--surface-hover); }
.model-table table { min-width: 1220px; }
.model-select-header, .model-select-cell { width: 42px; text-align: center; }
.model-select-cell input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.model-table tr.selectable { cursor: pointer; }
.model-table tr.selectable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.model-table tr.selected td { background: var(--surface-selected); }
.vendor-group th { position: static; padding: 7px 11px; border-top: 1px solid var(--border-strong); border-bottom: 1px solid var(--border-strong); background: var(--surface-subtle); color: var(--accent); font-size: 12px; text-transform: none; }
.model-name { font-weight: 650; color: var(--text-strong); }
.mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 7px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-subtle); color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.badge.ok, .badge.completed { color: var(--ok); border-color: var(--ok-border); background: var(--ok-bg); }
.badge.degraded, .badge.streaming, .badge.in_flight, .badge.aborted { color: var(--warn); border-color: var(--warn-border); background: var(--warn-bg); }
.badge.failed, .badge.missing { color: var(--bad); border-color: var(--bad-border); background: var(--bad-bg); }

.behavior-grid { margin-bottom: 18px; }
.request-layout { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(320px, 0.75fr); gap: 16px; min-height: 560px; }
.request-list { max-height: calc(100vh - 180px); }
.request-list table { min-width: 920px; }
.request-list tr.selected td { background: var(--surface-selected); }
.request-detail { min-width: 0; border-top: 2px solid #8b969b; }
.request-detail pre { margin: 0; min-height: 260px; max-height: calc(100vh - 230px); overflow: auto; padding: 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }

.error-banner { position: fixed; right: 18px; bottom: 18px; max-width: min(520px, calc(100vw - 36px)); padding: 10px 13px; border: 1px solid var(--bad-border); border-radius: 5px; background: var(--error-bg); color: var(--bad); box-shadow: 0 8px 24px var(--shadow); }

@media (max-width: 900px) {
  .app-header { grid-template-columns: 1fr auto; gap: 8px 12px; padding: 9px 14px; }
  .tabs { grid-column: 1 / -1; grid-row: 2; justify-content: flex-start; overflow-x: auto; border-top: 1px solid var(--border); }
  .header-actions { grid-column: 2; grid-row: 1; }
  .tab { min-width: 82px; }
  main { padding: 14px; }
  .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric-strip > div { border-bottom: 1px solid var(--border); }
  .metric-strip > div:nth-child(2n) { border-right: 0; }
  .metric-strip > div:nth-last-child(-n + 2) { border-bottom: 0; }
  .overview-grid, .behavior-grid, .request-layout { grid-template-columns: 1fr; }
  .request-list, .request-detail pre { max-height: none; }
}

@media (max-width: 560px) {
  .brand { font-size: 16px; }
  .header-actions .toggle { display: none; }
  .toolbar { align-items: flex-start; flex-direction: column; }
  .model-controls { width: 100%; justify-content: flex-start; }
  .toolbar input[type='search'] { width: 100%; }
  .model-copy-status { text-align: left; }
  .metric-strip { grid-template-columns: 1fr; }
  .metric-strip > div, .metric-strip > div:nth-child(2n) { border-right: 0; border-bottom: 1px solid var(--border); }
  .metric-strip > div:last-child { grid-column: auto; border-bottom: 0; }
  .kv-list > div { grid-template-columns: 1fr; gap: 3px; }
  .kv-list dd { text-align: left; }
}`

export const DASHBOARD_JS = String.raw`'use strict';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const THEME_STORAGE_KEY = 'ghc-proxy-dashboard-theme';
const darkThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const dashboardState = {
  activeView: 'overview',
  models: [],
  selectedModelIds: new Set(),
  requests: [],
  selectedRequestId: null,
  errors: new Map(),
  refreshing: false,
  pendingRefresh: null,
};

function byId(id) {
  return document.getElementById(id);
}

function readStoredTheme() {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY);
    return theme === 'dark' || theme === 'light' ? theme : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === null && darkThemeQuery.matches);
  const toggle = byId('theme-toggle');
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  toggle.checked = dark;
  toggle.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
  toggle.title = dark ? 'Use light theme' : 'Use dark theme';
  byId('theme-label').textContent = dark ? 'Dark' : 'Light';
}

function storeTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
  }
  applyTheme(theme);
}

function clearNode(node) {
  node.replaceChildren();
}

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function appendCell(row, text, className) {
  const cell = createElement('td', className, text);
  row.appendChild(cell);
  return cell;
}

function appendKv(list, label, value) {
  const row = createElement('div');
  row.appendChild(createElement('dt', '', label));
  row.appendChild(createElement('dd', 'mono', value === undefined || value === null || value === '' ? '-' : value));
  list.appendChild(row);
}

function makeBadge(value) {
  return createElement('span', 'badge ' + String(value || 'unknown'), value || 'unknown');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes + 'm ' + seconds + 's';
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '-';
}

function formatDate(value) {
  if (!value) return '-';
  if (DATE_ONLY_RE.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function compactJson(value) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('Dashboard request failed: ' + response.status);
  return response.json();
}

function renderErrors() {
  const banner = byId('error-banner');
  const current = dashboardState.errors.values().next();
  if (current.done) {
    banner.textContent = '';
    banner.hidden = true;
    return;
  }
  const error = current.value;
  banner.textContent = error instanceof Error ? error.message : 'Dashboard refresh failed';
  banner.hidden = false;
}

function renderOverview(data) {
  const health = data.status || 'degraded';
  byId('health-dot').className = 'status-dot ' + health;
  byId('health-label').textContent = health;
  byId('version-label').textContent = data.version ? 'v' + data.version : '';
  byId('metric-uptime').textContent = formatDuration(data.uptimeMs);
  byId('metric-active').textContent = formatNumber(data.activity.activeRequests);
  byId('metric-completed').textContent = formatNumber(data.activity.completed);
  byId('metric-failed').textContent = formatNumber(data.activity.failed);
  byId('metric-aborted').textContent = formatNumber(data.activity.aborted);
  const queue = data.activity.upstreamQueue || {};
  byId('metric-queue').textContent = formatNumber(queue.active) + ' / ' + formatNumber(queue.pending);
  byId('overview-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

  const runtime = byId('runtime-details');
  clearNode(runtime);
  appendKv(runtime, 'Started', formatDate(data.startedAt));
  appendKv(runtime, 'Recent finished', data.activity.recentRequests);
  appendKv(runtime, 'Upstream slots', formatNumber(queue.active) + ' / ' + formatNumber(queue.concurrency));
  appendKv(runtime, 'Pending queue', formatNumber(queue.pending) + ' / ' + formatNumber(queue.maxPending));
  appendKv(runtime, 'Cooldowns', (queue.accountCooldown ? 'account ' : '') + formatNumber(queue.modelCooldowns) + ' model');

  const authBody = byId('auth-body');
  clearNode(authBody);
  const github = data.auth.github || {};
  const copilot = data.auth.copilot || {};
  appendAuthRow(authBody, 'GitHub', github.status, github.login || github.accountType, github.lastValidatedAt);
  appendAuthRow(authBody, 'Copilot', copilot.status, copilot.modelsLoaded ? 'models loaded' : 'models unavailable', copilot.lastRefreshAt);

  const quota = data.quota || { status: 'unavailable' };
  byId('quota-status').textContent = quota.status + (quota.resetDate ? ' / resets ' + formatDate(quota.resetDate) : '');
  const quotaBody = byId('quota-body');
  clearNode(quotaBody);
  appendQuotaRow(quotaBody, 'Premium', quota.premiumInteractions);
  appendQuotaRow(quotaBody, 'Chat', quota.chat);
  appendQuotaRow(quotaBody, 'Completions', quota.completions);
}

function appendAuthRow(body, service, status, identity, checkedAt) {
  const row = createElement('tr');
  appendCell(row, service);
  const statusCell = createElement('td');
  statusCell.appendChild(makeBadge(status));
  row.appendChild(statusCell);
  appendCell(row, identity || '-', 'mono');
  appendCell(row, formatDate(checkedAt));
  body.appendChild(row);
}

function appendQuotaRow(body, name, quota) {
  const row = createElement('tr');
  appendCell(row, name);
  if (!quota) {
    appendCell(row, '-'); appendCell(row, '-'); appendCell(row, '-'); appendCell(row, '-');
  } else {
    appendCell(row, quota.unlimited ? 'Unlimited' : formatNumber(quota.remaining));
    appendCell(row, quota.unlimited ? '-' : formatNumber(quota.entitlement));
    appendCell(row, quota.unlimited ? '-' : Number(quota.percentRemaining).toFixed(1) + '%');
    appendCell(row, quota.overagePermitted ? 'Allowed' : 'No');
  }
  body.appendChild(row);
}

function renderModels(data) {
  dashboardState.models = Array.isArray(data.models) ? data.models : [];
  const availableIds = new Set(dashboardState.models.map(function (model) { return model.id; }));
  dashboardState.selectedModelIds.forEach(function (modelId) {
    if (!availableIds.has(modelId)) dashboardState.selectedModelIds.delete(modelId);
  });
  renderFilteredModels();
}

function renderFilteredModels() {
  const query = byId('model-filter').value.trim().toLowerCase();
  const grouped = byId('model-group-vendor').checked;
  const direction = byId('model-sort').value === 'desc' ? -1 : 1;
  const models = dashboardState.models.filter(function (model) {
    return !query || [model.id, model.name, model.vendor, model.effective.defaultMessagesStrategy]
      .some(function (value) { return String(value || '').toLowerCase().includes(query); });
  });
  models.sort(function (left, right) {
    if (grouped) {
      const vendorOrder = String(left.vendor || 'Unknown').localeCompare(String(right.vendor || 'Unknown'));
      if (vendorOrder !== 0) return vendorOrder;
    }
    return direction * String(left.name || left.id).localeCompare(String(right.name || right.id));
  });
  byId('model-count').textContent = models.length + ' of ' + dashboardState.models.length;
  const body = byId('models-body');
  clearNode(body);
  let currentVendor = null;
  models.forEach(function (model) {
    const vendor = String(model.vendor || 'Unknown');
    if (grouped && vendor !== currentVendor) {
      currentVendor = vendor;
      const groupRow = createElement('tr', 'vendor-group');
      const groupCell = createElement('th', '', vendor);
      groupCell.colSpan = 8;
      groupRow.appendChild(groupCell);
      body.appendChild(groupRow);
    }

    const row = createElement('tr');
    const selected = dashboardState.selectedModelIds.has(model.id);
    row.className = 'selectable' + (selected ? ' selected' : '');
    row.dataset.modelId = model.id;
    row.tabIndex = 0;
    row.setAttribute('aria-selected', String(selected));
    const selectCell = createElement('td', 'model-select-cell');
    const checkbox = createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected;
    checkbox.setAttribute('aria-label', 'Select ' + model.id);
    checkbox.addEventListener('click', function (event) { event.stopPropagation(); });
    checkbox.addEventListener('change', function () { setModelSelected(model.id, checkbox.checked); });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);
    const nameCell = createElement('td');
    nameCell.appendChild(createElement('div', 'model-name mono', model.id));
    nameCell.appendChild(createElement('div', 'muted', model.name + (model.preview ? ' / preview' : '')));
    row.appendChild(nameCell);
    appendCell(row, model.vendor + ' / ' + model.version);
    const strategyCell = createElement('td');
    strategyCell.appendChild(makeBadge(model.effective.defaultMessagesStrategy));
    row.appendChild(strategyCell);
    appendCell(row, (model.upstream.endpoints || []).join(', ') || '-', 'mono');
    appendCell(row, formatModelLimits(model, '\n'), 'mono');
    appendCell(row, formatModelCapabilities(model), 'mono');
    appendCell(row, formatModelCompatibility(model).join('\n'), 'mono');
    row.addEventListener('click', function () { toggleModelSelection(model.id); });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleModelSelection(model.id);
      }
    });
    body.appendChild(row);
  });
  updateModelSelectionControls();
}

function formatModelLimits(model, separator) {
  const limits = model.upstream.capabilities.limits || {};
  return [
    'context ' + formatNumber(limits.max_context_window_tokens),
    'prompt ' + formatNumber(limits.max_prompt_tokens),
    'output ' + formatNumber(limits.max_output_tokens),
  ].join(separator);
}

function formatModelCapabilities(model) {
  const supports = model.upstream.capabilities.supports || {};
  const capabilities = Object.keys(supports).filter(function (key) {
    return supports[key] === true || (Array.isArray(supports[key]) && supports[key].length > 0);
  });
  return capabilities.join(', ') || '-';
}

function formatModelCompatibility(model) {
  return [
    'structured ' + (model.effective.messagesStructuredOutput ? 'yes' : 'no'),
    'output_config ' + (model.effective.outputConfig ? 'yes' : 'no'),
    'chat tokens ' + model.effective.chatTokenParameter,
    model.effective.responsesParameterFilters.length ? 'filters ' + model.effective.responsesParameterFilters.join(',') : 'filters none',
    model.effective.contextManagement ? 'context managed' : 'context passthrough',
  ];
}

function setModelSelected(modelId, selected) {
  if (selected) dashboardState.selectedModelIds.add(modelId);
  else dashboardState.selectedModelIds.delete(modelId);
  document.querySelectorAll('#models-body tr[data-model-id]').forEach(function (row) {
    if (row.dataset.modelId !== modelId) return;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = selected;
  });
  byId('model-copy-status').textContent = '';
  updateModelSelectionControls();
}

function toggleModelSelection(modelId) {
  setModelSelected(modelId, !dashboardState.selectedModelIds.has(modelId));
}

function updateModelSelectionControls() {
  const count = dashboardState.selectedModelIds.size;
  const button = byId('copy-models');
  button.disabled = count === 0;
  button.textContent = 'Copy selected (' + count + ')';
}

async function copySelectedModels() {
  const selected = dashboardState.models
    .filter(function (model) { return dashboardState.selectedModelIds.has(model.id); })
    .sort(function (left, right) { return String(left.name || left.id).localeCompare(String(right.name || right.id)); });
  if (selected.length === 0) return;
  const localEndpoint = window.location.origin + '/v1';
  const headers = ['Model ID', 'Model Name', 'Vendor', 'Version', 'Messages Route', 'Upstream Endpoints', 'Limits', 'Capabilities', 'Proxy Compatibility'];
  const rows = selected.map(function (model) {
    return [
      model.id,
      model.name + (model.preview ? ' / preview' : ''),
      model.vendor,
      model.version,
      model.effective.defaultMessagesStrategy,
      (model.upstream.endpoints || []).join(', ') || '-',
      formatModelLimits(model, '; '),
      formatModelCapabilities(model),
      formatModelCompatibility(model).join('; '),
    ].map(tsvCell).join('\t');
  });
  const text = ['Endpoint: ' + localEndpoint, headers.join('\t')].concat(rows).join('\n');
  try {
    await writeClipboard(text);
    byId('model-copy-status').textContent = 'Copied ' + selected.length + ' model' + (selected.length === 1 ? '' : 's');
  } catch {
    byId('model-copy-status').textContent = 'Copy failed';
  }
}

function tsvCell(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy failed');
}

function renderBehavior(data) {
  const routing = byId('behavior-routing');
  clearNode(routing);
  appendKv(routing, 'Rewrites', compactJson(data.modelRouting.rewrites));
  appendKv(routing, 'Auto-correct', data.modelRouting.autoCorrect.enabled ? 'enabled' : 'waiting for models');
  appendKv(routing, 'Compact routing', compactJson(data.modelRouting.compact));
  appendKv(routing, 'Family fallbacks', compactJson(data.modelRouting.familyFallbacks));
  appendKv(routing, 'Overload fallbacks', compactJson(data.modelRouting.overloadFallbacks));
  appendKv(routing, 'Messages strategies', data.strategies.messages.join(' -> '));

  const parameters = byId('behavior-parameters');
  clearNode(parameters);
  appendKv(parameters, 'Responses filters', compactJson(data.parameterHandling.responsesFilters));
  appendKv(parameters, 'Replace defaults', data.parameterHandling.responsesFiltersReplaceDefault ? 'yes' : 'no');
  appendKv(parameters, 'Output token floor', data.parameterHandling.responsesOutputTokenFloor);
  appendKv(parameters, 'Context management', compactJson(data.contextManagement));
  appendKv(parameters, 'Function apply_patch', data.toolCompatibility.functionApplyPatch ? 'enabled' : 'disabled');
  appendKv(parameters, 'Remote image URLs', data.toolCompatibility.remoteResponsesImageUrlsRejected ? 'rejected' : 'forwarded');

  const effectsBody = byId('effects-body');
  clearNode(effectsBody);
  (data.effects || []).slice().sort(function (left, right) {
    return right.count - left.count || left.category.localeCompare(right.category) || left.label.localeCompare(right.label);
  }).forEach(function (effect) {
    const row = createElement('tr');
    appendCell(row, effect.category);
    const effectCell = createElement('td');
    effectCell.appendChild(createElement('div', '', effect.label));
    effectCell.appendChild(createElement('div', 'muted mono', effect.id));
    row.appendChild(effectCell);
    appendCell(row, formatNumber(effect.count), 'mono');
    effectsBody.appendChild(row);
  });
}

function renderRequests(data) {
  const active = Array.isArray(data.active) ? data.active : [];
  const recent = Array.isArray(data.recent) ? data.recent : [];
  dashboardState.requests = active.concat(recent);
  const selectedRequestExists = dashboardState.requests.some(function (request) {
    return request.requestId === dashboardState.selectedRequestId;
  });
  if (!selectedRequestExists) {
    dashboardState.selectedRequestId = dashboardState.requests.length > 0
      ? dashboardState.requests[0].requestId
      : null;
  }
  byId('request-count').textContent = active.length + ' active / ' + recent.length + ' finished';
  const body = byId('requests-body');
  clearNode(body);
  dashboardState.requests.forEach(function (request) {
    const row = createElement('tr');
    row.tabIndex = 0;
    row.dataset.requestId = request.requestId;
    if (request.requestId === dashboardState.selectedRequestId) row.className = 'selected';
    const stateCell = createElement('td');
    stateCell.appendChild(makeBadge(request.state));
    row.appendChild(stateCell);
    appendCell(row, request.endpoint, 'mono');
    appendCell(row, request.effectiveModel || request.requestedModel || '-', 'mono');
    appendCell(row, request.selectedStrategy || '-', 'mono');
    appendCell(row, request.status === undefined ? '-' : request.status, 'mono');
    appendCell(row, formatDuration(request.durationMs), 'mono');
    appendCell(row, formatDate(request.startedAt));
    row.addEventListener('click', function () { selectRequest(request.requestId); });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRequest(request.requestId); }
    });
    body.appendChild(row);
  });

  renderRequestDetail();
}

function selectRequest(requestId) {
  dashboardState.selectedRequestId = requestId;
  document.querySelectorAll('#requests-body tr').forEach(function (row) {
    row.classList.toggle('selected', row.dataset.requestId === requestId);
  });
  renderRequestDetail();
}

function renderRequestDetail() {
  const request = dashboardState.requests.find(function (entry) {
    return entry.requestId === dashboardState.selectedRequestId;
  });
  byId('request-detail').textContent = request ? JSON.stringify(request, null, 2) : 'No request selected';
}

async function loadOverview() {
  renderOverview(await fetchJson('/dashboard/api/overview'));
}

async function loadModels() {
  renderModels(await fetchJson('/dashboard/api/models'));
}

async function loadBehavior() {
  renderBehavior(await fetchJson('/dashboard/api/behavior'));
}

async function loadRequests() {
  renderRequests(await fetchJson('/dashboard/api/requests'));
}

async function settleLoads(loads) {
  const results = await Promise.allSettled(loads.map(function (entry) { return entry.load(); }));
  results.forEach(function (result, index) {
    const scope = loads[index].scope;
    if (result.status === 'rejected') dashboardState.errors.set(scope, result.reason);
    else dashboardState.errors.delete(scope);
  });
  renderErrors();
}

function queuePendingRefresh(kind) {
  if (kind === 'all' || dashboardState.pendingRefresh !== 'all') {
    dashboardState.pendingRefresh = kind;
  }
}

function replayPendingRefresh() {
  const pending = dashboardState.pendingRefresh;
  dashboardState.pendingRefresh = null;
  if (pending === 'all') refreshAll();
  if (pending === 'selected') refreshSelectedView(dashboardState.activeView);
}

async function refreshAll() {
  if (dashboardState.refreshing) {
    queuePendingRefresh('all');
    return;
  }
  dashboardState.refreshing = true;
  byId('refresh-button').disabled = true;
  try {
    await settleLoads([
      { scope: 'overview', load: loadOverview },
      { scope: 'models', load: loadModels },
      { scope: 'behavior', load: loadBehavior },
      { scope: 'requests', load: loadRequests },
    ]);
  } finally {
    dashboardState.refreshing = false;
    byId('refresh-button').disabled = false;
    replayPendingRefresh();
  }
}

async function refreshLiveViews() {
  if (!byId('live-refresh').checked || document.hidden || dashboardState.refreshing) return;
  dashboardState.refreshing = true;
  try {
    const loads = [{ scope: 'overview', load: loadOverview }];
    if (dashboardState.activeView === 'requests') loads.push({ scope: 'requests', load: loadRequests });
    if (dashboardState.activeView === 'behavior') loads.push({ scope: 'behavior', load: loadBehavior });
    await settleLoads(loads);
  } finally {
    dashboardState.refreshing = false;
    replayPendingRefresh();
  }
}

async function refreshSelectedView(view) {
  if (dashboardState.refreshing) {
    queuePendingRefresh('selected');
    return;
  }
  dashboardState.refreshing = true;
  try {
    const loads = [];
    if (view === 'overview') loads.push({ scope: 'overview', load: loadOverview });
    if (view === 'models') loads.push({ scope: 'models', load: loadModels });
    if (view === 'behavior') loads.push({ scope: 'behavior', load: loadBehavior });
    if (view === 'requests') loads.push({ scope: 'requests', load: loadRequests });
    if (loads.length > 0) await settleLoads(loads);
  } finally {
    dashboardState.refreshing = false;
    replayPendingRefresh();
  }
}

/* dashboard-state-test-boundary */
document.querySelectorAll('.tab').forEach(function (button) {
  button.addEventListener('click', function () {
    const target = button.dataset.tab;
    dashboardState.activeView = target;
    document.querySelectorAll('.tab').forEach(function (tab) { tab.classList.toggle('active', tab === button); });
    document.querySelectorAll('.view').forEach(function (view) {
      const active = view.dataset.view === target;
      view.hidden = !active;
      view.classList.toggle('active', active);
    });
    refreshSelectedView(target);
  });
});

byId('refresh-button').addEventListener('click', refreshAll);
byId('theme-toggle').addEventListener('change', function (event) {
  storeTheme(event.currentTarget.checked ? 'dark' : 'light');
});
byId('model-filter').addEventListener('input', renderFilteredModels);
byId('model-group-vendor').addEventListener('change', renderFilteredModels);
byId('model-sort').addEventListener('change', renderFilteredModels);
byId('copy-models').addEventListener('click', copySelectedModels);
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) refreshLiveViews();
});
darkThemeQuery.addEventListener('change', function () {
  if (readStoredTheme() === null) applyTheme(null);
});

applyTheme(readStoredTheme());
refreshAll();
setInterval(refreshLiveViews, 2000);`

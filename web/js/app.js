// App shell: navigation, chart panels, toolbar, drawing tools, watchlist, analysis panel.
import { h, clear, store, bus, toast, modal, menu, uid, fmtPrice, fmtPct, fmtNum, fmtStamp, fmtTime, downloadText, parseWorkspace } from './util.js';
import { TFS, TF, tfLabel, isIntraday, getBars, getBatch, searchSymbols, alignToBase, tfsAtOrAbove, backend, availableTfs } from './data.js';
import { IND, calcIndicator, defaultParams, indLabel, sma, rsi } from './ta.js';
import { autoTrendlines, autoLevels, autoFib, detectCandles, chartPatterns, openGaps } from './auto.js';
import { Chart } from './chart.js';
import { api } from './api.js';
import { evalRuleset, requiredTfs, describeCond, savedRulesets } from './conditions.js';
import * as alerts from './alerts.js';
import { loadCustomIndicators } from './studio.js';
import { loadModels } from './lab.js';

const $ = (id) => document.getElementById(id);
const mkInd = (id, params = {}) => ({ uid: uid(), id, params, tf: null, hidden: false, colors: {} });
const defaultPanel = (symbol = 'SPY', tf = '1d') => ({
  symbol, tf, type: 'candles', log: false, volume: true, vp: false, adj: false,
  inds: [mkInd('sma', { len: 50 }), mkInd('sma', { len: 200 }), mkInd('rsi')],
  auto: { trendlines: true, levels: true, fib: false, candles: true, patterns: true, gaps: false },
});
const AUTO_OPTS = [['trendlines', 'Trendlines'], ['levels', 'Support / resistance zones'], ['fib', 'Fibonacci retracement'], ['candles', 'Candlestick patterns'], ['patterns', 'Chart patterns'], ['gaps', 'Open gaps']];
const TYPES = [['candles', 'Candles'], ['hollow', 'Hollow candles'], ['ha', 'Heikin-Ashi'], ['bars', 'OHLC bars'], ['line', 'Line'], ['area', 'Area']];

const state = {
  view: 'chart',
  layout: store.get('layout', 1),
  cfgs: store.get('panels', null) || [defaultPanel()],
  active: 0,
  tool: 'cursor',
};
let panels = [];
const save = () => { store.set('panels', state.cfgs); store.set('layout', state.layout); };
const loadDrawings = (sym) => store.get('draw.' + sym, []);
const saveDrawings = (sym, list) => store.set('draw.' + sym, list.map((d) => ({ id: d.id, type: d.type, pts: d.pts, text: d.text, color: d.color })));

// ───────────────────────── chart panel ─────────────────────────
class Panel {
  constructor(cfg, idx) {
    this.cfg = cfg; this.idx = idx; this.token = 0; this.bars = null; this.autoRes = {};
    this.el = h('div');
    this.chart = new Chart(this.el, {
      onFocus: () => setActive(idx),
      onLegend: (act, id) => this.legendAction(act, id),
      onDrawings: (list) => { saveDrawings(this.cfg.symbol, list); for (const p of panels) if (p !== this && p.cfg.symbol === this.cfg.symbol) p.chart.setDrawings(loadDrawings(p.cfg.symbol)); },
      onContext: (c) => chartMenu(this, c),
      onTool: (t) => setTool(t),
      onText: (d) => editText(this, d),
      onHover: (t) => { for (const p of panels) if (p !== this) p.chart.setGhost(t); },
    });
  }
  async load({ keepView = false } = {}) {
    const { symbol, tf } = this.cfg, token = ++this.token;
    if (!keepView) { this.chart.setBars(null); this.chart.setMessage(`Loading ${symbol}…`); }
    try {
      const bars = await getBars(symbol, tf, { maxAge: keepView ? (this.bars && this.bars.live ? 3000 : 10000) : 15000, adjusted: !!this.cfg.adj });
      if (token !== this.token) return;
      const fresh = this.bars !== bars;
      this.bars = bars;
      this.chart.setOptions({ type: this.cfg.type, log: this.cfg.log, volume: this.cfg.volume, vp: this.cfg.vp });
      if (fresh || !keepView) this.chart.setBars(bars, { keepView });
      if (!keepView) { this.chart.setDrawings(loadDrawings(symbol)); this.chart.setTrades(this.tradesFor === symbol + '|' + tf ? this.trades : []); }
      this.chart.setAlertLines(alerts.priceLevels(symbol));
      if (fresh || !keepView) await this.compute();
      if (this.idx === state.active) updateStatus();
    } catch (e) {
      if (token !== this.token) return;
      if (e.code === 'tf' && tf !== '1d') {
        // the shared page keeps short timeframes for its core symbols only: show what there is
        toast(`${e.message}. Showing daily.`);
        this.cfg.tf = '1d'; save(); if (this.idx === state.active) { syncToolbar(); writeHash(); }
        return this.load();
      }
      if (!keepView) { this.bars = null; this.chart.setBars(null); this.chart.setMessage(`${symbol}: ${e.message}`); }
    }
    if (this.idx === state.active) renderAnalysis();
  }
  async compute() {
    const bars = this.bars; if (!bars) return;
    const list = [];
    for (const c of this.cfg.inds) {
      const def = IND.get(c.id); if (!def) continue;
      const params = { ...defaultParams(def), ...c.params };
      const htf = c.tf && TF[c.tf] && TF[c.tf].rank > TF[bars.tf].rank ? c.tf : null;
      let out;
      try {
        if (htf) {
          const hb = await getBars(bars.symbol, htf, { adjusted: !!this.cfg.adj }), raw = calcIndicator(c.id, hb, params);
          out = raw.__error ? raw : Object.fromEntries(def.outputs.map((o) => [o.k, alignToBase(bars, hb, raw[o.k])]));
        } else out = calcIndicator(c.id, bars, params);
      } catch (e) { out = { __error: e.message }; }
      const colors = {}; for (const o of def.outputs) colors[o.k] = (c.colors && c.colors[o.k]) || o.color;
      const label = c.id === 'avwap' && params.anchor ? `AVWAP from ${fmtStamp(params.anchor, isIntraday(bars.tf))}` : indLabel(def, params);
      list.push({ uid: c.uid, def, params, tf: htf, out, label, hidden: c.hidden, colors });
    }
    if (this.bars !== bars) return;
    this.chart.setIndicators(list);
    this.computeAuto();
  }
  computeAuto() {
    const b = this.bars, n = b.t.length, a = this.cfg.auto;
    const r = this.autoRes = n < 40 ? {} : {
      trendlines: autoTrendlines(b), levels: autoLevels(b), fib: autoFib(b),
      candles: detectCandles(b, Math.max(0, n - 400)), patterns: chartPatterns(b), gaps: openGaps(b),
    };
    const shown = {}; for (const k of Object.keys(a)) if (a[k] && r[k]) shown[k] = r[k];
    this.chart.setAuto(shown);
  }
  legendAction(act, id) {
    const c = this.cfg.inds.find((x) => x.uid === id); if (!c) return;
    if (act === 'remove') { this.cfg.inds = this.cfg.inds.filter((x) => x !== c); save(); this.compute(); }
    else if (act === 'toggle') { c.hidden = !c.hidden; save(); this.compute(); }
    else indicatorSettings(this, c);
  }
}

// What the active chart is actually showing: when its newest bar is from, and how far behind the
// feed's own clock runs. The provider's "last trade" time alone is not trusted: for futures it reads
// ten minutes ago even when no bar of the session has been published yet.
function wallNow(tz) { try { return Date.parse(new Date().toLocaleString('en-US', { timeZone: tz || 'America/New_York' }) + ' UTC') / 1000; } catch { return Date.now() / 1000; } }
const span = (s) => (s < 90 ? `${Math.max(0, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);
function feedStatus(b, nowUtc = Date.now() / 1000, nowWall = wallNow(b.meta.tz)) {
  const n = b.t.length, intr = isIntraday(b.tf), lag = b.meta.asof ? nowUtc - b.meta.asof : NaN, barAge = nowWall - b.t[n - 1];
  const parts = [b.symbol];
  if (b.stale) parts.push('provider not answering');
  if (b.live && b.live.kind === 'ext') {
    // a stock outside regular hours: the newest value is a real extended-hours print or an estimate
    const lv = b.live, d = new Date(nowWall * 1000), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), wk = d.getUTCDay() % 6 !== 0;
    const phase = !wk ? 'weekend' : mins >= 240 && mins < 570 ? 'pre-market' : mins >= 960 && mins < 1200 ? 'after hours' : 'overnight';
    const chg = lv.base ? ` ${fmtPrice(lv.price)} (${fmtPct((lv.price / lv.base - 1) * 100)} vs close)` : '';
    if (lv.isEst) { parts.push(`${phase} estimate via ${lv.src.split(':')[1]} perp (${span(Math.max(0, nowUtc - lv.asof))} ago)${chg}`); parts.push(`last exchange print ${span(lv.anchorAge)} ago`); }
    else { parts.push(`${phase} · last print ${span(lv.anchorAge)} ago${chg}`); }
    return { text: parts.join(' · '), late: false, live: true };
  }
  if (b.live) {
    // the newest bars are projected from a live market; say so, and say how far the real data reaches
    parts.push(`live estimate via ${b.live.src.split(':')[1]} (${span(Math.max(0, nowUtc - b.live.asof))} ago)`);
    parts.push(`exchange data to ${fmtTime(b.live.anchor)}`);
    if (b.live.anchorAge > 1800) parts.push(`rough: last exchange print ${span(b.live.anchorAge)} ago`);
    return { text: parts.join(' · '), late: false, live: true };
  }
  if (!b.meta.open) parts.push('market closed');
  if (b.meta.snapshot) parts.push(`shared snapshot ${span(Math.max(0, nowUtc - b.meta.snapshot))} old`);
  parts.push(intr ? `latest bar ${fmtStamp(b.t[n - 1], true).replace(/^(\w+ \d+), \d+ /, '$1 ')} (${span(barAge)} ago)` : `latest bar ${fmtStamp(b.t[n - 1], false)}`);
  if (b.meta.open && lag > 120) parts.push(`feed runs ${span(lag)} behind`);
  // open market, yet the newest bar is far older than the feed's delay explains
  const late = !!b.meta.open && intr && barAge > (lag > 0 ? lag : 0) + 3 * TF[b.tf].sec + 120;
  return { text: parts.join(' · '), late, live: false };
}
function updateStatus() {
  const el = $('data-status'), p = cur(), b = p && p.bars;
  if (!b) { el.textContent = ''; el.classList.remove('late'); return; }
  const st = feedStatus(b);
  el.textContent = st.text; el.classList.toggle('late', st.late); el.classList.toggle('live', st.live);
}

function buildPanels() {
  const grid = $('chart-grid'), count = state.layout;
  for (const p of panels) { p.token++; p.chart.destroy(); }
  clear(grid); grid.className = 'chart-grid l' + count;
  while (state.cfgs.length < count) { const src = state.cfgs[0]; const c = JSON.parse(JSON.stringify(src)); c.inds.forEach((i) => (i.uid = uid())); c.tf = ['1d', '1w', '1h', '15m'][state.cfgs.length] || '1d'; state.cfgs.push(c); }
  save(); // a panel added for a wider layout is part of the saved workspace from the start
  panels = state.cfgs.slice(0, count).map((cfg, i) => new Panel(cfg, i));
  for (const p of panels) grid.append(p.el);
  if (state.active >= count) state.active = 0;
  setActive(state.active, true);
  for (const p of panels) p.load();
}
const cur = () => panels[state.active];
function setActive(i, force) {
  if (i === state.active && !force) return;
  state.active = i;
  panels.forEach((p, k) => p.el.classList.toggle('active', k === i));
  syncToolbar(); renderWatchlist(); renderAnalysis(); updateStatus(); writeHash();
  bus.emit('symbol', cur().cfg.symbol);
}
function setSymbol(sym, tf) {
  const p = cur(); sym = sym.toUpperCase().trim(); if (!sym) return;
  p.cfg.symbol = sym; if (tf) p.cfg.tf = tf;
  save(); syncToolbar(); renderWatchlist(); writeHash(); p.load(); bus.emit('symbol', sym);
}
function setTool(t) { state.tool = t; for (const p of panels) p.chart.setTool(t); document.querySelectorAll('#draw-tools button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)); }

// ───────────────────────── toolbar ─────────────────────────
function buildToolbar() {
  const bar = $('chart-toolbar'); clear(bar);
  const tfGrp = h('div', { class: 'grp', id: 'tb-tf' }, TFS.map((t) => h('button', { 'data-tf': t.id, title: t.id, onclick: () => { cur().cfg.tf = t.id; save(); syncToolbar(); writeHash(); cur().load(); } }, t.label)));
  const typeSel = h('select', { id: 'tb-type', title: 'Chart type', onchange: (e) => { cur().cfg.type = e.target.value; save(); cur().chart.setOptions({ type: e.target.value }); } }, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const tog = (id, label, title, key) => h('button', { id, title, onclick: () => { const c = cur().cfg; c[key] = !c[key]; save(); cur().chart.setOptions({ [key]: c[key] }); syncToolbar(); } }, label);
  bar.append(tfGrp,
    h('div', { class: 'grp' }, typeSel),
    h('div', { class: 'grp' },
      h('button', { onclick: indicatorPicker, title: 'Add an indicator' }, 'ƒ Indicators'),
      h('button', { id: 'tb-auto', onclick: autoMenu, title: 'Automated analysis layers' }, 'Auto analysis ▾')),
    h('div', { class: 'grp' }, tog('tb-vol', 'Vol', 'Volume bars', 'volume'), tog('tb-vp', 'VP', 'Volume by price for the visible range', 'vp'), tog('tb-log', 'Log', 'Logarithmic price scale', 'log'),
      h('button', { id: 'tb-adj', title: 'Dividend-adjusted prices (total return) on daily and longer timeframes', onclick: () => { const c = cur().cfg; c.adj = !c.adj; save(); syncToolbar(); cur().load(); } }, 'Adj')),
    h('div', { class: 'grp' },
      h('select', { id: 'tb-layout', title: 'Layout', onchange: (e) => { state.layout = Number(e.target.value); save(); buildPanels(); } }, [[1, '1 chart'], [2, '2 charts'], [4, '4 charts']].map(([v, l]) => h('option', { value: v, selected: state.layout === v }, l)))),
    h('div', { class: 'grp' },
      h('button', { title: 'Reset zoom (double-click the chart)', onclick: () => cur().chart.resetView() }, 'Fit'),
      h('button', { title: 'Remove backtest trade markers', id: 'tb-trades', onclick: () => { cur().trades = []; cur().tradesFor = null; cur().chart.setTrades([]); syncToolbar(); } }, 'Clear trades')));
}
// which stored timeframes a symbol has on the shared page, in words ('daily, hourly and five-minute')
const keptWords = (ok) => {
  const w = [['1d', 'daily'], ['1h', 'hourly'], ['5m', 'five-minute'], ['1m', 'one-minute']].filter(([t]) => ok.has(t)).map(([, x]) => x);
  return w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}` : w[0] || 'no';
};
function syncToolbar() {
  const c = cur() && cur().cfg; if (!c) return;
  document.querySelectorAll('#tb-tf button').forEach((b) => b.classList.toggle('on', b.dataset.tf === c.tf));
  $('tb-type').value = c.type;
  $('tb-vol').classList.toggle('on', c.volume); $('tb-vp').classList.toggle('on', c.vp); $('tb-log').classList.toggle('on', c.log); $('tb-adj').classList.toggle('on', !!c.adj);
  $('tb-trades').hidden = !(cur().trades && cur().trades.length);
  $('symbol-input').placeholder = `${c.symbol} — type to search`;
  // dim the timeframes this symbol has no history for (the shared page keeps short ones for core symbols only)
  const sym = c.symbol;
  availableTfs(sym).then((ok) => { if (cur() && cur().cfg.symbol === sym) document.querySelectorAll('#tb-tf button').forEach((b) => { const na = !!ok && !ok.has(b.dataset.tf); b.classList.toggle('na', na); b.title = na ? `${sym} has ${keptWords(ok)} history on the shared page` : b.dataset.tf; }); }).catch(() => {});
}
function autoMenu(e) {
  const r = e.currentTarget.getBoundingClientRect(), c = cur().cfg;
  const el = menu(r.left, r.bottom + 4, []);
  for (const [k, label] of AUTO_OPTS) el.append(h('label', null, h('input', { type: 'checkbox', checked: !!c.auto[k], onchange: (ev) => { c.auto[k] = ev.target.checked; save(); cur().computeAuto(); renderAnalysis(); } }), label));
}

const ICON = {
  cursor: '<path d="M5 3l10 6.2-4.6 1.1L8.2 15z"/>',
  trend: '<path d="M4 15.5L16 4.5"/><circle cx="4" cy="15.5" r="1.6"/><circle cx="16" cy="4.5" r="1.6"/>',
  ray: '<path d="M4 14l13-7"/><circle cx="4" cy="14" r="1.6"/><path d="M13.5 6.5l3.5.5-1.6 3.1"/>',
  hline: '<path d="M2.5 10h15"/><circle cx="10" cy="10" r="1.6"/>',
  rect: '<rect x="3.5" y="5.5" width="13" height="9" rx="1"/>',
  fib: '<path d="M3 4.5h14M3 8h14M3 12h14M3 15.5h14"/>',
  text: '<path d="M5 5h10M10 5v10.5"/>',
  measure: '<path d="M3.5 13.5l10-10 3 3-10 10z"/><path d="M6.5 10.5l1.5 1.5M9 8l1.5 1.5M11.5 5.5L13 7"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/>',
};
function buildDrawTools() {
  const el = $('draw-tools'); clear(el);
  const tools = [['cursor', 'Select / pan'], ['trend', 'Trendline'], ['ray', 'Ray'], ['hline', 'Horizontal line'], ['rect', 'Rectangle'], ['fib', 'Fibonacci retracement'], ['text', 'Note'], ['measure', 'Measure']];
  for (const [t, title] of tools) el.append(h('button', { 'data-tool': t, title, class: t === 'cursor' ? 'on' : '', onclick: () => setTool(t), html: `<svg viewBox="0 0 20 20">${ICON[t]}</svg>` }));
  el.append(h('div', { class: 'sep' }),
    h('button', { title: 'Delete selected drawing (Delete key)', onclick: () => { if (!cur().chart.deleteSelected()) toast('Select a drawing first.'); }, html: `<svg viewBox="0 0 20 20">${ICON.trash}</svg>` }));
}

function chartMenu(p, c) {
  const sym = p.cfg.symbol, d = c.drawing, lineLike = d && (d.type === 'trend' || d.type === 'ray' || d.type === 'hline');
  menu(c.x, c.y, [
    { label: `Alert when price crosses ${fmtPrice(c.price)}`, fn: () => { alerts.addPriceAlert(sym, c.price); toast(`Alert set on ${sym} at ${fmtPrice(c.price)}`, 'ok'); } },
    lineLike ? { label: 'Alert when price crosses this line', fn: () => { alerts.addLineAlert(sym, p.cfg.tf, d); toast(`Line alert set on ${sym}`, 'ok'); } } : null,
    '-',
    { label: `Anchor a VWAP at ${fmtStamp(c.barT, isIntraday(p.cfg.tf))}`, fn: () => { p.cfg.inds.push(mkInd('avwap', { anchor: c.barT })); save(); p.compute(); } },
    { label: 'Add horizontal line here', fn: () => p.chart.addDrawing({ type: 'hline', pts: [{ t: c.t, p: c.price }] }) },
    d ? { label: 'Delete drawing', fn: () => p.chart.deleteSelected() } : null,
    loadDrawings(sym).length ? { label: `Delete all drawings on ${sym}`, fn: () => { saveDrawings(sym, []); for (const q of panels) if (q.cfg.symbol === sym) q.chart.setDrawings([]); } } : null,
    '-',
    { label: 'Reset zoom', fn: () => p.chart.resetView() },
  ]);
}
function editText(p, d) {
  const inp = h('input', { type: 'text', value: d.text || '', style: { width: '100%' } });
  const done = () => { d.text = inp.value.trim() || 'Note'; p.chart.changed(); m.close(); };
  const m = modal('Note', h('div', null, inp, h('div', { class: 'modal-foot' }, h('button', { class: 'primary', onclick: done }, 'Save'))));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

// ───────────────────────── indicators ─────────────────────────
function indicatorPicker() {
  const list = h('div', { class: 'ind-list' });
  const q = h('input', { type: 'text', placeholder: 'Search indicators…', style: { width: '100%', marginBottom: '8px' }, oninput: () => draw() });
  const draw = () => {
    clear(list);
    const term = q.value.trim().toLowerCase(), groups = {};
    for (const def of IND.values()) { if (term && !(def.name + ' ' + (def.short || '')).toLowerCase().includes(term)) continue; (groups[def.group || 'Other'] = groups[def.group || 'Other'] || []).push(def); }
    for (const [g, defs] of Object.entries(groups)) {
      list.append(h('h4', null, g));
      for (const def of defs) list.append(h('button', { onclick: () => { cur().cfg.inds.push(mkInd(def.id)); save(); cur().compute(); m.close(); } }, def.name, h('small', null, def.overlay ? 'overlay' : 'pane')));
    }
    if (!list.children.length) list.append(h('div', { class: 'hint' }, 'No match.'));
  };
  draw();
  const m = modal('Add indicator', h('div', null, q, list, h('p', { class: 'hint', style: { marginTop: '10px' } }, 'After adding, hover its name on the chart for settings — including a higher timeframe to compute it on. Build your own in Indicator Studio.')), { wide: true });
  setTimeout(() => q.focus(), 0);
}
function indicatorSettings(p, c) {
  const def = IND.get(c.id), params = { ...defaultParams(def), ...c.params }, colors = { ...c.colors };
  let tf = c.tf || '';
  const form = h('div', { class: 'form' });
  for (const q of def.params) {
    if (q.hidden) continue;
    let inp;
    if (q.type === 'source' || q.type === 'select') {
      const opts = q.type === 'source' ? ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'] : q.options;
      inp = h('select', { onchange: (e) => (params[q.k] = e.target.value) }, opts.map((v) => h('option', { value: v, selected: params[q.k] === v }, v)));
    } else inp = h('input', { type: 'number', step: q.step || 1, min: q.min, value: params[q.k], onchange: (e) => (params[q.k] = Number(e.target.value)) });
    form.append(h('label', null, q.label), inp);
  }
  form.append(h('label', { title: 'Compute on a higher timeframe and overlay it here. Values step when the higher bar closes.' }, 'Timeframe'),
    h('select', { onchange: (e) => (tf = e.target.value) }, h('option', { value: '' }, 'Same as chart'), tfsAtOrAbove(p.cfg.tf).slice(1).map((t) => h('option', { value: t.id, selected: tf === t.id }, t.label))));
  for (const o of def.outputs) { if (o.hidden) continue; form.append(h('label', null, o.label + ' color'), h('input', { type: 'color', value: colors[o.k] || o.color || '#888888', onchange: (e) => (colors[o.k] = e.target.value) })); }
  const m = modal(def.name, h('div', null, form, h('div', { class: 'modal-foot' },
    h('button', { onclick: () => { p.cfg.inds = p.cfg.inds.filter((x) => x !== c); save(); p.compute(); m.close(); } }, 'Remove'),
    h('button', { class: 'primary', onclick: () => { c.params = params; c.tf = tf || null; c.colors = colors; save(); p.compute(); m.close(); } }, 'Apply'))));
}

// ───────────────────────── watchlist ─────────────────────────
const wl = { lists: store.get('watchlists', { Default: ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GLD', 'TLT', 'BTC-USD'] }), cur: store.get('wl.cur', 'Default'), quotes: new Map() };
if (!wl.lists[wl.cur]) wl.cur = Object.keys(wl.lists)[0];
const saveWl = () => { store.set('watchlists', wl.lists); store.set('wl.cur', wl.cur); };
function spark(vals, up) {
  if (!vals || vals.length < 2) return '';
  let lo = Infinity, hi = -Infinity; for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * 60).toFixed(1)},${(16 - ((v - lo) / (hi - lo || 1)) * 14).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 60 18" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.3"/></svg>`;
}
function renderWatchlist() {
  const el = $('watchlist'), syms = wl.lists[wl.cur] || [], active = cur() ? cur().cfg.symbol : '';
  clear(el);
  el.append(h('div', { class: 'side-head' }, h('h3', null, 'Watchlist'),
    h('select', { onchange: (e) => { wl.cur = e.target.value; saveWl(); renderWatchlist(); refreshQuotes(); } }, Object.keys(wl.lists).map((k) => h('option', { value: k, selected: k === wl.cur }, k))),
    h('button', { class: 'icon-btn', title: `Add ${active} to this list`, onclick: () => { if (!syms.includes(active)) { syms.push(active); saveWl(); renderWatchlist(); refreshQuotes(); } } }, '+'),
    h('button', { class: 'icon-btn', title: 'List options', onclick: async (e) => {
      const r = e.currentTarget.getBoundingClientRect(), { ask } = await import('./conditions.js');
      menu(r.left - 120, r.bottom + 4, [
        { label: 'New list…', fn: async () => { const name = await ask('New watchlist', '', 'List name'); if (name && !wl.lists[name]) { wl.lists[name] = []; wl.cur = name; saveWl(); renderWatchlist(); } } },
        Object.keys(wl.lists).length > 1 ? { label: `Delete “${wl.cur}”`, fn: () => { delete wl.lists[wl.cur]; wl.cur = Object.keys(wl.lists)[0]; saveWl(); renderWatchlist(); refreshQuotes(); } } : null,
      ]);
    } }, '⋯')));
  const body = h('div', { class: 'side-body' });
  for (const s of syms) {
    const q = wl.quotes.get(s), up = q ? q.chg >= 0 : true;
    body.append(h('div', { class: 'wl-row' + (s === active ? ' cur' : ''), onclick: () => setSymbol(s) },
      h('span', { class: 'sym' }, s), h('span', { html: q ? spark(q.spark, q.spark[q.spark.length - 1] >= q.spark[0]) : '' }),
      h('span', { class: 'px' + (q && q.note ? (q.est ? ' est' : ' ext') : ''), title: q && q.note ? q.note : null }, q ? fmtPrice(q.last) : '…'), h('span', { class: 'ch ' + (up ? 'up' : 'dn') }, q ? fmtPct(q.chg) : ''),
      h('button', { class: 'x', title: 'Remove', onclick: (e) => { e.stopPropagation(); wl.lists[wl.cur] = syms.filter((x) => x !== s); saveWl(); renderWatchlist(); } }, '×')));
  }
  if (!syms.length) body.append(h('div', { class: 'hint', style: { padding: '8px 10px' } }, 'Empty list. Open a symbol and press +.'));
  el.append(body);
}
async function refreshQuotes() {
  const syms = wl.lists[wl.cur] || []; if (!syms.length) return;
  try {
    const { bars } = await getBatch(syms, '1d', { limit: 30, maxAge: 55000, live: true });
    for (const [s, b] of bars) {
      const n = b.c.length; if (n < 2) continue;
      const lv = b.live, ext = lv && lv.kind === 'ext' && lv.price;
      // outside regular hours a stock shows its latest extended print or estimate, against the close
      wl.quotes.set(s, ext ? { last: lv.price, chg: (lv.price / b.c[n - 1] - 1) * 100, spark: [...b.c, lv.price], note: lv.isEst ? `Estimate via ${lv.src.split(':')[1]} perp; change is against the last close` : 'Latest extended-hours print; change is against the last close', est: !!lv.isEst }
        : { last: b.c[n - 1], chg: (b.c[n - 1] / b.c[n - 2] - 1) * 100, spark: b.c, note: lv ? `Live estimate via ${lv.src.split(':')[1]}` : '', est: !!lv });
    }
    renderWatchlist();
  } catch { /* keep the previous quotes */ }
}

// ───────────────────────── analysis panel ─────────────────────────
let anToken = 0, checklistName = store.get('checklist', '');
async function renderAnalysis() {
  const el = $('analysis'), p = cur(); if (!p) return;
  const token = ++anToken, b = p.bars;
  const body = h('div', { class: 'side-body an' });
  clear(el); el.append(h('div', { class: 'side-head' }, h('h3', null, `Analysis · ${p.cfg.symbol}`)), body);
  if (!b) { body.append(h('div', { class: 'hint' }, 'No data loaded.')); return; }
  // trend by timeframe
  const tfs = [...new Set([p.cfg.tf, '1d', '1w'])].sort((x, y) => TF[x].rank - TF[y].rank);
  const tbl = h('table', null, h('tr', null, h('th', null, 'Trend'), h('th', null, 'vs 20'), h('th', null, 'vs 50'), h('th', null, 'vs 200'), h('th', null, 'RSI')));
  body.append(h('h4', null, 'Multi-timeframe'), tbl);
  const byTf = new Map([[b.tf, b]]);
  for (const tf of tfs) {
    let bb; try { bb = tf === b.tf ? b : await getBars(p.cfg.symbol, tf, { adjusted: !!p.cfg.adj }); } catch { continue; }
    if (token !== anToken) return;
    byTf.set(tf, bb);
    const n = bb.t.length, c = bb.c[n - 1], cell = (len) => { const v = sma(bb.c, len)[n - 1]; if (v !== v) return h('td', { class: 'muted' }, '–'); const d = (c / v - 1) * 100; return h('td', { class: d >= 0 ? 'up' : 'dn', title: `SMA ${len} = ${fmtPrice(v)}` }, (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(1) + '%'); };
    tbl.append(h('tr', null, h('td', null, tfLabel(tf)), cell(20), cell(50), cell(200), h('td', null, fmtNum(rsi(bb.c, 14)[n - 1], 0))));
  }
  // automated findings
  const r = p.autoRes || {}, n = b.t.length, items = [];
  for (const ln of r.trendlines || []) items.push(['k ' + (ln.kind === 'sup' ? 'up' : 'dn'), `${ln.slope >= 0 ? 'Rising' : 'Falling'} ${ln.kind === 'sup' ? 'support' : 'resistance'} line at ${fmtPrice(ln.valueAt(n - 1))}`, `${ln.touches.length} touches${ln.broken ? ' · broken' : ''}`]);
  for (const z of r.levels || []) items.push(['k ' + (z.kind === 'sup' ? 'up' : 'dn'), `${z.kind === 'sup' ? 'Support' : 'Resistance'} zone ${fmtPrice(z.price)}`, `${z.touches} touches · ${fmtPct((z.price / b.c[n - 1] - 1) * 100, 1)}`]);
  for (const pt of r.patterns || []) items.push(['k ac', pt.name, pt.confirmed ? 'confirmed' : 'forming']);
  for (const c of (r.candles || []).filter((c) => c.i >= n - 5)) items.push(['k ' + (c.bias > 0 ? 'up' : c.bias < 0 ? 'dn' : ''), c.name, n - 1 - c.i === 0 ? 'latest bar' : `${n - 1 - c.i} bars ago`]);
  if (r.fib) { const near = r.fib.levels.filter((l) => l.r > 0 && l.r < 1).sort((x, y) => Math.abs(x.p - b.c[n - 1]) - Math.abs(y.p - b.c[n - 1]))[0]; if (near) items.push(['k ac', `Nearest Fibonacci ${(near.r * 100).toFixed(1)}% at ${fmtPrice(near.p)}`, `${r.fib.up ? 'up' : 'down'}swing ${fmtPrice(r.fib.from.p)} → ${fmtPrice(r.fib.to.p)}`]); }
  for (const g of r.gaps || []) items.push(['k ac', `Open gap ${fmtPrice(g.bottom)} – ${fmtPrice(g.top)}`, fmtStamp(g.t, isIntraday(b.tf))]);
  body.append(h('h4', null, `Detected on ${tfLabel(b.tf)}`));
  if (!items.length) body.append(h('div', { class: 'hint' }, 'Nothing notable detected.'));
  for (const [k, t, s] of items) body.append(h('div', { class: 'item' }, h('span', { class: k }), h('span', { class: 't' }, t), h('small', null, s)));
  // checklist from a saved rule set
  const saved = savedRulesets(), names = Object.keys(saved);
  body.append(h('h4', null, 'Checklist'));
  if (!names.length) { body.append(h('div', { class: 'hint' }, 'Save a rule set in the Scanner or Strategy Tester to check it against any chart here.')); return; }
  if (!saved[checklistName]) checklistName = names[0];
  body.append(h('select', { style: { width: '100%', marginBottom: '6px' }, onchange: (e) => { checklistName = e.target.value; store.set('checklist', checklistName); renderAnalysis(); } }, names.map((k) => h('option', { value: k, selected: k === checklistName }, k))));
  const rs = saved[checklistName];
  for (const tf of requiredTfs(rs, b.tf)) if (!byTf.has(tf)) { try { byTf.set(tf, await getBars(p.cfg.symbol, tf, { adjusted: !!p.cfg.adj })); } catch { /* condition reads false */ } }
  if (token !== anToken) return;
  const { per, mask } = evalRuleset(rs, b, byTf);
  rs.conds.forEach((c, k) => { const okk = per[k][n - 1]; body.append(h('div', { class: 'check' }, h('b', { class: okk ? 'up' : 'dn' }, okk ? '✓' : '✗'), h('span', null, describeCond(c, b.tf)))); });
  body.append(h('div', { class: 'check' }, h('b', null, ''), h('span', { class: mask[n - 1] ? 'up' : 'muted' }, mask[n - 1] ? 'All conditions met on the latest bar' : 'Not met on the latest bar')));
}

// ───────────────────────── search ─────────────────────────
function initSearch() {
  const inp = $('symbol-input'), box = $('search-results');
  let items = [], sel = -1, timer = null, seq = 0;
  const hide = () => { box.hidden = true; items = []; sel = -1; };
  const pick = (s) => { hide(); inp.value = ''; inp.blur(); setSymbol(s); };
  const draw = () => { clear(box); items.forEach((it, i) => box.append(h('button', { class: i === sel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pick(it.symbol); } }, h('b', null, it.symbol), h('span', { class: 'nm' }, it.name), h('span', { class: 'ex' }, `${it.type} · ${it.exch}`)))); box.hidden = !items.length; };
  inp.addEventListener('input', () => {
    clearTimeout(timer); const q = inp.value.trim(); if (!q) return hide();
    timer = setTimeout(async () => { const my = ++seq; try { const r = await searchSymbols(q); if (my === seq && inp.value.trim()) { items = r; sel = -1; draw(); } } catch { /* typing continues to work without suggestions */ } }, 180);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(-1, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { const v = sel >= 0 ? items[sel].symbol : inp.value.trim(); if (v) pick(v); }
    else if (e.key === 'Escape') { hide(); inp.value = ''; inp.blur(); }
  });
  inp.addEventListener('blur', () => setTimeout(hide, 120));
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('.modal-back')) return;
    if (/^[a-zA-Z^]$/.test(e.key)) inp.focus();
  });
}

// ───────────────────────── workspace backup ─────────────────────────
// Everything the app saves lives in this browser's local storage; this is the way to move or keep it.
const WS_PREFIX = 'meridian.';
function exportWorkspace() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(WS_PREFIX)) data[k] = localStorage.getItem(k); }
  downloadText(`meridian-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'meridian', version: 1, saved: new Date().toISOString(), data }, null, 1), 'application/json');
  toast(`Exported ${Object.keys(data).length} saved items.`, 'ok');
}
async function importWorkspace(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const entries = parseWorkspace(await f.text(), WS_PREFIX);
    const body = h('div', null, h('p', null, `This replaces everything saved in this browser (layouts, watchlists, drawings, rules, scripts, models, alerts) with the ${entries.length} items in “${f.name}”.`),
      h('div', { class: 'modal-foot' }, h('button', { onclick: () => m.close() }, 'Cancel'), h('button', { class: 'primary', onclick: () => {
        for (const k of Object.keys(localStorage)) if (k.startsWith(WS_PREFIX)) localStorage.removeItem(k);
        for (const [k, v] of entries) localStorage.setItem(k, v);
        location.reload();
      } }, 'Replace and reload')));
    const m = modal('Import workspace', body);
  } catch (err) { toast('Could not import: ' + err.message, 'err'); }
}

// ───────────────────────── views ─────────────────────────
const mounted = {};
const loaders = {
  markets: () => import('./markets.js'), scanner: () => import('./scanner.js'), strategy: () => import('./backtest.js'), alerts: () => Promise.resolve(alerts),
  studio: () => import('./studio.js'), lab: () => import('./lab.js'), seasonality: () => import('./seasonality.js'),
};
async function goto(view) {
  state.view = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + view));
  if (view !== 'chart' && !mounted[view]) {
    mounted[view] = true;
    try { const mod = await loaders[view](); mod.mount($('view-' + view)); } catch (e) { console.error(e); $('view-' + view).append(h('div', { class: 'empty' }, 'This view failed to load: ' + e.message)); }
  }
  if (view === 'chart') for (const p of panels) p.chart.resize();
  writeHash();
  bus.emit('view', view);
}

// ───────────────────────── links ─────────────────────────
// The address always names what is on screen (#/chart/NQ=F/5m, #/markets), so it can be copied
// and opened by someone else. Layouts, drawings and indicators stay in each browser.
const VIEWS = ['chart', 'markets', 'scanner', 'strategy', 'alerts', 'studio', 'lab', 'seasonality'];
function readHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (!parts.length || !VIEWS.includes(parts[0])) return null;
  const sym = parts[0] === 'chart' && parts[1] && /^[A-Za-z0-9^=.:&\-]{1,24}$/.test(parts[1]) ? parts[1].toUpperCase() : null;
  return { view: parts[0], symbol: sym, tf: sym && TFS.some((t) => t.id === parts[2]) ? parts[2] : null };
}
function writeHash() {
  const p = cur(); if (!p) return;
  const want = state.view === 'chart' ? `#/chart/${encodeURIComponent(p.cfg.symbol).replace(/%3D/g, '=').replace(/%5E/g, '^').replace(/%3A/g, ':')}/${p.cfg.tf}` : `#/${state.view}`;
  if (location.hash !== want) history.replaceState(null, '', want);
}
function applyHash() {
  const hsh = readHash(); if (!hsh) return;
  if (hsh.view !== state.view) goto(hsh.view);
  if (hsh.symbol && (hsh.symbol !== cur().cfg.symbol || (hsh.tf && hsh.tf !== cur().cfg.tf))) setSymbol(hsh.symbol, hsh.tf);
}
async function copyLink() {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); toast(location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? 'Link copied. It opens on this computer only: share the published page to send a chart to someone.' : 'Link copied. It opens this view for anyone.', 'ok'); }
  catch { toast('Copy the address from the address bar: ' + location.href); }
}

function init() {
  const theme = store.get('theme', 'dark');
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  $('theme-btn').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    store.set('theme', light ? 'light' : 'dark');
    for (const p of panels) p.chart.readTheme();
    bus.emit('theme');
  });
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => goto(b.dataset.view)));
  $('ws-btn').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 230, r.bottom + 4, [
      { label: 'Export workspace to a file', fn: exportWorkspace },
      { label: 'Import workspace from a file…', fn: () => $('ws-file').click() },
    ]);
  });
  $('ws-file').addEventListener('change', importWorkspace);
  $('link-btn').addEventListener('click', copyLink);
  // a link that names a chart opens it in the first panel
  const linked = readHash();
  if (linked && linked.symbol) {
    // if one of this browser's own panels already shows it (a reload), that panel comes forward;
    // only a chart that is not on screen takes over the first panel
    const at = state.cfgs.slice(0, state.layout).findIndex((c) => c.symbol === linked.symbol && (!linked.tf || c.tf === linked.tf));
    if (at >= 0) state.active = at;
    else { state.cfgs[0].symbol = linked.symbol; if (linked.tf) state.cfgs[0].tf = linked.tf; state.active = 0; }
  }
  window.addEventListener('hashchange', applyHash);

  Object.assign(api, {
    openChart(symbol, tf) { goto('chart'); setSymbol(symbol, tf); },
    activeSymbol: () => (cur() ? cur().cfg.symbol : 'SPY'),
    activeTf: () => (cur() ? cur().cfg.tf : '1d'),
    showTrades(symbol, tf, trades) { const p = cur(); p.trades = trades; p.tradesFor = symbol.toUpperCase() + '|' + tf; goto('chart'); setSymbol(symbol, tf); },
    watchlists: () => wl.lists,
    setWatchlist(name, symbols) { wl.lists[name] = symbols; wl.cur = name; saveWl(); renderWatchlist(); refreshQuotes(); },
    addIndicator(id) { cur().cfg.inds.push(mkInd(id)); save(); goto('chart'); cur().compute(); },
    refreshCharts() { for (const p of panels) p.compute(); },
    goto,
  });

  backend().then((be) => { if (be.mode !== 'static') return; document.documentElement.dataset.mode = 'shared'; const ix = be.info(); $('symbol-input').title = `Shared page: ${ix.symbols.length} symbols with history, plus Hyperliquid's live markets (try XYZ100). Run Meridian locally to chart anything.`; });
  loadCustomIndicators(); loadModels();
  buildToolbar(); buildDrawTools(); initSearch(); buildPanels(); renderWatchlist(); refreshQuotes();
  if (linked && linked.view !== 'chart') goto(linked.view); else writeHash();
  alerts.start();
  bus.on('alerts', () => { for (const p of panels) p.chart.setAlertLines(alerts.priceLevels(p.cfg.symbol)); });
  bus.on('rulesets', () => renderAnalysis());
  // Charts with a live estimate refresh every 5 s, other intraday charts of an open market every
  // 15 s, everything else once a minute.
  let beat = 0;
  setInterval(() => {
    updateStatus();
    if (document.hidden) return;
    beat++;
    for (const p of panels) {
      const b = p.bars, every = b && b.live ? 1 : b && b.meta.open && isIntraday(p.cfg.tf) ? 3 : 12;
      if (beat % every === 0) p.load({ keepView: true });
    }
    if (beat % 12 === 0) refreshQuotes();
  }, 5000);
  window.__meridian = { state, panels: () => panels, api };
}
init();

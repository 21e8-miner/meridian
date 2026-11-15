// Indicator Studio: write indicators in JavaScript. Saved scripts join the indicator registry,
// so they work on charts and inside scanner / strategy / alert conditions.
import { h, clear, store, toast, uid } from './util.js';
import * as T from './ta.js';
import { api } from './api.js';

const SAMPLES = [
  { id: 'sample-spread', name: 'EMA Spread %', code: `// Distance between a fast and a slow EMA, as a percent of price.
const fast = input('Fast', 12);
const slow = input('Slow', 48);
const f = ta.ema(close, fast), s = ta.ema(close, slow);
plot(f.map((v, i) => (v - s[i]) / close[i] * 100), { name: 'Spread %', style: 'hist', colorBy: 'sign' });
hline(0);
` },
  { id: 'sample-chandelier', name: 'Chandelier Stop', code: `// Trailing stop: highest high of the lookback minus a multiple of ATR.
overlay();
const len = input('Length', 22);
const mult = input('ATR multiple', 3);
const hh = ta.highest(high, len), a = ta.atr(len);
plot(hh.map((v, i) => v - mult * a[i]), { name: 'Long stop', color: '#59c9a5' });
` },
];
const DOC = `Your script runs once per chart load with these in scope:

  open, high, low, close, volume, time   arrays, oldest first (time = seconds)
  input(name, default)                   a number the user can edit in settings
  plot(series, { name, color, style, colorBy })
        style: 'line' | 'hist' | 'dots' | 'step'      colorBy: 'sign'
  overlay()                              draw on the price pane (default: own pane)
  hline(value)                           dashed guide line in the pane

  ta.sma(a, n)  ta.ema(a, n)  ta.wma(a, n)  ta.hma(a, n)  ta.rma(a, n)
  ta.stdev(a, n)  ta.highest(a, n)  ta.lowest(a, n)  ta.zscore(a, n)
  ta.rsi(a, n)  ta.roc(a, n)  ta.change(a, n)  ta.linreg(a, n)
  ta.atr(n)  ta.tr()  ta.vwap(anchor)  ta.macd(a, fast, slow, signal)
  ta.bollinger(a, n, mult)  ta.crossUp(a, b)  ta.crossDown(a, b)
  ta.shift(a, k)   series delayed by k bars (k >= 0)

Every plotted series must have one value per bar; use NaN where undefined.
Use only data at or before index i to compute value i, or scans and backtests
built on the indicator will look into the future.`;

let scripts = null;
const load = () => (scripts = store.get('scripts', null) || JSON.parse(JSON.stringify(SAMPLES)));
const persist = () => store.set('scripts', scripts);
const slug = (s) => 'custom:' + s.id;

function synthetic(n = 320) {
  const b = { symbol: 'TEST', tf: '1d', t: [], o: [], h: [], l: [], c: [], v: [], meta: {} };
  let p = 100, seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) { const o = p, c = o * (1 + (rnd() - 0.48) * 0.03), hi = Math.max(o, c) * (1 + rnd() * 0.01), lo = Math.min(o, c) * (1 - rnd() * 0.01); b.t.push(86400 * (19000 + i)); b.o.push(o); b.h.push(hi); b.l.push(lo); b.c.push(c); b.v.push(1e6 * (0.5 + rnd())); p = c; }
  return b;
}

function execute(fn, bars, params) {
  const rec = { inputs: [], plots: [], levels: [], overlay: false };
  const ta = {
    sma: T.sma, ema: T.ema, wma: T.wma, hma: T.hma, rma: T.rma, stdev: T.stdev, highest: T.highest, lowest: T.lowest, zscore: T.zscore,
    rsi: T.rsi, roc: T.roc, change: T.change, linreg: (a, n) => T.linreg(a, n).value, atr: (n = 14) => T.atr(bars, n), tr: () => T.trueRange(bars),
    vwap: (anchor) => T.vwap(bars, anchor), macd: T.macd, bollinger: T.bollinger, crossUp: T.crossUp, crossDown: T.crossDown,
    shift: (a, k = 1) => a.map((_, i) => (i - k >= 0 ? a[i - k] : NaN)),
  };
  fn(bars.o, bars.h, bars.l, bars.c, bars.v, bars.t, ta,
    (name, def) => { rec.inputs.push({ name: String(name), def: Number(def) }); const v = params ? params[String(name)] : undefined; return v == null || v !== v ? Number(def) : Number(v); },
    (series, opts = {}) => { rec.plots.push({ series, ...opts }); },
    (v) => rec.levels.push(Number(v)),
    (v = true) => { rec.overlay = !!v; });
  const n = bars.t.length;
  rec.plots.forEach((p, i) => { if (!Array.isArray(p.series) || p.series.length !== n) throw new Error(`plot ${i + 1} must be an array with one value per bar (got ${Array.isArray(p.series) ? p.series.length + ' values for ' + n + ' bars' : typeof p.series})`); });
  if (!rec.plots.length) throw new Error('the script never called plot()');
  return rec;
}

export function compile(s) {
  const fn = new Function('open', 'high', 'low', 'close', 'volume', 'time', 'ta', 'input', 'plot', 'hline', 'overlay', '"use strict";\n' + s.code);
  const probe = execute(fn, synthetic(), null);
  return {
    id: slug(s), name: s.name, short: s.name, group: 'Custom', overlay: probe.overlay, rev: Date.now(),
    params: probe.inputs.map((q) => ({ k: q.name, label: q.name, def: q.def, step: Number.isInteger(q.def) ? 1 : 0.1 })),
    outputs: probe.plots.map((p, i) => ({ k: 'p' + i, label: p.name || `Plot ${i + 1}`, color: p.color || T.PALETTE[i % T.PALETTE.length], style: p.style || 'line', colorBy: p.colorBy })),
    levels: probe.levels,
    calc: (bars, params) => { const r = execute(fn, bars, params); return Object.fromEntries(r.plots.map((p, i) => ['p' + i, p.series])); },
  };
}

export function loadCustomIndicators() {
  load();
  for (const s of scripts) { try { T.registerIndicator(compile(s)); } catch (e) { console.warn(`Custom indicator “${s.name}” did not compile:`, e.message); } }
}

let sel = null, el = null;
export function mount(root) {
  el = root; load(); sel = scripts[0] || null;
  draw();
}
function draw() {
  clear(el);
  const left = h('div', { class: 'col cfg' }), right = h('div', { class: 'col res' });
  el.append(h('div', { class: 'cols' }, left, right));
  left.append(h('h2', null, 'Indicator Studio'), h('p', { class: 'hint' }, 'Write an indicator in JavaScript. Once saved it appears under “Custom” everywhere indicators are used: charts, scans, strategies and alerts.'),
    h('div', { class: 'row' }, h('button', { onclick: () => { const s = { id: uid(), name: 'My indicator', code: `// Describe your idea, then plot it.\nconst len = input('Length', 20);\nplot(ta.sma(close, len), { name: 'Average' });\noverlay();\n` }; scripts.push(s); sel = s; persist(); draw(); } }, '+ New indicator')));
  for (const s of scripts) left.append(h('div', { class: 'list-item' + (s === sel ? ' sel' : ''), style: { cursor: 'pointer' }, onclick: () => { sel = s; draw(); } },
    h('div', { class: 't' }, h('b', null, s.name), h('small', null, T.IND.has(slug(s)) ? 'compiled' : 'not compiled')),
    h('button', { class: 'icon-btn', title: 'Delete', onclick: (e) => { e.stopPropagation(); scripts = scripts.filter((x) => x !== s); T.unregisterIndicator(slug(s)); if (sel === s) sel = scripts[0] || null; persist(); api.refreshCharts(); draw(); } }, '✕')));
  left.append(h('h4', null, 'Reference'), h('pre', { class: 'doc' }, DOC));
  if (!sel) { right.append(h('div', { class: 'empty' }, 'Create an indicator to start.')); return; }
  const name = h('input', { type: 'text', value: sel.name, style: { width: '280px' } });
  const code = h('textarea', { class: 'code', spellcheck: 'false' }); code.value = sel.code;
  const status = h('div', { class: 'hint', style: { marginTop: '8px' } });
  code.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = code.selectionStart; code.setRangeText('  ', s, code.selectionEnd, 'end'); } });
  const saveIt = () => {
    sel.name = name.value.trim() || 'Untitled'; sel.code = code.value; persist();
    try {
      const def = compile(sel); T.registerIndicator(def); api.refreshCharts();
      status.className = 'hint up'; status.textContent = `Compiled: ${def.outputs.length} plot${def.outputs.length === 1 ? '' : 's'}, ${def.params.length} input${def.params.length === 1 ? '' : 's'}, ${def.overlay ? 'price overlay' : 'own pane'}.`;
      return def;
    } catch (e) { T.unregisterIndicator(slug(sel)); status.className = 'hint dn'; status.textContent = 'Error: ' + e.message; return null; }
  };
  right.append(h('div', { class: 'row' }, h('label', { class: 'field' }, 'Name', name), h('span', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => { if (saveIt()) { const l = el.querySelector('.list-item.sel b'); if (l) l.textContent = sel.name; } } }, 'Save & compile'),
    h('button', { onclick: () => { const def = saveIt(); if (!def) return; api.addIndicator(def.id); toast(`Added “${sel.name}” to the chart.`, 'ok'); } }, 'Add to chart')),
    code, status);
}

// Seasonality: monthly return grid by year, per-month averages, and day-of-week returns.
import { h, clear, bus, MON, fmtPct, fmtNum } from './util.js';
import { getBars } from './data.js';
import { api } from './api.js';

let el = null, sym = '', years = 20;
export function mount(root) {
  el = root; sym = api.activeSymbol();
  bus.on('symbol', (s) => { if (s !== sym) { sym = s; if (el.classList.contains('on')) draw(); else el.dataset.dirty = '1'; } });
  bus.on('view', (v) => { if (v === 'seasonality' && el.dataset.dirty) { delete el.dataset.dirty; draw(); } });
  bus.on('theme', () => { if (el.classList.contains('on')) draw(); });
  draw();
}
function heat(v, scale) {
  if (v !== v) return '';
  const a = Math.min(0.85, (Math.abs(v) / scale) * 0.85).toFixed(2);
  return `background: color-mix(in srgb, var(--${v >= 0 ? 'up' : 'down'}) ${Math.round(a * 100)}%, transparent)`;
}
async function draw() {
  clear(el);
  const box = h('div', { class: 'col res', style: { width: '100%' } });
  el.append(box);
  box.append(h('div', { class: 'row' }, h('h2', null, `Seasonality · ${sym}`), h('span', { class: 'spacer' }),
    h('label', { class: 'field' }, 'Symbol', h('input', { type: 'text', value: sym, style: { width: '96px', textTransform: 'uppercase' }, onchange: (e) => { sym = e.target.value.trim().toUpperCase(); draw(); } })),
    h('label', { class: 'field' }, 'Years', h('select', { onchange: (e) => { years = Number(e.target.value); draw(); } }, [10, 20, 30, 50].map((y) => h('option', { value: y, selected: y === years }, String(y)))))));
  let b;
  try { b = await getBars(sym, '1d'); } catch (e) { box.append(h('div', { class: 'empty' }, `${sym}: ${e.message}`)); return; }
  const n = b.t.length, byYM = new Map();
  for (let i = 1; i < n; i++) { const d = new Date(b.t[i] * 1000), k = d.getUTCFullYear() * 12 + d.getUTCMonth(); if (!byYM.has(k)) byYM.set(k, { first: b.c[i - 1], last: b.c[i] }); else byYM.get(k).last = b.c[i]; }
  const lastY = new Date(b.t[n - 1] * 1000).getUTCFullYear(), firstY = Math.max(new Date(b.t[0] * 1000).getUTCFullYear(), lastY - years + 1);
  const ret = (y, m) => { const r = byYM.get(y * 12 + m); return r ? (r.last / r.first - 1) * 100 : NaN; };
  const tbl = h('table', { class: 'heat' }), per = Array.from({ length: 12 }, () => []);
  tbl.append(h('tr', null, h('th', null, ''), MON.map((m) => h('th', null, m)), h('th', null, 'Year')));
  for (let y = lastY; y >= firstY; y--) {
    const tr = h('tr', null, h('th', null, String(y))); let comp = 1, any = false;
    for (let m = 0; m < 12; m++) { const v = ret(y, m); if (v === v) { per[m].push(v); comp *= 1 + v / 100; any = true; } tr.append(h('td', { style: heat(v, 8) }, v === v ? v.toFixed(1) : '')); }
    tr.append(h('td', { style: heat(any ? (comp - 1) * 100 : NaN, 30) }, any ? ((comp - 1) * 100).toFixed(1) : ''));
    tbl.append(tr);
  }
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN), med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const sum = h('table', { class: 'heat' });
  sum.append(h('tr', null, h('th', null, ''), MON.map((m) => h('th', null, m))),
    h('tr', null, h('th', null, 'Average %'), per.map((a) => h('td', { style: heat(avg(a), 4) }, fmtNum(avg(a), 2)))),
    h('tr', null, h('th', null, 'Median %'), per.map((a) => h('td', { style: heat(med(a), 4) }, fmtNum(med(a), 2)))),
    h('tr', null, h('th', null, 'Up months'), per.map((a) => h('td', null, a.length ? `${Math.round((a.filter((v) => v > 0).length / a.length) * 100)}%` : ''))),
    h('tr', null, h('th', null, 'Years'), per.map((a) => h('td', { class: 'muted' }, String(a.length)))));
  const dow = Array.from({ length: 7 }, () => []), cut = b.t[n - 1] - years * 31557600;
  for (let i = 1; i < n; i++) if (b.t[i] >= cut) dow[new Date(b.t[i] * 1000).getUTCDay()].push((b.c[i] / b.c[i - 1] - 1) * 100);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], days = names.map((nm, i) => [nm, dow[i]]).filter(([, a]) => a.length > 20);
  const dtbl = h('table', { class: 'heat', style: { maxWidth: '520px' } });
  dtbl.append(h('tr', null, h('th', null, ''), days.map(([nm]) => h('th', null, nm))),
    h('tr', null, h('th', null, 'Average %'), days.map(([, a]) => h('td', { style: heat(avg(a), 0.25) }, fmtNum(avg(a), 3)))),
    h('tr', null, h('th', null, 'Up days'), days.map(([, a]) => h('td', null, `${Math.round((a.filter((v) => v > 0).length / a.length) * 100)}%`))));
  box.append(h('p', { class: 'hint' }, `${b.meta.name || sym}. Month-over-month change in the closing price, ${firstY}–${lastY}. Prices are split-adjusted but exclude dividends. A dozen or two past years is a small sample: treat patterns here as weak evidence.`),
    h('h4', null, 'By calendar month'), sum, h('h4', null, 'By day of the week'), dtbl, h('h4', null, 'Every month'), tbl,
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { onclick: () => api.openChart(sym, '1mo') }, 'Open monthly chart')));
}

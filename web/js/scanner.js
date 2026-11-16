// Market scanner: multi-factor, multi-timeframe rules run across a symbol list.
import { h, clear, store, toast, fmtPrice, fmtPct, fmtVol, fmtNum, downloadText, toCsv } from './util.js';
import { TFS, TF, tfLabel, getBatch, universes } from './data.js';
import { sma } from './ta.js';
import { ruleBuilder, evalRuleset, requiredTfs, describeRuleset, operandLabel, leftValue, cmp, price, num, ind, newRuleset } from './conditions.js';
import { api } from './api.js';

const PRESETS = {
  'Oversold bounce — RSI crosses back above 30': () => newRuleset([cmp(ind('rsi', { len: 14 }), 'xup', num(30))]),
  'Golden cross — 50 SMA crosses above 200 SMA': () => newRuleset([cmp(ind('sma', { len: 50 }), 'xup', ind('sma', { len: 200 }))]),
  'Uptrend on heavy volume': () => newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 200 })), cmp(ind('rvol', { len: 20 }), 'gt', num(1.5)), cmp(ind('chg', { len: 1 }), 'gt', num(0))]),
  'New 52-week high': () => newRuleset([cmp(price('high'), 'gte', ind('donchian', { len: 252 }, 'upper'))]),
  'Bollinger squeeze breakout': () => newRuleset([cmp({ ...ind('bbw', { len: 20, mult: 2 }), offset: 1 }, 'lt', num(8)), cmp(price('close'), 'xup', ind('bb', { len: 20, mult: 2 }, 'upper'))]),
  'MACD bullish cross above the 200 SMA': () => newRuleset([cmp(ind('macd', {}, 'macd'), 'xup', ind('macd', {}, 'signal')), cmp(price('close'), 'gt', ind('sma', { len: 200 }))]),
  'Weekly uptrend, daily pullback (multi-timeframe)': () => newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 30 }), '1w'), cmp(ind('rsi', { len: 14 }), 'lt', num(40))]),
  'Bullish candlestick at the 50 SMA': () => newRuleset([{ kind: 'candle', tf: null, pattern: 'any_bull', within: 1 }, cmp(price('low'), 'lte', ind('sma', { len: 50 })), cmp(price('close'), 'gt', ind('sma', { len: 50 }))]),
  'Breakout through an auto resistance trendline': () => newRuleset([{ kind: 'auto', tf: null, signal: 'break_res' }]),
  'Testing an auto support zone': () => newRuleset([{ kind: 'auto', tf: null, signal: 'near_sup' }, cmp(price('close'), 'gt', ind('sma', { len: 200 }))]),
};

let cfg, resEl, statusEl, barEl, rows = [], sortK = 'chg', desc = true, cols = [];
const persist = () => store.set('scan.cfg', cfg);
let UNI = {}, uniReady = false;
const lists = () => ({ ...UNI, ...Object.fromEntries(Object.entries(api.watchlists()).map(([k, v]) => ['Watchlist: ' + k, v])) });

export function mount(el) {
  cfg = store.get('scan.cfg', null) || { tf: '1d', universe: 'Mega caps (30)', within: 1, rs: PRESETS['Uptrend on heavy volume']() };
  const left = h('div', { class: 'col cfg' }); resEl = h('div', { class: 'col res' });
  el.append(h('div', { class: 'cols' }, left, resEl));
  const drawCfg = () => {
    clear(left);
    const L = lists(); if (uniReady && !L[cfg.universe]) cfg.universe = Object.keys(L)[0]; // only once the lists are known
    statusEl = h('span', { class: 'muted' }); barEl = h('i');
    left.append(h('h2', null, 'Scanner'), h('p', { class: 'hint' }, 'Find symbols that meet every condition. Each condition can read its own timeframe; higher-timeframe values count only once that bar has closed.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Scan', h('select', { onchange: (e) => { cfg.universe = e.target.value; persist(); } }, Object.entries(L).map(([k, v]) => h('option', { value: k, selected: cfg.universe === k }, k.includes('(') ? k : `${k} (${v.length})`)))),
        h('label', { class: 'field' }, 'Timeframe', h('select', { onchange: (e) => { cfg.tf = e.target.value; persist(); drawCfg(); } }, TFS.map((t) => h('option', { value: t.id, selected: cfg.tf === t.id }, t.label)))),
        h('label', { class: 'field', title: 'Match if the rules were met on any of the last N bars' }, 'Within bars', h('input', { type: 'number', min: 1, max: 50, value: cfg.within, onchange: (e) => { cfg.within = Math.max(1, e.target.value | 0); persist(); } })),
        h('label', { class: 'field' }, 'Start from', h('select', { onchange: (e) => { const f = PRESETS[e.target.value]; if (f) { cfg.rs = f(); persist(); drawCfg(); } } }, h('option', { value: '' }, 'Preset…'), Object.keys(PRESETS).map((k) => h('option', { value: k }, k))))),
      ruleBuilder(cfg.rs, { title: 'Conditions', baseTf: () => cfg.tf, onChange: persist }),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: run }, 'Run scan'), statusEl),
      h('div', { class: 'progress' }, barEl));
  };
  drawCfg();
  universes().then((u) => { UNI = u; uniReady = true; drawCfg(); });
  resEl.append(h('div', { class: 'empty' }, 'Run a scan to see matches.'));
}

async function run() {
  const syms = lists()[cfg.universe] || [], rs = JSON.parse(JSON.stringify(cfg.rs)), tf = cfg.tf;
  if (!rs.conds.length) return toast('Add at least one condition.', 'err');
  clear(resEl); resEl.append(h('div', { class: 'empty' }, 'Scanning…'));
  const tfs = requiredTfs(rs, tf), data = new Map(), errors = {};
  const long = tfs.some((t) => t === '1w' || t === '1mo');
  let step = 0;
  for (const t of tfs) {
    const limit = TF[t].base === '1d' ? (long ? 2600 : 800) : 0;
    const r = await getBatch(syms, t, { limit, onProgress: (d, n) => { barEl.style.width = (((step + d / n) / tfs.length) * 100).toFixed(0) + '%'; statusEl.textContent = `Loading ${tfLabel(t)} data ${d} / ${n}`; } });
    data.set(t, r.bars); Object.assign(errors, r.errors); step++;
  }
  rows = [];
  const cmps = rs.conds.map((c, k) => ({ c, k })).filter((x) => x.c.kind === 'cmp' && x.c.a.type !== 'num');
  for (const s of syms) {
    const base = data.get(tf).get(s); if (!base || base.t.length < 30) continue;
    const byTf = new Map(tfs.map((t) => [t, data.get(t).get(s)]));
    const { mask } = evalRuleset(rs, base, byTf), n = base.t.length;
    let ago = -1; for (let k = 0; k < cfg.within && k < n; k++) if (mask[n - 1 - k]) { ago = k; break; }
    if (ago < 0) continue;
    const av = sma(base.v, 20)[n - 2];
    const row = { sym: s, last: base.c[n - 1], chg: (base.c[n - 1] / base.c[n - 2] - 1) * 100, vol: base.v[n - 1], rvol: av ? base.v[n - 1] / av : NaN, ago };
    for (const { c, k } of cmps) { const t = c.tf && TF[c.tf].rank > TF[tf].rank ? c.tf : tf, b = byTf.get(t); row['c' + k] = b ? leftValue(c, b) : NaN; }
    rows.push(row);
  }
  cols = [['sym', 'Symbol', (r) => r.sym], ['last', 'Last', (r) => fmtPrice(r.last)], ['chg', 'Chg %', (r) => fmtPct(r.chg)], ['vol', 'Volume', (r) => fmtVol(r.vol)], ['rvol', 'Rel vol', (r) => fmtNum(r.rvol, 2)],
    ...cmps.map(({ c, k }) => ['c' + k, operandLabel(c.a) + (c.tf && c.tf !== tf ? ` ${tfLabel(c.tf)}` : ''), (r) => (c.a.type === 'price' && c.a.field === 'volume' ? fmtVol(r['c' + k]) : fmtNum(r['c' + k], 2))]),
    ...(cfg.within > 1 ? [['ago', 'Bars ago', (r) => String(r.ago)]] : [])];
  const nErr = Object.keys(errors).length;
  statusEl.textContent = `${rows.length} match${rows.length === 1 ? '' : 'es'} in ${syms.length - nErr} symbols` + (nErr ? ` · ${nErr} had no data` : '');
  barEl.style.width = '100%';
  draw(rs, tf, errors);
}

function draw(rs, tf, errors) {
  clear(resEl);
  resEl.append(h('div', { class: 'row' }, h('h2', null, `${rows.length} match${rows.length === 1 ? '' : 'es'} · ${cfg.universe} · ${tfLabel(tf)}`), h('span', { class: 'spacer' }),
    rows.length ? h('button', { title: 'Download these matches as a CSV file', onclick: () => downloadText(`scan-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([cols.map(([, l]) => l), ...rows.map((r) => cols.map(([k]) => (typeof r[k] === 'number' ? +r[k].toFixed(4) : r[k])))]), 'text/csv') }, 'Export CSV') : null,
    rows.length ? h('button', { onclick: () => { api.setWatchlist('Scan results', rows.map((r) => r.sym)); toast('Saved to the watchlist “Scan results”.', 'ok'); } }, 'Save as watchlist') : null),
    h('p', { class: 'hint' }, describeRuleset(rs, tf)));
  const nErr = Object.keys(errors || {}).length;
  if (nErr) resEl.append(h('p', { class: 'hint' }, `No data for: ${Object.keys(errors).join(', ')}`));
  if (!rows.length) { resEl.append(h('div', { class: 'empty' }, 'No symbols meet these conditions right now.')); return; }
  const tbl = h('table', { class: 'grid' });
  const paint = () => {
    clear(tbl);
    rows.sort((a, b) => { const x = a[sortK], y = b[sortK]; return (typeof x === 'string' ? x.localeCompare(y) : (x === x ? x : -Infinity) - (y === y ? y : -Infinity)) * (desc ? -1 : 1); });
    tbl.append(h('thead', null, h('tr', null, cols.map(([k, l]) => h('th', { onclick: () => { desc = sortK === k ? !desc : k !== 'sym'; sortK = k; paint(); } }, l + (sortK === k ? (desc ? ' ▾' : ' ▴') : ''))))),
      h('tbody', null, rows.map((r) => h('tr', { onclick: () => api.openChart(r.sym, tf) }, cols.map(([k, , f]) => h('td', { class: k === 'chg' ? (r.chg >= 0 ? 'up' : 'dn') : '' }, k === 'sym' ? h('b', null, r.sym) : f(r)))))));
  };
  if (!cols.some(([k]) => k === sortK)) sortK = 'chg';
  paint(); resEl.append(tbl);
}

// Market scanner: filters on daily values plus multi-factor, multi-timeframe rules, run across a
// symbol list. On the shared page the filters and the presets (unchanged, on the daily timeframe)
// are answered at once from each build's screening file (web/js/screen.js, tools/screen.mjs);
// other rules download the history they need, for the symbols that passed the filters.
import { h, clear, appendAll, store, toast, fmtPrice, fmtPct, fmtVol, fmtNum, fmtTime, downloadText, toCsv } from './util.js';
import { TFS, TF, tfLabel, getBatch, universes, backend, screenFiles } from './data.js';
import { sma } from './ta.js';
import { ruleBuilder, requiredTfs, describeRuleset, operandLabel, leftValue } from './conditions.js';
import { PRESETS, presetOf, scanLimit, matchAgo, SCREEN_COLS, SCREEN_KEYS, FILTER_OPS, validFilters, passes, screenRow, mergeScreens, rowObject, describeFilters, AGO_DEPTH } from './screen.js';
import { api } from './api.js';

let cfg, resEl, statusEl, barEl, rows = [], sortK = 'chg', desc = true, cols = [];
const persist = () => store.set('scan.cfg', cfg);
let UNI = {}, uniReady = false, shared = false;
const lists = () => ({ ...UNI, ...Object.fromEntries(Object.entries(api.watchlists()).map(([k, v]) => ['Watchlist: ' + k, v])) });
const COL = Object.fromEntries(SCREEN_COLS.map((c) => [c.k, c]));
const FMT = { price: fmtPrice, pct: (x) => fmtPct(x), vol: fmtVol, usd: (x) => (x == null ? '–' : '$' + fmtVol(x)), num: (x) => fmtNum(x, 2) };
// the screening columns a result table shows, besides any a filter reads
const SHOWN = ['last', 'chg', 'm1', 'ytd', 'dv', 'rvol', 'rsi', 's200', 'hi52'];

export function mount(el) {
  cfg = store.get('scan.cfg', null) || { tf: '1d', universe: 'Mega caps (30)', within: 1, rs: PRESETS['Uptrend on heavy volume']() };
  if (!Array.isArray(cfg.filters)) cfg.filters = [];
  const left = h('div', { class: 'col cfg' }); resEl = h('div', { class: 'col res' });
  el.append(h('div', { class: 'cols' }, left, resEl));
  const drawCfg = () => {
    clear(left);
    const L = lists(); if (uniReady && !L[cfg.universe]) cfg.universe = Object.keys(L)[0]; // only once the lists are known
    statusEl = h('span', { class: 'muted' }); barEl = h('i');
    const n = (L[cfg.universe] || []).length, instant = shared && cfg.tf === '1d' && presetOf(cfg.rs) && cfg.within <= AGO_DEPTH;
    appendAll(left, h('h2', null, 'Scanner'), h('p', { class: 'hint' }, 'Find symbols that pass every filter and meet the conditions. Each condition can read its own timeframe; higher-timeframe values count only once that bar has closed.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Scan', h('select', { onchange: (e) => { cfg.universe = e.target.value; persist(); drawCfg(); } }, Object.entries(L).map(([k, v]) => h('option', { value: k, selected: cfg.universe === k }, k.includes('(') ? k : `${k} (${v.length})`)))),
        h('label', { class: 'field' }, 'Timeframe', h('select', { onchange: (e) => { cfg.tf = e.target.value; persist(); drawCfg(); } }, TFS.map((t) => h('option', { value: t.id, selected: cfg.tf === t.id }, t.label)))),
        h('label', { class: 'field', title: 'Match if the rules were met on any of the last N bars' }, 'Within bars', h('input', { type: 'number', min: 1, max: 50, value: cfg.within, onchange: (e) => { cfg.within = Math.max(1, e.target.value | 0); persist(); drawCfg(); } })),
        h('label', { class: 'field' }, 'Start from', h('select', { onchange: (e) => { const f = PRESETS[e.target.value]; if (f) { cfg.rs = f(); persist(); drawCfg(); } } }, h('option', { value: '' }, 'Preset…'), Object.keys(PRESETS).map((k) => h('option', { value: k }, k))))),
      filterBox(),
      // on the shared page every symbol scanned the slow way is a file to download: say so before a big one
      shared && n > 250 && cfg.rs.conds.length && !instant ? h('p', { class: 'hint' }, `${n} symbols: conditions other than an unchanged preset on the daily timeframe download about 0.13 MB of history a symbol${validFilters(cfg.filters).length ? ', for the symbols that pass the filters' : ` (${Math.round(n * 0.13)} MB here; filters narrow it first)`}.`) : null,
      shared && instant ? h('p', { class: 'hint' }, 'Instant: this preset was run on every symbol in the latest build.') : null,
      ruleBuilder(cfg.rs, { title: 'Conditions', baseTf: () => cfg.tf, onChange: () => { persist(); syncHint(); } }),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: run }, 'Run scan'), statusEl),
      h('div', { class: 'progress' }, barEl),
      shared ? h('p', { class: 'hint' }, 'Daily signals: ', h('a', { href: 'signals.xml', target: '_blank', rel: 'noopener' }, 'a feed'), ' of what each preset matched at the close, for a feed reader.') : null);
  };
  // a condition edited away from its preset changes what the run will cost: redraw the hints only
  let hintKey = '';
  const syncHint = () => { const k = String(!!presetOf(cfg.rs)) + cfg.rs.conds.length; if (k !== hintKey) { hintKey = k; drawCfg(); } };
  const filterBox = () => {
    const box = h('div', { class: 'filters' });
    const draw = () => {
      clear(box);
      box.append(h('div', { class: 'row' }, h('b', null, 'Filters'), h('span', { class: 'muted' }, shared ? 'daily values for every symbol, from the latest build' : 'daily values, read with the scan')));
      cfg.filters.forEach((f, i) => box.append(h('div', { class: 'row filter' },
        h('select', { onchange: (e) => { f.k = e.target.value; persist(); } }, SCREEN_COLS.map((c) => h('option', { value: c.k, selected: f.k === c.k }, c.long || c.label))),
        h('select', { onchange: (e) => { f.op = e.target.value; persist(); } }, FILTER_OPS.map((o) => h('option', { value: o.id, selected: f.op === o.id }, o.label))),
        h('input', { type: 'text', inputmode: 'decimal', value: f.v, placeholder: 'e.g. 10M', style: { width: '90px' }, title: 'A number; K, M and B work too (10M = 10,000,000)', onchange: (e) => { f.v = e.target.value.trim(); persist(); } }),
        h('button', { title: 'Remove this filter', onclick: () => { cfg.filters.splice(i, 1); persist(); draw(); drawCfg(); } }, '×'))));
      box.append(h('div', { class: 'row' }, h('button', { onclick: () => { cfg.filters.push({ k: 'dv', op: 'gte', v: '10M' }); persist(); draw(); } }, '+ Filter')));
    };
    draw();
    return box;
  };
  drawCfg();
  universes().then(async (u) => { UNI = u; uniReady = true; shared = !!(await backend()).info(); drawCfg(); });
  resEl.append(h('div', { class: 'empty' }, 'Run a scan to see matches.'));
}

const progress = (label, part = 0, parts = 1) => (d, n) => { barEl.style.width = (((part + d / Math.max(1, n)) / parts) * 100).toFixed(0) + '%'; statusEl.textContent = `Loading ${label} ${d} / ${n}`; };

async function run() {
  const all = lists()[cfg.universe] || [], rs = JSON.parse(JSON.stringify(cfg.rs)), tf = cfg.tf, filters = validFilters(cfg.filters);
  if (!rs.conds.length && !filters.length) return toast('Add a filter or a condition.', 'err');
  if (cfg.filters.length > filters.length) toast('A filter without a number is left out.', 'info');
  clear(resEl); resEl.append(h('div', { class: 'empty' }, 'Scanning…'));
  barEl.style.width = '0%';
  const errors = {}, files = await screenFiles(), screen = files && files.length ? mergeScreens(files) : null;
  const preset = presetOf(rs), instant = !!screen && tf === '1d' && !!preset && cfg.within <= AGO_DEPTH && screen.has(preset);
  // screening rows: from the builds' files where they cover a symbol, else from its daily bars
  const rowOf = new Map();
  const rowsFor = async (syms) => {
    const missing = [];
    for (const s of syms) { const r = screen && screen.row(s); if (r) rowOf.set(s, r); else if (!rowOf.has(s)) missing.push(s); }
    if (!missing.length) return;
    const r = await getBatch(missing, '1d', { limit: 800, onProgress: progress('daily data') });
    for (const [s, b] of r.bars) { const row = rowObject(screenRow(b)); if (row) rowOf.set(s, row); }
    Object.assign(errors, r.errors);
  };
  let syms = all;
  if (filters.length) { await rowsFor(syms); syms = syms.filter((s) => passes(rowOf.get(s), filters)); }
  let scanned = [], quick = [];
  if (!rs.conds.length) { await rowsFor(syms); quick = syms.filter((s) => rowOf.has(s)).map((s) => ({ s, ago: null })); }
  else if (instant) {
    // the preset was run on every symbol a screening file covers; the rest are scanned here
    const covered = syms.filter((s) => screen.row(s));
    for (const s of covered) { const a = screen.ago(preset, s); if (a !== undefined && a < cfg.within) quick.push({ s, ago: a }); }
    for (const q of quick) rowOf.set(q.s, screen.row(q.s));
    const rest = syms.filter((s) => !screen.row(s));
    if (rest.length) scanned = await scanSymbols(rest, rs, tf, errors);
  } else scanned = await scanSymbols(syms, rs, tf, errors);
  // results: screening columns when there are no per-condition values to show
  const fcols = [...new Set(filters.map((f) => f.k))];
  if (!scanned.length || quick.length) {
    for (const x of scanned) if (!rowOf.has(x.sym) && x.daily) { const r = rowObject(screenRow(x.daily)); if (r) rowOf.set(x.sym, r); }
    rows = [...quick.map((q) => ({ sym: q.s, ...rowOf.get(q.s), ago: q.ago })), ...scanned.map((x) => ({ ...(rowOf.get(x.sym) || {}), ...x.row, sym: x.sym }))];
    const keys = [...SHOWN, ...fcols.filter((k) => !SHOWN.includes(k))];
    cols = [['sym', 'Symbol', (r) => r.sym], ...keys.map((k) => [k, COL[k].label, (r) => FMT[COL[k].fmt](r[k])]), ...(rs.conds.length && cfg.within > 1 ? [['ago', 'Bars ago', (r) => (r.ago == null ? '–' : String(r.ago))]] : [])];
  } else {
    rows = scanned.map((x) => ({ ...x.row, ...Object.fromEntries(fcols.map((k) => [k, (rowOf.get(x.sym) || {})[k]])) }));
    const cmps = rs.conds.map((c, k) => ({ c, k })).filter((x) => x.c.kind === 'cmp' && x.c.a.type !== 'num');
    cols = [['sym', 'Symbol', (r) => r.sym], ['last', 'Last', (r) => fmtPrice(r.last)], ['chg', 'Chg %', (r) => fmtPct(r.chg)], ['vol', 'Volume', (r) => fmtVol(r.vol)], ['rvol', 'Rel vol', (r) => fmtNum(r.rvol, 2)],
      ...cmps.map(({ c, k }) => ['c' + k, operandLabel(c.a) + (c.tf && c.tf !== tf ? ` ${tfLabel(c.tf)}` : ''), (r) => (c.a.type === 'price' && c.a.field === 'volume' ? fmtVol(r['c' + k]) : fmtNum(r['c' + k], 2))]),
      ...fcols.filter((k) => !['last', 'chg', 'vol', 'rvol'].includes(k)).map((k) => [k, COL[k].label, (r) => FMT[COL[k].fmt](r[k])]),
      ...(cfg.within > 1 ? [['ago', 'Bars ago', (r) => String(r.ago)]] : [])];
  }
  const nErr = Object.keys(errors).length, how = screen && (instant || !rs.conds.length) && !scanned.length ? ` · instant, from the build of ${fmtTime(screen.generated - new Date().getTimezoneOffset() * 60)}` : '';
  statusEl.textContent = `${rows.length} match${rows.length === 1 ? '' : 'es'} in ${all.length - nErr} symbols` + (nErr ? ` · ${nErr} had no data` : '') + how;
  barEl.style.width = '100%';
  draw(rs, tf, errors, filters);
}

// The rules on each symbol, from downloaded history: [{ sym, row, daily }] for the matches.
async function scanSymbols(syms, rs, tf, errors) {
  const tfs = requiredTfs(rs, tf), data = new Map();
  let step = 0;
  for (const t of tfs) {
    const r = await getBatch(syms, t, { limit: scanLimit(tfs, t), onProgress: progress(`${tfLabel(t)} data`, step, tfs.length) });
    data.set(t, r.bars); Object.assign(errors, r.errors); step++;
  }
  const cmps = rs.conds.map((c, k) => ({ c, k })).filter((x) => x.c.kind === 'cmp' && x.c.a.type !== 'num'), out = [];
  for (const s of syms) {
    const base = data.get(tf).get(s), byTf = new Map(tfs.map((t) => [t, data.get(t).get(s)]));
    const ago = matchAgo(rs, base, byTf, cfg.within);
    if (ago < 0) continue;
    const n = base.t.length, av = sma(base.v, 20)[n - 2];
    const row = { sym: s, last: base.c[n - 1], chg: (base.c[n - 1] / base.c[n - 2] - 1) * 100, vol: base.v[n - 1], rvol: av ? base.v[n - 1] / av : NaN, ago };
    for (const { c, k } of cmps) { const t = c.tf && TF[c.tf].rank > TF[tf].rank ? c.tf : tf, b = byTf.get(t); row['c' + k] = b ? leftValue(c, b) : NaN; }
    out.push({ sym: s, row, daily: tf === '1d' ? base : null });
  }
  return out;
}

function draw(rs, tf, errors, filters) {
  clear(resEl);
  const what = [describeFilters(filters), rs.conds.length ? describeRuleset(rs, tf) : ''].filter(Boolean).join('  AND  ');
  resEl.append(h('div', { class: 'row' }, h('h2', null, `${rows.length} match${rows.length === 1 ? '' : 'es'} · ${cfg.universe} · ${tfLabel(tf)}`), h('span', { class: 'spacer' }),
    rows.length ? h('button', { title: 'Download these matches as a CSV file', onclick: () => downloadText(`scan-${tf}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([cols.map(([, l]) => l), ...rows.map((r) => cols.map(([k]) => (typeof r[k] === 'number' ? +r[k].toFixed(4) : r[k])))]), 'text/csv') }, 'Export CSV') : null,
    rows.length ? h('button', { onclick: () => { api.setWatchlist('Scan results', rows.map((r) => r.sym)); toast('Saved to the watchlist “Scan results”.', 'ok'); } }, 'Save as watchlist') : null),
    h('p', { class: 'hint' }, what));
  const nErr = Object.keys(errors || {}).length;
  if (nErr) resEl.append(h('p', { class: 'hint' }, `No data for: ${Object.keys(errors).slice(0, 60).join(', ')}${nErr > 60 ? ` and ${nErr - 60} more` : ''}`));
  if (!rows.length) { resEl.append(h('div', { class: 'empty' }, 'No symbols meet these conditions right now.')); return; }
  const tbl = h('table', { class: 'grid' });
  const paint = () => {
    clear(tbl);
    rows.sort((a, b) => { const x = a[sortK], y = b[sortK]; return (typeof x === 'string' ? x.localeCompare(y) : (x != null && x === x ? x : -Infinity) - (y != null && y === y ? y : -Infinity)) * (desc ? -1 : 1); });
    tbl.append(h('thead', null, h('tr', null, cols.map(([k, l]) => h('th', { onclick: () => { desc = sortK === k ? !desc : k !== 'sym'; sortK = k; paint(); }, title: COL[k] ? COL[k].long : '' }, l + (sortK === k ? (desc ? ' ▾' : ' ▴') : ''))))),
      h('tbody', null, rows.slice(0, 2000).map((r) => h('tr', { onclick: () => api.openChart(r.sym, tf) }, cols.map(([k, , f]) => h('td', { class: k === 'chg' ? (r.chg >= 0 ? 'up' : 'dn') : '' }, k === 'sym' ? h('b', null, r.sym) : f(r)))))));
  };
  if (!cols.some(([k]) => k === sortK)) sortK = 'chg';
  paint(); resEl.append(tbl);
  if (rows.length > 2000) resEl.append(h('p', { class: 'hint' }, `Showing the first 2,000 of ${rows.length} by the sorted column; Export CSV has them all.`));
}

// Markets: a whole list at a glance - breadth, a heat map grouped by sector, sector table, movers.
//
// Everything here is computed from a year of daily closes per symbol. On the shared page those
// arrive in one small file (data/pack.json, written by tools/snapshot.py: pack_row); with a server
// they are cut from ordinary daily bars (packFromBars - the same thing, kept in step by tests).
import { h, clear, store, bus, fmtPrice, fmtPct, fmtDate, clamp } from './util.js';
import { backend, getBatch, universes, stockSectors } from './data.js';
import { api } from './api.js';

export const PERIODS = [['1D', '1 day'], ['1W', '1 week'], ['1M', '1 month'], ['3M', '3 months'], ['6M', '6 months'], ['YTD', 'year to date'], ['1Y', '1 year']];
// the change, in percent, at which a tile reaches full color
const FULL = { '1D': 3, '1W': 6, '1M': 12, '3M': 20, '6M': 30, YTD: 40, '1Y': 50 };
const PACK_DAYS = 375;
const TYPE_GROUP = { ETF: 'ETFs', FUTURE: 'Futures', INDEX: 'Indexes', CURRENCY: 'Currencies', CRYPTOCURRENCY: 'Crypto', EQUITY: 'Other stocks' };

// ───────────────────────── pure parts (tests/markets.mjs) ─────────────────────────
// Daily bars -> the last year of closes, plus the average value traded a day over the 20 bars
// before the newest. That is price x shares for stocks and ETFs; crypto volume already comes in
// dollars; for indexes, futures and currencies the feed's volume cannot be turned into dollars,
// so there is no figure (0).
export function packFromBars(b) {
  const n = b.t.length, type = b.meta && b.meta.type, kind = type === 'EQUITY' || type === 'ETF' ? 1 : type === 'CRYPTOCURRENCY' ? 2 : 0;
  let k = n - 1;
  while (k > 0 && b.t[k - 1] >= b.t[n - 1] - PACK_DAYS * 86400) k--;
  const lo = Math.max(0, n - 21);
  let s = 0;
  for (let i = lo; i < n - 1; i++) s += kind === 1 ? b.c[i] * b.v[i] : kind === 2 ? b.v[i] : 0;
  return { t: b.t.slice(k), c: b.c.slice(k), dv: Math.floor(s / Math.max(1, n - 1 - lo) + 0.5) };
}
// A row of data/pack.json -> the same shape.
export function decodePack(row) {
  const t = [row.d0 * 86400];
  for (const d of row.dd) t.push(t[t.length - 1] + d * 86400);
  return { t, c: row.c, dv: row.dv, f: row.f };
}
// The same calendar day `months` earlier (the month's last day if it has no such day), as seconds.
export function monthsBack(t, months) {
  const d = new Date(t * 1000), mm = d.getUTCMonth() - months, y = d.getUTCFullYear() + Math.floor(mm / 12), m = ((mm % 12) + 12) % 12;
  return Date.UTC(y, m, Math.min(d.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / 1000;
}
/**
 * What the views show for one symbol. Changes are measured from the last close at or before the
 * start of each period (one calendar week, month, ... before the newest bar; the last bar of the
 * previous year for year to date), so a holiday or a weekend never shortens a period. NaN where
 * the history does not reach back far enough.
 */
export function stats(p) {
  const { t, c } = p, n = c.length, last = c[n - 1], T = t[n - 1];
  const baseAt = (cut) => { let i = n - 1; while (i >= 0 && t[i] > cut) i--; return i >= 0 ? c[i] : NaN; };
  const pct = (b) => (b > 0 ? (last / b - 1) * 100 : NaN);
  const chg = {
    '1D': n > 1 ? pct(c[n - 2]) : NaN, '1W': pct(baseAt(T - 7 * 86400)), '1M': pct(baseAt(monthsBack(T, 1))), '3M': pct(baseAt(monthsBack(T, 3))),
    '6M': pct(baseAt(monthsBack(T, 6))), YTD: pct(baseAt(Date.UTC(new Date(T * 1000).getUTCFullYear(), 0, 1) / 1000 - 1)), '1Y': pct(baseAt(monthsBack(T, 12))),
  };
  const mean = (len) => { if (n < len) return NaN; let s = 0; for (let i = n - len; i < n; i++) s += c[i]; return s / len; };
  const m50 = mean(50), m200 = mean(200);
  // the 52-week range of closes; needs most of a year of history to mean anything
  const from = monthsBack(T, 12);
  let hi = -Infinity, lo = Infinity, cnt = 0;
  for (let i = n - 1; i >= 0 && t[i] >= from; i--) { if (c[i] > hi) hi = c[i]; if (c[i] < lo) lo = c[i]; cnt++; }
  const year = cnt >= 150;
  return { last, t: T, chg, above50: m50 === m50 ? last > m50 : null, above200: m200 === m200 ? last > m200 : null, atHigh: year && last >= hi, atLow: year && last <= lo, fromHigh: year ? (last / hi - 1) * 100 : NaN, dv: p.dv };
}
export function median(xs) {
  const a = xs.filter((x) => x === x).sort((x, y) => x - y), n = a.length;
  return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NaN;
}
// Breadth of a set of rows (each { s: stats }) over one period.
export function breadth(rows, period, get = (r) => r.s.chg[period]) {
  const ch = rows.map(get).filter((x) => x === x), share = (k) => { const v = rows.map((r) => r.s[k]).filter((x) => x !== null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : NaN; };
  return { n: ch.length, up: ch.filter((x) => x > 0).length, down: ch.filter((x) => x < 0).length, median: median(ch), above50: share('above50'), above200: share('above200'), highs: rows.filter((r) => r.s.atHigh).length, lows: rows.filter((r) => r.s.atLow).length };
}
/**
 * Squarified treemap (Bruls, Huizing, van Wijk): lays items out in a rectangle with areas in
 * proportion to their `v`, keeping tiles as close to square as it can. Returns [{ item, x, y, w, h }].
 */
export function treemap(items, x, y, w, h) {
  const out = [], list = items.filter((it) => it.v > 0), total = list.reduce((s, it) => s + it.v, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const k = (w * h) / total, rest = list.map((it) => ({ it, a: it.v * k })).sort((p, q) => q.a - p.a);
  let i = 0;
  while (i < rest.length) {
    const short = Math.min(w, h), row = [];
    let sum = 0, best = Infinity, j = i;
    while (j < rest.length) {
      const a = rest[j].a, s2 = sum + a, mx = row.length ? row[0].a : a;
      const worst = Math.max((short * short * mx) / (s2 * s2), (s2 * s2) / (short * short * a));
      if (row.length && worst > best) break;
      best = worst; sum = s2; row.push(rest[j]); j++;
    }
    const thick = sum / short;
    if (w >= h) { let yy = y; for (const r of row) { const hh = r.a / thick; out.push({ item: r.it, x, y: yy, w: thick, h: hh }); yy += hh; } x += thick; w -= thick; }
    else { let xx = x; for (const r of row) { const ww = r.a / thick; out.push({ item: r.it, x: xx, y, w: ww, h: thick }); xx += ww; } y += thick; h -= thick; }
    i = j;
  }
  return out;
}
// Diverging color: neutral gray at no change, growing toward the up or down hue. Returns [r, g, b].
const hex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(s.trim()); const v = m ? parseInt(m[1], 16) : 0x808080; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
export function tileRgb(pct, full, mid, up, down) {
  if (!(pct === pct)) return mid;
  const x = clamp(pct / full, -1, 1), a = Math.pow(Math.abs(x), 0.75), to = x >= 0 ? up : down;
  return mid.map((m, k) => Math.round(m + (to[k] - m) * a));
}
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

// ───────────────────────── the view ─────────────────────────
let root, cfg, lists = {}, rows = [], loadedFor = null, loadSeq = 0, focus = null, timer = null, shared = false, built = 0, note = '';
const persist = () => store.set('mk.cfg', cfg);
const clock = (s) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const money = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${Math.round(v / 1e3)}K`);
const groupOf = (r) => r.sector || TYPE_GROUP[r.type] || 'Other';

async function load() {
  const my = ++loadSeq, syms = lists[cfg.list] || [], be = await backend(), ix = be.info();
  let stamp = 0;
  const { sectors, stocks } = await stockSectors();
  const out = [];
  if (ix) {
    const pk = await be.pack(syms.some((s) => { const e = ix.by.get(s); return e && e.tier === 3; }));
    if (my !== loadSeq) return;
    if (pk.generated === built && loadedFor === cfg.list) return; // nothing new since the last look
    stamp = pk.generated;
    for (const sym of syms) {
      const row = pk.s[sym], e = ix.by.get(sym); if (!row || !e) continue;
      const p = decodePack(row);
      out.push({ sym, name: e.name, type: e.type, sector: e.sector != null ? ix.sectors[e.sector] : null, f: p.f, s: stats(p) });
    }
  } else {
    const st = root.querySelector('.mk-note');
    const { bars } = await getBatch(syms, '1d', { limit: 400, maxAge: 240000, onProgress: (d, n) => { if (st && my === loadSeq && d < n) st.textContent = `Loading ${d} of ${n}…`; } });
    stamp = Date.now() / 1000;
    for (const sym of syms) {
      const b = bars.get(sym); if (!b || b.t.length < 2) continue;
      out.push({ sym, name: b.meta.name || sym, type: b.meta.type, sector: stocks[sym] != null ? sectors[stocks[sym]] : null, f: stamp, s: stats(packFromBars(b)) });
    }
  }
  if (my !== loadSeq) return; // a newer request owns the view; this one must leave no trace
  built = stamp;
  // A symbol whose newest bar is older than its kind's newest has not been read since the session
  // changed (the wider list is refreshed in turns). Its "1 day" change is yesterday's: say so
  // instead of mixing sessions.
  const newest = {};
  for (const r of out) newest[r.type] = Math.max(newest[r.type] || 0, r.s.t);
  for (const r of out) r.old = r.s.t < newest[r.type];
  rows = out; loadedFor = cfg.list;
  const fs = rows.map((r) => r.f).filter(Boolean);
  note = !rows.length ? '' : shared
    ? `Exchange quotes read ${clock(Math.min(...fs)) === clock(Math.max(...fs)) ? `at ${clock(Math.max(...fs))}` : `between ${clock(Math.min(...fs))} and ${clock(Math.max(...fs))}`} your time; the feed itself runs up to 15 minutes late. Not live estimates.`
    : `Exchange quotes as of ${clock(built)}; the feed runs up to 15 minutes late.`;
  const behind = rows.filter((r) => r.old).length;
  if (behind) note += ` ${behind} ${behind === 1 ? 'symbol has' : 'symbols have'} no bar for the newest session yet: gray on the 1-day view.`;
  draw();
}

function theme() {
  const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim(), light = document.documentElement.dataset.theme === 'light';
  return { mid: hex(light ? '#d9dee5' : '#2a323d'), up: hex(light ? '#0f9a74' : '#16b88c'), down: hex(light ? '#d8443c' : '#e5564e'), upCss: v('--up'), downCss: v('--down') };
}

function draw() {
  if (!root) return;
  const per = cfg.period, perName = PERIODS.find((p) => p[0] === per)[1], th = theme();
  const val = (r) => (per === '1D' && r.old ? NaN : r.s.chg[per]); // see `old` in load()
  const head = root.querySelector('.mk-head'), body = root.querySelector('.mk-body');
  clear(head); clear(body);
  head.append(h('h2', null, 'Markets'),
    h('select', { title: 'Which list to show', onchange: (e) => { cfg.list = e.target.value; focus = null; persist(); draw(); load(); } }, Object.keys(lists).map((k) => h('option', { value: k, selected: k === cfg.list }, k))),
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, PERIODS.map(([id, name]) => h('button', { class: id === per ? 'on' : '', title: `Change over ${name}`, onclick: () => { cfg.period = id; persist(); draw(); } }, id))),
    h('label', { class: 'mk-size', title: 'Tile area. Dollar volume is the average value traded per day over the last 20 sessions.' }, 'Size by',
      h('select', { onchange: (e) => { cfg.size = e.target.value; persist(); draw(); } }, [['dv', 'Dollar volume'], ['eq', 'Equal']].map(([v, l]) => h('option', { value: v, selected: cfg.size === v }, l)))),
    h('span', { class: 'mk-note muted' }, loadedFor === cfg.list ? note : 'Loading…'));
  if (loadedFor !== cfg.list) return;
  if (!rows.length) { body.append(h('div', { class: 'empty' }, 'No data for this list.')); return; }

  // breadth
  const br = breadth(rows, per, val), pc = (x) => (x === x ? `${x.toFixed(0)}%` : '–');
  const tile = (label, value, sub, cls) => h('div', { class: 'stat' }, h('small', null, label), h('b', { class: cls || '' }, value), sub ? h('span', { class: 'muted' }, sub) : null);
  body.append(h('div', { class: 'stats' },
    tile(`Advancing · ${per}`, br.n ? `${br.up} of ${br.n}` : '–', br.n ? `${pc((br.up / br.n) * 100)} up, ${br.down} down` : ''),
    tile(`Median change · ${per}`, fmtPct(br.median), '', br.median >= 0 ? 'up' : 'dn'),
    tile('Above 50-day average', pc(br.above50), 'of those with 50 days of history'),
    tile('Above 200-day average', pc(br.above200), 'of those with 200 days of history'),
    tile('52-week closing highs / lows', `${br.highs} / ${br.lows}`, 'newest close is the highest or lowest of the year')));

  // groups
  const groups = new Map();
  for (const r of rows) { const g = groupOf(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
  if (focus && !groups.has(focus)) focus = null;
  const gstats = [...groups].map(([name, list]) => ({ name, list, b: breadth(list, per, val) })).sort((a, b) => (b.b.median === b.b.median ? b.b.median : -1e9) - (a.b.median === a.b.median ? a.b.median : -1e9));

  // heat map
  const full = FULL[per], map = h('div', { class: 'hmap', role: 'img', 'aria-label': `Heat map of ${rows.length} symbols colored by change over ${perName}; the same figures are in the tables below.` }), tip = h('div', { class: 'hmap-tip', hidden: true });
  const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  const legend = h('div', { class: 'hmap-legend' }, h('span', null, `−${full}%`), h('i', { style: { background: `linear-gradient(90deg, ${css(th.down)}, ${css(th.mid)}, ${css(th.up)})` } }), h('span', null, `+${full}%`),
    h('span', { class: 'muted' }, `color = change over ${perName} · area = ${cfg.size === 'dv' ? 'dollars traded a day (20-day average)' : 'equal'}${focus ? '' : ' · click a tile to open its chart'}`),
    focus ? h('button', { class: 'ghost', onclick: () => { focus = null; draw(); } }, `Showing ${focus} only · show all`) : null);
  const shown = focus ? gstats.filter((g) => g.name === focus) : gstats;
  const lay = () => {
    clear(map);
    const W = map.clientWidth, H = map.clientHeight; if (W < 40 || H < 40) return;
    // symbols with no dollar-volume figure (indexes, futures, currencies) take the typical size
    const sum = shown.reduce((s, g) => s + g.list.reduce((q, r) => q + (r.s.dv || 0), 0), 0), floor = sum * 0.0004;
    const typical = median(shown.flatMap((g) => g.list.map((r) => r.s.dv || NaN))) || 1;
    const size = (r) => (cfg.size === 'eq' ? 1 : Math.max(r.s.dv || typical, floor, 1));
    const boxes = treemap(shown.map((g) => ({ g, v: g.list.reduce((s, r) => s + size(r), 0) })), 0, 0, W, H);
    for (const bx of boxes) {
      const g = bx.item.g, label = shown.length > 1 && bx.w > 70 && bx.h > 46, top = label ? 15 : 0;
      if (label) map.append(h('div', { class: 'hmap-group', style: { left: bx.x + 2 + 'px', top: bx.y + 1 + 'px', width: bx.w - 4 + 'px' }, title: `${g.name}: median ${fmtPct(g.b.median)} over ${perName}. Click to show only this group.`, onclick: () => { focus = g.name; draw(); } }, g.name, h('span', null, fmtPct(g.b.median, 1))));
      for (const t of treemap(g.list.map((r) => ({ r, v: size(r) })), bx.x + 1, bx.y + top + 1, bx.w - 2, bx.h - top - 2)) {
        const r = t.item.r, x = val(r), rgb = tileRgb(x, full, th.mid, th.up, th.down), w = t.w - 2, hh = t.h - 2; if (w < 1 || hh < 1) continue;
        const fs = clamp(Math.min(w / 4.3, hh / 2.5), 9, 19), el = h('div', { class: 'tile', 'data-sym': r.sym, style: { left: t.x + 1 + 'px', top: t.y + 1 + 'px', width: w + 'px', height: hh + 'px', background: css(rgb), color: lum(rgb) > 0.36 ? '#0b0e12' : '#f3f6f9', fontSize: fs + 'px' } });
        if (w >= 30 && hh >= 15) el.append(h('b', null, r.sym));
        if (w >= 40 && hh >= 31 && x === x) el.append(h('span', null, fmtPct(x, Math.abs(x) >= 10 ? 1 : 2)));
        map.append(el);
      }
    }
  };
  const bySym = new Map(rows.map((r) => [r.sym, r]));
  map.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.tile'), r = el && bySym.get(el.dataset.sym);
    if (!r) { tip.hidden = true; return; }
    clear(tip);
    tip.append(h('div', null, h('b', null, r.sym), ' ', h('span', { class: 'muted' }, r.name)),
      val(r) === val(r) ? h('div', null, fmtPrice(r.s.last), ' ', h('b', { class: val(r) >= 0 ? 'up' : 'dn' }, fmtPct(val(r))), h('span', { class: 'muted' }, ` over ${perName}`))
        : h('div', null, fmtPrice(r.s.last), ' ', h('span', { class: 'muted' }, r.old ? `newest bar is ${fmtDate(r.s.t)}: not read yet this session` : `no figure for ${perName}`)),
      h('div', { class: 'muted' }, PERIODS.filter(([id]) => id !== per).map(([id]) => `${id} ${fmtPct(r.s.chg[id], 1)}`).join(' · ')),
      h('div', { class: 'muted' }, `${r.s.dv ? `${money(r.s.dv)} a day` : 'no dollar-volume figure'} · ${r.s.atHigh ? '52-week closing high' : r.s.atLow ? '52-week closing low' : r.s.fromHigh === r.s.fromHigh ? `${fmtPct(r.s.fromHigh, 1)} from 52-week high` : 'under a year of history'} · read ${clock(r.f)}`));
    tip.hidden = false;
    const box = map.getBoundingClientRect(), tw = tip.offsetWidth, thh = tip.offsetHeight;
    tip.style.left = clamp(e.clientX - box.left + 14, 0, Math.max(0, box.width - tw)) + 'px';
    tip.style.top = (e.clientY - box.top + 16 + thh > box.height ? e.clientY - box.top - thh - 10 : e.clientY - box.top + 16) + 'px';
  });
  map.addEventListener('mouseleave', () => { tip.hidden = true; });
  map.addEventListener('click', (e) => { const el = e.target.closest('.tile'); if (el) api.openChart(el.dataset.sym, '1d'); });
  const wrap = h('div', { class: 'hmap-wrap' }, map, tip);

  // group table (also the table view of the heat map's group level)
  const maxAbs = Math.max(0.01, ...gstats.map((g) => Math.abs(g.b.median) || 0));
  const gt = h('table', { class: 'grid mk-groups' }, h('thead', null, h('tr', null, h('th', null, groups.size > 1 ? 'Group' : 'List'), h('th', null, `Median ${per}`), h('th', { class: 'l' }, ''), h('th', { title: 'Share of the group that is up over the period' }, 'Up'), h('th', { title: 'Share of the group above its 50-day average' }, '> 50-day'), h('th', { title: 'Symbols in the group' }, 'N'))),
    h('tbody', null, gstats.map((g) => {
      const m = g.b.median, wd = m === m ? (Math.abs(m) / maxAbs) * 50 : 0;
      return h('tr', { class: focus === g.name ? 'cur' : '', title: 'Show only this group in the heat map', onclick: () => { focus = focus === g.name ? null : g.name; draw(); } },
        h('td', null, g.name), h('td', { class: m >= 0 ? 'up' : 'dn' }, fmtPct(m)),
        h('td', { class: 'l' }, h('div', { class: 'dbar' }, h('i', { style: { width: wd + '%', [m >= 0 ? 'left' : 'right']: '50%', background: m >= 0 ? th.upCss : th.downCss } }))),
        h('td', null, g.b.n ? pc((g.b.up / g.b.n) * 100) : '–'), h('td', null, pc(g.b.above50)), h('td', null, String(g.list.length)));
    })));

  // movers
  const pool = (focus ? rows.filter((r) => groupOf(r) === focus) : rows).filter((r) => val(r) === val(r)).sort((a, b) => val(b) - val(a));
  const mv = (title, list) => h('div', null, h('h4', null, title), h('table', { class: 'grid' }, h('tbody', null, list.map((r) => h('tr', { onclick: () => api.openChart(r.sym, '1d') },
    h('td', null, h('b', null, r.sym)), h('td', { class: 'l muted mk-name' }, r.name), h('td', null, fmtPrice(r.s.last)), h('td', { class: val(r) >= 0 ? 'up' : 'dn' }, fmtPct(val(r))))))));
  const k = Math.min(10, Math.floor(pool.length / 2));
  body.append(legend, wrap, h('div', { class: 'mk-tables' },
    h('div', null, h('h4', null, groups.size > 1 ? 'By group' : 'Summary'), gt),
    k ? mv(`Strongest · ${per}`, pool.slice(0, k)) : null, k ? mv(`Weakest · ${per}`, pool.slice(-k).reverse()) : null));
  lay();
  drawn = lay;
}
let drawn = null;

export async function mount(el) {
  root = el;
  cfg = store.get('mk.cfg', null) || { list: '', period: '1D', size: 'dv' };
  el.append(h('div', { class: 'mk' }, h('div', { class: 'mk-head' }), h('div', { class: 'mk-body' }, h('div', { class: 'empty' }, 'Loading…'))));
  const be = await backend();
  shared = !!be.info();
  const uni = await universes(), wls = Object.fromEntries(Object.entries(api.watchlists()).map(([k, v]) => ['Watchlist: ' + k, v]));
  lists = { ...uni, ...wls };
  // start on the S&P 500: it groups by sector and loads quickly
  const names = Object.keys(lists);
  if (!lists[cfg.list]) cfg.list = names.find((k) => k.startsWith('S&P 500')) || names.find((k) => k.startsWith('Large caps')) || names[0];
  let rt = null;
  const relay = () => { clearTimeout(rt); rt = setTimeout(() => { if (drawn && root.offsetParent) drawn(); }, 80); };
  window.addEventListener('resize', relay);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(relay).observe(el);
  bus.on('theme', () => draw());
  bus.on('view', (v) => { if (v === 'markets') { if (drawn) drawn(); refresh(); } });
  draw();
  await load().catch((e) => { clear(root.querySelector('.mk-body')).append(h('div', { class: 'empty' }, 'Markets could not load: ' + e.message)); });
  // the shared snapshot is rebuilt every few minutes and costs one small request to check;
  // with a server each refresh is a request per symbol, so it is left at five minutes
  timer = setInterval(refresh, shared ? 60000 : 300000);
}
function refresh() {
  if (!root || !root.offsetParent || document.hidden) return;
  load().catch(() => { /* keep what is shown */ });
}

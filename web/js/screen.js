// Screening every symbol at once.
//
// The Scanner's filters read a row of daily values per symbol (SCREEN_COLS), and its preset scans
// can be answered without downloading anything: each shared-site build runs tools/screen.mjs, which
// applies these same functions to every daily file it publishes and writes data/screen.json. With
// a server, the Scanner applies them to the bars it loads itself. One implementation, so the
// instant answers are exactly what a scan of the downloaded files would give.
import { calcIndicator } from './ta.js';
import { evalRuleset, requiredTfs, newRuleset, cmp, price, num, ind } from './conditions.js';
import { TF, aggregate, sliceBars } from './data.js';
import { stats, packFromBars } from './markets.js';

export const PRESETS = {
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

// How many of the newest bars a scan reads at timeframe `t`, when its rules need `tfs`: daily-based
// history is cut to 800 bars (2,600 when a weekly or monthly condition needs years of it).
export function scanLimit(tfs, t) {
  const long = tfs.some((x) => x === '1w' || x === '1mo');
  return TF[t].base === '1d' ? (long ? 2600 : 800) : 0;
}
// The bars a scan of `rs` on `baseTf` reads, from one symbol's full daily history (the shared
// page's files; the Scanner downloads the same cut). Daily-based timeframes only.
export function scanBars(rs, baseTf, daily) {
  const tfs = requiredTfs(rs, baseTf), byTf = new Map();
  for (const t of tfs) { const lim = scanLimit(tfs, t), b = lim ? sliceBars(daily, daily.t.length - lim) : daily; byTf.set(t, t === b.tf ? b : aggregate(b, t)); }
  return { base: byTf.get(baseTf), byTf };
}
// Did the rules hold on one of the last `within` bars? How many bars ago it last did, or -1.
// Fewer than 30 bars is too little history to scan.
export function matchAgo(rs, base, byTf, within) {
  if (!base || base.t.length < 30) return -1;
  const { mask } = evalRuleset(rs, base, byTf), n = base.t.length;
  for (let k = 0; k < within && k < n; k++) if (mask[n - 1 - k]) return k;
  return -1;
}

// A ruleset in a canonical form: what the builder leaves at its default (no offset, a multiplier
// of 1, the chart's timeframe) is dropped, so an untouched preset compares equal to a fresh one.
function canonOperand(o) {
  if (!o) return null;
  const out = { type: o.type };
  if (o.type === 'num') out.value = Number(o.value);
  else if (o.type === 'price') out.field = o.field || 'close';
  else { out.id = o.id; out.out = o.out; out.params = Object.fromEntries(Object.keys(o.params || {}).sort().map((k) => [k, o.params[k]])); }
  if (o.type !== 'num') { if (o.offset | 0) out.offset = o.offset | 0; if (o.mult != null && o.mult !== '' && Number(o.mult) !== 1) out.mult = Number(o.mult); }
  return out;
}
function canon(rs) {
  return JSON.stringify({
    mode: rs.mode === 'any' ? 'any' : 'all',
    conds: (rs.conds || []).map((c) => c.kind === 'candle' ? { kind: 'candle', tf: c.tf || null, pattern: c.pattern, within: Math.max(1, c.within | 0) }
      : c.kind === 'auto' ? { kind: 'auto', tf: c.tf || null, signal: c.signal }
      : { kind: 'cmp', tf: c.tf || null, a: canonOperand(c.a), op: c.op, b: canonOperand(c.b) }),
  });
}
const presetCanon = new Map(Object.entries(PRESETS).map(([k, f]) => [canon(f()), k]));
// The preset a ruleset is, unchanged, or null.
export const presetOf = (rs) => presetCanon.get(canon(rs)) || null;

// ── the screening row ──
export const SCREEN_COLS = [
  { k: 'last', label: 'Last', fmt: 'price', long: 'Last close' },
  { k: 'chg', label: 'Chg %', fmt: 'pct', long: '1-day change %' },
  { k: 'w1', label: '1W %', fmt: 'pct', long: '1-week change %' },
  { k: 'm1', label: '1M %', fmt: 'pct', long: '1-month change %' },
  { k: 'm3', label: '3M %', fmt: 'pct', long: '3-month change %' },
  { k: 'ytd', label: 'YTD %', fmt: 'pct', long: 'Year-to-date change %' },
  { k: 'y1', label: '1Y %', fmt: 'pct', long: '1-year change %' },
  { k: 'vol', label: 'Volume', fmt: 'vol', long: 'Latest volume' },
  { k: 'dv', label: '$ volume', fmt: 'usd', long: 'Average dollar volume, 20 days' },
  { k: 'rvol', label: 'Rel vol', fmt: 'num', long: 'Relative volume (20)' },
  { k: 'rsi', label: 'RSI', fmt: 'num', long: 'RSI (14)' },
  { k: 's50', label: 'vs SMA 50', fmt: 'pct', long: '% above the 50-day SMA' },
  { k: 's200', label: 'vs SMA 200', fmt: 'pct', long: '% above the 200-day SMA' },
  { k: 'atr', label: 'ATR %', fmt: 'pct', long: 'ATR (14) as % of price' },
  { k: 'hi52', label: 'From 52w high', fmt: 'pct', long: '% from the 52-week high (0 = at it)' },
  { k: 'lo52', label: 'Over 52w low', fmt: 'pct', long: '% above the 52-week low' },
  { k: 'gap', label: 'Gap %', fmt: 'pct', long: "Latest open vs the previous close, %" },
];
export const SCREEN_KEYS = SCREEN_COLS.map((c) => c.k);
const fin = (x) => typeof x === 'number' && x === x && Math.abs(x) !== Infinity;
const r2 = (x) => (fin(x) ? Math.round(x * 100) / 100 : null);
const sig = (x) => (fin(x) ? Number(x.toPrecision(6)) : null);
const whole = (x) => (fin(x) ? Math.round(x) : null);
// Dollar volume, or null when there is no figure: an index, a future, a currency, or a stock in
// another currency without a rate all come as 0, which is "unknown", not "nothing traded". A
// blank passes no filter (0 would pass every "at most" one) and shows as a dash.
const knownDv = (x) => (fin(x) && x > 0 ? Math.round(x) : null);
const lastOf = (id, b, params, out = 'value') => { const r = calcIndicator(id, b, params); return r && !r.__error && r[out] ? r[out][b.t.length - 1] : NaN; };
const pctOver = (x, y) => (fin(x) && fin(y) && y > 0 ? (x / y - 1) * 100 : NaN);

/**
 * One symbol's screening row from its daily bars (the same 800-bar cut a daily scan reads), in
 * SCREEN_COLS order. Prices as published (not dividend-adjusted), like the Scanner and Markets.
 * `dv`: dollar volume from the shared page's summary, which converts other currencies; without
 * it, the Markets view's own figure. Blank (null) when there is none: see knownDv.
 */
export function screenRow(daily, dv) {
  const b = sliceBars(daily, daily.t.length - 800), n = b.t.length;
  if (n < 2) return null;
  const c = b.c[n - 1], s = stats({ t: b.t, c: b.c });
  const v = {
    last: sig(c), chg: r2(pctOver(c, b.c[n - 2])),
    w1: r2(s.chg['1W']), m1: r2(s.chg['1M']), m3: r2(s.chg['3M']), ytd: r2(s.chg.YTD), y1: r2(s.chg['1Y']),
    vol: whole(b.v[n - 1]), dv: knownDv(dv != null ? dv : packFromBars(b).dv),
    rvol: r2(lastOf('rvol', b, { len: 20 })), rsi: r2(lastOf('rsi', b, { len: 14, src: 'close' })),
    s50: r2(pctOver(c, lastOf('sma', b, { len: 50, src: 'close' }))), s200: r2(pctOver(c, lastOf('sma', b, { len: 200, src: 'close' }))),
    atr: r2((lastOf('atr', b, { len: 14 }) / c) * 100),
    hi52: r2(pctOver(c, lastOf('donchian', b, { len: 252 }, 'upper'))), lo52: r2(pctOver(c, lastOf('donchian', b, { len: 252 }, 'lower'))),
    gap: r2(pctOver(b.o[n - 1], b.c[n - 2])),
  };
  return SCREEN_KEYS.map((k) => v[k]);
}

export const AGO_DEPTH = 10; // preset matches are kept for this many of the newest bars

// The calendar day (days since 1970) it is now where a market is, for a time zone name.
const dayFmt = new Map();
export function localDay(tz, now) {
  const zone = tz || 'America/New_York';
  let f = dayFmt.get(zone);
  if (!f) {
    const opt = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try { f = new Intl.DateTimeFormat('en-CA', { ...opt, timeZone: zone }); } catch { f = new Intl.DateTimeFormat('en-CA', { ...opt, timeZone: 'America/New_York' }); }
    dayFmt.set(zone, f);
  }
  const [y, m, d] = f.format(new Date(now * 1000)).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}
export const isoDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
// Seconds a time zone's wall clock is ahead of UTC at an instant.
const offFmt = new Map();
function zoneOffset(tz, utc) {
  let f = offFmt.get(tz);
  if (!f) {
    const opt = { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
    try { f = new Intl.DateTimeFormat('en-US', { ...opt, timeZone: tz }); } catch { f = new Intl.DateTimeFormat('en-US', { ...opt, timeZone: 'America/New_York' }); }
    offFmt.set(tz, f);
  }
  const p = {}; for (const x of f.formatToParts(new Date(Math.floor(utc) * 1000))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - Math.floor(utc);
}
/**
 * From when is the daily bar dated `day` (days since 1970 on its market's calendar) final? A copy
 * of the series fetched before that may hold a bar that was still forming, whatever the date says.
 *   coins and currencies   the end of that day where they are quoted (midnight UTC, or London)
 *   everything else        half an hour after New York's close on that date (an hour and a half
 *                          for futures): Asia's and Europe's sessions of the date ended hours before
 */
export function finalAfter(day, type, tz) {
  if (type === 'CRYPTOCURRENCY' || type === 'CURRENCY') { const z = tz || 'UTC', end = (day + 1) * 86400; return end - zoneOffset(z, end); }
  const local = day * 86400 + (type === 'FUTURE' ? 17.5 : 16.5) * 3600;
  return local - zoneOffset('America/New_York', local + 5 * 3600);
}

/**
 * Everything the build publishes for one symbol, from its full daily history:
 *   row     its screening row
 *   ago     preset name -> bars ago of the latest match on one of the newest AGO_DEPTH bars (the
 *           newest may still be forming): what an instant preset scan answers
 *   final   { day, hits }: the presets that matched on its newest finished bar, for the daily
 *           signals feed. Finished: dated before today where the market is, and (when `fetched`,
 *           the time this copy was read from the provider, is given) read after that session
 *           ended: a copy taken mid-session and not refreshed since has a half-day bar.
 */
export function screenSymbol(daily, { now = Date.now() / 1000, dv, fetched } = {}) {
  const n = daily.t.length;
  if (n < 2) return null;
  const out = { row: screenRow(daily, dv), ago: {}, final: null };
  const run = (bars) => {
    const hits = {};
    for (const [name, make] of Object.entries(PRESETS)) {
      const rs = make(), { base, byTf } = scanBars(rs, '1d', bars), k = matchAgo(rs, base, byTf, AGO_DEPTH);
      if (k >= 0) hits[name] = k;
    }
    return hits;
  };
  out.ago = run(daily);
  const meta = daily.meta || {}, today = localDay(meta.tz, now);
  const finished = (i) => { const day = Math.floor(daily.t[i] / 86400); return day < today && (fetched == null || fetched >= finalAfter(day, meta.type, meta.tz)); };
  let k = n - 1;
  while (k >= 0 && !finished(k)) k--;
  if (k >= 0) {
    const day = Math.floor(daily.t[k] / 86400);
    const hits = k === n - 1 ? Object.keys(out.ago).filter((name) => out.ago[name] === 0) : Object.entries(run(uptoBars(daily, k + 1))).filter(([, a]) => a === 0).map(([name]) => name);
    out.final = { day, hits };
  }
  return out;
}
// The first `end` bars.
export function uptoBars(bars, end) {
  if (end >= bars.t.length) return bars;
  const out = { symbol: bars.symbol, tf: bars.tf, meta: bars.meta };
  for (const key of ['t', 'o', 'h', 'l', 'c', 'v', 'a']) if (bars[key]) out[key] = bars[key].slice(0, end);
  return out;
}

// ── several sites' screen files -> one view ──
/** `files` is [screen.json, ...]: { cols, rows: { SYM: [...] }, presets: { name: { SYM: ago } } }.
 *  Returns { cols, row(sym) -> { k: value } | null, ago(name, sym) -> bars ago | undefined, has(name), generated }. */
export function mergeScreens(files) {
  const rows = new Map(), presets = new Map(), cols = SCREEN_KEYS;
  let generated = 0, oldest = Infinity;
  for (const f of files) {
    if (!f || !f.rows) continue;
    generated = Math.max(generated, f.generated || 0); oldest = Math.min(oldest, f.generated || 0);
    const idx = cols.map((k) => (f.cols || []).indexOf(k));
    for (const [s, r] of Object.entries(f.rows)) if (!rows.has(s)) rows.set(s, Object.fromEntries(cols.map((k, i) => [k, idx[i] >= 0 ? r[idx[i]] : null])));
    for (const [name, hits] of Object.entries(f.presets || {})) {
      let m = presets.get(name); if (!m) presets.set(name, (m = new Map()));
      for (const [s, a] of Object.entries(hits)) if (!m.has(s)) m.set(s, a);
    }
  }
  // `oldest`: the build time to show for an answer drawn from all of them (the sites build on their own schedules)
  return { cols, generated, oldest: oldest === Infinity ? 0 : oldest, size: rows.size, row: (s) => rows.get(s) || null, ago: (name, s) => { const m = presets.get(name); return m ? m.get(s) : undefined; }, has: (name) => presets.has(name) };
}

// ── filters ──
export const FILTER_OPS = [{ id: 'gte', label: '≥' }, { id: 'lte', label: '≤' }];
// A filter's value as typed: a number (1500, 1.5e3), optionally with K, M or B (10M = 10,000,000). NaN if not one.
export function parseAmount(v) {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([kmb]?)\s*$/i.exec(String(v == null ? '' : v).replace(/[,_$%]/g, ''));
  return m ? Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()]) : NaN;
}
export const validFilters = (fs) => (fs || []).filter((f) => SCREEN_KEYS.includes(f.k) && (f.op === 'gte' || f.op === 'lte') && Number.isFinite(parseAmount(f.v)));
// Does a screening row ({ key: value }) pass every filter? A blank value passes none.
export function passes(row, filters) {
  if (!row) return false;
  for (const f of filters) { const x = row[f.k], v = parseAmount(f.v); if (x == null || !(f.op === 'gte' ? x >= v : x <= v)) return false; }
  return true;
}
export const rowObject = (arr) => (arr ? Object.fromEntries(SCREEN_KEYS.map((k, i) => [k, arr[i]])) : null);
export const describeFilters = (fs) => validFilters(fs).map((f) => { const c = SCREEN_COLS.find((x) => x.k === f.k); return `${c.long || c.label} ${f.op === 'gte' ? '≥' : '≤'} ${String(f.v).trim()}`; }).join('  AND  ');

// ── the daily signals feed ──
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Atom feed of daily preset matches. `entries`: [{ date: 'YYYY-MM-DD', added: unix s, presets: { name: [SYM, ...] } }],
 *  newest first, symbols already in order (most traded first). `site`: the page's address, ending in '/'. */
export function atomFeed(entries, site, cap = 40) {
  const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const long = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const items = entries.map((e) => {
    const names = Object.keys(PRESETS).filter((k) => (e.presets[k] || []).length);
    const total = names.reduce((s, k) => s + e.presets[k].length, 0);
    const body = names.map((k) => {
      const syms = e.presets[k], shown = syms.slice(0, cap);
      return `<h3>${esc(k)} (${syms.length})</h3><p>${shown.map((s) => `<a href="${esc(site)}#/chart/${encodeURIComponent(s)}/1d">${esc(s)}</a>`).join(', ')}${syms.length > cap ? ` and ${syms.length - cap} more` : ''}</p>`;
    }).join('') || '<p>No preset matched on this close.</p>';
    return `  <entry>\n    <title>${esc(`Signals at the close of ${long(e.date)}: ${total} match${total === 1 ? '' : 'es'}${e.partial ? ' (main site only)' : ''}`)}</title>\n    <id>${esc(site)}signals.xml#${e.date}</id>\n    <updated>${iso(e.updated || e.added)}</updated>\n    <link href="${esc(site)}#/scanner"/>\n    <content type="html">${esc(body)}</content>\n  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <title>Meridian daily signals</title>\n  <subtitle>Which symbols each of the Scanner's presets matched at the close, every trading day.</subtitle>\n  <link href="${esc(site)}signals.xml" rel="self"/>\n  <link href="${esc(site)}"/>\n  <id>${esc(site)}signals.xml</id>\n  <updated>${iso(entries.reduce((m, e) => Math.max(m, e.updated || e.added || 0), 0))}</updated>\n  <author><name>Meridian</name></author>\n${items.join('\n')}\n</feed>\n`;
}

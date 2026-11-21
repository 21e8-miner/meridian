// Data backend for the shared static site (GitHub Pages), where there is no Meridian server.
//
// Exchange history comes from a snapshot a scheduled job publishes next to the page
// (data/<tf>/<symbol>.json, see tools/snapshot.py). The page then brings each series up to the
// second by itself, projecting from Hyperliquid, which a browser is allowed to read directly.
//
// The functions below are a line-for-line port of the live-fill code in server.py. Keep the two in
// step: tests/parity.mjs runs both on the same inputs and compares the results.

const HL = 'https://api.hyperliquid.xyz/info';
export const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 };
const STOCK_TYPES = ['EQUITY', 'ETF'];
const MAX_PROXY_MINUTES = 15000;
const LAG_MIN = 20;

export function round(x) { const a = Math.abs(x); return Number(x.toFixed(a >= 100 ? 3 : a >= 1 ? 4 : 8)); }
export function hlCoin(symbol) { const s = String(symbol).trim(); return s.slice(0, 4).toLowerCase() === 'xyz:' && s.length > 4 ? 'xyz:' + s.slice(4).toUpperCase() : null; }
const isCrypto = (s) => s.endsWith('-USD') || s.endsWith('-USDT');

// ── time zones: seconds to add to a UTC time to get the wall clock there ──
const offCache = new Map(), fmts = new Map();
export function tzOffset(tz, utc) {
  const day = Math.floor(utc / 86400), key = tz + '|' + day;
  let off = offCache.get(key);
  if (off === undefined) {
    let f = fmts.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); fmts.set(tz, f); }
    const p = {}; for (const x of f.formatToParts(new Date(Math.floor(utc) * 1000))) p[x.type] = Number(x.value);
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - Math.floor(utc);
    offCache.set(key, off);
  }
  return off;
}
export function wallFn(tz) { let zone = tz || 'America/New_York'; try { tzOffset(zone, 0); } catch { zone = 'America/New_York'; } return (utc) => Math.floor(utc) + tzOffset(zone, utc); }

// ── market sessions (server.py: session_open) ──
export function sessionOpen(symbol, utc = Date.now() / 1000, lag = LAG_MIN) {
  if (isCrypto(symbol) || hlCoin(symbol)) return true;
  const d = new Date((Math.floor(utc) + tzOffset('America/New_York', utc)) * 1000);
  const wd = (d.getUTCDay() + 6) % 7, mins = d.getUTCHours() * 60 + d.getUTCMinutes(); // Monday = 0
  if (symbol.endsWith('=F')) {
    if (wd === 5) return false;
    if (wd === 6) return mins >= 18 * 60;
    if (wd === 4) return mins < 17 * 60 + lag;
    return !(17 * 60 + lag <= mins && mins < 18 * 60);
  }
  if (symbol.endsWith('=X')) {
    if (wd === 5) return false;
    if (wd === 6) return mins >= 17 * 60;
    if (wd === 4) return mins < 17 * 60 + lag;
    return true;
  }
  if (wd >= 5) return false;
  return (lag ? 9 * 60 + 25 : 9 * 60 + 30) <= mins && mins <= 16 * 60 + lag;
}

// ── the live fill (server.py: live_anchor, anchor_from_1m, _merge_minutes, splice_live, stock_minutes, splice_ext) ──
export function liveAnchor(data, tf) {
  const T = data.t, V = data.v;
  let k = T.length - 1;
  while (k >= 0 && !V[k]) k--;
  if (k < 0) return null;
  const asof = data.meta.asof, asofW = asof ? wallFn(data.meta.tz)(asof) : null;
  if (tf === '1d') {
    const close = T[k] + 17 * 3600, live = asofW !== null && T[k] - 6 * 3600 <= asofW && asofW < close;
    return [k, live ? asofW : close];
  }
  const end = T[k] + SEC[tf];
  return [k, asofW !== null && asofW > T[k] ? Math.min(end, asofW) : end];
}

export function anchorFrom1m(m1) {
  const T = m1.t, C = m1.c, V = m1.v;
  let k = T.length - 1;
  while (k >= 0 && !V[k]) k--;
  if (k < 0) return null;
  const asof = m1.meta.asof, asofW = asof ? wallFn(m1.meta.tz)(asof) : null;
  if (asofW !== null && asofW < T[k] + 60 && k > 0) k--;
  return [T[k] + 60, C[k]];
}

export function mergeMinutes(data, k, mins, tf) {
  const interval = SEC[tf], daily = tf === '1d';
  const T = data.t.slice(0, k + 1), O = data.o.slice(0, k + 1), H = data.h.slice(0, k + 1), L = data.l.slice(0, k + 1), C = data.c.slice(0, k + 1), V = data.v.slice(0, k + 1);
  const flags = [];
  let partial = false;
  for (const [wt, o0, h0, l0, c0, v, est] of mins) {
    const o = round(o0), h = round(h0), l = round(l0), c = round(c0);
    const b = daily ? Math.floor((wt + 6 * 3600) / 86400) * 86400 : T[k] + Math.floor((wt - T[k]) / interval) * interval;
    const last = T.length - 1;
    if (b <= T[last]) {
      H[last] = Math.max(H[last], h, c); L[last] = Math.min(L[last], l, c); C[last] = c; V[last] += v;
      if (last === k) partial = true; else flags[flags.length - 1] = flags[flags.length - 1] && est;
    } else {
      T.push(b); O.push(o); H.push(Math.max(h, o, c)); L.push(Math.min(l, o, c)); C.push(c); V.push(v); flags.push(est);
    }
  }
  const runs = [];
  let prev = -2;
  flags.forEach((f, j) => {
    if (!f) return;
    const t = T[k + 1 + j];
    if (runs.length && prev === j - 1) runs[runs.length - 1][1] = t; else runs.push([t, t]);
    prev = j;
  });
  return { cols: { t: T, o: O, h: H, l: L, c: C, v: V }, partial, added: flags.length, runs };
}

export function spliceLive(data, minutes, symbol, tf, coin, now, anchor = null) {
  const found = liveAnchor(data, tf);
  if (!found || !minutes.length) return data;
  const [k, own] = found;
  const [at, price] = anchor || [own, data.c[k]];
  const wall = wallFn(data.meta.tz);
  const pm = minutes.map(([u, o, h, l, c]) => [wall(u), o, h, l, c, u]);
  let i = -1;
  for (let j = 0; j < pm.length; j++) { if (pm[j][0] <= at - 1) i = j; else break; }
  if (i < 0 || at - 1 - pm[i][0] > 180 || !pm[i][4]) return data;
  const ratio = price / pm[i][4];
  const mins = pm.slice(i + 1).filter((m) => sessionOpen(symbol, m[5], 0)).map(([wt, o, h, l, c]) => [wt, ratio * o, ratio * h, ratio * l, ratio * c, 0, true]);
  const { cols, partial, added, runs } = mergeMinutes(data, k, mins, tf);
  if (!partial && !added) return data;
  const out = { ...data, ...cols };
  delete out.a;
  out.live = { kind: 'fill', src: coin, from: partial ? cols.t[k] : cols.t[k + 1], partial, bars: added, est: runs, anchor: at, anchorAge: Math.floor(wall(now) - at), ratio: Number(ratio.toFixed(6)), asof: Math.floor(now), price: cols.c[cols.c.length - 1], isEst: true };
  return out;
}

export function stockMinutes(rthEnd, rthClose, ext, proxy, nowWall, minGap = 120) {
  const real = new Map(), pmap = new Map();
  for (const r of ext) if (r[0] >= rthEnd) real.set(r[0], r);
  for (const r of proxy) pmap.set(r[0], r);
  const out = [];
  let lastT = rthEnd, lastP = rthClose, ratio = null;
  const end = Math.floor(nowWall / 60) * 60;
  for (let m = rthEnd; m <= end; m += 60) {
    const r = real.get(m);
    if (r) { out.push([m, r[1], r[2], r[3], r[4], r[5], false]); lastT = m + 60; lastP = r[4]; ratio = null; }
    else if (pmap.size && m - lastT >= minGap - 60 && pmap.has(m)) {
      if (ratio === null) {
        ratio = false;
        for (const back of [60, 120, 180]) { const a = pmap.get(lastT - back); if (a && a[4]) { ratio = lastP / a[4]; break; } }
      }
      if (ratio) { const p = pmap.get(m); out.push([m, ratio * p[1], ratio * p[2], ratio * p[3], ratio * p[4], 0, true]); }
    }
  }
  return [out, lastT];
}

export function spliceExt(data, ext, proxy, tf, coin, now) {
  const T = data.t;
  if (!T.length) return data;
  const k = T.length - 1, daily = tf === '1d', wall = wallFn(data.meta.tz);
  const rthEnd = daily ? T[k] + 16 * 3600 : T[k] + SEC[tf];
  const rows = [];
  for (let i = 0; i < ext.t.length; i++) if (ext.t[i] >= rthEnd) rows.push([ext.t[i], ext.o[i], ext.h[i], ext.l[i], ext.c[i], ext.v[i]]);
  const [mins, lastReal0] = stockMinutes(rthEnd, data.c[k], rows, proxy.map(([u, o, h, l, c]) => [wall(u), o, h, l, c]), wall(now));
  if (!mins.length) return data;
  const lastReal = Math.min(lastReal0, wall(now)), tail = mins[mins.length - 1];
  const live = { kind: 'ext', src: mins.some((m) => m[6]) ? coin : null, anchor: lastReal, anchorAge: Math.floor(wall(now) - lastReal), asof: Math.floor(now), price: round(tail[4]), base: data.c[k], isEst: !!tail[6], partial: false };
  if (daily) return { ...data, live: { ...live, from: null, bars: 0, est: [] } };
  const { cols, added, runs } = mergeMinutes(data, k, mins, tf);
  const out = { ...data, ...cols };
  delete out.a;
  out.live = { ...live, from: cols.t[k + 1], bars: added, est: runs };
  return out;
}

export function parseHl(candles, symbol, coin, tf, now = Date.now() / 1000) {
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const x of candles) {
    const t = Math.floor(Number(x.t) / 1000);
    if (out.t.length && t <= out.t[out.t.length - 1]) continue;
    const o = Number(x.o), h = Number(x.h), l = Number(x.l), c = Number(x.c);
    out.t.push(t); out.o.push(round(o)); out.h.push(round(Math.max(h, o, c))); out.l.push(round(Math.min(l, o, c))); out.c.push(round(c)); out.v.push(Number(x.v || 0));
  }
  if (!out.t.length) throw new Error('no data for symbol');
  const lastT = out.t[out.t.length - 1], forming = now - lastT < SEC[tf];
  return { symbol, tf, ...out, meta: { name: `${coin.split(':')[1]} perpetual (Hyperliquid, live 24/7)`, currency: 'USD', exchange: 'Hyperliquid', type: 'PERP', tz: 'UTC', asof: forming ? Math.floor(now) : lastT + SEC[tf] } };
}

// 15- and 30-minute bars are built here from the snapshot's 5-minute bars.
export function regroup(data, tf) {
  const sec = SEC[tf], out = { ...data, tf, t: [], o: [], h: [], l: [], c: [], v: [] };
  let day = null, first = 0, cur = null, j = -1;
  for (let i = 0; i < data.t.length; i++) {
    const d = Math.floor(data.t[i] / 86400);
    if (d !== day) { day = d; first = data.t[i]; }
    const key = first + Math.floor((data.t[i] - first) / sec) * sec;
    if (key !== cur) { cur = key; j++; out.t.push(key); out.o.push(data.o[i]); out.h.push(data.h[i]); out.l.push(data.l[i]); out.c.push(data.c[i]); out.v.push(data.v[i]); }
    else { if (data.h[i] > out.h[j]) out.h[j] = data.h[i]; if (data.l[i] < out.l[j]) out.l[j] = data.l[i]; out.c[j] = data.c[i]; out.v[j] += data.v[i]; }
  }
  return out;
}

// ───────────────────────── network ─────────────────────────
async function post(body) {
  const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`live market HTTP ${r.status}`);
  return r.json();
}
const hlCandles = (coin, interval, startS, endS) => post({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(startS) * 1000, endTime: Math.floor(endS) * 1000 } });

const proxyCache = new Map(); // coin -> { at, first, rows, pending }
const row = (c) => [Math.floor(Number(c.t) / 1000), Number(c.o), Number(c.h), Number(c.l), Number(c.c)];
export async function proxyMinutes(coin, startS) {
  const hit = proxyCache.get(coin), now = Date.now() / 1000;
  if (hit && hit.pending) { try { await hit.pending; } catch { /* retried below */ } return proxyMinutes(coin, startS); }
  if (hit && now - hit.at < 3 && hit.first <= startS) return hit.rows;
  const work = (async () => {
    let rows, first;
    if (hit && hit.first <= startS && hit.rows.length && now - hit.rows[hit.rows.length - 1][0] < 4000 * 60) {
      const fresh = (await hlCandles(coin, '1m', hit.rows[hit.rows.length - 1][0] - 180, now + 60)).map(row);
      rows = fresh.length ? hit.rows.filter((r) => r[0] < fresh[0][0]).concat(fresh) : hit.rows; first = hit.first;
    } else {
      rows = []; first = Math.floor(startS);
      let cur = first;
      for (let n = 0; n < 4; n++) {
        const page = (await hlCandles(coin, '1m', cur, now + 60)).map(row).filter((r) => !rows.length || r[0] > rows[rows.length - 1][0]);
        rows = rows.concat(page);
        if (page.length < 4900 || now - rows[rows.length - 1][0] < 180) break;
        cur = rows[rows.length - 1][0];
      }
    }
    return { at: Date.now() / 1000, first, rows };
  })();
  proxyCache.set(coin, { ...(hit || { at: 0, first: Infinity, rows: [] }), pending: work });
  try { const fresh = await work; proxyCache.set(coin, fresh); return fresh.rows; }
  catch (e) { if (hit) proxyCache.set(coin, { at: hit.at, first: hit.first, rows: hit.rows }); else proxyCache.delete(coin); throw e; }
}

// ── the snapshot ──
// data/stamp.json is tiny and says when the snapshot was built and which symbol list goes with it;
// the list itself (data/catalog.json) is fetched again only when that changes.
// The data set can live on more than one site (tools/snapshot.py --part): this page's own, plus
// the "shards" its catalog names, each with its own stamp, catalog and files. They are merged into
// one index. A symbol can have some timeframes on one site and the rest on another (the broad
// tier's daily history on the data site, its hourly here): it remembers which site has each
// (`bases`, timeframe -> site). A shard that cannot be read leaves its files out (or keeps the copy
// read before) and the rest of the page works.
let index = null, indexAt = 0, hlNames = null;
const sites = new Map(); // base ('' = this site) -> { id, generated, cat }
const files = new Map(); // "tf|SYM" -> { g, data }
async function getJson(url, opts) { const r = await fetch(url, opts); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
async function readSite(base) {
  const st = await getJson(`${base}data/stamp.json?m=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
  const old = sites.get(base);
  const cat = old && old.id === st.catalog ? old.cat : await getJson(`${base}data/catalog.json?c=${st.catalog}`);
  const changed = !old || old.id !== st.catalog;
  sites.set(base, { id: st.catalog, generated: st.generated, cat });
  return changed;
}
const TF_ORDER = ['1m', '5m', '1h', '1d', 'x1m'];
// Catalogs of several sites -> one index. `list` is [[base, catalog]], this page's own first: where
// two sites have the same timeframe of a symbol, the first one's is used. Exported for tests.
export function mergeSites(list) {
  const main = list[0][1], ix = { ...main, symbols: [], file: {}, families: {}, indexes: {} };
  const by = new Map();
  for (const [base, cat] of list) {
    for (const e of cat.symbols) {
      const have = by.get(e.symbol);
      if (!have) {
        const x = { ...e, tfs: [...e.tfs], bases: Object.fromEntries(e.tfs.map((tf) => [tf, base])) };
        by.set(e.symbol, x); ix.symbols.push(x); ix.file[e.symbol] = cat.file[e.symbol];
        continue;
      }
      for (const tf of e.tfs) if (!(tf in have.bases)) { have.bases[tf] = base; have.tfs.push(tf); }
      have.tfs.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
      if (have.sector == null && e.sector != null) have.sector = e.sector;
    }
    // lists (fund families, world indexes) are the union of what each site publishes
    for (const key of ['families', 'indexes']) {
      for (const [name, v] of Object.entries(cat[key] || {})) {
        const cur = ix[key][name], members = (key === 'families' ? v : v.members) || [];
        if (!cur) { ix[key][name] = key === 'families' ? [...members] : { ...v, members: [...members] }; continue; }
        const into = key === 'families' ? cur : cur.members, seen = new Set(into);
        for (const m of members) if (!seen.has(m)) into.push(m);
      }
    }
  }
  ix.by = by;
  return ix;
}
const merge = () => mergeSites([...sites].map(([base, site]) => [base, site.cat]));
async function loadIndex(force = false) {
  if (index && !force && Date.now() - indexAt < 60000) return index;
  try {
    let changed = await readSite('');
    for (const sh of sites.get('').cat.shards || []) {
      try { changed = (await readSite(sh.base)) || changed; } catch (e) { console.warn(`data site ${sh.base} unavailable:`, e.message); }
    }
    if (!index || changed) index = merge();
    index.generated = sites.get('').generated; indexAt = Date.now();
  } catch (e) { if (!index) throw new Error('the shared data set could not be loaded (' + e.message + ')'); }
  return index;
}
// what a symbol has on the shared page, in words: 'daily and hourly history', 'daily history'
const WORD = { '1d': 'daily', '1h': 'hourly', '5m': 'five-minute', '1m': 'one-minute' };
export const kept = (tfs) => {
  const w = ['1d', '1h', '5m', '1m'].filter((t) => tfs.includes(t)).map((t) => WORD[t]);
  return `${w.length > 1 ? w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1] : w[0] || 'no'} history`;
};
// The published file format (tools/snapshot.py: encode_series): bar times as gaps in bar steps,
// the adjusted close as runs of a factor. Plain files pass through unchanged.
export function decodeSeries(d) {
  if (!d || !d.enc) return d;
  const out = {};
  for (const k of Object.keys(d)) if (!['enc', 't0', 'step', 'dt', 'af'].includes(k)) out[k] = d[k];
  if (d.t0 != null) { const t = [d.t0]; for (const g of d.dt) t.push(t[t.length - 1] + g * d.step); out.t = t; }
  if (d.af) {
    const a = [], c = d.c;
    d.af.forEach(([start, f], k) => { const end = k + 1 < d.af.length ? d.af[k + 1][0] : c.length; for (let i = start; i < end; i++) a.push(round(c[i] * f)); });
    out.a = a;
  }
  return out;
}
async function loadFile(tf, symbol) {
  const ix = await loadIndex(), key = tf + '|' + symbol, hit = files.get(key), e = ix.by.get(symbol);
  if (!e || !e.tfs.includes(tf)) throw Object.assign(new Error(e && tf !== 'x1m' ? `${symbol} has ${kept(e.tfs)} on the shared page; shorter timeframes are kept for the most traded symbols` : `${symbol}: no ${tf} data in the shared set`), { code: 'tf' });
  if (hit && hit.g === ix.generated) return hit.p || hit.data;
  // core files change with every build; the rest change a few times an hour at most, so they are
  // left to the browser's own cache (the site serves them as fresh for ten minutes)
  const g = ix.generated; // the build this request belongs to: the index object is updated in place
  const base = (e.bases && e.bases[tf]) ?? e.base ?? '';
  const p = fetch(`${base}data/${tf}/${ix.file[symbol]}.json${e.tier === 1 || !e.tier ? `?g=${g}` : ''}`).then((r) => { if (!r.ok) throw new Error(`${symbol}: no ${tf} data in the shared set`); return r.json(); }).then(decodeSeries);
  files.set(key, { g, p }); // callers that arrive while it loads share the one request
  const mine = () => { const cur = files.get(key); return cur && cur.p === p; }; // not replaced by a newer build's request
  try { const data = await p; if (mine()) files.set(key, { g, data }); return data; }
  catch (err) { if (mine()) files.delete(key); throw err; }
}
const EMPTY = { t: [], o: [], h: [], l: [], c: [], v: [] };

async function addLive(data, ix) {
  const symbol = data.symbol, tf = data.tf, now = Date.now() / 1000;
  const coin = ix.live[symbol] || ix.stocks[symbol] || null, stock = STOCK_TYPES.includes(data.meta.type);
  if ((!coin && !stock) || !SEC[tf] || !data.t.length) return data;
  try {
    const wall = wallFn(data.meta.tz), toUtc = (w) => Math.floor(w - (wall(now) - now));
    if (sessionOpen(symbol, now, 0)) {
      // the snapshot is minutes old: project the stretch since its last exchange print
      const found = coin && liveAnchor(data, tf);
      if (!found) return data;
      let anchor = null;
      try { anchor = anchorFrom1m(tf === '1m' ? data : await loadFile('1m', symbol)); } catch { /* use this timeframe's own last print */ }
      const start = toUtc(anchor ? anchor[0] : found[1]) - 300;
      if (now - start > MAX_PROXY_MINUTES * 60) return data;
      return spliceLive(data, await proxyMinutes(coin, start), symbol, tf, coin, now, anchor);
    }
    if (stock) {
      // outside regular hours: the snapshot's extended-hours prints, then estimates where it has a proxy
      let ext = EMPTY, proxy = [];
      if (!coin && !(ix.by.get(symbol) || { tfs: [] }).tfs.includes('x1m')) return data; // no extended prints kept and nothing to project from
      try { ext = await loadFile('x1m', symbol); } catch { /* none in the snapshot */ }
      const start = toUtc(data.t[data.t.length - 1] + (tf === '1d' ? 16 * 3600 : SEC[tf])) - 300;
      if (coin && now - start <= MAX_PROXY_MINUTES * 60) { try { proxy = await proxyMinutes(coin, start); } catch (e) { console.warn(`proxy unavailable for ${symbol}:`, e.message); } }
      return spliceExt(data, ext, proxy, tf, coin, now);
    }
  } catch (e) { console.warn(`live fill failed for ${symbol}:`, e.message); }
  return data;
}

// ───────────────────────── backend interface (same shape as the server's responses) ─────────────────────────
export const mode = 'static';
export async function init() { await loadIndex(true); return index; }
export function info() { return index; }

export async function bars(symbol, tf, live = true) {
  symbol = symbol.toUpperCase();
  const coin = hlCoin(symbol), now = Date.now() / 1000;
  if (coin) {
    const d = parseHl(await hlCandles(coin, tf, now - 5000 * SEC[tf], now), symbol, coin, tf, now);
    d.meta.open = true;
    return d;
  }
  const ix = await loadIndex();
  if (!ix.by.has(symbol)) throw new Error(`not in the shared data set (${ix.symbols.length} symbols). Live markets work too: try XYZ100. Run Meridian locally for any symbol.`);
  const src = tf === '15m' || tf === '30m' ? '5m' : tf;
  let data = await loadFile(src, symbol);
  const fetched = data.fetched || ix.generated; // when this series was read from the exchange feed
  if (src !== tf) data = regroup(data, tf);
  const out = live ? await addLive(data, ix) : data;
  return { ...out, meta: { ...out.meta, open: sessionOpen(symbol, now), snapshot: fetched } };
}

// Which stored timeframes a symbol has here (null = any: a live market).
export function tfs(symbol) {
  if (hlCoin(symbol) || !index) return null;
  const e = index.by.get(symbol.toUpperCase());
  return e ? e.tfs : [];
}

// A year of daily closes for every symbol in one file, for the Markets view.
// `broad`: also the broad tier's file (pages published before it was split have it all in one)
const packAt = {};
export async function pack(broad = false) {
  await loadIndex();
  const get = async (base, name) => {
    const g = (sites.get(base) || {}).generated, key = base + name, hit = packAt[key];
    if (hit && hit.g === g) return hit.data;
    const data = await getJson(`${base}data/${name}?g=${g}`); packAt[key] = { g, data }; return data;
  };
  const main = await get('', 'pack.json');
  if (!broad) return main;
  const s = { ...main.s };
  // the broad tier's summary is on its data site, or on this one when there is no data site
  const own = !(sites.get('').cat.shards || []).length;
  for (const base of sites.keys()) {
    if (base === '' && !own) continue;
    try { Object.assign(s, (await get(base, 'pack-broad.json')).s); } catch { /* none there (an older build kept everything in pack.json) */ }
  }
  return { generated: main.generated, s };
}

// Every site's screening file (tools/screen.mjs), this site's first. A site without one (an older
// build, or a data site that cannot be read) is left out: the Scanner downloads its files instead.
const screenAt = {};
export async function screens() {
  await loadIndex();
  const out = [];
  for (const [base, site] of sites) {
    const hit = screenAt[base];
    if (hit && hit.g === site.generated) { out.push(hit.data); continue; }
    try { const data = await getJson(`${base}data/screen.json?g=${site.generated}`); screenAt[base] = { g: site.generated, data }; out.push(data); } catch { /* none there */ }
  }
  return out;
}

export async function batch(symbols, tf, limit = 0, live = false) {
  const out = { bars: {}, errors: {} }, queue = symbols.slice();
  const worker = async () => {
    for (;;) {
      const s = queue.shift(); if (!s) return;
      try {
        let d = await bars(s, tf, live);
        if (limit > 0 && d.t.length > limit) { d = { ...d }; for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'a']) if (d[k]) d[k] = d[k].slice(-limit); }
        out.bars[s] = d;
      } catch (e) { out.errors[s] = e.message; }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

export async function search(q) {
  const ix = await loadIndex(), u = q.trim().toUpperCase();
  if (!u) return [];
  const rank = (s) => (s.symbol === u ? 0 : s.symbol.startsWith(u) ? 1 : 2);
  const hits = ix.symbols.filter((s) => s.symbol.includes(u) || (s.name || '').toUpperCase().includes(u)).sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol)).slice(0, 8)
    .map((s) => ({ symbol: s.symbol, name: s.name, type: s.type === 'EQUITY' ? 'Equity' : s.type, exch: s.exch }));
  if (!hlNames) { try { hlNames = (await post({ type: 'meta', dex: 'xyz' })).universe.filter((x) => !x.isDelisted).map((x) => x.name.split(':')[1]); } catch { hlNames = null; } }
  const ql = u.replace('XYZ:', ''), live = (hlNames || []).filter((n) => n.startsWith(ql) || (ql.length >= 3 && n.includes(ql))).sort((a, b) => (a !== ql) - (b !== ql) || a.length - b.length).slice(0, 4)
    .map((n) => ({ symbol: 'XYZ:' + n, name: `${n} perpetual · live 24/7`, type: 'Perp', exch: 'Hyperliquid' }));
  const exact = live.filter((r) => r.symbol === 'XYZ:' + ql);
  return exact.concat(hits, live.filter((r) => !exact.includes(r)));
}

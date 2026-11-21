// Price data: fetch + cache, derived timeframes, and causal higher-timeframe alignment.
import { dayKey, weekKey, monthKey } from './ta.js';

export const TFS = [
  { id: '1m', label: '1m', sec: 60, base: '1m' },
  { id: '5m', label: '5m', sec: 300, base: '5m' },
  { id: '15m', label: '15m', sec: 900, base: '15m' },
  { id: '30m', label: '30m', sec: 1800, base: '30m' },
  { id: '1h', label: '1h', sec: 3600, base: '1h' },
  { id: '4h', label: '4h', sec: 14400, base: '1h' },
  { id: '1d', label: 'D', sec: 86400, base: '1d' },
  { id: '1w', label: 'W', sec: 604800, base: '1d' },
  { id: '1mo', label: 'M', sec: 2629800, base: '1d' },
];
export const TF = Object.fromEntries(TFS.map((t, i) => [t.id, { ...t, rank: i }]));
export const isIntraday = (tf) => TF[tf].sec < 86400;
export const tfLabel = (tf) => (TF[tf] ? TF[tf].label : tf);
// Index of the first bar that is (wholly or partly) a live estimate, or -1.
export function liveStart(bars) {
  if (!bars || !bars.live || bars.live.from == null) return -1;
  const sec = TF[bars.tf].sec, n = bars.t.length;
  for (let i = Math.max(0, n - 3000); i < n; i++) if (bars.t[i] + sec > bars.live.from) return i;
  return -1;
}
// Is bar i made only of estimates? (bars.live.est lists [first, last] start times of such runs)
export function estimateTest(bars) {
  const runs = bars && bars.live && bars.live.est;
  if (!runs || !runs.length) return null;
  const sec = TF[bars.tf].sec, base = TF[TF[bars.tf].base].sec;
  // a derived bar (4h from 1h) is an estimate only if it lies wholly inside one run
  return (i) => { const a = bars.t[i], z = a + sec - base; for (const r of runs) if (a >= r[0] && z <= r[1]) return true; return false; };
}
export const tfsAtOrAbove = (tf) => TFS.filter((t) => TF[t.id].rank >= TF[tf].rank);

const cache = new Map(); // "SYM|tf" -> { at, bars } for base timeframes
const derived = new WeakMap(); // base bars -> { tf: bars }
const inflight = new Map();

function wrap(d) {
  const b = { symbol: d.symbol, tf: d.tf, t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, meta: d.meta || {}, stale: !!d.stale };
  if (d.a && d.a.length === d.c.length) b.a = d.a; // dividend-adjusted close (daily only)
  if (d.live) b.live = d.live; // newest bars are a live estimate: { src, from, partial, anchor, anchorAge, asof }
  return b;
}

/**
 * Total-return view of daily bars: every price is scaled by adjustedClose / close, so dividends
 * count as if reinvested. Bars without an adjusted column (intraday, crypto, indexes) come back
 * unchanged. Higher timeframes must be aggregated from this, not adjusted after aggregation,
 * because the factor changes inside a week or month at each ex-dividend date.
 */
const adjMemo = new WeakMap();
export function adjust(bars) {
  if (!bars.a) return bars;
  let out = adjMemo.get(bars);
  if (out) return out;
  const n = bars.t.length, o = new Array(n), hh = new Array(n), l = new Array(n);
  for (let i = 0; i < n; i++) { const f = bars.a[i] / bars.c[i]; o[i] = bars.o[i] * f; hh[i] = bars.h[i] * f; l[i] = bars.l[i] * f; }
  out = { symbol: bars.symbol, tf: bars.tf, t: bars.t, o, h: hh, l, c: bars.a, v: bars.v, meta: bars.meta, stale: bars.stale, adjusted: true };
  if (bars.live) out.live = bars.live;
  adjMemo.set(bars, out);
  return out;
}

export function aggregate(base, tf) {
  const n = base.t.length, keys = new Array(n);
  if (tf === '1w') for (let i = 0; i < n; i++) keys[i] = weekKey(base.t[i]);
  else if (tf === '1mo') for (let i = 0; i < n; i++) keys[i] = monthKey(base.t[i]);
  else if (tf === '4h') {
    let day = null, first = 0;
    for (let i = 0; i < n; i++) {
      const d = dayKey(base.t[i]);
      if (d !== day) { day = d; first = base.t[i]; }
      keys[i] = d * 16 + Math.floor((base.t[i] - first) / 14400);
    }
  } else return base;
  const out = { symbol: base.symbol, tf, t: [], o: [], h: [], l: [], c: [], v: [], meta: base.meta, stale: base.stale };
  if (base.adjusted) out.adjusted = true;
  if (base.live) out.live = base.live;
  let cur = null, j = -1;
  for (let i = 0; i < n; i++) {
    if (keys[i] !== cur) {
      cur = keys[i]; j++;
      out.t.push(base.t[i]); out.o.push(base.o[i]); out.h.push(base.h[i]); out.l.push(base.l[i]); out.c.push(base.c[i]); out.v.push(base.v[i]);
    } else {
      if (base.h[i] > out.h[j]) out.h[j] = base.h[i];
      if (base.l[i] < out.l[j]) out.l[j] = base.l[i];
      out.c[j] = base.c[i]; out.v[j] += base.v[i];
    }
  }
  return out;
}

function derive(base, tf) {
  if (TF[tf].base === tf) return base;
  let d = derived.get(base);
  if (!d) { d = {}; derived.set(base, d); }
  if (!d[tf]) d[tf] = aggregate(base, tf);
  return d[tf];
}

// ── where prices come from ──
// With a Meridian server running (local use) every request goes to it. Without one (the shared
// static site) the page reads a published snapshot and brings it up to date itself: see static.js.
const serverBackend = {
  mode: 'server',
  bars: (symbol, tf, live) => fetchJson(`/api/bars?symbol=${encodeURIComponent(symbol)}&tf=${tf}${live ? '' : '&live=0'}`),
  batch: (symbols, tf, limit, live) => fetchJson(`/api/batch?symbols=${encodeURIComponent(symbols.join(','))}&tf=${tf}&limit=${limit}${live ? '&live=1' : ''}`),
  search: async (q) => (await fetchJson('/api/search?q=' + encodeURIComponent(q))).results || [],
  info: () => null,
};
let backendPromise = null;
export function backend() {
  if (!backendPromise) backendPromise = (async () => {
    // the published page is marked as having no server (tools/snapshot.py), so it does not ask
    const marked = typeof document !== 'undefined' && document.documentElement.dataset.backend === 'static';
    if (!marked) { try { const r = await fetch('api/health', { cache: 'no-store' }); if (r.ok && (await r.json()).ok) return serverBackend; } catch { /* no server here */ } }
    const st = await import('./static.js'); await st.init(); return st;
  })();
  return backendPromise;
}
// The symbol lists scans and multi-symbol tests can use: fixed lists locally, the snapshot's own
// symbols on the shared site (nothing else has data there).
export async function universes() {
  const be = await backend(), ix = be.info();
  if (!ix) {
    // with a server any symbol works: the fixed lists, plus each fund family's whole line-up
    const fams = (await stockSectors()).families || {};
    return { ...UNIVERSES, ...Object.fromEntries(Object.entries(fams).filter(([, v]) => v.length).map(([k, v]) => [`${k} ETFs (${v.length})`, v])) };
  }
  const all = ix.symbols, out = {};
  const put = (name, f) => { const list = all.filter(f).map((s) => s.symbol); if (list.length) out[`${name} (${list.length})`] = list; };
  // the lightest list first: it is what a scan starts on
  put('Core set · every timeframe', (s) => !s.tier || s.tier === 1);
  put('S&P 500', (s) => s.sp);
  put('US stocks', (s) => s.type === 'EQUITY' && !s.mkt);
  (ix.sectors || []).forEach((name, k) => put(name, (s) => s.sector === k && !s.mkt)); // US sectors; each world index has its own list
  put('ETFs', (s) => s.type === 'ETF');
  for (const [fam, list] of Object.entries(ix.families || {})) if (list.length) out[`${fam} ETFs (${list.length})`] = list;
  put('International stocks', (s) => !!s.mkt);
  for (const [name, v] of Object.entries(ix.indexes || {})) if (v.members.length) out[`${name} · ${v.country} (${v.members.length})`] = v.members;
  put('Futures', (s) => s.type === 'FUTURE');
  put('Indexes', (s) => s.type === 'INDEX');
  put('Currencies', (s) => s.type === 'CURRENCY');
  put('Crypto', (s) => s.type === 'CRYPTOCURRENCY');
  put('Everything shared', () => true);
  return out;
}
// Which timeframes can be charted for a symbol: null means all of them (always, with a server).
// On the shared page most symbols have no timeframe shorter than an hour or five minutes.
export async function availableTfs(symbol) {
  const be = await backend();
  if (!be.tfs) return null;
  const have = be.tfs(symbol);
  if (!have) return null;
  const src = (id) => (id === '15m' || id === '30m' ? '5m' : TF[id].base);
  return new Set(TFS.filter((t) => have.includes(src(t.id))).map((t) => t.id));
}
// Sector of each listed stock, for grouping: { sectors: [name], stocks: { SYM: index } }.
let universePromise = null;
export function stockSectors() {
  if (!universePromise) universePromise = fetch('universe.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).catch(() => ({ sectors: [], stocks: {} }));
  return universePromise;
}

async function fetchJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// live: true (default) asks for the freshest view - delayed futures filled in, stocks continued
// past the close with extended-hours prints and estimates. live: false is exchange bars only, for
// backtests and model training.
export async function getBars(symbol, tf, { maxAge = 60000, adjusted = false, live = true } = {}) {
  symbol = symbol.toUpperCase();
  const base = TF[tf].base, key = symbol + '|' + base + (live ? '' : '|x'), hit = cache.get(key);
  const view = (b) => derive(adjusted ? adjust(b) : b, tf);
  if (hit && Date.now() - hit.at < maxAge) return view(hit.bars);
  let p = inflight.get(key);
  if (!p) {
    p = backend().then((be) => be.bars(symbol, base, live))
      .then((d) => { const bars = wrap(d); cache.set(key, { at: Date.now(), bars }); return bars; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return view(await p);
}

// Loads many symbols at one timeframe. Returns { bars: Map(symbol -> bars), errors }.
// With `limit` only the most recent bars are sent; those copies are cached apart from full history.
const trimCache = new Map();
export async function getBatch(symbols, tf, { limit = 0, onProgress, maxAge = 60000, live = false } = {}) {
  const base = TF[tf].base, out = new Map(), errors = {}, need = [], now = Date.now(), lk = live ? '|live' : '';
  for (const s of symbols) {
    const full = cache.get(s + '|' + base + (live ? '' : '|x')), tr = limit ? trimCache.get(s + '|' + base + '|' + limit + lk) : null;
    if (tr && now - tr.at < maxAge) out.set(s, derive(tr.bars, tf));
    else if (full && now - full.at < maxAge) {
      // cut the cached full history to the same length the server would send, so results do not depend on what else was opened
      const b = limit ? sliceBars(full.bars, full.bars.t.length - limit) : full.bars;
      if (limit) trimCache.set(s + '|' + base + '|' + limit + lk, { at: full.at, bars: b });
      out.set(s, derive(b, tf));
    }
    else need.push(s);
  }
  const CH = 20;
  let done = symbols.length - need.length;
  if (onProgress) onProgress(done, symbols.length);
  for (let i = 0; i < need.length; i += CH) {
    const chunk = need.slice(i, i + CH);
    try {
      const j = await (await backend()).batch(chunk, base, limit, live);
      for (const [s, d] of Object.entries(j.bars)) {
        const bars = wrap(d);
        if (limit) trimCache.set(s + '|' + base + '|' + limit + lk, { at: Date.now(), bars }); else cache.set(s + '|' + base + (live ? '' : '|x'), { at: Date.now(), bars });
        out.set(s, derive(bars, tf));
      }
      Object.assign(errors, j.errors || {});
    } catch (e) { for (const s of chunk) errors[s] = e.message; }
    done += chunk.length;
    if (onProgress) onProgress(done, symbols.length);
  }
  return { bars: out, errors };
}

export async function searchSymbols(q) { return (await backend()).search(q); }
// The shared page's screening files (web/js/screen.js), or null with a server (nothing is precomputed there).
export async function screenFiles() { const be = await backend(); return be.screens ? be.screens() : null; }

/**
 * Map a series computed on a higher timeframe onto base bars without lookahead.
 * A base bar gets the higher-timeframe value only once that higher bar has closed (the base bar
 * is the last one inside it); until then it carries the previous completed value. The final base
 * bar shows the still-forming value, which uses nothing beyond that bar.
 */
export function alignToBase(base, htf, vals) {
  const n = base.t.length, m = htf.t.length, out = new Array(n).fill(NaN);
  if (!m) return out;
  const snap = isIntraday(base.tf) && !isIntraday(htf.tf);
  const key = (i) => (snap ? dayKey(base.t[i]) * 86400 : base.t[i]);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const k = key(i);
    while (j + 1 < m && htf.t[j + 1] <= k) j++;
    if (htf.t[j] > k) continue;
    const complete = i === n - 1 || (j + 1 < m ? key(i + 1) >= htf.t[j + 1] : false);
    out[i] = complete ? vals[j] : j > 0 ? vals[j - 1] : NaN;
  }
  return out;
}

export function sliceBars(bars, from) {
  if (from <= 0) return bars;
  const out = { symbol: bars.symbol, tf: bars.tf, meta: bars.meta, stale: bars.stale };
  if (bars.adjusted) out.adjusted = true;
  if (bars.live) out.live = bars.live;
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'a']) if (bars[k]) out[k] = bars[k].slice(from);
  return out;
}

export const UNIVERSES = {
  'Mega caps (30)': 'AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM MA COST HD PG JNJ WMT NFLX ABBV BAC CRM ORCL KO CVX MRK AMD PEP'.split(' '),
  'Large caps (100)': 'AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM MA COST HD PG JNJ WMT NFLX ABBV BAC CRM ORCL KO CVX MRK AMD PEP ADBE TMO LIN ACN MCD CSCO ABT WFC DHR QCOM TXN GE INTU AMGN IBM CAT VZ PM DIS NOW AMAT PFE GS ISRG CMCSA UBER RTX NEE SPGI T LOW HON UNP BKNG AXP MS BLK COP PGR ELV TJX SYK BA VRTX C MDT LMT ADP REGN MU PANW SCHW DE ADI BMY CB GILD LRCX PLD NKE SBUX UPS INTC SO MO DUK CL TGT F GM PYPL'.split(' '),
  'Growth & momentum (40)': 'NVDA AMD AVGO MU SMCI ARM PLTR SNOW CRWD NET DDOG ZS PANW SHOP PYPL COIN HOOD SOFI RBLX U ROKU TTD MELI SE UBER ABNB DASH LYFT RIVN LCID NIO PLUG ENPH FSLR CELH ELF DKNG AFRM UPST MSTR'.split(' '),
  'ETFs (36)': 'SPY QQQ IWM DIA MDY VTI EFA EEM XLK XLF XLE XLV XLI XLY XLP XLU XLB XLRE XLC SMH XBI KRE XHB XRT ITB GDX GLD SLV USO UNG TLT IEF HYG LQD UUP ARKK'.split(' '),
  'Crypto (20)': 'BTC-USD ETH-USD SOL-USD BNB-USD XRP-USD ADA-USD DOGE-USD AVAX-USD LINK-USD DOT-USD LTC-USD BCH-USD ATOM-USD UNI7083-USD NEAR-USD APT21794-USD ARB11841-USD OP-USD AAVE-USD FIL-USD'.split(' '),
};

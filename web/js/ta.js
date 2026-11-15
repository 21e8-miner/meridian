// Meridian technical-analysis library.
// Every function takes plain arrays and returns arrays of the same length, NaN during warm-up.
// Nothing here looks ahead: the value at index i depends only on data at indices <= i.

export const nanArr = (n) => new Array(n).fill(NaN);
const ok = (x) => x === x && x !== Infinity && x !== -Infinity;

export function source(bars, s) {
  const n = bars.t.length;
  switch (s) {
    case 'open': return bars.o;
    case 'high': return bars.h;
    case 'low': return bars.l;
    case 'volume': return bars.v;
    case 'hl2': { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = (bars.h[i] + bars.l[i]) / 2; return a; }
    case 'hlc3': { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = (bars.h[i] + bars.l[i] + bars.c[i]) / 3; return a; }
    case 'ohlc4': { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = (bars.o[i] + bars.h[i] + bars.l[i] + bars.c[i]) / 4; return a; }
    default: return bars.c;
  }
}

export function sma(a, len) {
  const n = a.length, out = nanArr(n);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    if (ok(x)) { sum += x; cnt++; }
    if (i >= len) { const y = a[i - len]; if (ok(y)) { sum -= y; cnt--; } }
    if (cnt === len) out[i] = sum / len;
  }
  return out;
}

function smoothed(a, len, alpha) {
  const n = a.length, out = nanArr(n);
  let prev = NaN, sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    if (!ok(x)) { if (!ok(prev)) { sum = 0; cnt = 0; } continue; }
    if (!ok(prev)) {
      sum += x; cnt++;
      if (cnt === len) { prev = sum / len; out[i] = prev; }
    } else {
      prev = alpha * x + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}
export const ema = (a, len) => smoothed(a, len, 2 / (len + 1));
export const rma = (a, len) => smoothed(a, len, 1 / len);

export function wma(a, len) {
  const n = a.length, out = nanArr(n), den = (len * (len + 1)) / 2;
  for (let i = len - 1; i < n; i++) {
    let s = 0, good = true;
    for (let k = 0; k < len; k++) { const x = a[i - k]; if (!ok(x)) { good = false; break; } s += x * (len - k); }
    if (good) out[i] = s / den;
  }
  return out;
}

export function hma(a, len) {
  const h = wma(a, Math.max(1, Math.floor(len / 2))), f = wma(a, len), n = a.length, d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = 2 * h[i] - f[i];
  return wma(d, Math.max(1, Math.round(Math.sqrt(len))));
}

export function stdev(a, len) {
  const n = a.length, out = nanArr(n);
  for (let i = len - 1; i < n; i++) {
    let s = 0, good = true;
    for (let k = 0; k < len; k++) { const x = a[i - k]; if (!ok(x)) { good = false; break; } s += x; }
    if (!good) continue;
    const m = s / len;
    let q = 0;
    for (let k = 0; k < len; k++) { const d = a[i - k] - m; q += d * d; }
    out[i] = Math.sqrt(q / len);
  }
  return out;
}

export function highest(a, len) {
  const n = a.length, out = nanArr(n);
  for (let i = len - 1; i < n; i++) {
    let m = -Infinity;
    for (let k = 0; k < len; k++) { const x = a[i - k]; if (x > m) m = x; else if (!ok(x)) { m = NaN; break; } }
    out[i] = m;
  }
  return out;
}
export function lowest(a, len) {
  const n = a.length, out = nanArr(n);
  for (let i = len - 1; i < n; i++) {
    let m = Infinity;
    for (let k = 0; k < len; k++) { const x = a[i - k]; if (x < m) m = x; else if (!ok(x)) { m = NaN; break; } }
    out[i] = m;
  }
  return out;
}

export function change(a, len = 1) {
  const n = a.length, out = nanArr(n);
  for (let i = len; i < n; i++) out[i] = a[i] - a[i - len];
  return out;
}
export function roc(a, len) {
  const n = a.length, out = nanArr(n);
  for (let i = len; i < n; i++) if (a[i - len]) out[i] = (a[i] / a[i - len] - 1) * 100;
  return out;
}

export function trueRange(bars) {
  const n = bars.t.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const hl = bars.h[i] - bars.l[i];
    if (i === 0) { out[i] = hl; continue; }
    const pc = bars.c[i - 1];
    out[i] = Math.max(hl, Math.abs(bars.h[i] - pc), Math.abs(bars.l[i] - pc));
  }
  return out;
}
export const atr = (bars, len) => rma(trueRange(bars), len);

export function rsi(a, len) {
  const n = a.length, up = nanArr(n), dn = nanArr(n);
  for (let i = 1; i < n; i++) {
    const d = a[i] - a[i - 1];
    if (!ok(d)) continue;
    up[i] = d > 0 ? d : 0; dn[i] = d < 0 ? -d : 0;
  }
  const u = rma(up, len), d = rma(dn, len), out = nanArr(n);
  for (let i = 0; i < n; i++) {
    if (!ok(u[i])) continue;
    out[i] = d[i] === 0 ? (u[i] === 0 ? 50 : 100) : 100 - 100 / (1 + u[i] / d[i]);
  }
  return out;
}

export function macd(a, fast, slow, sig) {
  const f = ema(a, fast), s = ema(a, slow), n = a.length, m = nanArr(n);
  for (let i = 0; i < n; i++) m[i] = f[i] - s[i];
  const signal = ema(m, sig), hist = nanArr(n);
  for (let i = 0; i < n; i++) hist[i] = m[i] - signal[i];
  return { macd: m, signal, hist };
}

export function stoch(bars, kLen, kSmooth, dLen) {
  const hh = highest(bars.h, kLen), ll = lowest(bars.l, kLen), n = bars.t.length, raw = nanArr(n);
  for (let i = 0; i < n; i++) { const r = hh[i] - ll[i]; if (ok(r)) raw[i] = r === 0 ? 50 : (100 * (bars.c[i] - ll[i])) / r; }
  const k = sma(raw, kSmooth), d = sma(k, dLen);
  return { k, d };
}

export function stochRsi(a, rsiLen, stLen, kSmooth, dLen) {
  const r = rsi(a, rsiLen), hh = highest(r, stLen), ll = lowest(r, stLen), n = a.length, raw = nanArr(n);
  for (let i = 0; i < n; i++) { const rg = hh[i] - ll[i]; if (ok(rg)) raw[i] = rg === 0 ? 50 : (100 * (r[i] - ll[i])) / rg; }
  const k = sma(raw, kSmooth), d = sma(k, dLen);
  return { k, d };
}

export function bollinger(a, len, mult) {
  const mid = sma(a, len), sd = stdev(a, len), n = a.length, upper = nanArr(n), lower = nanArr(n);
  for (let i = 0; i < n; i++) { upper[i] = mid[i] + mult * sd[i]; lower[i] = mid[i] - mult * sd[i]; }
  return { mid, upper, lower };
}

export function keltner(bars, len, mult, atrLen) {
  const mid = ema(bars.c, len), a = atr(bars, atrLen), n = bars.t.length, upper = nanArr(n), lower = nanArr(n);
  for (let i = 0; i < n; i++) { upper[i] = mid[i] + mult * a[i]; lower[i] = mid[i] - mult * a[i]; }
  return { mid, upper, lower };
}

export function donchian(bars, len) {
  const upper = highest(bars.h, len), lower = lowest(bars.l, len), n = bars.t.length, mid = nanArr(n);
  for (let i = 0; i < n; i++) mid[i] = (upper[i] + lower[i]) / 2;
  return { upper, lower, mid };
}

export function ichimoku(bars, tLen, kLen, bLen, shift) {
  const n = bars.t.length;
  const midOf = (len) => { const hh = highest(bars.h, len), ll = lowest(bars.l, len), o = nanArr(n); for (let i = 0; i < n; i++) o[i] = (hh[i] + ll[i]) / 2; return o; };
  const tenkan = midOf(tLen), kijun = midOf(kLen), b = midOf(bLen), spanA = nanArr(n), spanB = nanArr(n);
  // spans are plotted `shift` bars forward: the value shown at bar i was known at bar i - shift
  for (let i = shift; i < n; i++) { spanA[i] = (tenkan[i - shift] + kijun[i - shift]) / 2; spanB[i] = b[i - shift]; }
  return { tenkan, kijun, spanA, spanB };
}

export function psar(bars, step, max) {
  const n = bars.t.length, out = nanArr(n);
  if (n < 2) return out;
  let up = bars.c[1] >= bars.c[0], af = step, ep = up ? bars.h[0] : bars.l[0], sar = up ? bars.l[0] : bars.h[0];
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, bars.l[i - 1], i > 1 ? bars.l[i - 2] : bars.l[i - 1]);
      if (bars.l[i] < sar) { up = false; sar = ep; ep = bars.l[i]; af = step; }
      else if (bars.h[i] > ep) { ep = bars.h[i]; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, bars.h[i - 1], i > 1 ? bars.h[i - 2] : bars.h[i - 1]);
      if (bars.h[i] > sar) { up = true; sar = ep; ep = bars.h[i]; af = step; }
      else if (bars.l[i] < ep) { ep = bars.l[i]; af = Math.min(max, af + step); }
    }
    out[i] = sar;
  }
  return out;
}

export function supertrend(bars, len, mult) {
  const n = bars.t.length, a = atr(bars, len), line = nanArr(n), dir = nanArr(n);
  let fu = NaN, fl = NaN, d = 1;
  for (let i = 0; i < n; i++) {
    if (!ok(a[i])) continue;
    const mid = (bars.h[i] + bars.l[i]) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i], pc = i > 0 ? bars.c[i - 1] : bars.c[i];
    fu = !ok(fu) || bu < fu || pc > fu ? bu : fu;
    fl = !ok(fl) || bl > fl || pc < fl ? bl : fl;
    if (d === 1 && bars.c[i] < fl) d = -1; else if (d === -1 && bars.c[i] > fu) d = 1;
    line[i] = d === 1 ? fl : fu; dir[i] = d;
  }
  return { line, dir };
}

export function adx(bars, len) {
  const n = bars.t.length, pdm = nanArr(n), mdm = nanArr(n);
  for (let i = 1; i < n; i++) {
    const u = bars.h[i] - bars.h[i - 1], d = bars.l[i - 1] - bars.l[i];
    pdm[i] = u > d && u > 0 ? u : 0; mdm[i] = d > u && d > 0 ? d : 0;
  }
  const trv = trueRange(bars); trv[0] = NaN;
  const a = rma(trv, len), p = rma(pdm, len), m = rma(mdm, len), pdi = nanArr(n), mdi = nanArr(n), dx = nanArr(n);
  for (let i = 0; i < n; i++) {
    if (!ok(a[i]) || a[i] === 0) continue;
    pdi[i] = (100 * p[i]) / a[i]; mdi[i] = (100 * m[i]) / a[i];
    const s = pdi[i] + mdi[i]; dx[i] = s === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / s;
  }
  return { adx: rma(dx, len), pdi, mdi };
}

export function cci(bars, len) {
  const tp = source(bars, 'hlc3'), m = sma(tp, len), n = tp.length, out = nanArr(n);
  for (let i = len - 1; i < n; i++) {
    let dev = 0; for (let k = 0; k < len; k++) dev += Math.abs(tp[i - k] - m[i]);
    dev /= len; out[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
  }
  return out;
}

export function obv(bars) {
  const n = bars.t.length, out = new Array(n); let s = 0;
  for (let i = 0; i < n; i++) { if (i > 0) s += bars.c[i] > bars.c[i - 1] ? bars.v[i] : bars.c[i] < bars.c[i - 1] ? -bars.v[i] : 0; out[i] = s; }
  return out;
}

export function mfi(bars, len) {
  const tp = source(bars, 'hlc3'), n = tp.length, out = nanArr(n);
  for (let i = len; i < n; i++) {
    let pos = 0, neg = 0;
    for (let k = 0; k < len; k++) { const j = i - k, f = tp[j] * bars.v[j]; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

export function willr(bars, len) {
  const hh = highest(bars.h, len), ll = lowest(bars.l, len), n = bars.t.length, out = nanArr(n);
  for (let i = 0; i < n; i++) { const r = hh[i] - ll[i]; if (ok(r)) out[i] = r === 0 ? -50 : (-100 * (hh[i] - bars.c[i])) / r; }
  return out;
}

export function cmf(bars, len) {
  const n = bars.t.length, mfv = new Array(n);
  for (let i = 0; i < n; i++) { const r = bars.h[i] - bars.l[i]; mfv[i] = r === 0 ? 0 : (((bars.c[i] - bars.l[i]) - (bars.h[i] - bars.c[i])) / r) * bars.v[i]; }
  const a = sma(mfv, len), b = sma(bars.v, len), out = nanArr(n);
  for (let i = 0; i < n; i++) if (b[i]) out[i] = a[i] / b[i];
  return out;
}

export function aroon(bars, len) {
  const n = bars.t.length, up = nanArr(n), down = nanArr(n);
  for (let i = len; i < n; i++) {
    let hi = -Infinity, lo = Infinity, hk = 0, lk = 0;
    for (let k = 0; k <= len; k++) { if (bars.h[i - k] > hi) { hi = bars.h[i - k]; hk = k; } if (bars.l[i - k] < lo) { lo = bars.l[i - k]; lk = k; } }
    up[i] = (100 * (len - hk)) / len; down[i] = (100 * (len - lk)) / len;
  }
  return { up, down };
}

export function trix(a, len) {
  const e = ema(ema(ema(a, len), len), len);
  return roc(e, 1);
}

export function zscore(a, len) {
  const m = sma(a, len), sd = stdev(a, len), n = a.length, out = nanArr(n);
  for (let i = 0; i < n; i++) if (sd[i]) out[i] = (a[i] - m[i]) / sd[i];
  return out;
}

export function linreg(a, len) {
  const n = a.length, out = nanArr(n), slope = nanArr(n);
  const sx = (len * (len - 1)) / 2, sxx = ((len - 1) * len * (2 * len - 1)) / 6, den = len * sxx - sx * sx;
  for (let i = len - 1; i < n; i++) {
    let sy = 0, sxy = 0, good = true;
    for (let k = 0; k < len; k++) { const y = a[i - len + 1 + k]; if (!ok(y)) { good = false; break; } sy += y; sxy += k * y; }
    if (!good) continue;
    const b = (len * sxy - sx * sy) / den, c0 = (sy - b * sx) / len;
    out[i] = c0 + b * (len - 1); slope[i] = b;
  }
  return { value: out, slope };
}

// Period keys from wall-clock bar times (see server.py: times are exchange-local, UTC-encoded).
export const dayKey = (t) => Math.floor(t / 86400);
export const weekKey = (t) => Math.floor((dayKey(t) + 3) / 7);
export const monthKey = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
export const quarterKey = (t) => Math.floor(monthKey(t) / 3);
export const yearKey = (t) => new Date(t * 1000).getUTCFullYear();
const KEYFN = { session: dayKey, week: weekKey, month: monthKey, quarter: quarterKey, year: yearKey };

export function vwap(bars, anchor = 'session') {
  const n = bars.t.length, out = nanArr(n), key = KEYFN[anchor] || dayKey;
  let pv = 0, vol = 0, cur = null;
  for (let i = 0; i < n; i++) {
    const k = key(bars.t[i]);
    if (k !== cur) { cur = k; pv = 0; vol = 0; }
    const tp = (bars.h[i] + bars.l[i] + bars.c[i]) / 3;
    pv += tp * bars.v[i]; vol += bars.v[i];
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

// Classic floor pivots from the previous period's high/low/close, held flat through the period.
export function pivotPoints(bars, period = 'session') {
  const n = bars.t.length, key = KEYFN[period] || dayKey;
  const p = nanArr(n), r1 = nanArr(n), s1 = nanArr(n), r2 = nanArr(n), s2 = nanArr(n);
  let cur = null, hi = -Infinity, lo = Infinity, cl = NaN, P = NaN, R1 = NaN, S1 = NaN, R2 = NaN, S2 = NaN;
  for (let i = 0; i < n; i++) {
    const k = key(bars.t[i]);
    if (k !== cur) {
      if (cur !== null) { P = (hi + lo + cl) / 3; R1 = 2 * P - lo; S1 = 2 * P - hi; R2 = P + (hi - lo); S2 = P - (hi - lo); }
      cur = k; hi = -Infinity; lo = Infinity;
    }
    p[i] = P; r1[i] = R1; s1[i] = S1; r2[i] = R2; s2[i] = S2;
    if (bars.h[i] > hi) hi = bars.h[i];
    if (bars.l[i] < lo) lo = bars.l[i];
    cl = bars.c[i];
  }
  return { p, r1, s1, r2, s2 };
}

export function crossUp(a, b) { const n = a.length, o = new Array(n).fill(false); for (let i = 1; i < n; i++) o[i] = a[i] > b[i] && a[i - 1] <= b[i - 1]; return o; }
export function crossDown(a, b) { const n = a.length, o = new Array(n).fill(false); for (let i = 1; i < n; i++) o[i] = a[i] < b[i] && a[i - 1] >= b[i - 1]; return o; }

// ───────────────────────── indicator registry ─────────────────────────
const C = { a: '#f0b34a', b: '#5aa9e6', c: '#c586e8', d: '#59c9a5', e: '#ef6f6c', f: '#9aa5b1', g: '#e6d15a', up: '#2fb590', dn: '#e5564e' };
const P = {
  len: (def, label = 'Length') => ({ k: 'len', label, def, min: 1, max: 1000 }),
  src: (def = 'close') => ({ k: 'src', label: 'Source', def, type: 'source' }),
  num: (k, label, def, step = 1, min = 0) => ({ k, label, def, step, min }),
};
const line = (k, label, color, extra = {}) => ({ k, label, color, style: 'line', ...extra });

export const IND = new Map();
export function registerIndicator(def) { IND.set(def.id, def); }
export function unregisterIndicator(id) { IND.delete(id); }

const defs = [
  { id: 'sma', name: 'Simple Moving Average', short: 'SMA', group: 'Trend', overlay: true, params: [P.len(50), P.src()], outputs: [line('value', 'SMA', C.a)], calc: (b, p) => ({ value: sma(source(b, p.src), p.len) }) },
  { id: 'ema', name: 'Exponential Moving Average', short: 'EMA', group: 'Trend', overlay: true, params: [P.len(21), P.src()], outputs: [line('value', 'EMA', C.b)], calc: (b, p) => ({ value: ema(source(b, p.src), p.len) }) },
  { id: 'wma', name: 'Weighted Moving Average', short: 'WMA', group: 'Trend', overlay: true, params: [P.len(20), P.src()], outputs: [line('value', 'WMA', C.c)], calc: (b, p) => ({ value: wma(source(b, p.src), p.len) }) },
  { id: 'hma', name: 'Hull Moving Average', short: 'HMA', group: 'Trend', overlay: true, params: [P.len(21), P.src()], outputs: [line('value', 'HMA', C.d)], calc: (b, p) => ({ value: hma(source(b, p.src), p.len) }) },
  { id: 'vwap', name: 'Anchored VWAP', short: 'VWAP', group: 'Trend', overlay: true, params: [{ k: 'anchor', label: 'Anchor', def: 'session', type: 'select', options: ['session', 'week', 'month', 'quarter', 'year'] }], outputs: [line('value', 'VWAP', C.g)], calc: (b, p) => ({ value: vwap(b, p.anchor) }) },
  { id: 'bb', name: 'Bollinger Bands', short: 'BB', group: 'Volatility', overlay: true, params: [P.len(20), P.num('mult', 'Std dev', 2, 0.1), P.src()], outputs: [line('upper', 'Upper', C.b), line('mid', 'Mid', C.f), line('lower', 'Lower', C.b)], fill: ['upper', 'lower'], calc: (b, p) => bollinger(source(b, p.src), p.len, p.mult) },
  { id: 'keltner', name: 'Keltner Channels', short: 'KC', group: 'Volatility', overlay: true, params: [P.len(20), P.num('mult', 'ATR mult', 2, 0.1), P.num('atrLen', 'ATR length', 10, 1, 1)], outputs: [line('upper', 'Upper', C.c), line('mid', 'Mid', C.f), line('lower', 'Lower', C.c)], fill: ['upper', 'lower'], calc: (b, p) => keltner(b, p.len, p.mult, p.atrLen) },
  { id: 'donchian', name: 'Donchian Channel', short: 'DC', group: 'Volatility', overlay: true, params: [P.len(20)], outputs: [line('upper', 'Upper', C.d), line('mid', 'Mid', C.f), line('lower', 'Lower', C.d)], fill: ['upper', 'lower'], calc: (b, p) => donchian(b, p.len) },
  { id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', group: 'Trend', overlay: true, params: [P.num('t', 'Conversion', 9, 1, 1), P.num('k', 'Base', 26, 1, 1), P.num('b', 'Span B', 52, 1, 1), P.num('shift', 'Displacement', 26, 1, 0)], outputs: [line('tenkan', 'Conv', C.b), line('kijun', 'Base', C.e), line('spanA', 'Span A', C.up), line('spanB', 'Span B', C.dn)], fill: ['spanA', 'spanB'], calc: (b, p) => ichimoku(b, p.t, p.k, p.b, p.shift) },
  { id: 'psar', name: 'Parabolic SAR', short: 'PSAR', group: 'Trend', overlay: true, params: [P.num('step', 'Step', 0.02, 0.01), P.num('max', 'Max', 0.2, 0.01)], outputs: [{ k: 'value', label: 'SAR', color: C.c, style: 'dots' }], calc: (b, p) => ({ value: psar(b, p.step, p.max) }) },
  { id: 'supertrend', name: 'Supertrend', short: 'ST', group: 'Trend', overlay: true, params: [P.len(10, 'ATR length'), P.num('mult', 'Multiplier', 3, 0.1)], outputs: [line('line', 'Supertrend', C.a, { colorBy: 'dir' }), { k: 'dir', label: 'Direction', hidden: true }], calc: (b, p) => supertrend(b, p.len, p.mult) },
  { id: 'pivots', name: 'Pivot Points', short: 'Pivots', group: 'Levels', overlay: true, params: [{ k: 'period', label: 'Period', def: 'session', type: 'select', options: ['session', 'week', 'month'] }], outputs: [{ k: 'p', label: 'P', color: C.f, style: 'step' }, { k: 'r1', label: 'R1', color: C.dn, style: 'step' }, { k: 's1', label: 'S1', color: C.up, style: 'step' }, { k: 'r2', label: 'R2', color: C.dn, style: 'step' }, { k: 's2', label: 'S2', color: C.up, style: 'step' }], calc: (b, p) => pivotPoints(b, p.period) },
  { id: 'linreg', name: 'Linear Regression', short: 'LinReg', group: 'Trend', overlay: true, params: [P.len(50), P.src()], outputs: [line('value', 'LinReg', C.g), { k: 'slope', label: 'Slope', hidden: true }], calc: (b, p) => linreg(source(b, p.src), p.len) },
  { id: 'volume', name: 'Volume', short: 'Vol', group: 'Volume', overlay: false, params: [P.len(20, 'Average length')], outputs: [{ k: 'vol', label: 'Vol', color: C.f, style: 'hist', colorBy: 'bar' }, line('avg', 'Avg', C.a)], calc: (b, p) => ({ vol: b.v, avg: sma(b.v, p.len) }), fmt: 'vol' },
  { id: 'rvol', name: 'Relative Volume', short: 'RVOL', group: 'Volume', overlay: false, params: [P.len(20)], outputs: [{ k: 'value', label: 'RVOL', color: C.b, style: 'hist' }], levels: [1], calc: (b, p) => { const a = sma(b.v, p.len), n = b.t.length, o = nanArr(n); for (let i = 1; i < n; i++) if (a[i - 1]) o[i] = b.v[i] / a[i - 1]; return { value: o }; } },
  { id: 'obv', name: 'On-Balance Volume', short: 'OBV', group: 'Volume', overlay: false, params: [], outputs: [line('value', 'OBV', C.b)], calc: (b) => ({ value: obv(b) }), fmt: 'vol' },
  { id: 'mfi', name: 'Money Flow Index', short: 'MFI', group: 'Volume', overlay: false, params: [P.len(14)], outputs: [line('value', 'MFI', C.d)], levels: [20, 80], range: [0, 100], calc: (b, p) => ({ value: mfi(b, p.len) }) },
  { id: 'cmf', name: 'Chaikin Money Flow', short: 'CMF', group: 'Volume', overlay: false, params: [P.len(20)], outputs: [line('value', 'CMF', C.d)], levels: [0], calc: (b, p) => ({ value: cmf(b, p.len) }) },
  { id: 'rsi', name: 'Relative Strength Index', short: 'RSI', group: 'Momentum', overlay: false, params: [P.len(14), P.src()], outputs: [line('value', 'RSI', C.c)], levels: [30, 70], range: [0, 100], calc: (b, p) => ({ value: rsi(source(b, p.src), p.len) }) },
  { id: 'macd', name: 'MACD', short: 'MACD', group: 'Momentum', overlay: false, params: [P.num('fast', 'Fast', 12, 1, 1), P.num('slow', 'Slow', 26, 1, 1), P.num('sig', 'Signal', 9, 1, 1), P.src()], outputs: [{ k: 'hist', label: 'Hist', color: C.f, style: 'hist', colorBy: 'sign' }, line('macd', 'MACD', C.b), line('signal', 'Signal', C.a)], levels: [0], calc: (b, p) => macd(source(b, p.src), p.fast, p.slow, p.sig) },
  { id: 'stoch', name: 'Stochastic', short: 'Stoch', group: 'Momentum', overlay: false, params: [P.num('k', '%K length', 14, 1, 1), P.num('smooth', '%K smoothing', 3, 1, 1), P.num('d', '%D length', 3, 1, 1)], outputs: [line('k', '%K', C.b), line('d', '%D', C.a)], levels: [20, 80], range: [0, 100], calc: (b, p) => stoch(b, p.k, p.smooth, p.d) },
  { id: 'stochrsi', name: 'Stochastic RSI', short: 'StochRSI', group: 'Momentum', overlay: false, params: [P.num('rsi', 'RSI length', 14, 1, 1), P.num('st', 'Stoch length', 14, 1, 1), P.num('k', '%K', 3, 1, 1), P.num('d', '%D', 3, 1, 1)], outputs: [line('k', '%K', C.b), line('d', '%D', C.a)], levels: [20, 80], range: [0, 100], calc: (b, p) => stochRsi(b.c, p.rsi, p.st, p.k, p.d) },
  { id: 'cci', name: 'Commodity Channel Index', short: 'CCI', group: 'Momentum', overlay: false, params: [P.len(20)], outputs: [line('value', 'CCI', C.g)], levels: [-100, 100], calc: (b, p) => ({ value: cci(b, p.len) }) },
  { id: 'willr', name: 'Williams %R', short: '%R', group: 'Momentum', overlay: false, params: [P.len(14)], outputs: [line('value', '%R', C.c)], levels: [-80, -20], range: [-100, 0], calc: (b, p) => ({ value: willr(b, p.len) }) },
  { id: 'roc', name: 'Rate of Change', short: 'ROC', group: 'Momentum', overlay: false, params: [P.len(12), P.src()], outputs: [line('value', 'ROC %', C.b)], levels: [0], calc: (b, p) => ({ value: roc(source(b, p.src), p.len) }) },
  { id: 'mom', name: 'Momentum', short: 'Mom', group: 'Momentum', overlay: false, params: [P.len(10), P.src()], outputs: [line('value', 'Mom', C.b)], levels: [0], calc: (b, p) => ({ value: change(source(b, p.src), p.len) }) },
  { id: 'trix', name: 'TRIX', short: 'TRIX', group: 'Momentum', overlay: false, params: [P.len(15)], outputs: [line('value', 'TRIX', C.a)], levels: [0], calc: (b, p) => ({ value: trix(b.c, p.len) }) },
  { id: 'adx', name: 'ADX / DMI', short: 'ADX', group: 'Trend', overlay: false, params: [P.len(14)], outputs: [line('adx', 'ADX', C.a), line('pdi', '+DI', C.up), line('mdi', '-DI', C.dn)], levels: [20], calc: (b, p) => adx(b, p.len) },
  { id: 'aroon', name: 'Aroon', short: 'Aroon', group: 'Trend', overlay: false, params: [P.len(25)], outputs: [line('up', 'Up', C.up), line('down', 'Down', C.dn)], range: [0, 100], calc: (b, p) => aroon(b, p.len) },
  { id: 'atr', name: 'Average True Range', short: 'ATR', group: 'Volatility', overlay: false, params: [P.len(14)], outputs: [line('value', 'ATR', C.e)], calc: (b, p) => ({ value: atr(b, p.len) }) },
  { id: 'atrp', name: 'ATR %', short: 'ATR%', group: 'Volatility', overlay: false, params: [P.len(14)], outputs: [line('value', 'ATR %', C.e)], calc: (b, p) => { const a = atr(b, p.len); return { value: a.map((x, i) => (100 * x) / b.c[i]) }; } },
  { id: 'bbw', name: 'Bollinger Band Width', short: 'BBW', group: 'Volatility', overlay: false, params: [P.len(20), P.num('mult', 'Std dev', 2, 0.1)], outputs: [line('value', 'Width %', C.b)], calc: (b, p) => { const x = bollinger(b.c, p.len, p.mult); return { value: x.mid.map((m, i) => (100 * (x.upper[i] - x.lower[i])) / m) }; } },
  { id: 'pctb', name: 'Bollinger %B', short: '%B', group: 'Volatility', overlay: false, params: [P.len(20), P.num('mult', 'Std dev', 2, 0.1)], outputs: [line('value', '%B', C.b)], levels: [0, 1], calc: (b, p) => { const x = bollinger(b.c, p.len, p.mult); return { value: x.mid.map((m, i) => (b.c[i] - x.lower[i]) / (x.upper[i] - x.lower[i])) }; } },
  { id: 'zscore', name: 'Z-Score', short: 'Z', group: 'Volatility', overlay: false, params: [P.len(20), P.src()], outputs: [line('value', 'Z', C.g)], levels: [-2, 0, 2], calc: (b, p) => ({ value: zscore(source(b, p.src), p.len) }) },
  { id: 'chg', name: 'Percent Change', short: 'Chg%', group: 'Price', overlay: false, params: [P.len(1, 'Bars')], outputs: [{ k: 'value', label: 'Chg %', color: C.f, style: 'hist', colorBy: 'sign' }], levels: [0], calc: (b, p) => ({ value: roc(b.c, p.len) }) },
  { id: 'gap', name: 'Opening Gap %', short: 'Gap%', group: 'Price', overlay: false, params: [], outputs: [{ k: 'value', label: 'Gap %', color: C.f, style: 'hist', colorBy: 'sign' }], levels: [0], calc: (b) => { const n = b.t.length, o = nanArr(n); for (let i = 1; i < n; i++) o[i] = (b.o[i] / b.c[i - 1] - 1) * 100; return { value: o }; } },
];
defs.forEach(registerIndicator);

export function defaultParams(def) { const p = {}; for (const q of def.params) p[q.k] = q.def; return p; }
export function paramText(def, params) {
  const vals = def.params.filter((q) => q.type !== 'source' || params[q.k] !== 'close').map((q) => params[q.k]);
  return vals.length ? `(${vals.join(', ')})` : '';
}
export const indLabel = (def, params) => `${def.short || def.name}${paramText(def, params)}`;

// Memoised per bars object, so the chart, scanner and tester share work.
const memo = new WeakMap();
export function calcIndicator(id, bars, params) {
  const def = IND.get(id);
  if (!def) return null;
  const p = { ...defaultParams(def), ...(params || {}) };
  let m = memo.get(bars);
  if (!m) { m = new Map(); memo.set(bars, m); }
  const key = id + '|' + (def.rev || 0) + '|' + JSON.stringify(p);
  let out = m.get(key);
  if (!out) {
    try { out = def.calc(bars, p); } catch (e) { out = { __error: String(e && e.message || e) }; }
    m.set(key, out);
  }
  return out;
}

export const PALETTE = [C.a, C.b, C.c, C.d, C.e, C.g, C.f];

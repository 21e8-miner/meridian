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
  return wma(d, Math.max(1, Math.floor(Math.sqrt(len))));
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


// ───────────────────────── more studies ─────────────────────────
const rsum = (a, len) => sma(a, len).map((x) => x * len);
const zip = (a, b, f) => a.map((x, i) => f(x, b[i], i));

export function dema(a, len) { const e1 = ema(a, len), e2 = ema(e1, len); return zip(e1, e2, (x, y) => 2 * x - y); }
export function tema(a, len) { const e1 = ema(a, len), e2 = ema(e1, len), e3 = ema(e2, len); return e1.map((x, i) => 3 * x - 3 * e2[i] + e3[i]); }
export function kama(a, len = 10, fast = 2, slow = 30) {
  const n = a.length, out = nanArr(n), fs = 2 / (fast + 1), ss = 2 / (slow + 1);
  let prev = NaN;
  for (let i = len; i < n; i++) {
    if (!ok(a[i]) || !ok(a[i - len])) continue;
    let vol = 0; for (let k = 0; k < len; k++) vol += Math.abs(a[i - k] - a[i - k - 1]);
    const er = vol ? Math.abs(a[i] - a[i - len]) / vol : 0, sc = (er * (fs - ss) + ss) ** 2;
    prev = ok(prev) ? prev + sc * (a[i] - prev) : a[i];
    out[i] = prev;
  }
  return out;
}
export function vwma(bars, len) { const pv = bars.c.map((c, i) => c * bars.v[i]), a = sma(pv, len), b = sma(bars.v, len); return zip(a, b, (x, y) => (y ? x / y : NaN)); }
export function ppo(a, fast, slow, sig) { const f = ema(a, fast), s = ema(a, slow), p = zip(f, s, (x, y) => (y ? ((x - y) / y) * 100 : NaN)), signal = ema(p, sig); return { ppo: p, signal, hist: zip(p, signal, (x, y) => x - y) }; }
export function awesome(bars) { const m = source(bars, 'hl2'); return zip(sma(m, 5), sma(m, 34), (x, y) => x - y); }
export function ultimate(bars, a = 7, b = 14, c = 28) {
  const n = bars.t.length, bp = nanArr(n), tr = nanArr(n);
  for (let i = 1; i < n; i++) { const pc = bars.c[i - 1], lo = Math.min(bars.l[i], pc); bp[i] = bars.c[i] - lo; tr[i] = Math.max(bars.h[i], pc) - lo; }
  const r = (len) => zip(rsum(bp, len), rsum(tr, len), (x, y) => (y ? x / y : NaN)), x = r(a), y = r(b), z = r(c);
  return x.map((v, i) => (100 * (4 * v + 2 * y[i] + z[i])) / 7);
}
export function tsi(a, long = 25, short = 13, sig = 7) {
  const m = change(a, 1), am = m.map(Math.abs), num = ema(ema(m, long), short), den = ema(ema(am, long), short), t = zip(num, den, (x, y) => (y ? (100 * x) / y : NaN));
  return { tsi: t, signal: ema(t, sig) };
}
export function dpo(a, len) { const m = sma(a, len), k = Math.floor(len / 2) + 1, n = a.length, out = nanArr(n); for (let i = k; i < n; i++) out[i] = a[i - k] - m[i]; return out; }
export function vortex(bars, len) {
  const n = bars.t.length, vp = nanArr(n), vm = nanArr(n), tr = trueRange(bars); tr[0] = NaN;
  for (let i = 1; i < n; i++) { vp[i] = Math.abs(bars.h[i] - bars.l[i - 1]); vm[i] = Math.abs(bars.l[i] - bars.h[i - 1]); }
  const t = rsum(tr, len);
  return { plus: zip(rsum(vp, len), t, (x, y) => (y ? x / y : NaN)), minus: zip(rsum(vm, len), t, (x, y) => (y ? x / y : NaN)) };
}
export function adl(bars) { const n = bars.t.length, out = new Array(n); let s = 0; for (let i = 0; i < n; i++) { const r = bars.h[i] - bars.l[i]; s += r ? (((bars.c[i] - bars.l[i]) - (bars.h[i] - bars.c[i])) / r) * bars.v[i] : 0; out[i] = s; } return out; }
export function chaikinOsc(bars, fast = 3, slow = 10) { const a = adl(bars); return zip(ema(a, fast), ema(a, slow), (x, y) => x - y); }
export function forceIndex(bars, len) { const n = bars.t.length, raw = nanArr(n); for (let i = 1; i < n; i++) raw[i] = (bars.c[i] - bars.c[i - 1]) * bars.v[i]; return ema(raw, len); }
export function easeOfMovement(bars, len) {
  const n = bars.t.length, raw = nanArr(n);
  for (let i = 1; i < n; i++) { const r = bars.h[i] - bars.l[i], dm = (bars.h[i] + bars.l[i]) / 2 - (bars.h[i - 1] + bars.l[i - 1]) / 2; raw[i] = r && bars.v[i] ? dm / (bars.v[i] / 1e8 / r) : 0; }
  return sma(raw, len);
}
export function elderRay(bars, len) { const e = ema(bars.c, len); return { bull: zip(bars.h, e, (x, y) => x - y), bear: zip(bars.l, e, (x, y) => x - y) }; }
export function fisher(bars, len) {
  const m = source(bars, 'hl2'), hh = highest(m, len), ll = lowest(m, len), n = m.length, f = nanArr(n), sig = nanArr(n);
  let x = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    if (!ok(hh[i])) continue;
    const r = hh[i] - ll[i];
    x = 0.33 * 2 * ((r ? (m[i] - ll[i]) / r : 0.5) - 0.5) + 0.67 * x;
    x = Math.max(-0.999, Math.min(0.999, x));
    const v = 0.5 * Math.log((1 + x) / (1 - x)) + 0.5 * prev;
    sig[i] = prev; f[i] = v; prev = v;
  }
  return { fisher: f, signal: sig };
}
export function choppiness(bars, len) {
  const tr = trueRange(bars), s = rsum(tr, len), hh = highest(bars.h, len), ll = lowest(bars.l, len), lg = Math.log10(len);
  return s.map((x, i) => { const r = hh[i] - ll[i]; return r > 0 && x > 0 ? (100 * Math.log10(x / r)) / lg : NaN; });
}
export function ulcer(a, len) { const hh = highest(a, len), dd2 = a.map((x, i) => (ok(hh[i]) && hh[i] ? ((100 * (x - hh[i])) / hh[i]) ** 2 : NaN)); return sma(dd2, len).map(Math.sqrt); }
export function coppock(a, r1 = 14, r2 = 11, w = 10) { return wma(zip(roc(a, r1), roc(a, r2), (x, y) => x + y), w); }
export function massIndex(bars, len = 25, e = 9) { const r = bars.h.map((x, i) => x - bars.l[i]), e1 = ema(r, e), e2 = ema(e1, e); return rsum(zip(e1, e2, (x, y) => (y ? x / y : NaN)), len); }
export function pvt(bars) { const n = bars.t.length, out = new Array(n); let s = 0; for (let i = 0; i < n; i++) { if (i > 0 && bars.c[i - 1]) s += (bars.v[i] * (bars.c[i] - bars.c[i - 1])) / bars.c[i - 1]; out[i] = s; } return out; }
export function streak(a) { const n = a.length, out = new Array(n).fill(0); for (let i = 1; i < n; i++) out[i] = a[i] > a[i - 1] ? Math.max(1, out[i - 1] + 1) : a[i] < a[i - 1] ? Math.min(-1, out[i - 1] - 1) : 0; return out; }
export function connorsRsi(a, rsiLen = 3, streakLen = 2, rankLen = 100) {
  const r1 = rsi(a, rsiLen), r2 = rsi(streak(a), streakLen), ch = roc(a, 1), n = a.length, out = nanArr(n);
  for (let i = rankLen; i < n; i++) {
    if (!ok(r1[i]) || !ok(r2[i]) || !ok(ch[i])) continue;
    let below = 0, cnt = 0; for (let k = 1; k <= rankLen; k++) { const v = ch[i - k]; if (ok(v)) { cnt++; if (v < ch[i]) below++; } }
    out[i] = cnt ? (r1[i] + r2[i] + (100 * below) / cnt) / 3 : NaN;
  }
  return out;
}
export function histVol(a, len, perYear = 252) { const n = a.length, lr = nanArr(n); for (let i = 1; i < n; i++) if (a[i] > 0 && a[i - 1] > 0) lr[i] = Math.log(a[i] / a[i - 1]); return stdev(lr, len).map((x) => x * Math.sqrt(perYear) * 100); }
// Volatility squeeze: Bollinger Bands inside Keltner Channels, with a momentum read.
export function squeeze(bars, len = 20, bbMult = 2, kcMult = 1.5) {
  const bb = bollinger(bars.c, len, bbMult), kc = keltner(bars, len, kcMult, len), hh = highest(bars.h, len), ll = lowest(bars.l, len), m = sma(bars.c, len);
  const d = bars.c.map((c, i) => c - ((hh[i] + ll[i]) / 2 + m[i]) / 2);
  return { mom: linreg(d, len).value, on: bb.upper.map((u, i) => (ok(u) && ok(kc.upper[i]) ? (u < kc.upper[i] && bb.lower[i] > kc.lower[i] ? 1 : 0) : NaN)) };
}
// VWAP anchored at a chosen bar time (set by right-clicking a chart).
export function anchoredVwap(bars, anchorT = 0) {
  const n = bars.t.length, out = nanArr(n); let pv = 0, vol = 0;
  for (let i = 0; i < n; i++) { if (bars.t[i] < anchorT) continue; const tp = (bars.h[i] + bars.l[i] + bars.c[i]) / 3; pv += tp * bars.v[i]; vol += bars.v[i]; out[i] = vol > 0 ? pv / vol : tp; }
  return out;
}

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
  { id: 'dema', name: 'Double EMA', short: 'DEMA', group: 'Trend', overlay: true, params: [P.len(21), P.src()], outputs: [line('value', 'DEMA', C.b)], calc: (b, p) => ({ value: dema(source(b, p.src), p.len) }) },
  { id: 'tema', name: 'Triple EMA', short: 'TEMA', group: 'Trend', overlay: true, params: [P.len(21), P.src()], outputs: [line('value', 'TEMA', C.c)], calc: (b, p) => ({ value: tema(source(b, p.src), p.len) }) },
  { id: 'kama', name: 'Kaufman Adaptive MA', short: 'KAMA', group: 'Trend', overlay: true, params: [P.len(10), P.num('fast', 'Fast', 2, 1, 1), P.num('slow', 'Slow', 30, 1, 1), P.src()], outputs: [line('value', 'KAMA', C.d)], calc: (b, p) => ({ value: kama(source(b, p.src), p.len, p.fast, p.slow) }) },
  { id: 'vwma', name: 'Volume-Weighted MA', short: 'VWMA', group: 'Trend', overlay: true, params: [P.len(20)], outputs: [line('value', 'VWMA', C.g)], calc: (b, p) => ({ value: vwma(b, p.len) }) },
  { id: 'avwap', name: 'VWAP from a chosen bar', short: 'AVWAP', group: 'Trend', overlay: true, params: [{ k: 'anchor', label: 'Anchor', def: 0, type: 'time', hidden: true }], outputs: [line('value', 'AVWAP', C.e)], calc: (b, p) => ({ value: anchoredVwap(b, p.anchor) }) },
  { id: 'envelope', name: 'Moving Average Envelope', short: 'Env', group: 'Volatility', overlay: true, params: [P.len(20), P.num('pct', 'Percent', 2.5, 0.1)], outputs: [line('upper', 'Upper', C.d), line('mid', 'Mid', C.f), line('lower', 'Lower', C.d)], fill: ['upper', 'lower'], calc: (b, p) => { const m = sma(b.c, p.len); return { upper: m.map((x) => x * (1 + p.pct / 100)), mid: m, lower: m.map((x) => x * (1 - p.pct / 100)) }; } },
  { id: 'chandelier', name: 'Chandelier Exit', short: 'Chand', group: 'Volatility', overlay: true, params: [P.len(22), P.num('mult', 'ATR mult', 3, 0.1)], outputs: [line('long', 'Long stop', C.up), line('short', 'Short stop', C.dn)], calc: (b, p) => { const a = atr(b, p.len), hh = highest(b.h, p.len), ll = lowest(b.l, p.len); return { long: hh.map((x, i) => x - p.mult * a[i]), short: ll.map((x, i) => x + p.mult * a[i]) }; } },
  { id: 'ppo', name: 'Percentage Price Oscillator', short: 'PPO', group: 'Momentum', overlay: false, params: [P.num('fast', 'Fast', 12, 1, 1), P.num('slow', 'Slow', 26, 1, 1), P.num('sig', 'Signal', 9, 1, 1)], outputs: [{ k: 'hist', label: 'Hist', color: C.f, style: 'hist', colorBy: 'sign' }, line('ppo', 'PPO', C.b), line('signal', 'Signal', C.a)], levels: [0], calc: (b, p) => ppo(b.c, p.fast, p.slow, p.sig) },
  { id: 'ao', name: 'Awesome Oscillator', short: 'AO', group: 'Momentum', overlay: false, params: [], outputs: [{ k: 'value', label: 'AO', color: C.f, style: 'hist', colorBy: 'sign' }], levels: [0], calc: (b) => ({ value: awesome(b) }) },
  { id: 'uo', name: 'Ultimate Oscillator', short: 'UO', group: 'Momentum', overlay: false, params: [P.num('a', 'Short', 7, 1, 1), P.num('b', 'Mid', 14, 1, 1), P.num('c', 'Long', 28, 1, 1)], outputs: [line('value', 'UO', C.c)], levels: [30, 70], range: [0, 100], calc: (b, p) => ({ value: ultimate(b, p.a, p.b, p.c) }) },
  { id: 'tsi', name: 'True Strength Index', short: 'TSI', group: 'Momentum', overlay: false, params: [P.num('long', 'Long', 25, 1, 1), P.num('short', 'Short', 13, 1, 1), P.num('sig', 'Signal', 7, 1, 1)], outputs: [line('tsi', 'TSI', C.b), line('signal', 'Signal', C.a)], levels: [0], calc: (b, p) => tsi(b.c, p.long, p.short, p.sig) },
  { id: 'dpo', name: 'Detrended Price Oscillator', short: 'DPO', group: 'Momentum', overlay: false, params: [P.len(20)], outputs: [line('value', 'DPO', C.g)], levels: [0], calc: (b, p) => ({ value: dpo(b.c, p.len) }) },
  { id: 'coppock', name: 'Coppock Curve', short: 'Coppock', group: 'Momentum', overlay: false, params: [P.num('r1', 'ROC 1', 14, 1, 1), P.num('r2', 'ROC 2', 11, 1, 1), P.num('w', 'WMA', 10, 1, 1)], outputs: [line('value', 'Coppock', C.d)], levels: [0], calc: (b, p) => ({ value: coppock(b.c, p.r1, p.r2, p.w) }) },
  { id: 'fisher', name: 'Fisher Transform', short: 'Fisher', group: 'Momentum', overlay: false, params: [P.len(9)], outputs: [line('fisher', 'Fisher', C.b), line('signal', 'Trigger', C.a)], levels: [0], calc: (b, p) => fisher(b, p.len) },
  { id: 'crsi', name: 'Connors RSI', short: 'CRSI', group: 'Momentum', overlay: false, params: [P.num('rsi', 'RSI', 3, 1, 1), P.num('streak', 'Streak RSI', 2, 1, 1), P.num('rank', 'Rank lookback', 100, 1, 2)], outputs: [line('value', 'CRSI', C.c)], levels: [10, 90], range: [0, 100], calc: (b, p) => ({ value: connorsRsi(b.c, p.rsi, p.streak, p.rank) }) },
  { id: 'streak', name: 'Up / Down Streak', short: 'Streak', group: 'Price', overlay: false, params: [], outputs: [{ k: 'value', label: 'Streak', color: C.f, style: 'hist', colorBy: 'sign' }], levels: [0], calc: (b) => ({ value: streak(b.c) }) },
  { id: 'dist52', name: 'Distance from High %', short: 'FromHigh', group: 'Price', overlay: false, params: [P.len(252, 'Lookback')], outputs: [line('value', '% from high', C.e)], levels: [0], calc: (b, p) => { const hh = highest(b.h, p.len); return { value: hh.map((x, i) => (x ? (b.c[i] / x - 1) * 100 : NaN)) }; } },
  { id: 'vortex', name: 'Vortex Indicator', short: 'Vortex', group: 'Trend', overlay: false, params: [P.len(14)], outputs: [line('plus', 'VI+', C.up), line('minus', 'VI-', C.dn)], levels: [1], calc: (b, p) => vortex(b, p.len) },
  { id: 'elder', name: 'Elder Ray', short: 'Elder', group: 'Trend', overlay: false, params: [P.len(13)], outputs: [line('bull', 'Bull power', C.up), line('bear', 'Bear power', C.dn)], levels: [0], calc: (b, p) => elderRay(b, p.len) },
  { id: 'chop', name: 'Choppiness Index', short: 'Chop', group: 'Trend', overlay: false, params: [P.len(14)], outputs: [line('value', 'Chop', C.g)], levels: [38.2, 61.8], calc: (b, p) => ({ value: choppiness(b, p.len) }) },
  { id: 'mass', name: 'Mass Index', short: 'Mass', group: 'Volatility', overlay: false, params: [P.len(25), P.num('e', 'EMA', 9, 1, 1)], outputs: [line('value', 'Mass', C.b)], levels: [26.5, 27], calc: (b, p) => ({ value: massIndex(b, p.len, p.e) }) },
  { id: 'stdev', name: 'Standard Deviation', short: 'StDev', group: 'Volatility', overlay: false, params: [P.len(20), P.src()], outputs: [line('value', 'StDev', C.e)], calc: (b, p) => ({ value: stdev(source(b, p.src), p.len) }) },
  { id: 'hv', name: 'Historical Volatility', short: 'HV', group: 'Volatility', overlay: false, params: [P.len(20), P.num('year', 'Bars per year', 252, 1, 1)], outputs: [line('value', 'HV %', C.e)], calc: (b, p) => ({ value: histVol(b.c, p.len, p.year) }) },
  { id: 'ulcer', name: 'Ulcer Index', short: 'Ulcer', group: 'Volatility', overlay: false, params: [P.len(14)], outputs: [line('value', 'Ulcer', C.e)], calc: (b, p) => ({ value: ulcer(b.c, p.len) }) },
  { id: 'squeeze', name: 'Volatility Squeeze', short: 'Squeeze', group: 'Volatility', overlay: false, params: [P.len(20), P.num('bb', 'BB mult', 2, 0.1), P.num('kc', 'KC mult', 1.5, 0.1)], outputs: [{ k: 'mom', label: 'Momentum', color: C.f, style: 'hist', colorBy: 'sign' }, { k: 'on', label: 'Squeeze on (1/0)', hidden: true }], levels: [0], calc: (b, p) => squeeze(b, p.len, p.bb, p.kc) },
  { id: 'adl', name: 'Accumulation / Distribution', short: 'A/D', group: 'Volume', overlay: false, params: [], outputs: [line('value', 'A/D', C.b)], calc: (b) => ({ value: adl(b) }), fmt: 'vol' },
  { id: 'cho', name: 'Chaikin Oscillator', short: 'ChO', group: 'Volume', overlay: false, params: [P.num('fast', 'Fast', 3, 1, 1), P.num('slow', 'Slow', 10, 1, 1)], outputs: [line('value', 'ChO', C.d)], levels: [0], calc: (b, p) => ({ value: chaikinOsc(b, p.fast, p.slow) }), fmt: 'vol' },
  { id: 'force', name: 'Force Index', short: 'Force', group: 'Volume', overlay: false, params: [P.len(13)], outputs: [line('value', 'Force', C.d)], levels: [0], calc: (b, p) => ({ value: forceIndex(b, p.len) }), fmt: 'vol' },
  { id: 'eom', name: 'Ease of Movement', short: 'EOM', group: 'Volume', overlay: false, params: [P.len(14)], outputs: [line('value', 'EOM', C.d)], levels: [0], calc: (b, p) => ({ value: easeOfMovement(b, p.len) }) },
  { id: 'pvt', name: 'Price Volume Trend', short: 'PVT', group: 'Volume', overlay: false, params: [], outputs: [line('value', 'PVT', C.b)], calc: (b) => ({ value: pvt(b) }), fmt: 'vol' },
];
defs.forEach(registerIndicator);

// Settings as the maths will use them: numbers forced into [min, max], whole where the setting is
// a count. Without this a negative length would index forward in time and read the future.
export function cleanParams(def, params) {
  const p = { ...defaultParams(def), ...(params || {}) };
  for (const q of def.params) {
    if (q.type) { if (q.type === 'select' && !q.options.includes(p[q.k])) p[q.k] = q.def; continue; }
    let v = Number(p[q.k]);
    if (!Number.isFinite(v)) v = q.def;
    if ((q.step || 1) >= 1) v = Math.round(v);
    if (q.min != null && v < q.min) v = q.min;
    if (q.max != null && v > q.max) v = q.max;
    p[q.k] = v;
  }
  return p;
}
export function defaultParams(def) { const p = {}; for (const q of def.params) p[q.k] = q.def; return p; }
export function paramText(def, params) {
  const vals = def.params.filter((q) => !q.hidden && (q.type !== 'source' || params[q.k] !== 'close')).map((q) => params[q.k]);
  return vals.length ? `(${vals.join(', ')})` : '';
}
export const indLabel = (def, params) => `${def.short || def.name}${paramText(def, params)}`;

// Memoised per bars object, so the chart, scanner and tester share work.
const memo = new WeakMap();
export function calcIndicator(id, bars, params) {
  const def = IND.get(id);
  if (!def) return null;
  const p = cleanParams(def, params);
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

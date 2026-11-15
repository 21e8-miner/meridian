// Automated chart analysis: swing pivots, trendlines, support/resistance zones, Fibonacci,
// candlestick patterns, chart patterns and open gaps. Pure functions over bars.
import { atr, sma } from './ta.js';

// A pivot high at i is the highest high of [i-left, i+right]; it is only knowable `right` bars later.
export function pivots(bars, left = 5, right = left, from = 0, to = bars.t.length - 1) {
  const highs = [], lows = [];
  for (let i = Math.max(from, left); i <= to - right; i++) {
    let isH = true, isL = true;
    const hi = bars.h[i], lo = bars.l[i];
    for (let k = 1; k <= left && (isH || isL); k++) { if (bars.h[i - k] >= hi) isH = false; if (bars.l[i - k] <= lo) isL = false; }
    for (let k = 1; k <= right && (isH || isL); k++) { if (bars.h[i + k] > hi) isH = false; if (bars.l[i + k] < lo) isL = false; }
    if (isH) highs.push({ i, p: hi });
    if (isL) lows.push({ i, p: lo });
  }
  return { highs, lows };
}

function atrAt(bars, end) {
  const a = atr(bars, 14);
  let v = a[end];
  if (!(v > 0)) { let s = 0, c = 0; for (let i = Math.max(0, end - 20); i <= end; i++) { s += bars.h[i] - bars.l[i]; c++; } v = s / Math.max(1, c); }
  return v || bars.c[end] * 0.01;
}

/**
 * Trendlines through swing pivots. A candidate must hold (no close through it) from its first
 * anchor up to the last `breakWindow` bars; a close through it inside that window marks it broken.
 */
export function autoTrendlines(bars, { lookback = 250, strength = 5, maxLines = 2, end = bars.t.length - 1, breakWindow = 3 } = {}) {
  const start = Math.max(0, end - lookback);
  if (end - start < strength * 4) return [];
  const A = atrAt(bars, end), tol = 0.35 * A;
  const pv = pivots(bars, strength, strength, start, end);
  const out = [];
  for (const kind of ['sup', 'res']) {
    const pts = kind === 'sup' ? pv.lows : pv.highs, sign = kind === 'sup' ? 1 : -1;
    const cands = [];
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const p1 = pts[a], p2 = pts[b], span = p2.i - p1.i;
        if (span < Math.max(8, strength * 2)) continue;
        const m = (p2.p - p1.p) / span, at = (i) => p1.p + m * (i - p1.i);
        const vEnd = at(end);
        if (!(vEnd > 0) || Math.abs(vEnd - bars.c[end]) > 4 * A) continue;
        let bad = false;
        for (let k = p1.i + 1; k <= end - breakWindow; k++) { if (sign * (bars.c[k] - at(k)) < -tol * 1.5) { bad = true; break; } }
        if (bad) continue;
        let broken = false;
        for (let k = Math.max(p1.i + 1, end - breakWindow + 1); k <= end; k++) if (sign * (bars.c[k] - at(k)) < -tol) broken = true;
        const touches = [];
        for (const q of pts) if (q.i >= p1.i && Math.abs(q.p - at(q.i)) <= tol) touches.push(q.i);
        if (touches.length < 2) continue;
        const score = touches.length * touches.length * 4 + (end - p1.i) / lookback * 6 + (p2.i - start) / lookback * 3 - (broken ? 2 : 0);
        cands.push({ kind, i1: p1.i, p1: p1.p, i2: p2.i, p2: p2.p, slope: m, touches, broken, score, vEnd });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    const picked = [];
    for (const c of cands) {
      if (picked.length >= maxLines) break;
      if (picked.some((q) => Math.abs(q.vEnd - c.vEnd) < 1.2 * A && Math.abs(q.slope - c.slope) * lookback < 3 * A)) continue;
      picked.push(c);
    }
    for (const c of picked) out.push({ ...c, t1: bars.t[c.i1], t2: bars.t[c.i2], valueAt: (i) => c.p1 + c.slope * (i - c.i1) });
  }
  return out;
}

// Horizontal zones where several swing highs/lows cluster.
export function autoLevels(bars, { lookback = 400, strength = 5, max = 5, end = bars.t.length - 1 } = {}) {
  const start = Math.max(0, end - lookback), A = atrAt(bars, end), tol = 0.6 * A;
  const pv = pivots(bars, strength, strength, start, end);
  const pts = [...pv.highs.map((p) => ({ ...p, k: 'h' })), ...pv.lows.map((p) => ({ ...p, k: 'l' }))].sort((a, b) => a.p - b.p);
  const clusters = [];
  for (const p of pts) {
    const c = clusters[clusters.length - 1];
    if (c && p.p - c.lo <= tol) { c.sum += p.p; c.n++; c.lo = Math.min(c.lo, p.p); c.hi = Math.max(c.hi, p.p); c.last = Math.max(c.last, p.i); c.idx.push(p.i); }
    else clusters.push({ sum: p.p, n: 1, lo: p.p, hi: p.p, last: p.i, idx: [p.i] });
  }
  const px = bars.c[end];
  return clusters.filter((c) => c.n >= 2 && Math.abs(c.sum / c.n - px) <= 10 * A)
    .map((c) => {
      const price = c.sum / c.n, half = Math.min(0.4 * A, Math.max((c.hi - c.lo) / 2, 0.12 * A));
      return { price, lo: price - half, hi: price + half, touches: c.n, last: c.last, kind: price < px ? 'sup' : 'res', score: c.n + (c.last - start) / lookback, idx: c.idx };
    })
    .sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => b.price - a.price);
}

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
export function autoFib(bars, { lookback = 200, end = bars.t.length - 1 } = {}) {
  const start = Math.max(0, end - lookback);
  let ih = start, il = start;
  for (let i = start; i <= end; i++) { if (bars.h[i] > bars.h[ih]) ih = i; if (bars.l[i] < bars.l[il]) il = i; }
  if (ih === il) return null;
  const hi = bars.h[ih], lo = bars.l[il], up = ih > il, rng = hi - lo;
  return {
    up, from: up ? { i: il, t: bars.t[il], p: lo } : { i: ih, t: bars.t[ih], p: hi }, to: up ? { i: ih, t: bars.t[ih], p: hi } : { i: il, t: bars.t[il], p: lo },
    levels: FIB_RATIOS.map((r) => ({ r, p: up ? hi - r * rng : lo + r * rng })),
  };
}

// ───────────────────────── candlestick patterns ─────────────────────────
export const CANDLES = [
  { id: 'doji', name: 'Doji', bias: 0 },
  { id: 'dragonfly', name: 'Dragonfly Doji', bias: 1 },
  { id: 'gravestone', name: 'Gravestone Doji', bias: -1 },
  { id: 'hammer', name: 'Hammer', bias: 1 },
  { id: 'hanging', name: 'Hanging Man', bias: -1 },
  { id: 'invhammer', name: 'Inverted Hammer', bias: 1 },
  { id: 'star', name: 'Shooting Star', bias: -1 },
  { id: 'bullengulf', name: 'Bullish Engulfing', bias: 1 },
  { id: 'bearengulf', name: 'Bearish Engulfing', bias: -1 },
  { id: 'bullharami', name: 'Bullish Harami', bias: 1 },
  { id: 'bearharami', name: 'Bearish Harami', bias: -1 },
  { id: 'piercing', name: 'Piercing Line', bias: 1 },
  { id: 'darkcloud', name: 'Dark Cloud Cover', bias: -1 },
  { id: 'morningstar', name: 'Morning Star', bias: 1 },
  { id: 'eveningstar', name: 'Evening Star', bias: -1 },
  { id: 'soldiers', name: 'Three White Soldiers', bias: 1 },
  { id: 'crows', name: 'Three Black Crows', bias: -1 },
  { id: 'bullmaru', name: 'Bullish Marubozu', bias: 1 },
  { id: 'bearmaru', name: 'Bearish Marubozu', bias: -1 },
  { id: 'inside', name: 'Inside Bar', bias: 0 },
];
export const CANDLE_BY_ID = Object.fromEntries(CANDLES.map((c) => [c.id, c]));

const candleMemo = new WeakMap();
export function candlePatterns(bars) {
  let res = candleMemo.get(bars);
  if (res) return res;
  const n = bars.t.length, { o, h, l, c } = bars;
  res = {};
  for (const p of CANDLES) res[p.id] = new Array(n).fill(false);
  const body = new Array(n);
  for (let i = 0; i < n; i++) body[i] = Math.abs(c[i] - o[i]);
  const avgB = sma(body, 10), ma = sma(c, 10);
  for (let i = 12; i < n; i++) {
    const rng = h[i] - l[i];
    if (!(rng > 0)) continue;
    const b = body[i], up = h[i] - Math.max(o[i], c[i]), lo = Math.min(o[i], c[i]) - l[i], bull = c[i] > o[i], bear = c[i] < o[i];
    const ab = avgB[i - 1] || b;
    const dn = c[i - 1] < ma[i - 1] && ma[i - 1] < ma[i - 4], ut = c[i - 1] > ma[i - 1] && ma[i - 1] > ma[i - 4];
    const pb = body[i - 1], pBull = c[i - 1] > o[i - 1], pBear = c[i - 1] < o[i - 1];
    const doji = b <= 0.1 * rng;
    if (doji) {
      if (lo >= 0.6 * rng && up <= 0.1 * rng) res.dragonfly[i] = true;
      else if (up >= 0.6 * rng && lo <= 0.1 * rng) res.gravestone[i] = true;
      else res.doji[i] = true;
    } else {
      if (lo >= 2 * b && up <= 0.15 * rng) { if (dn) res.hammer[i] = true; else if (ut) res.hanging[i] = true; }
      if (up >= 2 * b && lo <= 0.15 * rng) { if (dn) res.invhammer[i] = true; else if (ut) res.star[i] = true; }
    }
    if (pBear && bull && dn && o[i] <= c[i - 1] && c[i] >= o[i - 1] && b > pb) res.bullengulf[i] = true;
    if (pBull && bear && ut && o[i] >= c[i - 1] && c[i] <= o[i - 1] && b > pb) res.bearengulf[i] = true;
    if (pBear && bull && dn && pb > ab && c[i] < o[i - 1] && o[i] > c[i - 1] && b < 0.6 * pb) res.bullharami[i] = true;
    if (pBull && bear && ut && pb > ab && c[i] > o[i - 1] && o[i] < c[i - 1] && b < 0.6 * pb) res.bearharami[i] = true;
    const pMid = (o[i - 1] + c[i - 1]) / 2;
    if (pBear && bull && dn && pb > ab && o[i] < c[i - 1] && c[i] > pMid && c[i] < o[i - 1]) res.piercing[i] = true;
    if (pBull && bear && ut && pb > ab && o[i] > c[i - 1] && c[i] < pMid && c[i] > o[i - 1]) res.darkcloud[i] = true;
    const b2 = body[i - 2], mid2 = (o[i - 2] + c[i - 2]) / 2, ab2 = avgB[i - 3] || b2;
    const dn2 = c[i - 3] < ma[i - 3] && ma[i - 3] < ma[i - 6], ut2 = c[i - 3] > ma[i - 3] && ma[i - 3] > ma[i - 6];
    if (c[i - 2] < o[i - 2] && b2 > ab2 && pb < 0.5 * ab2 && Math.max(o[i - 1], c[i - 1]) < mid2 && bull && c[i] > mid2 && dn2) res.morningstar[i] = true;
    if (c[i - 2] > o[i - 2] && b2 > ab2 && pb < 0.5 * ab2 && Math.min(o[i - 1], c[i - 1]) > mid2 && bear && c[i] < mid2 && ut2) res.eveningstar[i] = true;
    if (bull && pBull && c[i - 2] > o[i - 2] && c[i] > c[i - 1] && c[i - 1] > c[i - 2] && o[i] > o[i - 1] && o[i] < c[i - 1] && o[i - 1] > o[i - 2] && o[i - 1] < c[i - 2] && b > 0.6 * ab && pb > 0.6 * ab && b2 > 0.6 * ab && up < 0.3 * b) res.soldiers[i] = true;
    if (bear && pBear && c[i - 2] < o[i - 2] && c[i] < c[i - 1] && c[i - 1] < c[i - 2] && o[i] < o[i - 1] && o[i] > c[i - 1] && o[i - 1] < o[i - 2] && o[i - 1] > c[i - 2] && b > 0.6 * ab && pb > 0.6 * ab && b2 > 0.6 * ab && lo < 0.3 * b) res.crows[i] = true;
    if (b >= 0.92 * rng && b > 1.3 * ab) { if (bull) res.bullmaru[i] = true; else res.bearmaru[i] = true; }
    if (h[i] < h[i - 1] && l[i] > l[i - 1]) res.inside[i] = true;
  }
  res.any_bull = new Array(n).fill(false); res.any_bear = new Array(n).fill(false);
  for (const p of CANDLES) {
    if (!p.bias) continue;
    const dst = p.bias > 0 ? res.any_bull : res.any_bear, a = res[p.id];
    for (let i = 0; i < n; i++) if (a[i]) dst[i] = true;
  }
  candleMemo.set(bars, res);
  return res;
}

export function detectCandles(bars, from = 0, to = bars.t.length - 1, { skip = ['inside', 'doji'] } = {}) {
  const res = candlePatterns(bars), out = [];
  for (let i = Math.max(0, from); i <= to; i++) {
    for (const p of CANDLES) { if (skip.includes(p.id)) continue; if (res[p.id][i]) { out.push({ i, id: p.id, name: p.name, bias: p.bias }); break; } }
  }
  return out;
}

// ───────────────────────── chart patterns ─────────────────────────
function fitLine(pts) {
  const n = pts.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.i; sy += p.p; sxx += p.i * p.i; sxy += p.i * p.p; }
  const den = n * sxx - sx * sx; if (!den) return null;
  const m = (n * sxy - sx * sy) / den, b = (sy - m * sx) / n;
  let err = 0; for (const p of pts) err = Math.max(err, Math.abs(p.p - (m * p.i + b)));
  return { m, b, err, at: (i) => m * i + b };
}

export function chartPatterns(bars, { lookback = 220, strength = 4, end = bars.t.length - 1 } = {}) {
  const start = Math.max(0, end - lookback), A = atrAt(bars, end), out = [];
  const { highs, lows } = pivots(bars, strength, strength, start, end);
  const px = bars.c[end];
  const minBetween = (a, b) => { let m = a; for (let i = a; i <= b; i++) if (bars.l[i] < bars.l[m]) m = i; return m; };
  const maxBetween = (a, b) => { let m = a; for (let i = a; i <= b; i++) if (bars.h[i] > bars.h[m]) m = i; return m; };
  const recent = (i) => end - i <= 60;

  // double top / bottom
  if (highs.length >= 2) {
    const a = highs[highs.length - 2], b = highs[highs.length - 1];
    const top = (a.p + b.p) / 2, tr = minBetween(a.i, b.i);
    if (recent(b.i) && b.i - a.i >= 8 && Math.abs(a.p - b.p) <= Math.max(0.015 * top, 0.5 * A) && top - bars.l[tr] >= Math.max(0.03 * top, 2 * A) && px < top) {
      const hiAfter = bars.h[maxBetween(b.i, end)];
      if (hiAfter <= Math.max(a.p, b.p) + 0.3 * A)
        out.push({ type: 'double_top', name: 'Double Top', bias: -1, confirmed: px < bars.l[tr], points: [a, { i: tr, p: bars.l[tr] }, b], level: bars.l[tr], iEnd: b.i });
    }
  }
  if (lows.length >= 2) {
    const a = lows[lows.length - 2], b = lows[lows.length - 1];
    const bot = (a.p + b.p) / 2, pk = maxBetween(a.i, b.i);
    if (recent(b.i) && b.i - a.i >= 8 && Math.abs(a.p - b.p) <= Math.max(0.015 * bot, 0.5 * A) && bars.h[pk] - bot >= Math.max(0.03 * bot, 2 * A) && px > bot) {
      const loAfter = bars.l[minBetween(b.i, end)];
      if (loAfter >= Math.min(a.p, b.p) - 0.3 * A)
        out.push({ type: 'double_bottom', name: 'Double Bottom', bias: 1, confirmed: px > bars.h[pk], points: [a, { i: pk, p: bars.h[pk] }, b], level: bars.h[pk], iEnd: b.i });
    }
  }
  // head and shoulders / inverse
  if (highs.length >= 3) {
    const [ls, hd, rs] = highs.slice(-3);
    if (recent(rs.i) && hd.p > ls.p + A && hd.p > rs.p + A && Math.abs(ls.p - rs.p) <= 0.04 * hd.p) {
      const t1 = minBetween(ls.i, hd.i), t2 = minBetween(hd.i, rs.i);
      const neck = (i) => bars.l[t1] + ((bars.l[t2] - bars.l[t1]) / (t2 - t1 || 1)) * (i - t1);
      if (px < rs.p + 0.3 * A)
        out.push({ type: 'hs', name: 'Head & Shoulders', bias: -1, confirmed: px < neck(end), points: [ls, { i: t1, p: bars.l[t1] }, hd, { i: t2, p: bars.l[t2] }, rs], lines: [[{ i: t1, p: bars.l[t1] }, { i: end, p: neck(end) }]], iEnd: rs.i });
    }
  }
  if (lows.length >= 3) {
    const [ls, hd, rs] = lows.slice(-3);
    if (recent(rs.i) && hd.p < ls.p - A && hd.p < rs.p - A && Math.abs(ls.p - rs.p) <= 0.04 * hd.p) {
      const t1 = maxBetween(ls.i, hd.i), t2 = maxBetween(hd.i, rs.i);
      const neck = (i) => bars.h[t1] + ((bars.h[t2] - bars.h[t1]) / (t2 - t1 || 1)) * (i - t1);
      if (px > rs.p - 0.3 * A)
        out.push({ type: 'ihs', name: 'Inverse Head & Shoulders', bias: 1, confirmed: px > neck(end), points: [ls, { i: t1, p: bars.h[t1] }, hd, { i: t2, p: bars.h[t2] }, rs], lines: [[{ i: t1, p: bars.h[t1] }, { i: end, p: neck(end) }]], iEnd: rs.i });
    }
  }
  // converging / parallel structures from the last three swing highs and lows
  if (highs.length >= 3 && lows.length >= 3) {
    const H = highs.slice(-3), L = lows.slice(-3), fh = fitLine(H), fl = fitLine(L);
    const i0 = Math.min(H[0].i, L[0].i), span = end - i0;
    if (fh && fl && span >= 15 && recent(Math.max(H[2].i, L[2].i)) && fh.err <= 0.8 * A && fl.err <= 0.8 * A && fh.at(end) > fl.at(end) && fh.at(i0) > fl.at(i0)) {
      const nh = (fh.m * span) / px, nl = (fl.m * span) / px, flat = 0.02;
      const w0 = fh.at(i0) - fl.at(i0), w1 = fh.at(end) - fl.at(end), conv = w1 < 0.7 * w0, par = Math.abs(w1 - w0) <= 0.3 * w0;
      let name = null, bias = 0, type = null;
      const hf = Math.abs(nh) < flat, lf = Math.abs(nl) < flat;
      if (hf && lf) { name = 'Rectangle'; type = 'rectangle'; }
      else if (hf && nl >= flat && conv) { name = 'Ascending Triangle'; bias = 1; type = 'asc_triangle'; }
      else if (lf && nh <= -flat && conv) { name = 'Descending Triangle'; bias = -1; type = 'desc_triangle'; }
      else if (nh <= -flat && nl >= flat && conv) { name = 'Symmetrical Triangle'; type = 'sym_triangle'; }
      else if (nh > 0 && nl > 0 && conv) { name = 'Rising Wedge'; bias = -1; type = 'rising_wedge'; }
      else if (nh < 0 && nl < 0 && conv) { name = 'Falling Wedge'; bias = 1; type = 'falling_wedge'; }
      else if (nh >= flat && nl >= flat && par) { name = 'Ascending Channel'; bias = 1; type = 'channel_up'; }
      else if (nh <= -flat && nl <= -flat && par) { name = 'Descending Channel'; bias = -1; type = 'channel_down'; }
      if (name && px <= fh.at(end) + A && px >= fl.at(end) - A)
        out.push({ type, name, bias, confirmed: false, points: [], lines: [[{ i: i0, p: fh.at(i0) }, { i: end, p: fh.at(end) }], [{ i: i0, p: fl.at(i0) }, { i: end, p: fl.at(end) }]], iEnd: end, labelAt: { i: i0, p: fh.at(i0) } });
    }
  }
  for (const p of out) { for (const q of p.points) q.t = bars.t[q.i]; for (const ln of p.lines || []) for (const q of ln) q.t = bars.t[q.i]; if (p.labelAt) p.labelAt.t = bars.t[p.labelAt.i]; }
  return out;
}

export function openGaps(bars, { lookback = 120, max = 4, end = bars.t.length - 1 } = {}) {
  const start = Math.max(1, end - lookback), A = atrAt(bars, end), out = [];
  for (let i = end; i >= start && out.length < max; i--) {
    const up = bars.l[i] > bars.h[i - 1], dn = bars.h[i] < bars.l[i - 1];
    if (!up && !dn) continue;
    const top = up ? bars.l[i] : bars.l[i - 1], bottom = up ? bars.h[i - 1] : bars.h[i];
    if (top - bottom < 0.3 * A) continue;
    let filled = false;
    for (let k = i + 1; k <= end; k++) { if (up ? bars.l[k] <= bottom : bars.h[k] >= top) { filled = true; break; } }
    if (!filled) out.push({ i, t: bars.t[i], top, bottom, dir: up ? 1 : -1 });
  }
  return out;
}

/**
 * Signals from the automated analysis on the latest bar, for scans and alerts. The trendlines and
 * zones are built from bars up to the one before last, then tested against the last close.
 */
export function autoSignals(bars) {
  const n = bars.t.length, res = { break_res: false, break_sup: false, near_sup: false, near_res: false };
  if (n < 60) return res;
  const end = n - 1, A = atrAt(bars, end - 1);
  for (const ln of autoTrendlines(bars, { end: end - 1, breakWindow: 0 })) {
    const v = ln.valueAt(end), vp = ln.valueAt(end - 1);
    if (ln.kind === 'res' && bars.c[end] > v + 0.25 * A && bars.c[end - 1] <= vp + 0.25 * A) res.break_res = true;
    if (ln.kind === 'sup' && bars.c[end] < v - 0.25 * A && bars.c[end - 1] >= vp - 0.25 * A) res.break_sup = true;
  }
  for (const z of autoLevels(bars, { end: end - 1 })) {
    if (z.kind === 'sup' && bars.l[end] <= z.hi + 0.25 * A && bars.c[end] >= z.lo) res.near_sup = true;
    if (z.kind === 'res' && bars.h[end] >= z.lo - 0.25 * A && bars.c[end] <= z.hi) res.near_res = true;
  }
  return res;
}
export const AUTO_SIGNALS = [
  { id: 'break_res', name: 'Closes above an auto resistance trendline' },
  { id: 'break_sup', name: 'Closes below an auto support trendline' },
  { id: 'near_sup', name: 'Tests an auto support zone' },
  { id: 'near_res', name: 'Tests an auto resistance zone' },
];

// node tests/smoke.mjs — indicators, timeframe aggregation, higher-timeframe alignment, auto analysis.
import * as ta from '../web/js/ta.js';
import * as auto from '../web/js/auto.js';
import { aggregate, alignToBase, adjust, sliceBars } from '../web/js/data.js';
import { dailyBars, intradayBars, cut, check, done } from './fixture.mjs';

const d = dailyBars(), n = d.t.length, part = cut(d, n - 60), i5 = intradayBars();
// 1. every registered indicator: one value per bar, finite at the end, and unchanged when the future is removed
for (const [id, def] of ta.IND) {
  for (const bars of [d, i5]) {
    const short = cut(bars, bars.t.length - 60), full = ta.calcIndicator(id, bars), prt = ta.calcIndicator(id, short), N = bars.t.length;
    let good = !full.__error, why = full.__error || '';
    for (const o of def.outputs) {
      const a = full[o.k], b = prt[o.k];
      if (!a || a.length !== N) { good = false; why = 'length of ' + o.k; break; }
      if (!Number.isFinite(a[N - 1])) { good = false; why = 'last value not finite: ' + o.k; break; }
      for (let i = 0; i < b.length; i++) { const x = a[i], y = b[i]; if ((x === x || y === y) && !(Math.abs(x - y) <= 1e-7 * Math.max(1, Math.abs(x)))) { good = false; why = `lookahead in ${o.k} at ${i}`; break; } }
      if (!good) break;
    }
    check(`indicator ${id} (${bars.tf})`, good, why);
  }
}
// 2. reference values computed the long way
const last20 = d.c.slice(-20), mean = last20.reduce((a, b) => a + b) / 20;
check('sma', Math.abs(ta.sma(d.c, 20)[n - 1] - mean) < 1e-9);
check('stdev', Math.abs(ta.stdev(d.c, 20)[n - 1] - Math.sqrt(last20.reduce((s, x) => s + (x - mean) ** 2, 0) / 20)) < 1e-9);
{ let ag = 0, al = 0; for (let i = 1; i <= 14; i++) { const x = d.c[i] - d.c[i - 1]; if (x > 0) ag += x; else al -= x; } ag /= 14; al /= 14; for (let i = 15; i < n; i++) { const x = d.c[i] - d.c[i - 1]; ag = (ag * 13 + (x > 0 ? x : 0)) / 14; al = (al * 13 + (x < 0 ? -x : 0)) / 14; } check('rsi (Wilder)', Math.abs(ta.rsi(d.c, 14)[n - 1] - (100 - 100 / (1 + ag / al))) < 1e-9); }
{ let e = d.c.slice(0, 10).reduce((a, b) => a + b) / 10; for (let i = 10; i < n; i++) e = (2 / 11) * d.c[i] + (9 / 11) * e; check('ema', Math.abs(ta.ema(d.c, 10)[n - 1] - e) < 1e-9); }
{ const hh = Math.max(...d.h.slice(-14)), ll = Math.min(...d.l.slice(-14)); check('willr', Math.abs(ta.willr(d, 14)[n - 1] - (-100 * (hh - d.c[n - 1])) / (hh - ll)) < 1e-9); }
{ const m = ta.macd(d.c, 12, 26, 9); check('macd identity', Math.abs(m.hist[n - 1] - (m.macd[n - 1] - m.signal[n - 1])) < 1e-12 && Math.abs(m.macd[n - 1] - (ta.ema(d.c, 12)[n - 1] - ta.ema(d.c, 26)[n - 1])) < 1e-12); }
{ const b = ta.bollinger(d.c, 20, 2); check('bollinger symmetric', Math.abs(b.upper[n - 1] + b.lower[n - 1] - 2 * b.mid[n - 1]) < 1e-9); }
{ const v = ta.vwap(i5, 'session'), k = i5.t.length - 1; let pv = 0, vv = 0; for (let i = k; i >= 0 && ta.dayKey(i5.t[i]) === ta.dayKey(i5.t[k]); i--) { pv += ((i5.h[i] + i5.l[i] + i5.c[i]) / 3) * i5.v[i]; vv += i5.v[i]; } check('session vwap resets daily', Math.abs(v[k] - pv / vv) < 1e-9); }
{ const t0 = d.t[n - 100], av = ta.anchoredVwap(d, t0); check('anchored vwap starts at anchor', av[n - 101] !== av[n - 101] && Math.abs(av[n - 100] - (d.h[n - 100] + d.l[n - 100] + d.c[n - 100]) / 3) < 1e-9); }
// 3. timeframes
const w = aggregate(d, '1w'), mo = aggregate(d, '1mo'), h1 = intradayBars(30, 7, 'TEST', 3600), h4 = aggregate(h1, '4h');
check('weekly bar count', w.t.length === Math.ceil(n / 5) || Math.abs(w.t.length - n / 5) < 3, String(w.t.length));
check('weekly volume conserved', Math.abs(w.v.reduce((a, b) => a + b) - d.v.reduce((a, b) => a + b)) < 1);
check('weekly high/low/close', w.h[w.t.length - 1] === Math.max(...d.h.slice(n - 5)) && w.c[w.t.length - 1] === d.c[n - 1] && w.o[w.t.length - 1] === d.o[n - 5]);
check('weeks start on Monday', w.t.every((t) => new Date(t * 1000).getUTCDay() === 1));
check('monthly bar count', Math.abs(mo.t.length - n / 21) < 6, String(mo.t.length));
check('4h bars: two per session', h4.t.length === 60 && h4.o[0] === h1.o[0], String(h4.t.length));
// 4. higher-timeframe alignment is causal
const wk = ta.sma(w.c, 10), al = alignToBase(d, w, wk);
{ let good = true; for (let i = n - 400; i < n - 1; i++) { let j = 0; while (j + 1 < w.t.length && w.t[j + 1] <= d.t[i]) j++; const lastOfWeek = d.t[i + 1] >= (w.t[j + 1] ?? Infinity); if (Math.abs(al[i] - (lastOfWeek ? wk[j] : wk[j - 1])) > 1e-12) good = false; } check('weekly value reaches a daily bar only at the week close', good); }
{ const pw = aggregate(part, '1w'), pal = alignToBase(part, pw, ta.sma(pw.c, 10)); let good = true; for (let i = 0; i < part.t.length - 1; i++) if ((al[i] === al[i] || pal[i] === pal[i]) && Math.abs(al[i] - pal[i]) > 1e-12) good = false; check('alignment unchanged when the future is removed', good); }
{ const dd = dailyBars(60, 42), ai = alignToBase(i5, { ...dd, t: i5.t.filter((t, i) => i % 78 === 0).map((t) => ta.dayKey(t) * 86400), c: [] }, i5.t.filter((t, i) => i % 78 === 0).map((_, k) => k)); check('daily value reaches a 5m bar only on the last bar of the day', ai[77] === 0 && ai[76] !== ai[76] && ai[78] === 0 && ai[155] === 1 && ai[154] === 0); }
{ const hm = ta.hma(d.c, 21), half = ta.wma(d.c, 10), fullw = ta.wma(d.c, 21), want = ta.wma(half.map((x, i) => 2 * x - fullw[i]), 4); check('hull MA smooths over floor(sqrt(n))', Math.abs(hm[n - 1] - want[n - 1]) < 1e-12); }
// 5. total-return adjustment
const adj = adjust(d), wa = aggregate(adj, '1w');
check('adjusted close is the adjusted column', adj.c === d.a && adj.adjusted && Math.abs(adj.h[10] / adj.c[10] - d.h[10] / d.c[10]) < 1e-12);
check('adjusted series returns more than price', adj.c[n - 1] / adj.c[0] > d.c[n - 1] / d.c[0] * 1.15, (adj.c[n - 1] / adj.c[0] / (d.c[n - 1] / d.c[0])).toFixed(3));
check('adjusted weekly close = adjusted daily close', wa.c[wa.t.length - 1] === d.a[n - 1] && wa.adjusted === true);
check('adjust is memoised and a no-op without the column', adjust(d) === adj && adjust(i5) === i5);
check('sliceBars keeps columns', sliceBars(d, n - 10).a.length === 10 && sliceBars(adj, 5).adjusted === true);
// 6. automated analysis
const piv = auto.pivots(d, 5);
check('pivots are local extremes', piv.highs.every((p) => d.h[p.i] === Math.max(...d.h.slice(p.i - 5, p.i + 6))) && piv.lows.every((p) => d.l[p.i] === Math.min(...d.l.slice(p.i - 5, p.i + 6))) && piv.highs.length > 100);
const tl = auto.autoTrendlines(d), lv = auto.autoLevels(d), fb = auto.autoFib(d);
check('trendlines found', tl.length > 0, tl.map((x) => `${x.kind}:${x.touches.length}`).join(' '));
check('trendline anchors on its pivots', tl.every((x) => Math.abs(x.valueAt(x.i1) - x.p1) < 1e-9 && Math.abs(x.valueAt(x.i2) - x.p2) < 1e-9 && x.touches.length >= 2));
check('unbroken support stays under closes', tl.filter((x) => x.kind === 'sup' && !x.broken).every((x) => { for (let i = x.i1 + 1; i < n; i++) if (d.c[i] < x.valueAt(i) - ta.atr(d, 14)[n - 1]) return false; return true; }));
check('zones sorted, near price', lv.length > 0 && lv.every((z, i) => z.lo < z.hi && (i === 0 || z.price < lv[i - 1].price)) && lv.every((z) => (z.kind === 'sup') === (z.price < d.c[n - 1])));
check('fibonacci spans the swing', fb && Math.abs(fb.levels[0].p - fb.to.p) < 1e-9 && Math.abs(fb.levels.find((l) => l.r === 1).p - fb.from.p) < 1e-9);
{ const cp = auto.candlePatterns(d), cnt = Object.fromEntries(auto.CANDLES.map((c) => [c.id, cp[c.id].filter(Boolean).length])); check('every candlestick pattern occurs', Object.values(cnt).every((x) => x > 0), JSON.stringify(cnt)); const pc = auto.candlePatterns(part); let good = true; for (const c of auto.CANDLES) for (let i = 0; i < part.t.length; i++) if (cp[c.id][i] !== pc[c.id][i]) good = false; check('candlestick patterns are causal', good); }
{ const names = new Set(); for (let e = 400; e < n; e += 7) for (const p of auto.chartPatterns(d, { end: e })) names.add(p.type); check('chart patterns detected across history', names.size >= 5, [...names].join(' ')); }
{ let fired = 0, good = true; for (let e = 300; e < n; e += 3) { const c = cut(d, e), s = auto.autoSignals(c); if (s.break_res || s.break_sup) fired++; const s2 = auto.autoSignals(c); if (JSON.stringify(s) !== JSON.stringify(s2)) good = false; } check('auto signals fire and are deterministic', fired > 5 && good, `${fired} breaks`); }
check('open gaps are unfilled', auto.openGaps(d).every((g) => { for (let k = g.i + 1; k < n; k++) if (g.dir > 0 ? d.l[k] <= g.bottom : d.h[k] >= g.top) return false; return g.top > g.bottom; }));
done('smoke');

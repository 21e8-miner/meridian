// Run: node tests/smoke.mjs  (needs the server's disk cache or network via server.py)
import { readFileSync, existsSync } from 'node:fs';
import * as ta from '../web/js/ta.js';
import * as auto from '../web/js/auto.js';
import { aggregate, alignToBase } from '../web/js/data.js';
const load = (s, tf) => { const d = JSON.parse(readFileSync(new URL(`../.cache/${tf}/${s}.json`, import.meta.url))); return d; };
const spy = load('SPY', '1d'), n = spy.t.length;
let fails = 0; const check = (name, cond, extra='') => { if (!cond) fails++; console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + ' ' + extra); };
// every registered indicator: right length, last value finite, and causal (truncating the future leaves the past unchanged)
const cut = { ...spy }; for (const k of ['t','o','h','l','c','v']) cut[k] = spy[k].slice(0, n - 50);
for (const [id, def] of ta.IND) {
  const full = ta.calcIndicator(id, spy), part = ta.calcIndicator(id, cut);
  let good = !full.__error, why = full.__error || '';
  for (const o of def.outputs) {
    const a = full[o.k], b = part[o.k];
    if (!a || a.length !== n) { good = false; why = 'len ' + o.k; break; }
    if (!(Number.isFinite(a[n - 1]))) { good = false; why = 'last NaN ' + o.k; break; }
    for (let i = 0; i < b.length; i++) { const x = a[i], y = b[i]; if ((x === x || y === y) && Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x))) { good = false; why = `lookahead ${o.k} @${i}`; break; } }
    if (!good) break;
  }
  check('ind ' + id, good, why);
}
// reference values
const r = ta.rsi(spy.c, 14)[n - 1]; check('rsi range', r > 0 && r < 100, r.toFixed(2));
const s20 = ta.sma(spy.c, 20)[n - 1], manual = spy.c.slice(-20).reduce((a, b) => a + b) / 20; check('sma exact', Math.abs(s20 - manual) < 1e-6);
const w = aggregate({ ...spy, tf: '1d' }, '1w'), mo = aggregate({ ...spy, tf: '1d' }, '1mo');
check('weekly bars', w.t.length > n / 5.3 && w.t.length < n / 4.5, String(w.t.length)); check('monthly bars', Math.abs(mo.t.length - n / 21) < 12, String(mo.t.length));
const wk = ta.sma(w.c, 10), al = alignToBase({ ...spy, tf: '1d' }, w, wk);
// causality of alignment: at a mid-week bar the aligned value must equal the previous completed week's value
let okAlign = true; for (let i = n - 300; i < n - 1; i++) { let j = 0; while (j + 1 < w.t.length && w.t[j + 1] <= spy.t[i]) j++; const lastOfWeek = spy.t[i + 1] >= (w.t[j + 1] ?? Infinity); const exp = lastOfWeek ? wk[j] : wk[j - 1]; if (Math.abs(al[i] - exp) > 1e-9) okAlign = false; }
check('htf align causal', okAlign);
const tl = auto.autoTrendlines(spy), lv = auto.autoLevels(spy), fb = auto.autoFib(spy), cp = auto.chartPatterns(spy), cd = auto.detectCandles(spy, n - 250), gp = auto.openGaps(spy);
check('trendlines', tl.length > 0, tl.map((x) => `${x.kind}:${x.touches.length}t${x.broken ? ' broken' : ''}`).join(' '));
check('levels', lv.length > 0, lv.map((x) => x.price.toFixed(1) + 'x' + x.touches).join(' '));
check('fib', !!fb, fb && `${fb.up ? 'up' : 'down'} ${fb.from.p}→${fb.to.p}`);
console.log('patterns:', cp.map((p) => p.name).join(', ') || '(none)', '| candles in 250 bars:', cd.length, '| gaps:', gp.length, '| signals:', JSON.stringify(auto.autoSignals(spy)));
const cnt = {}; const all = auto.candlePatterns(spy); for (const c of auto.CANDLES) cnt[c.id] = all[c.id].filter(Boolean).length; console.log('candle counts over', n, 'bars:', JSON.stringify(cnt));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);

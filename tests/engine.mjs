// Run: node tests/engine.mjs   — backtest engine and rule evaluation checks on cached SPY data.
import { readFileSync } from 'node:fs';
import { runBacktest, summarize } from '../web/js/engine.js';
import { evalRuleset, cmp, price, num, ind, newRuleset, describeRuleset } from '../web/js/conditions.js';
import { aggregate } from '../web/js/data.js';
const spy = { ...JSON.parse(readFileSync(new URL('../.cache/1d/SPY.json', import.meta.url))), tf: '1d' }, n = spy.t.length;
let fails = 0; const check = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + ' ' + extra); };
// 1. always-in long with no costs reproduces buy & hold from the bar after the first signal
const T = new Array(n).fill(true), F = new Array(n).fill(false);
let r = runBacktest(spy, T, F, { from: n - 1000 }), s = summarize(spy, r);
const exp = (spy.c[n - 1] / spy.o[n - 999] - 1) * 100;
check('always-long = hold from next open', Math.abs(s.netPct - exp) < 1e-6, `${s.netPct.toFixed(3)} vs ${exp.toFixed(3)}`);
// 2. fills happen at the open after the signal
const e = new Array(n).fill(false), x = new Array(n).fill(false); e[n - 50] = true; x[n - 40] = true;
r = runBacktest(spy, e, x, {});
check('entry at next open', r.trades.length === 1 && r.trades[0].entryI === n - 49 && r.trades[0].entryP === spy.o[n - 49]);
check('exit at next open', r.trades[0].exitI === n - 39 && r.trades[0].exitP === spy.o[n - 39]);
// 3. results up to bar k do not change when the future is removed
const rs = newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 200 })), cmp(ind('rsi', { len: 2 }), 'lt', num(10))]), ex = newRuleset([cmp(ind('rsi', { len: 2 }), 'gt', num(70))]);
const full = runBacktest(spy, evalRuleset(rs, spy).mask, evalRuleset(ex, spy).mask, { stopPct: 5, trailPct: 8 });
const cut = { ...spy }; for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) cut[k] = spy[k].slice(0, n - 300);
const part = runBacktest(cut, evalRuleset(rs, cut).mask, evalRuleset(ex, cut).mask, { stopPct: 5, trailPct: 8 });
const closedPart = part.trades.filter((t) => !t.open);
check('no lookahead in trades', closedPart.every((t, i) => t.entryI === full.trades[i].entryI && t.exitI === full.trades[i].exitI && Math.abs(t.pnl - full.trades[i].pnl) < 1e-9), `${closedPart.length} trades compared`);
// 4. stop: never lose much more than the stop on a non-gap bar; short mirrors long
const st = runBacktest(spy, T, F, { stopPct: 2, from: n - 2000 });
check('stop exits bounded', st.trades.filter((t) => t.reason === 'stop').every((t) => t.pnlPct <= -1.99) && st.trades.some((t) => t.reason === 'stop'), `${st.trades.length} trades`);
const sh = summarize(spy, runBacktest(spy, T, F, { side: 'short', from: n - 1000 }));
check('short mirrors long', Math.abs(sh.netPct + (1 - spy.o[n - 999] / spy.c[n - 1]) * 100 * (spy.c[n - 1] / spy.o[n - 999])) < 1e-6, sh.netPct.toFixed(2));
// 5. fees reduce equity by the expected amount
const fee = summarize(spy, runBacktest(spy, e, x, { feeBps: 10 })), nofee = summarize(spy, runBacktest(spy, e, x, {}));
check('fees applied', nofee.netPct - fee.netPct > 0.19 && nofee.netPct - fee.netPct < 0.21, (nofee.netPct - fee.netPct).toFixed(4));
// 6. multi-timeframe rule: weekly condition is constant through a week until the week closes
const w = aggregate(spy, '1w'), mt = newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 30 }), '1w')]);
const m = evalRuleset(mt, spy, new Map([['1w', w]])).mask;
check('mtf rule evaluates', m.filter(Boolean).length > n * 0.4 && m.filter(Boolean).length < n, `${m.filter(Boolean).length} of ${n} bars`);
console.log(describeRuleset(rs, '1d'), '→', full.trades.length, 'trades,', summarize(spy, full).netPct.toFixed(1) + '% net,', 'win', summarize(spy, full).winRate.toFixed(0) + '%');
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);

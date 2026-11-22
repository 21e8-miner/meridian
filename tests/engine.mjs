// node tests/engine.mjs — backtest engine, rule evaluation, simulation glue, yearly table, sweep.
import { runBacktest, summarize } from '../web/js/engine.js';
import { evalRuleset, evalCond, cmp, price, num, ind, newRuleset } from '../web/js/conditions.js';
import { aggregate, adjust } from '../web/js/data.js';
import { simulate } from '../web/js/sim.js';
import { yearly, knobs, sweep, getPath, setPath, splitAudit, monteCarlo, costSensitivity } from '../web/js/research.js';
import { IND, defaultParams, sma, calcIndicator, cleanParams } from '../web/js/ta.js';
import { parseWorkspace, toCsv } from '../web/js/util.js';
import { dailyBars, cut, check, done } from './fixture.mjs';

const d = dailyBars(), n = d.t.length, T = new Array(n).fill(true), F = new Array(n).fill(false);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ── fills and accounting ──
{ const s = summarize(d, runBacktest(d, T, F, { from: n - 1000 })); check('always-long equals holding from the next open', near(s.netPct, (d.c[n - 1] / d.o[n - 999] - 1) * 100)); check('buy & hold reference', near(s.buyHold, (d.c[n - 1] / d.c[n - 1000] - 1) * 100)); }
{ const s = summarize(d, runBacktest(d, T, F, { side: 'short', from: n - 1000 })); check('short earns the mirror of the move', near(s.netPct, (1 - d.c[n - 1] / d.o[n - 999]) * 100)); }
const e = F.slice(), x = F.slice(); e[n - 50] = true; x[n - 40] = true;
{ const r = runBacktest(d, e, x, {}), t = r.trades[0]; check('entry and exit at the open after the signal', r.trades.length === 1 && t.entryI === n - 49 && t.entryP === d.o[n - 49] && t.exitI === n - 39 && t.exitP === d.o[n - 39] && t.reason === 'signal'); check('trade P&L matches equity', near(r.equity[n - 1] - 10000, t.pnl)); check('equity flat before entry and after exit', r.equity[n - 51] === 10000 && r.equity[n - 39] === r.equity[n - 1]); }
{ const a = summarize(d, runBacktest(d, e, x, { feeBps: 10 })), b = summarize(d, runBacktest(d, e, x, {})); const t = runBacktest(d, e, x, {}).trades[0]; check('fees: 10 bps on the entry notional and on the exit notional', near(b.netPct - a.netPct, 0.1 * (1 + t.exitP / t.entryP), 1e-9), (b.netPct - a.netPct).toFixed(4)); }
{ const r = runBacktest(d, e, x, { slipBps: 5 }), t = r.trades[0]; check('slippage worsens both fills', near(t.entryP, d.o[n - 49] * 1.0005) && near(t.exitP, d.o[n - 39] * 0.9995)); }
{ const r = runBacktest(d, e, x, { sizePct: 50 }), full = runBacktest(d, e, x, {}); check('half size, half the P&L', near(r.trades[0].pnl * 2, full.trades[0].pnl)); }
{ const r = runBacktest(d, e, F, {}); check('open trade is marked, not booked', r.trades.length === 1 && r.trades[0].open && r.position && near(r.equity[n - 1], 10000 + r.trades[0].pnl)); }
{ const last = F.slice(); last[n - 1] = true; check('a signal on the final bar cannot fill', runBacktest(d, last, F, {}).trades.length === 0); }
// ── stops, targets, trailing, time exits ──
{ const r = runBacktest(d, T, F, { stopPct: 2, from: n - 2000 }), st = r.trades.filter((t) => t.reason === 'stop'); check('stop: loss is the stop, or worse only on a gap', st.length > 20 && st.every((t) => t.pnlPct <= -2 + 1e-9 && (near(t.exitP, t.entryP * 0.98) || t.exitP === d.o[t.exitI]))); check('stop fills never above the stop', st.every((t) => t.exitP <= t.entryP * 0.98 + 1e-9)); }
{ const r = runBacktest(d, T, F, { targetPct: 3, stopPct: 3, from: n - 2000 }), tg = r.trades.filter((t) => t.reason === 'target'); check('target: gain is the target, or better on a gap', tg.length > 20 && tg.every((t) => t.pnlPct >= 3 - 1e-9 && t.exitP >= t.entryP * 1.03 - 1e-9)); }
{ const r = runBacktest(d, T, F, { stopPct: 1, targetPct: 1, from: n - 2000 }); let both = 0, good = true; for (const t of r.trades) { if (t.open) continue; const i = t.exitI, hitS = d.l[i] <= t.entryP * 0.99, hitT = d.h[i] >= t.entryP * 1.01; const gapT = i !== t.entryI && d.o[i] >= t.entryP * 1.01, gapS = i !== t.entryI && d.o[i] <= t.entryP * 0.99; if (hitS && hitT && !gapT && !gapS) { both++; if (t.reason !== 'stop') good = false; } if (gapT && (t.reason !== 'target' || t.exitP !== d.o[i])) good = false; if (gapS && (t.reason !== 'stop' || t.exitP !== d.o[i])) good = false; } check('stop wins inside one bar; a gap at the open fills at the open', good && both > 0, `${both} such bars`); }
{ const r = runBacktest(d, T, F, { trailPct: 4, from: n - 2000 }), tr = r.trades.filter((t) => t.reason === 'trail'); let good = tr.length > 20; for (const t of tr) { let best = t.entryP; for (let i = t.entryI; i < t.exitI; i++) best = Math.max(best, d.h[i]); const lvl = best * 0.96; if (!(near(t.exitP, lvl) || (t.exitP === d.o[t.exitI] && t.exitP < lvl))) good = false; } check('trailing stop follows the best price up to the prior bar', good, `${tr.length} trail exits`); }
{ const r = runBacktest(d, T, F, { maxBars: 5, from: n - 500 }); check('time exit after N bars at the close', r.trades.filter((t) => !t.open).every((t) => t.bars === 5 && t.exitP === d.c[t.exitI] && t.reason === 'time')); }
{ const r = runBacktest(d, T, F, { side: 'short', stopPct: 2, targetPct: 2, from: n - 2000 }), st = r.trades.filter((t) => t.reason === 'stop'), tg = r.trades.filter((t) => t.reason === 'target'); check('short: stop above entry, target below', st.length > 20 && tg.length > 20 && st.every((t) => t.exitP >= t.entryP * 1.02 - 1e-9 && t.pnlPct <= -2 + 1e-9) && tg.every((t) => t.exitP <= t.entryP * 0.98 + 1e-9 && t.pnlPct >= 2 - 1e-9), `${st.length} stops, ${tg.length} targets`); }
// ── review findings (regressions) ──
{ const b = { t: [0, 1, 2, 3].map((k) => k * 86400), o: [100, 100, 106, 100], h: [101, 101, 107, 100], l: [99, 99, 94, 100], c: [100, 100, 95, 100], v: [1, 1, 1, 1] }, r = runBacktest(b, [true, false, false, false], [false, false, false, false], { stopPct: 5, targetPct: 5 }); check('a bar that opens above the target fills the target at the open, even if it later trades to the stop', r.trades[0].reason === 'target' && r.trades[0].exitP === 106); }
{ const b = { t: [0, 1, 2, 3, 4, 5].map((k) => k * 86400), o: [100, 100, 350, 300, 300, 150], h: [100, 100, 350, 300, 300, 150], l: [100, 100, 350, 300, 300, 150], c: [100, 350, 350, 300, 300, 150], v: [1, 1, 1, 1, 1, 1] }, r = runBacktest(b, [true, false, true, true, false, false], [false, true, false, false, false, false], { side: 'short' }); check('no new position once equity is gone', r.trades.length === 1 && r.equity[5] < 0 && r.equity[5] === r.equity[2], `${r.trades.length} trade, equity ${r.equity[5]}`); }
{ const w = aggregate(d, '1w'), rs = newRuleset([cmp(price('close'), 'xup', ind('sma', { len: 10 }), '1w')]), m = evalRuleset(rs, d, new Map([['1w', w]])).mask, wk = evalCond(cmp(price('close'), 'xup', ind('sma', { len: 10 })), w); let runs = 0, longRun = false; for (let i = 0; i < n - 1; i++) { if (m[i]) { runs++; if (m[i + 1]) longRun = true; } } check('a weekly cross counts once on daily bars, at the week close', !longRun && Math.abs(runs - wk.filter(Boolean).length) <= 1 && runs > 20, `${runs} daily bars for ${wk.filter(Boolean).length} weekly crosses`); const st = evalRuleset(newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 10 }), '1w')]), d, new Map([['1w', w]])).mask; check('a weekly state still holds all week', st.filter(Boolean).length > runs * 4); }
// ── no lookahead through rules + engine ──
const entry = newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 200 })), cmp(ind('rsi', { len: 2 }), 'lt', num(10))]), exit = newRuleset([cmp(ind('rsi', { len: 2 }), 'gt', num(70))]);
{ const full = runBacktest(d, evalRuleset(entry, d).mask, evalRuleset(exit, d).mask, { stopPct: 5, trailPct: 8 }), c = cut(d, n - 300), part = runBacktest(c, evalRuleset(entry, c).mask, evalRuleset(exit, c).mask, { stopPct: 5, trailPct: 8 }).trades.filter((t) => !t.open); check('trades are unchanged when the future is removed', part.length > 20 && part.every((t, i) => t.entryI === full.trades[i].entryI && t.exitI === full.trades[i].exitI && near(t.pnl, full.trades[i].pnl, 1e-12)), `${part.length} trades`); }
// ── rule evaluation ──
{ const a = evalCond(cmp(price('close'), 'xup', ind('sma', { len: 20 })), d), s = sma(d.c, 20); let good = true, cnt = 0; for (let i = 21; i < n; i++) { const want = d.c[i] > s[i] && d.c[i - 1] <= s[i - 1]; if (a[i] !== want) good = false; if (want) cnt++; } check('crosses above', good && cnt > 20, `${cnt} crosses`); }
{ const a = evalCond(cmp(price('close'), 'gt', { ...price('high'), offset: 1 }), d); let good = true; for (let i = 1; i < n; i++) if (a[i] !== d.c[i] > d.h[i - 1]) good = false; check('bars-ago offset', good && a[0] === false); }
{ const a = evalCond(cmp(price('volume'), 'gt', { ...ind('volume', { len: 20 }, 'avg'), mult: 1.5 }), d), av = sma(d.v, 20); let good = true; for (let i = 20; i < n; i++) if (a[i] !== d.v[i] > 1.5 * av[i]) good = false; check('multiplier', good); }
{ const A = cmp(ind('rsi', { len: 14 }), 'lt', num(30)), B = cmp(price('close'), 'gt', ind('sma', { len: 50 })), all = evalRuleset(newRuleset([A, B], 'all'), d), any = evalRuleset(newRuleset([A, B], 'any'), d); let good = true; for (let i = 0; i < n; i++) { if (all.mask[i] !== (all.per[0][i] && all.per[1][i])) good = false; if (any.mask[i] !== (any.per[0][i] || any.per[1][i])) good = false; } check('ALL and ANY combine conditions', good && any.mask.filter(Boolean).length > all.mask.filter(Boolean).length); }
check('an empty rule set never fires', evalRuleset(newRuleset([]), d).mask.every((v) => !v));
check('a rule on a timeframe that is not loaded reads false', evalRuleset(newRuleset([cmp(price('close'), 'gt', num(0), '1w')]), d, new Map()).mask.every((v) => !v));
{ const w = aggregate(d, '1w'), m = evalRuleset(newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 30 }), '1w')]), d, new Map([['1w', w]])).mask, ws = sma(w.c, 30); let good = true; for (let i = n - 500; i < n - 1; i++) { let j = 0; while (j + 1 < w.t.length && w.t[j + 1] <= d.t[i]) j++; const k = d.t[i + 1] >= (w.t[j + 1] ?? Infinity) ? j : j - 1; if (m[i] !== w.c[k] > ws[k]) good = false; } check('weekly rule on daily bars uses the last closed week', good); }
{ const k = cmp(price('close'), 'gt', num(0), '5m'), m = evalRuleset(newRuleset([k]), d).mask; check('a lower timeframe than the chart falls back to the chart', m.every(Boolean)); }
// ── simulate: window, dividends ──
const c = { tf: '1d', years: '5', side: 'long', entry, exit, stopPct: 0, targetPct: 0, trailPct: 0, maxBars: 10, capital: 10000, sizePct: 100, feeBps: 0, slipBps: 0 };
{ const { res } = simulate(d, new Map(), c); check('history window starts where asked', Math.abs((d.t[n - 1] - d.t[res.from]) / 31557600 - 5) < 0.02 && res.trades.every((t) => t.entryI > res.from)); }
{ const a = adjust(d), plain = simulate(d, new Map(), { ...c, entry: newRuleset([cmp(price('close'), 'gt', num(0))]), exit: newRuleset([]), maxBars: 0 }), tot = simulate(a, new Map(), { ...c, entry: newRuleset([cmp(price('close'), 'gt', num(0))]), exit: newRuleset([]), maxBars: 0 }); check('dividends raise a held position’s return', tot.stats.netPct > plain.stats.netPct * 1.05 && tot.stats.buyHold > plain.stats.buyHold, `${plain.stats.netPct.toFixed(1)}% → ${tot.stats.netPct.toFixed(1)}%`); }
// ── yearly table ──
{ const { res, stats } = simulate(d, new Map(), c), y = yearly(d, res); const comp = y.reduce((p, r) => p * (1 + r.ret / 100), 1), bh = y.reduce((p, r) => p * (1 + r.bh / 100), 1); check('yearly returns compound to the total', near((comp - 1) * 100, stats.netPct) && near((bh - 1) * 100, stats.buyHold)); check('yearly trades add up', y.reduce((s, r) => s + r.trades, 0) === res.trades.length && y.length >= 5 && y.length <= 6); }
// ── sweep ──
{ const ks = knobs(c, IND, defaultParams), k = ks.find((q) => q.label.includes('Enter #2 · compared value')); check('sweepable settings found', ks.length === 4 + 5 && !!k && getPath(c, k.path) === 10, ks.map((q) => q.label).join(' | '));
  const sw = sweep(d, new Map(), c, k, [5, 10, 15, 20]); let good = true; for (const r of sw.rows) { const cc = JSON.parse(JSON.stringify(c)); setPath(cc, k.path, r.v); const { res, stats } = simulate(d, new Map(), cc); if (!near((1 + r.is.net / 100) * (1 + r.oos.net / 100), 1 + stats.netPct / 100) || r.is.trades + r.oos.trades !== res.trades.length) good = false; }
  check('in-sample × out-of-sample = the whole run', good); check('sweep leaves the strategy untouched', getPath(c, k.path) === 10); check('split is 70 / 30', Math.abs((sw.split - sw.from) / (n - sw.from) - 0.7) < 0.001 && near((1 + sw.bhIs / 100) * (1 + sw.bhOos / 100), d.c[n - 1] / d.c[sw.from])); }
// ── stats ──
{ const r = runBacktest(d, T, F, { from: n - 1000 }), s = summarize(d, r); let peak = -Infinity, dd = 0; for (let i = n - 1000; i < n; i++) { peak = Math.max(peak, r.equity[i]); dd = Math.min(dd, (r.equity[i] / peak - 1) * 100); } check('max drawdown', near(s.maxDD, dd) && s.maxDD < 0); check('exposure and CAGR', s.exposure > 99 && near(Math.pow(1 + s.cagr / 100, s.years), 1 + s.netPct / 100)); }
{ const r = runBacktest(d, evalRuleset(entry, d).mask, evalRuleset(exit, d).mask, {}), s = summarize(d, r), w = r.trades.filter((t) => t.pnl > 0); check('win rate and profit factor', near(s.winRate, (w.length / r.trades.length) * 100) && near(s.profitFactor, w.reduce((a, t) => a + t.pnl, 0) / -r.trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0))); }
{ const s = summarize(d, runBacktest(d, F, F, {})); check('no trades: zero return, no NaN in headline numbers', s.netPct === 0 && s.maxDD === 0 && s.trades === 0 && s.exposure === 0); }
// ── settings cannot reach into the future ──
{ const c2 = cut(d, n - 40); let good = true; for (const [id, bad] of [['roc', { len: -5 }], ['mom', { len: -5 }], ['chg', { len: -3 }], ['ichimoku', { shift: -26 }], ['sma', { len: 0 }], ['rsi', { len: 2.6 }], ['donchian', { len: 1e9 }]]) { const a = calcIndicator(id, d, bad), b = calcIndicator(id, c2, bad); for (const k of Object.keys(b)) for (let i = 0; i < c2.t.length; i++) { const x = a[k][i], y = b[k][i]; if ((x === x || y === y) && Math.abs(x - y) > 1e-9) good = false; } } check('out-of-range settings are clamped, not run', good && cleanParams(IND.get('roc'), { len: -5 }).len === 1 && cleanParams(IND.get('rsi'), { len: 2.6 }).len === 3 && cleanParams(IND.get('bb'), { mult: 2.5 }).mult === 2.5 && cleanParams(IND.get('vwap'), { anchor: 'nope' }).anchor === 'session'); }
// ── helpers ──
check('csv quoting', toCsv([['a', 'b,c', 'say "hi"'], [1, null, 2.5]]) === 'a,"b,c","say ""hi"""\n1,,2.5\n');
{ const ok = JSON.stringify({ app: 'meridian', data: { 'meridian.theme': '"dark"', 'other.key': '1', 'meridian.x': '[1,2]' } }); check('workspace file: keeps only its own keys', parseWorkspace(ok).length === 2); let m = ''; try { parseWorkspace('{"app":"x","data":{}}'); } catch (err) { m = err.message; } check('workspace file: rejects strangers', /not a Meridian/.test(m)); m = ''; try { parseWorkspace(JSON.stringify({ app: 'meridian', data: { 'meridian.a': '{bad' } })); } catch (err) { m = err.message; } check('workspace file: rejects damaged items', /damaged/.test(m)); }
// ── stress test: IS/OOS split audit, Monte Carlo resampling, execution cost sensitivity ──
{
  const { res, stats } = simulate(d, new Map(), c);
  const sp = splitAudit(d, res);
  check('splitAudit: IS × OOS compounds to full run (strategy and buy & hold)',
    near((1 + sp.is.netPct / 100) * (1 + sp.oos.netPct / 100), 1 + stats.netPct / 100) &&
    near((1 + sp.is.buyHold / 100) * (1 + sp.oos.buyHold / 100), 1 + stats.buyHold / 100));
  check('splitAudit: trade counts sum and windows abut cleanly',
    sp.is.trades + sp.oos.trades === res.trades.length && sp.is.to + 1 === sp.oos.from &&
    Math.abs((sp.split - sp.from) / (n - sp.from) - 0.7) < 0.002);
  check('splitAudit: efficiency matches OOS CAGR / IS CAGR',
    sp.is.cagr > 0 ? near(sp.efficiency, sp.oos.cagr / sp.is.cagr) : Number.isNaN(sp.efficiency));
  const emptySp = splitAudit(d, runBacktest(d, F, F, {}));
  check('splitAudit: zero-trade run produces clean zeros and NaN efficiency',
    emptySp.is.netPct === 0 && emptySp.oos.netPct === 0 && emptySp.is.trades === 0 && emptySp.oos.trades === 0 && Number.isNaN(emptySp.efficiency));
}
{
  const { res, stats } = simulate(d, new Map(), { ...c, sizePct: 50 });
  const mc1 = monteCarlo(d, res, { trials: 400, seed: 123, sizePct: 50 });
  const mc2 = monteCarlo(d, res, { trials: 400, seed: 123, sizePct: 50 });
  const mc3 = monteCarlo(d, res, { trials: 400, seed: 999, sizePct: 50 });
  check('monteCarlo: deterministic for the same seed', JSON.stringify(mc1) === JSON.stringify(mc2));
  check('monteCarlo: different seed changes draws', mc1.net.p50 !== mc3.net.p50 || mc1.sharpe.p50 !== mc3.sharpe.p50);
  check('monteCarlo: quantile ordering and bounds hold',
    mc1.net.p5 <= mc1.net.p25 && mc1.net.p25 <= mc1.net.p50 && mc1.net.p50 <= mc1.net.p75 && mc1.net.p75 <= mc1.net.p95 &&
    mc1.maxDD.p5 <= mc1.maxDD.p50 && mc1.maxDD.p50 <= mc1.maxDD.p95 && mc1.maxDD.p95 <= 0 &&
    mc1.probLoss >= 0 && mc1.probLoss <= 100);
  const fanOrdered = mc1.fan.steps.every((_, j) => mc1.fan.p5[j] <= mc1.fan.p50[j] + 1e-9 && mc1.fan.p50[j] <= mc1.fan.p95[j] + 1e-9);
  const lastActual = mc1.fan.actual[mc1.fan.actual.length - 1];
  check('monteCarlo: equity fan is ordered and actual terminal equity matches backtest',
    fanOrdered && near(lastActual, res.equity[n - 1], 1e-4), `actual ${lastActual.toFixed(2)} vs ${res.equity[n - 1].toFixed(2)}`);
  check('monteCarlo: block-bootstrap Sharpe matches observed and has ordered 95% CI',
    near(mc1.sharpe.observed, stats.sharpe, 1e-9) &&
    mc1.sharpe.ci95Lo <= mc1.sharpe.p5 && mc1.sharpe.p5 <= mc1.sharpe.p50 && mc1.sharpe.p50 <= mc1.sharpe.p95 && mc1.sharpe.p95 <= mc1.sharpe.ci95Hi &&
    mc1.sharpe.probPositive >= 0 && mc1.sharpe.probPositive <= 100);
  const emptyMc = monteCarlo(d, runBacktest(d, F, F, {}), { trials: 100, seed: 7 });
  check('monteCarlo: zero trades handled without NaN in return/DD',
    emptyMc.trades === 0 && emptyMc.net.p50 === 0 && emptyMc.maxDD.p5 === 0 && emptyMc.probLoss === 0 && Number.isNaN(emptyMc.sharpe.observed));
  // Synthetic constant-return trades verify exact compounding, zero DD, and 0% / 100% loss probability.
  const synthRes = { capital: 10000, from: 0, equity: d.c.map(() => 10000), trades: Array.from({ length: 20 }, () => ({ pnlPct: 2 })) };
  const winMc = monteCarlo(d, synthRes, { trials: 200, seed: 1 });
  const loseMc = monteCarlo(d, { ...synthRes, trades: Array.from({ length: 20 }, () => ({ pnlPct: -2 })) }, { trials: 200, seed: 1 });
  check('monteCarlo: constant +2% / -2% trades give exact 0% / 100% loss probability and zero DD on winners',
    winMc.probLoss === 0 && winMc.maxDD.p5 === 0 && near(winMc.net.p5, winMc.net.p95) &&
    near(winMc.net.p50, (Math.pow(1.02, 20) - 1) * 100) && loseMc.probLoss === 100 && loseMc.net.p95 < 0);
}
{
  const cCost = { ...c, feeBps: 3, slipBps: 2 };
  const cs = costSensitivity(d, new Map(), cCost, { levels: [0, 5, 10, 15, 25, 40, 60], maxBreakevenBps: 200 });
  const mono = cs.rows.every((r, i) => i === 0 || r.netPct <= cs.rows[i - 1].netPct + 1e-9);
  const s0 = simulate(d, new Map(), { ...cCost, feeBps: 0, slipBps: 0 }).stats;
  const s10 = simulate(d, new Map(), { ...cCost, feeBps: 5, slipBps: 0 }).stats;
  check('costSensitivity: net return decreases monotonically with friction and matches simulate()',
    mono && near(cs.rows[0].netPct, s0.netPct) && near(cs.rows[2].netPct, s10.netPct) && cs.currentRtBps === 10 && cCost.feeBps === 3);
  if (cs.breakevenBps > 0 && Number.isFinite(cs.breakevenBps)) {
    const atBe = simulate(d, new Map(), { ...cCost, feeBps: cs.breakevenBps / 2, slipBps: 0 }).stats.netPct;
    const belowBe = simulate(d, new Map(), { ...cCost, feeBps: Math.max(0, (cs.breakevenBps - 0.5) / 2), slipBps: 0 }).stats.netPct;
    const aboveBe = simulate(d, new Map(), { ...cCost, feeBps: (cs.breakevenBps + 0.5) / 2, slipBps: 0 }).stats.netPct;
    check('costSensitivity: bisected breakeven friction crosses 0% accurately',
      Math.abs(atBe) < 0.1 && belowBe > 0 && aboveBe <= 0, `breakeven ${cs.breakevenBps} bps -> ${atBe.toFixed(3)}%`);
  } else {
    check('costSensitivity: breakeven friction is valid (0 or Infinity)', cs.breakevenBps === 0 || cs.breakevenBps === Infinity);
  }
  const losing = costSensitivity(d, new Map(), { ...cCost, side: 'short', entry: newRuleset([cmp(price('close'), 'gt', num(0))]), exit: newRuleset([]), maxBars: 0 });
  check('costSensitivity: unprofitable strategy at 0 bps has 0 breakeven friction', losing.rows[0].netPct < 0 && losing.breakevenBps === 0);
}
done('engine');

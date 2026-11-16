// Glue between rules and the backtest engine: load the timeframes a strategy needs, then simulate.
import { getBars } from './data.js';
import { evalRuleset, requiredTfs } from './conditions.js';
import { runBacktest, summarize } from './engine.js';

// c.adjusted !== false: test on total-return prices (dividends reinvested) where the data has them.
export async function prepare(symbol, c) {
  const opt = { adjusted: c.adjusted !== false, live: false }; // exchange bars only: no estimates in a backtest
  const base = await getBars(symbol, c.tf, opt), byTf = new Map([[c.tf, base]]);
  for (const tf of new Set([...requiredTfs(c.entry, c.tf), ...requiredTfs(c.exit, c.tf)])) if (!byTf.has(tf)) byTf.set(tf, await getBars(symbol, tf, opt));
  return { base, byTf };
}
export function simulate(base, byTf, c, extra = {}) {
  const n = base.t.length;
  let from = 0;
  if (Number(c.years) > 0) { const cut = base.t[n - 1] - Number(c.years) * 31557600; while (from < n - 1 && base.t[from] < cut) from++; }
  const entry = evalRuleset(c.entry, base, byTf).mask, exit = evalRuleset(c.exit, base, byTf).mask;
  if (extra.maskBefore != null) for (let i = 0; i < n; i++) if (base.t[i] <= extra.maskBefore) entry[i] = false;
  const res = runBacktest(base, entry, exit, { side: c.side, stopPct: +c.stopPct || 0, targetPct: +c.targetPct || 0, trailPct: +c.trailPct || 0, maxBars: +c.maxBars || 0, feeBps: +c.feeBps || 0, slipBps: +c.slipBps || 0, capital: +c.capital || 10000, sizePct: +c.sizePct || 100, from: extra.from != null ? extra.from : from });
  return { res, stats: summarize(base, res), entry, exit };
}

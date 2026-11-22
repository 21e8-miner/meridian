// Pure research helpers for the Strategy Tester: per-year breakdown, parameter sweeps,
// in-sample / out-of-sample audits, deterministic Monte Carlo resampling, and cost sensitivity.
// No DOM here, so tests can import it.
import { evalRuleset } from './conditions.js';
import { runBacktest, summarize } from './engine.js';
import { simulate } from './sim.js';

// Strategy and buy & hold return for each calendar year in the test window.
export function yearly(base, res) {
  const rows = [], n = base.t.length;
  let cur = null;
  for (let i = res.from; i < n; i++) {
    const y = new Date(base.t[i] * 1000).getUTCFullYear();
    if (!cur || cur.year !== y) { cur = { year: y, eq0: i === res.from ? res.capital : res.equity[i - 1], c0: i === res.from ? base.c[i] : base.c[i - 1], trades: 0 }; rows.push(cur); }
    cur.eq1 = res.equity[i]; cur.c1 = base.c[i];
  }
  for (const t of res.trades) { const r = rows.find((x) => x.year === new Date(t.entryT * 1000).getUTCFullYear()); if (r) r.trades++; }
  for (const r of rows) { r.ret = (r.eq1 / r.eq0 - 1) * 100; r.bh = (r.c1 / r.c0 - 1) * 100; }
  return rows;
}

// Every number in a strategy that can be varied: risk settings, compared values, indicator settings.
export function knobs(c, IND, defaultParams) {
  const out = [];
  for (const [k, label] of [['stopPct', 'Stop loss %'], ['targetPct', 'Take profit %'], ['trailPct', 'Trailing stop %'], ['maxBars', 'Max bars held']]) out.push({ label, path: [k], step: k === 'maxBars' ? 1 : 0.5 });
  for (const [which, name] of [['entry', 'Enter'], ['exit', 'Exit']]) {
    c[which].conds.forEach((cd, i) => {
      if (cd.kind !== 'cmp') return;
      for (const side of ['a', 'b']) {
        const o = cd[side];
        if (o.type === 'num') out.push({ label: `${name} #${i + 1} · compared value`, path: [which, 'conds', i, side, 'value'], step: Number.isInteger(Number(o.value)) ? 1 : 0.1 });
        else if (o.type === 'ind') {
          const def = IND.get(o.id); if (!def) continue;
          for (const p of def.params) if (!p.hidden && !p.type) out.push({ label: `${name} #${i + 1} · ${def.short || def.name} ${p.label.toLowerCase()}`, path: [which, 'conds', i, side, 'params', p.k], step: p.step || 1, fallback: defaultParams(def)[p.k] });
        }
      }
    });
  }
  return out;
}
export const getPath = (o, path) => path.reduce((x, k) => (x == null ? x : x[k]), o);
export function setPath(o, path, v) { let x = o; for (let i = 0; i < path.length - 1; i++) { if (x[path[i]] == null) x[path[i]] = {}; x = x[path[i]]; } x[path[path.length - 1]] = v; }

/**
 * Run the strategy once per value of one setting. The first 70% of the test window is in-sample,
 * the rest out-of-sample; each run is one continuous simulation, split at that bar, so the two
 * returns compound to the run's total. A trade is counted in the part where it was entered.
 */
export function sweep(base, byTf, c, knob, values) {
  const rows = [], n = base.t.length;
  let split = 0, from = 0;
  for (const v of values) {
    const cc = JSON.parse(JSON.stringify(c)); setPath(cc, knob.path, v);
    const { res } = simulate(base, byTf, cc);
    from = res.from; split = from + Math.max(1, Math.floor((n - from) * 0.7));
    const eqS = res.equity[split - 1], part = (ts) => ({ trades: ts.length, win: ts.length ? (ts.filter((t) => t.pnl > 0).length / ts.length) * 100 : NaN });
    rows.push({ v, is: { net: (eqS / res.capital - 1) * 100, ...part(res.trades.filter((t) => t.entryI < split)) }, oos: { net: (res.equity[n - 1] / eqS - 1) * 100, ...part(res.trades.filter((t) => t.entryI >= split)) } });
  }
  const xs = rows.map((r) => r.is.net), ys = rows.map((r) => r.oos.net), mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return { rows, split, from, agreement: sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN, bhIs: (base.c[split - 1] / base.c[from] - 1) * 100, bhOos: (base.c[n - 1] / base.c[split - 1] - 1) * 100 };
}

// Deterministic Mulberry32 PRNG for reproducible resampling across runs and tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Chronological in-sample vs out-of-sample audit on an already-run backtest.
 * Splits [res.from, n - 1] at `ratio` (default 70 / 30) so IS and OOS returns compound
 * identically to the full run. Trades are assigned to the half where they were entered.
 */
export function splitAudit(base, res, ratio = 0.7) {
  const n = base.t.length, from = res.from;
  const split = from + Math.max(1, Math.min(n - from - 1, Math.floor((n - from) * ratio)));
  const sliceStats = (lo, hi, eqStart, cStart, trades) => {
    const barsN = hi - lo + 1;
    const t0 = lo === from ? base.t[lo] : base.t[lo - 1];
    const years = Math.max(1e-9, (base.t[hi] - t0) / 31557600);
    const eqEnd = res.equity[hi];
    let peak = eqStart, maxDD = 0, sum = 0, sum2 = 0, cnt = 0;
    for (let i = lo; i <= hi; i++) {
      const e = res.equity[i];
      if (e > peak) peak = e;
      const dd = peak > 0 ? (e / peak - 1) * 100 : -100;
      if (dd < maxDD) maxDD = dd;
      const prev = i === lo ? eqStart : res.equity[i - 1];
      if (prev > 0) { const r = e / prev - 1; sum += r; sum2 += r * r; cnt++; }
    }
    const mean = cnt ? sum / cnt : 0, sd = cnt > 1 ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
    const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
    const netPct = eqStart > 0 ? (eqEnd / eqStart - 1) * 100 : 0;
    const cagr = eqStart > 0 ? (Math.pow(Math.max(1e-9, eqEnd / eqStart), 1 / years) - 1) * 100 : -100;
    const buyHold = cStart > 0 ? (base.c[hi] / cStart - 1) * 100 : 0;
    const buyHoldCagr = (Math.pow(Math.max(1e-9, 1 + buyHold / 100), 1 / years) - 1) * 100;
    return {
      from: lo, to: hi, bars: barsN, years, netPct, cagr, maxDD,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsN / years) : NaN,
      buyHold, buyHoldCagr, trades: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : NaN,
      profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
      avgTrade: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : NaN,
    };
  };
  const is = sliceStats(from, split - 1, res.capital, base.c[from], res.trades.filter((t) => t.entryI < split));
  const oos = sliceStats(split, n - 1, res.equity[split - 1], base.c[split - 1], res.trades.filter((t) => t.entryI >= split));
  const efficiency = is.cagr > 0 && Number.isFinite(oos.cagr) ? oos.cagr / is.cagr : NaN;
  const sharpeRetention = is.sharpe > 0 && Number.isFinite(oos.sharpe) ? oos.sharpe / is.sharpe : NaN;
  return { from, split, ratio, is, oos, efficiency, sharpeRetention };
}

/**
 * Deterministic seeded Monte Carlo resampling for a backtest:
 *  - Trade-return bootstrap (with replacement) for terminal return percentiles, max drawdown
 *    distribution, probability of loss, and equity fan curves (5th / 50th / 95th).
 *  - Circular block bootstrap on per-bar returns for an annualized Sharpe 95% CI that
 *    preserves volatility clustering and short-range serial correlation.
 */
export function monteCarlo(base, res, { trials = 1000, seed = 42, sizePct = 100, blockSize = null } = {}) {
  const rng = mulberry32(seed), capital = res.capital, trades = res.trades, m = trades.length;
  const scale = sizePct / 100;
  // Build trade equity checkpoints (at most 120 points so fan memory stays small even for large m).
  const maxPts = Math.min(m, 120), steps = [0];
  if (m > 0) {
    for (let j = 1; j <= maxPts; j++) {
      const s = Math.round((j * m) / maxPts);
      if (s > steps[steps.length - 1]) steps.push(s);
    }
  }
  const S = steps.length;
  const actual = new Array(S); actual[0] = capital;
  let eqAct = capital, nextPt = 1;
  const mults = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const mult = Math.max(0, 1 + (trades[i].pnlPct / 100) * scale);
    mults[i] = mult;
    eqAct *= mult;
    while (nextPt < S && steps[nextPt] === i + 1) actual[nextPt++] = eqAct;
  }

  let netStats, ddStats, probLoss = 0;
  const fanP5 = new Array(S).fill(capital), fanP50 = new Array(S).fill(capital), fanP95 = new Array(S).fill(capital);
  if (m === 0) {
    netStats = { p5: 0, p25: 0, p50: 0, p75: 0, p95: 0, mean: 0 };
    ddStats = { p5: 0, p50: 0, p95: 0, mean: 0 };
  } else {
    const nets = new Float64Array(trials), dds = new Float64Array(trials);
    const cols = Array.from({ length: S }, () => new Float64Array(trials));
    let losses = 0, sumNet = 0, sumDd = 0;
    for (let t = 0; t < trials; t++) {
      let eq = capital, peak = capital, maxDD = 0, pt = 1;
      cols[0][t] = capital;
      for (let i = 0; i < m; i++) {
        const pick = Math.floor(rng() * m);
        eq *= mults[pick];
        if (eq > peak) peak = eq;
        const dd = peak > 0 ? (eq / peak - 1) * 100 : -100;
        if (dd < maxDD) maxDD = dd;
        if (pt < S && steps[pt] === i + 1) cols[pt++][t] = eq;
      }
      const net = (eq / capital - 1) * 100;
      nets[t] = net; dds[t] = maxDD; sumNet += net; sumDd += maxDD;
      if (net < 0) losses++;
    }
    nets.sort(); dds.sort();
    netStats = { p5: quantile(nets, 0.05), p25: quantile(nets, 0.25), p50: quantile(nets, 0.5), p75: quantile(nets, 0.75), p95: quantile(nets, 0.95), mean: sumNet / trials };
    ddStats = { p5: quantile(dds, 0.05), p50: quantile(dds, 0.5), p95: quantile(dds, 0.95), mean: sumDd / trials };
    probLoss = (losses / trials) * 100;
    for (let j = 1; j < S; j++) {
      cols[j].sort();
      fanP5[j] = quantile(cols[j], 0.05); fanP50[j] = quantile(cols[j], 0.5); fanP95[j] = quantile(cols[j], 0.95);
    }
  }

  // Circular block bootstrap on per-bar returns for annualized Sharpe 95% CI.
  const n = base.t.length, from = res.from, barsN = n - from;
  const years = Math.max(1e-9, (base.t[n - 1] - base.t[from]) / 31557600);
  const rets = [];
  for (let i = from + 1; i < n; i++) if (res.equity[i - 1] > 0) rets.push(res.equity[i] / res.equity[i - 1] - 1);
  const L = rets.length;
  let sumO = 0, sum2O = 0;
  for (let i = 0; i < L; i++) { sumO += rets[i]; sum2O += rets[i] * rets[i]; }
  const meanO = L ? sumO / L : 0, sdO = L > 1 ? Math.sqrt(Math.max(0, sum2O / L - meanO * meanO)) : 0;
  const ann = Math.sqrt(barsN / years);
  const observed = sdO > 0 ? (meanO / sdO) * ann : NaN;
  let sharpe = { observed, ci95Lo: NaN, p5: NaN, p50: NaN, p95: NaN, ci95Hi: NaN, probPositive: NaN, blockSize: 0 };
  if (L > 1 && sdO > 0) {
    const B = Math.max(1, Math.min(L, blockSize || Math.max(5, Math.min(25, Math.round(Math.pow(L, 1 / 3))))));
    // Prefix sums over circularly extended returns for O(1) block accumulation.
    const ps = new Float64Array(L + B + 1), ps2 = new Float64Array(L + B + 1);
    for (let i = 0; i < L + B; i++) { const r = rets[i % L]; ps[i + 1] = ps[i] + r; ps2[i + 1] = ps2[i] + r * r; }
    const sh = new Float64Array(trials);
    let pos = 0;
    for (let t = 0; t < trials; t++) {
      let s1 = 0, s2 = 0, rem = L;
      while (rem > 0) {
        const start = Math.floor(rng() * L), len = rem < B ? rem : B;
        s1 += ps[start + len] - ps[start];
        s2 += ps2[start + len] - ps2[start];
        rem -= len;
      }
      const mu = s1 / L, sd = Math.sqrt(Math.max(0, s2 / L - mu * mu));
      const v = sd > 0 ? (mu / sd) * ann : 0;
      sh[t] = v;
      if (v > 0) pos++;
    }
    sh.sort();
    sharpe = {
      observed, ci95Lo: quantile(sh, 0.025), p5: quantile(sh, 0.05), p50: quantile(sh, 0.5),
      p95: quantile(sh, 0.95), ci95Hi: quantile(sh, 0.975), probPositive: (pos / trials) * 100, blockSize: B,
    };
  }

  return { trials, seed, trades: m, net: netStats, maxDD: ddStats, probLoss, fan: { steps, actual, p5: fanP5, p50: fanP50, p95: fanP95 }, sharpe };
}

/**
 * Execution cost / slippage sensitivity curve.
 * Evaluates the strategy's exact entry/exit signals across a grid of round-trip friction
 * levels (split equally per side) and bisects the exact breakeven round-trip friction (bps)
 * where net return crosses 0%.
 */
export function costSensitivity(base, byTf, c, { levels = [0, 5, 10, 15, 25, 40, 60], maxBreakevenBps = 200 } = {}) {
  const n = base.t.length;
  let from = 0;
  if (Number(c.years) > 0) { const cut = base.t[n - 1] - Number(c.years) * 31557600; while (from < n - 1 && base.t[from] < cut) from++; }
  const entry = evalRuleset(c.entry, base, byTf).mask, exit = evalRuleset(c.exit, base, byTf).mask;
  const baseOpts = {
    side: c.side, stopPct: +c.stopPct || 0, targetPct: +c.targetPct || 0, trailPct: +c.trailPct || 0,
    maxBars: +c.maxBars || 0, capital: +c.capital || 10000, sizePct: +c.sizePct || 100, from,
  };
  const evalAt = (rtBps) => summarize(base, runBacktest(base, entry, exit, { ...baseOpts, feeBps: rtBps / 2, slipBps: 0 }));
  const rows = levels.map((rtBps) => {
    const s = evalAt(rtBps);
    return { rtBps, perSideBps: rtBps / 2, netPct: s.netPct, cagr: s.cagr, sharpe: s.sharpe, maxDD: s.maxDD, profitFactor: s.profitFactor, avgTrade: s.avgTrade, trades: s.trades };
  });
  const zeroNet = rows.length && rows[0].rtBps === 0 ? rows[0].netPct : evalAt(0).netPct;
  let breakevenBps;
  if (!(zeroNet > 0)) {
    breakevenBps = 0;
  } else {
    // Bracket the root from the evaluated grid first, or extend up to maxBreakevenBps.
    let lo = 0, hi = maxBreakevenBps;
    let foundHi = false;
    for (const r of rows) {
      if (r.netPct > 0 && r.rtBps > lo && r.rtBps <= maxBreakevenBps) lo = r.rtBps;
      else if (r.netPct <= 0 && !foundHi) { hi = r.rtBps; foundHi = true; break; }
    }
    if (!foundHi && evalAt(maxBreakevenBps).netPct > 0) {
      breakevenBps = Infinity;
    } else {
      for (let it = 0; it < 16; it++) {
        const mid = (lo + hi) / 2;
        if (evalAt(mid).netPct > 0) lo = mid; else hi = mid;
      }
      breakevenBps = +((lo + hi) / 2).toFixed(2);
    }
  }
  const currentRtBps = 2 * ((+c.feeBps || 0) + (+c.slipBps || 0));
  return { rows, breakevenBps, maxBreakevenBps, currentRtBps };
}

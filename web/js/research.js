// Pure research helpers for the Strategy Tester: per-year breakdown and parameter sweeps.
// No DOM here, so tests can import it.
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

// Backtest engine. Pure: bars + boolean entry/exit series in, trades + equity out.
//
// Timing rules (no lookahead):
//   • A signal is read at a bar's close and filled at the NEXT bar's open.
//   • Stops, targets and trailing stops are checked inside each bar from the entry bar on. If the
//     bar opens beyond the level, the fill is the open (gap); otherwise the level itself.
//   • If a stop and a target are both inside one bar, the stop is assumed to have come first.
//   • A trailing stop uses the best price up to the previous bar.

export function runBacktest(bars, entry, exit, o = {}) {
  const { side = 'long', stopPct = 0, targetPct = 0, trailPct = 0, maxBars = 0, feeBps = 0, slipBps = 0, capital = 10000, sizePct = 100, from = 0 } = o;
  const n = bars.t.length, dir = side === 'short' ? -1 : 1, slip = slipBps / 1e4, fee = feeBps / 1e4;
  const equity = new Array(n).fill(NaN), trades = [];
  let eq = capital, pos = null, pending = false, inPos = 0;
  const close = (i, px, reason, open = false) => {
    const exitP = px * (1 - dir * slip), gross = pos.qty * dir * (exitP - pos.entryP), exitFee = open ? 0 : pos.qty * exitP * fee;
    if (!open) eq += gross - exitFee;
    const pnl = gross - pos.fee - exitFee;
    trades.push({ side, entryI: pos.i, entryT: bars.t[pos.i], entryP: pos.entryP, exitI: i, exitT: bars.t[i], exitP, pnl, pnlPct: (pnl / pos.notional) * 100, bars: i - pos.i + 1, reason, open });
    if (!open) pos = null;
  };
  for (let i = Math.max(0, from); i < n; i++) {
    const O = bars.o[i], H = bars.h[i], L = bars.l[i], C = bars.c[i];
    if (pos && pos.exitNext) close(i, O, 'signal');
    if (!pos && pending) {
      const entryP = O * (1 + dir * slip), notional = (eq * sizePct) / 100, f = notional * fee;
      eq -= f;
      pos = { i, entryP, qty: notional / entryP, fee: f, notional, best: entryP, exitNext: false };
    }
    pending = false;
    if (pos) {
      inPos++;
      let stop = NaN, kind = 'stop';
      if (stopPct > 0) stop = pos.entryP * (1 - (dir * stopPct) / 100);
      if (trailPct > 0) { const tr = pos.best * (1 - (dir * trailPct) / 100); if (stop !== stop || dir * (tr - stop) > 0) { stop = tr; kind = 'trail'; } }
      const target = targetPct > 0 ? pos.entryP * (1 + (dir * targetPct) / 100) : NaN, entryBar = pos.i === i;
      const hitStop = stop === stop && (dir > 0 ? L <= stop : H >= stop), hitTarget = target === target && (dir > 0 ? H >= target : L <= target);
      if (hitStop) close(i, !entryBar && (dir > 0 ? O < stop : O > stop) ? O : stop, kind);
      else if (hitTarget) close(i, !entryBar && (dir > 0 ? O > target : O < target) ? O : target, 'target');
      else {
        pos.best = dir > 0 ? Math.max(pos.best, H) : Math.min(pos.best, L);
        if (maxBars > 0 && i - pos.i + 1 >= maxBars) close(i, C, 'time');
        else if (exit[i]) pos.exitNext = true;
      }
    }
    if (!pos && entry[i] && i < n - 1) pending = true;
    equity[i] = eq + (pos ? pos.qty * dir * (C - pos.entryP) : 0);
  }
  if (pos) close(n - 1, bars.c[n - 1], 'open', true);
  return { trades, equity, from: Math.max(0, from), capital, inPos, position: pos ? { entryT: bars.t[pos.i], entryP: pos.entryP, side } : null };
}

export function summarize(bars, res) {
  const { trades, equity, from, capital } = res, n = bars.t.length, last = equity[n - 1];
  const years = Math.max(1e-9, (bars.t[n - 1] - bars.t[from]) / 31557600), barsN = n - from;
  let peak = -Infinity, maxDD = 0, sum = 0, sum2 = 0, cnt = 0;
  const dd = new Array(n).fill(NaN);
  for (let i = from; i < n; i++) {
    const e = equity[i]; if (e > peak) peak = e;
    dd[i] = (e / peak - 1) * 100; if (dd[i] < maxDD) maxDD = dd[i];
    if (i > from && equity[i - 1] > 0) { const r = e / equity[i - 1] - 1; sum += r; sum2 += r * r; cnt++; }
  }
  const mean = cnt ? sum / cnt : 0, sd = cnt > 1 ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  const avg = (a, f) => (a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : NaN);
  const bh = (bars.c[n - 1] / bars.c[from] - 1) * 100;
  return {
    netPct: (last / capital - 1) * 100, cagr: (Math.pow(Math.max(1e-9, last / capital), 1 / years) - 1) * 100, maxDD,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsN / years) : NaN,
    trades: trades.length, winRate: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
    avgTrade: avg(trades, (t) => t.pnlPct), avgWin: avg(wins, (t) => t.pnlPct), avgLoss: avg(losses, (t) => t.pnlPct), avgBars: avg(trades, (t) => t.bars),
    exposure: barsN ? (res.inPos / barsN) * 100 : 0, buyHold: bh, buyHoldCagr: (Math.pow(Math.max(1e-9, 1 + bh / 100), 1 / years) - 1) * 100,
    years, final: last, dd,
  };
}

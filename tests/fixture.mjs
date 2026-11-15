// Deterministic synthetic price history for tests: trending regimes, volatility clustering,
// weekday sessions, quarterly dividends (adjusted close) and a matching intraday series.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function dailyBars(n = 3000, seed = 42, symbol = 'TEST') {
  const r = rng(seed), b = { symbol, tf: '1d', t: [], o: [], h: [], l: [], c: [], v: [], a: [], meta: { name: 'Synthetic', tz: 'America/New_York' } };
  let day = Date.UTC(2012, 0, 2) / 1000, p = 50, vol = 0.012, drift = 0.0004, left = 0;
  while (b.t.length < n) {
    const dow = new Date(day * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      if (left-- <= 0) { drift = (r() - 0.42) * 0.0022; left = 40 + Math.floor(r() * 160); }
      const shock = gauss(r);
      vol = Math.sqrt(0.000004 + 0.9 * vol * vol + 0.08 * (vol * shock) ** 2);
      const gap = gauss(r) * vol * 0.35, o = p * Math.exp(gap), c = o * Math.exp(drift + vol * shock);
      const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.5), lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.5);
      b.t.push(day); b.o.push(+o.toFixed(4)); b.h.push(+hi.toFixed(4)); b.l.push(+lo.toFixed(4)); b.c.push(+c.toFixed(4));
      b.v.push(Math.round(2e6 * Math.exp(gauss(r) * 0.35) * (1 + 25 * Math.abs(c / p - 1))));
      p = c;
    }
    day += 86400;
  }
  // 0.4% dividend every 63 sessions: adjusted close = close * product of (1 - d) for later ex-dates
  let f = 1;
  for (let i = n - 1; i >= 0; i--) { b.a[i] = +(b.c[i] * f).toFixed(6); if (i % 63 === 0 && i > 0) f *= 1 - 0.004; }
  return b;
}

export function intradayBars(days = 30, seed = 7, symbol = 'TEST', step = 300) {
  const r = rng(seed), per = Math.round(23400 / step), b = { symbol, tf: step === 300 ? '5m' : step === 900 ? '15m' : '1h', t: [], o: [], h: [], l: [], c: [], v: [], meta: { name: 'Synthetic', tz: 'America/New_York' } };
  let day = Date.UTC(2026, 8, 1) / 1000, p = 100, d = 0;
  while (d < days) {
    const dow = new Date(day * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      p *= Math.exp(gauss(r) * 0.004);
      for (let k = 0; k < per; k++) {
        const o = p, c = o * Math.exp(gauss(r) * 0.0012 + 0.00002), hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0006), lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0006);
        b.t.push(day + 34200 + k * step); b.o.push(+o.toFixed(4)); b.h.push(+hi.toFixed(4)); b.l.push(+lo.toFixed(4)); b.c.push(+c.toFixed(4)); b.v.push(Math.round(4e4 * Math.exp(gauss(r) * 0.5) * (k < 6 || k > per - 7 ? 3 : 1)));
        p = c;
      }
      d++;
    }
    day += 86400;
  }
  return b;
}

export function cut(bars, n) { const o = { ...bars }; for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'a']) if (bars[k]) o[k] = bars[k].slice(0, n); return o; }

let fails = 0;
export function check(name, cond, extra = '') { if (!cond) fails++; console.log((cond ? 'ok  ' : 'FAIL') + ' ' + name + (extra !== '' ? ' ' + extra : '')); }
export function done(label) { console.log(fails ? `${label}: ${fails} FAILED` : `${label}: all passed`); if (fails) process.exitCode = 1; }

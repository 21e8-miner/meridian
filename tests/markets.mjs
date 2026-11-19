// node tests/markets.mjs — the Markets view's arithmetic: period changes by calendar, breadth,
// the treemap layout and tile colors. (Pack parity with tools/snapshot.py is in tests/parity.mjs.)
import { stats, monthsBack, median, breadth, treemap, tileRgb, packFromBars, decodePack } from '../web/js/markets.js';
import { dailyBars, check, done } from './fixture.mjs';

const D = 86400, day = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
// weekdays from 2025-06-02 to 2026-11-13, skipping two holidays; close = 100 + bar index
const t = [], c = [];
for (let x = day(2025, 6, 2); x <= day(2026, 11, 13); x += D) {
  const wd = new Date(x * 1000).getUTCDay();
  if (wd === 0 || wd === 6 || x === day(2026, 11, 6) || x === day(2025, 12, 31)) continue;
  t.push(x); c.push(100 + t.length - 1);
}
const at = (y, m, d) => c[t.indexOf(day(y, m, d))], n = c.length, last = c[n - 1];
const pk = (tt, cc) => { const k = tt.findIndex((x) => x >= tt[tt.length - 1] - 375 * D); return { t: tt.slice(k), c: cc.slice(k), dv: 1e6 }; };
const s = stats(pk(t, c)), near = (a, b) => Math.abs(a - b) < 1e-9;
check('1 day: against the bar before', near(s.chg['1D'], (last / c[n - 2] - 1) * 100));
check('1 week: the close seven calendar days back, or the last one before it (a holiday)', near(s.chg['1W'], (last / at(2026, 11, 5) - 1) * 100));
check('1 month: same day a month back, or the session before a weekend', near(s.chg['1M'], (last / at(2026, 10, 13) - 1) * 100));
check('3 and 6 months', near(s.chg['3M'], (last / at(2026, 8, 13) - 1) * 100) && near(s.chg['6M'], (last / at(2026, 5, 13) - 1) * 100));
check('year to date: from the last close of the previous year', near(s.chg.YTD, (last / at(2025, 12, 30) - 1) * 100));
check('1 year', near(s.chg['1Y'], (last / at(2025, 11, 13) - 1) * 100));
check('month ends clamp: a month before March 31 is the end of February', monthsBack(day(2026, 3, 31), 1) === day(2026, 2, 28) && monthsBack(day(2024, 3, 31), 1) === day(2024, 2, 29) && monthsBack(day(2026, 1, 15), 3) === day(2025, 10, 15) && monthsBack(day(2026, 11, 13), 12) === day(2025, 11, 13));
check('a rising series is above both averages and at its 52-week closing high', s.above50 === true && s.above200 === true && s.atHigh && !s.atLow && near(s.fromHigh, 0));
{ const f = stats(pk(t, c.map((x) => 1000 - x))); check('a falling series: below both, at its low', f.above50 === false && f.above200 === false && f.atLow && !f.atHigh && f.fromHigh < 0); }
{ const sh = stats({ t: t.slice(-30), c: c.slice(-30), dv: 5 }); check('short history: long periods and averages are blank, not wrong', sh.chg['1Y'] !== sh.chg['1Y'] && sh.chg['3M'] !== sh.chg['3M'] && sh.chg['1W'] === sh.chg['1W'] && sh.above50 === null && sh.above200 === null && !sh.atHigh && sh.fromHigh !== sh.fromHigh); }
{ const one = stats({ t: [day(2026, 11, 13)], c: [5], dv: 0 }); check('a single bar gives no changes', Object.values(one.chg).every((x) => x !== x)); }
// seven-day instruments use the same calendar rules
{ const tt = [], cc = []; for (let x = day(2025, 10, 1); x <= day(2026, 11, 15); x += D) { tt.push(x); cc.push(50 + tt.length); } const z = stats(pk(tt, cc)); check('every-day series: 1 week is seven bars', near(z.chg['1W'], (cc[cc.length - 1] / cc[cc.length - 8] - 1) * 100) && near(z.chg['1Y'], (cc[cc.length - 1] / cc[tt.indexOf(day(2025, 11, 15))] - 1) * 100)); }

check('median', median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5 && median([NaN, 5]) === 5 && median([]) !== median([]));
{ const rows = [1, -2, 0, NaN, 4].map((x, i) => ({ s: { chg: { '1D': x }, above50: i < 2 ? true : i === 2 ? false : null, above200: null, atHigh: i === 4, atLow: false } })), b = breadth(rows, '1D');
  check('breadth: a row can be left out of the period (not read yet this session)', breadth(rows, '1D', (r) => (r.s.atHigh ? NaN : r.s.chg['1D'])).n === 3);
  check('breadth counts only what has a value', b.n === 4 && b.up === 2 && b.down === 1 && b.median === 0.5 && near(b.above50, (2 / 3) * 100) && b.above200 !== b.above200 && b.highs === 1 && b.lows === 0); }

// treemap: areas in proportion, inside the box, no overlaps, nothing lost
{ const items = [50, 30, 12, 5, 2, 1, 0.4, 0, 20, 8].map((v, i) => ({ v, i })), W = 640, H = 380, r = treemap(items, 10, 20, W, H), tot = items.reduce((q, it) => q + it.v, 0);
  check('treemap: one tile per positive item', r.length === 9);
  check('treemap: area is proportional to value', r.every((b) => Math.abs((b.w * b.h) / (W * H) - b.item.v / tot) < 1e-9));
  check('treemap: tiles stay inside the box', r.every((b) => b.x >= 10 - 1e-9 && b.y >= 20 - 1e-9 && b.x + b.w <= 10 + W + 1e-6 && b.y + b.h <= 20 + H + 1e-6));
  let overlap = false; for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) { const p = r[a], q = r[b]; if (Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 1e-6 && Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > 1e-6) overlap = true; }
  check('treemap: tiles do not overlap', !overlap);
  const eq = treemap(Array.from({ length: 12 }, () => ({ v: 1 })), 0, 0, 400, 300); check('treemap: equal items come out near square', eq.every((b) => Math.max(b.w / b.h, b.h / b.w) < 1.6));
  check('treemap: empty and degenerate inputs', treemap([], 0, 0, 10, 10).length === 0 && treemap([{ v: 1 }], 0, 0, 0, 10).length === 0); }

{ const mid = [40, 50, 60], up = [0, 200, 100], dn = [220, 80, 70];
  check('tile color: no change and no data are the neutral gray', String(tileRgb(0, 3, mid, up, dn)) === String(mid) && String(tileRgb(NaN, 3, mid, up, dn)) === String(mid));
  check('tile color: full color at and beyond the scale', String(tileRgb(3, 3, mid, up, dn)) === String(up) && String(tileRgb(99, 3, mid, up, dn)) === String(up) && String(tileRgb(-3, 3, mid, up, dn)) === String(dn));
  const a = tileRgb(1, 3, mid, up, dn), b = tileRgb(2, 3, mid, up, dn); check('tile color: deepens with the size of the move', a[1] > mid[1] && b[1] > a[1] && b[1] < up[1]); }

// the pack is the tail of the bars
{ const b = dailyBars(900); b.meta.type = 'EQUITY'; const p = packFromBars(b), n9 = b.t.length; let sum = 0; for (let i = n9 - 21; i < n9 - 1; i++) sum += b.c[i] * b.v[i];
  check('pack: about a year of closes, ending at the newest bar', p.t[p.t.length - 1] === b.t[n9 - 1] && p.c[p.c.length - 1] === b.c[n9 - 1] && p.t[0] >= b.t[n9 - 1] - 375 * D && b.t[n9 - p.t.length - 1] < b.t[n9 - 1] - 375 * D);
  check('pack: dollar volume is the 20 bars before the newest', p.dv === Math.floor(sum / 20 + 0.5));
  let vs = 0; for (let i = n9 - 21; i < n9 - 1; i++) vs += b.v[i];
  check('pack: a stock priced in another currency has no dollar figure here (the shared summary converts it)', packFromBars({ ...b, meta: { type: 'EQUITY', currency: 'JPY' } }).dv === 0 && packFromBars({ ...b, meta: { type: 'EQUITY', currency: 'USD' } }).dv === p.dv);
  check('pack: crypto volume is already dollars; other kinds have no dollar figure', packFromBars({ ...b, meta: { type: 'CRYPTOCURRENCY' } }).dv === Math.floor(vs / 20 + 0.5) && ['INDEX', 'FUTURE', 'CURRENCY', undefined].every((k) => packFromBars({ ...b, meta: { type: k } }).dv === 0));
  const row = { d0: p.t[0] / D, dd: p.t.slice(1).map((x, i) => (x - p.t[i]) / D), c: p.c, dv: p.dv, f: 7 }, back = decodePack(row);
  check('pack: decoding restores the dates', JSON.stringify(back.t) === JSON.stringify(p.t) && back.f === 7 && back.dv === p.dv); }
done('markets');

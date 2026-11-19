// node tests/parity.mjs — the browser port of the live fill (web/js/static.js) must give the same
// answers as server.py on the same inputs. tests/parity.json is written by tests/make_parity.py.
import { readFileSync } from 'node:fs';
import * as S from '../web/js/static.js';
import { packFromBars, decodePack } from '../web/js/markets.js';
import { check, done } from './fixture.mjs';

const { cases } = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const same = (a, b, path = '') => {
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null) ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  if (typeof a === 'boolean' || typeof b === 'boolean' || typeof a === 'string' || typeof b === 'string') return a === b ? null : `${path}: ${a} vs ${b}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) { if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`; for (let i = 0; i < a.length; i++) { const d = same(a[i], b[i], `${path}[${i}]`); if (d) return d; } return null; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (k === 'fetched') continue; const d = same(a[k], b[k], path ? `${path}.${k}` : k); if (d) return d; }
  return null;
};
const run = {
  sessionOpen: (a) => S.sessionOpen(...a), hlCoin: (a) => S.hlCoin(...a), round: (a) => S.round(...a),
  liveAnchor: (a) => S.liveAnchor(...a), anchorFrom1m: (a) => S.anchorFrom1m(...a),
  spliceLive: (a) => S.spliceLive(...a), spliceExt: (a) => S.spliceExt(...a),
  stockMinutes: (a) => S.stockMinutes(...a), mergeMinutes: (a) => S.mergeMinutes(...a), parseHl: (a) => S.parseHl(...a),
  decode: (a) => S.decodeSeries(...a),
  pack: (a) => { const d = decodePack(a[1]); return { fromBars: packFromBars(a[0]), decoded: { t: d.t, c: d.c, dv: d.dv } }; },
};
const tally = {};
for (const c of cases) {
  const t = (tally[c.fn] = tally[c.fn] || { n: 0, bad: [] });
  t.n++;
  let got; try { got = run[c.fn](JSON.parse(JSON.stringify(c.args))); } catch (e) { t.bad.push('threw ' + e.message); continue; }
  const d = same(got, c.out);
  if (d) t.bad.push(d);
}
for (const [fn, t] of Object.entries(tally)) check(`${fn}: browser port matches the server on ${t.n} cases`, !t.bad.length, t.bad.slice(0, 3).join(' | '));
// the port must not change its inputs either
{ const c = cases.find((x) => x.fn === 'spliceExt' && x.out.live && x.out.live.bars), before = JSON.stringify(c.args); S.spliceExt(...c.args); check('inputs are left untouched', JSON.stringify(c.args) === before); }
// regrouping 5-minute bars (page only): three 5m bars make one 15m bar from the session's first bar
{ const d = { symbol: 'T', tf: '5m', meta: {}, t: [34200, 34500, 34800, 35100, 86400 + 34200], o: [1, 2, 3, 4, 9], h: [5, 6, 7, 8, 9], l: [0.5, 1, 2, 3, 8], c: [2, 3, 4, 5, 9], v: [10, 20, 30, 40, 50] }, r = S.regroup(d, '15m');
  check('5m bars regroup into 15m', JSON.stringify(r.t) === '[34200,35100,120600]' && r.o[0] === 1 && r.h[0] === 7 && r.l[0] === 0.5 && r.c[0] === 4 && r.v[0] === 60 && r.tf === '15m' && d.t.length === 5); }
done('parity');

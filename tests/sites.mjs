// node tests/sites.mjs — the shared page's data set split over several sites (web/js/static.js:
// mergeSites): one symbol's timeframes can come from different sites, lists are unions.
import { mergeSites, kept, readJsonBytes, fetchSeries } from '../web/js/static.js';
import { gzipSync } from 'node:zlib';
import { check, done } from './fixture.mjs';

const DATA = 'https://example.github.io/meridian-data/';
const main = {
  symbols: [{ symbol: 'SPY', tfs: ['1m', '5m', '1h', '1d', 'x1m'], tier: 1 }, { symbol: 'VGT', tfs: ['1h'], tier: 3, sector: 2 }, { symbol: 'KO', tfs: ['5m', '1h', '1d'], tier: 2 }],
  file: { SPY: 'SPY', VGT: 'VGT', KO: 'KO' }, families: { Vanguard: ['VOO', 'VGT'] }, indexes: {}, shards: [{ base: DATA }],
};
const data = {
  symbols: [{ symbol: 'VGT', tfs: ['1d'], tier: 3 }, { symbol: 'AAL', tfs: ['1d'], tier: 3, sector: 6 }, { symbol: 'KO', tfs: ['1d'], tier: 3 }],
  file: { VGT: 'VGT', AAL: 'AAL', KO: 'KO' }, families: { Vanguard: ['VGT', 'VHT'], Cambria: ['TAIL'] }, indexes: { 'Nikkei 225': { country: 'Japan', members: ['7203.T'] } },
};
const ix = mergeSites([['', main], [DATA, data]]);
const vgt = ix.by.get('VGT');
check('a symbol on two sites is listed once', ix.symbols.filter((s) => s.symbol === 'VGT').length === 1 && ix.symbols.length === 4);
check('its timeframes are combined, in order, each read from the site that has it', vgt.tfs.join() === '1h,1d' && vgt.bases['1h'] === '' && vgt.bases['1d'] === DATA);
check('the first site wins a timeframe both have', ix.by.get('KO').bases['1d'] === '' && ix.by.get('KO').tfs.join() === '5m,1h,1d');
check('a symbol only on the data site is read from there', ix.by.get('AAL').bases['1d'] === DATA && ix.file.AAL === 'AAL');
check('a sector missing on one site is taken from the other', vgt.sector === 2);
check('fund families and indexes are the union of every site\'s', ix.families.Vanguard.join() === 'VOO,VGT,VHT' && ix.families.Cambria.join() === 'TAIL' && ix.indexes['Nikkei 225'].members.join() === '7203.T');
check('the catalogs read are not changed by merging', main.symbols[1].tfs.join() === '1h' && main.families.Vanguard.length === 2 && !('bases' in main.symbols[1]));
check('this page\'s own settings are kept', ix.shards.length === 1);
check('what a symbol has, in words', kept(['1h', '1d']) === 'daily and hourly history' && kept(['1d']) === 'daily history' && kept(['5m', '1h', '1d']) === 'daily, hourly and five-minute history' && kept(['1m', '5m', '1h', '1d']) === 'daily, hourly, five-minute and one-minute history');
// series files: gzip-compressed on sites built since that change, plain before
{
  const doc = { symbol: 'X', t0: 5, step: 60, dt: [1, 2], c: [1.5, 2, 2.5], enc: 1 }, plain = Buffer.from(JSON.stringify(doc)), gz = gzipSync(plain);
  const a = await readJsonBytes(gz), b = await readJsonBytes(plain), c = await readJsonBytes(gzipSync(gz)), d = await readJsonBytes(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.length));
  check('a series file reads the same compressed, plain, compressed twice on the way, or as a raw buffer', [a, b, c, d].every((x) => JSON.stringify(x) === JSON.stringify(doc)));
  const seen = [], site = (files, status = 404) => async (url) => { seen.push(url); const f = files[url.split('?')[0]]; return f ? { ok: true, status: 200, arrayBuffer: async () => f } : { ok: false, status }; };
  const one = await fetchSeries('D/1d/AAL', true, '?g=7', site({ 'D/1d/AAL.json.gz': gz }));
  check('a compressed site: the .json.gz file is read, with the query kept', JSON.stringify(one) === JSON.stringify(doc) && seen.join() === 'D/1d/AAL.json.gz?g=7');
  seen.length = 0;
  const two = await fetchSeries('D/1d/AAL', true, '', site({ 'D/1d/AAL.json': plain }));
  check('a page holding a catalog from before the switch still finds the file under its other name', JSON.stringify(two) === JSON.stringify(doc) && seen.join() === 'D/1d/AAL.json.gz,D/1d/AAL.json');
  seen.length = 0;
  check('no file under either name: null', (await fetchSeries('D/1d/ZZZ', false, '', site({}))) === null && seen.join() === 'D/1d/ZZZ.json,D/1d/ZZZ.json.gz');
  let threw = ''; try { await fetchSeries('D/1d/AAL', true, '', site({}, 503)); } catch (e) { threw = e.message; }
  check('a server error is reported, not taken for a missing file', threw === 'HTTP 503');
}
// ── the page against two sites, with a stand-in for fetch ──
// Each scenario gets its own copy of the module (its caches are module state).
const DSITE = 'https://d.test/';
const series = (sym, closes, tf = '1d') => ({ symbol: sym, tf, t: closes.map((_, i) => 86400 * (20000 + i)), o: closes, h: closes, l: closes, c: closes, v: closes.map(() => 5), meta: { tz: 'America/New_York', type: 'EQUITY' }, fetched: 1 });
function world() {
  const w = {
    log: [], mainUp: true, dataUp: true, packBroadFails: false,
    main: { gen: 1000, files: { '1d/SPY': series('SPY', [1, 2, 3]), '1h/AAL': series('AAL', [7, 8], '1h') } },
    data: { gen: 500, files: { '1d/AAL': series('AAL', [10, 11, 12]), '5m/AAL': series('AAL', [10, 10.5], '5m') } },
    extra: [],
  };
  const cat = (site) => site === w.main
    ? { gz: 1, shards: [{ base: DSITE }], symbols: [{ symbol: 'SPY', tfs: ['1d'], tier: 1 }, { symbol: 'AAL', tfs: ['1h'], tier: 3 }, ...w.extra.map((s) => ({ symbol: s, tfs: ['1d'], tier: 2 }))], file: Object.fromEntries(['SPY', 'AAL', ...w.extra].map((s) => [s, s])) }
    : { gz: 1, symbols: [{ symbol: 'AAL', tfs: ['5m', '1d'], tier: 3 }], file: { AAL: 'AAL' } };
  const json = (v) => ({ ok: true, status: 200, json: async () => v, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(v)).buffer });
  const miss = (status = 404) => ({ ok: false, status, json: async () => { throw new Error('no body'); }, arrayBuffer: async () => new ArrayBuffer(0) });
  w.fetch = async (url) => {
    const u = String(url), isData = u.startsWith(DSITE), site = isData ? w.data : w.main, path = (isData ? u.slice(DSITE.length) : u).split('?')[0];
    w.log.push((isData ? 'D:' : 'M:') + path);
    if (!(isData ? w.dataUp : w.mainUp)) throw new TypeError('Failed to fetch');
    if (path === 'data/stamp.json') return json({ generated: site.gen, catalog: 'c' + (isData ? 'd' : 'm') + w.extra.length });
    if (path === 'data/catalog.json') return json(cat(site));
    if (path === 'data/pack.json') return json({ generated: w.main.gen, s: { SPY: { d0: 1, dd: [], c: [3], dv: 9 } } });
    if (path === 'data/pack-broad.json') return isData && !w.packBroadFails ? json({ generated: w.data.gen, s: { AAL: { d0: 1, dd: [], c: [12], dv: 4 } } }) : miss(isData ? 503 : 404);
    const m = /^data\/(\w+)\/(.+)\.json\.gz$/.exec(path), f = m && site.files[`${m[1]}/${m[2]}`];
    if (m && !f && w.extra.includes(m[2]) && m[1] === '1d' && !isData) { const b = gzipSync(JSON.stringify(series(m[2], [1, 2]))); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
    if (!f) return miss();
    const b = gzipSync(JSON.stringify(f));
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
  };
  return w;
}
const realFetch = globalThis.fetch;
try {
  // 1. both sites up; then each rebuilds on its own
  {
    const w = world(); globalThis.fetch = w.fetch;
    const S = await import('../web/js/static.js?scenario=rebuilds');
    await S.init();
    check('two sites: a symbol\'s timeframes are read from whichever site has them', S.tfs('AAL').join() === '5m,1h,1d' && (await S.bars('AAL', '1d', false)).c.join() === '10,11,12' && (await S.bars('AAL', '1h', false)).c.join() === '7,8' && w.log.includes('D:data/1d/AAL.json.gz') && w.log.includes('M:data/1h/AAL.json.gz'));
    // the data site publishes a new build; the main site has not
    w.data.gen = 600; w.data.files['1d/AAL'] = series('AAL', [10, 11, 12, 13]);
    await S.init();
    check('a file on the data site is read again when the data site rebuilds, without waiting for the main site', (await S.bars('AAL', '1d', false)).c.join() === '10,11,12,13');
    const before = w.log.filter((x) => x === 'D:data/1d/AAL.json.gz').length;
    w.main.gen = 1100; w.main.files['1d/SPY'] = series('SPY', [1, 2, 3, 4]);
    await S.init();
    check('and is not read again when only the main site rebuilds; the main site\'s own file is', (await S.bars('AAL', '1d', false)).c.length === 4 && w.log.filter((x) => x === 'D:data/1d/AAL.json.gz').length === before && (await S.bars('SPY', '1d', false)).c.join() === '1,2,3,4');
    // the Markets summary: what it is made of must show in its key
    const p1 = await S.pack(true);
    w.data.gen = 700; await S.init(); const p2 = await S.pack(true);
    w.packBroadFails = true; w.data.gen = 800; await S.init(); const p3 = await S.pack(true);
    w.packBroadFails = false; const p4 = await S.pack(true);
    check('Markets summary: its key changes when the data site rebuilds though the main build time does not', p1.s.AAL && p1.generated === p2.generated && p1.key !== p2.key && !p1.partial);
    check('Markets summary: a part that cannot be read is marked, and reading it later gives a different key', p3.partial === true && !p3.s.AAL && /x/.test(p3.key) && p4.s.AAL && !p4.partial && p4.key !== p3.key && (await S.pack(false)).key === undefined);
  }
  // 2. the data site cannot be read when the page opens
  {
    const w = world(); w.dataUp = false; globalThis.fetch = w.fetch;
    const warn = console.warn; console.warn = () => {};
    const S = await import('../web/js/static.js?scenario=down');
    await S.init();
    let err = null; try { await S.bars('AAL', '1d', false); } catch (e) { err = e; }
    check('data site down: everything on the main site still works', (await S.bars('SPY', '1d', false)).c.join() === '1,2,3' && S.tfs('AAL').join() === '1h' && (await S.bars('AAL', '1h', false)).c.join() === '7,8');
    check('data site down: a timeframe kept there is refused with the real reason, not "this symbol only has ..."', err && err.code === 'down' && /second site that cannot be read/.test(err.message));
    let err2 = null; try { await S.bars('SPY', '5m', false); } catch (e) { err2 = e; }
    check('data site down: a main-site symbol missing a timeframe still says so plainly (the chart falls back to daily on that)', err2 && err2.code === 'tf');
    w.dataUp = true; await S.init();
    check('data site back: its timeframes return', S.tfs('AAL').join() === '5m,1h,1d' && (await S.bars('AAL', '1d', false)).c.join() === '10,11,12');
    // read once, then down: a file there fails with the same plain reason
    w.dataUp = false; w.data.gen = 900; await S.init();
    let err3 = null; try { await S.bars('AAL', '5m', false); } catch (e) { err3 = e; }
    console.warn = warn;
    check('data site down after it was read: its files fail with the same reason, not a bare network error', err3 && err3.code === 'down');
  }
  // 3. a scan of everything must not keep every series in memory
  {
    const w = world(); w.extra = Array.from({ length: 900 }, (_, i) => 'X' + i); globalThis.fetch = w.fetch;
    const S = await import('../web/js/static.js?scenario=memory');
    await S.init();
    const r = await S.batch(w.extra, '1d', 0, false);
    check('memory: after reading 900 series the page keeps at most 600 decoded ones, and can still read any of them', Object.keys(r.bars).length === 900 && S.cachedSeries() <= 600 && S.cachedSeries() >= 500 && (await S.bars('X3', '1d', false)).c.join() === '1,2');
  }
  // world markets keep their own hours
  {
    const S = await import('../web/js/static.js');
    const at = (iso) => Date.parse(iso) / 1000;
    check('market hours: Tokyo, London and Sydney by their own clocks; US symbols with a dot or dash are still New York',
      S.sessionOpen('7203.T', at('2026-11-17T01:00:00Z'), 0) && !S.sessionOpen('7203.T', at('2026-11-16T15:30:00Z'), 0) && S.sessionOpen('SPY', at('2026-11-16T15:30:00Z'), 0)
      && S.sessionOpen('HSBA.L', at('2026-11-17T09:00:00Z'), 0) && !S.sessionOpen('HSBA.L', at('2026-11-21T09:00:00Z'), 0) && S.sessionOpen('BHP.AX', at('2026-11-16T23:30:00Z'), 0)
      && S.sessionOpen('^N225', at('2026-11-17T06:20:00Z'), 0) && !S.sessionOpen('^N225', at('2026-11-17T07:00:00Z'), 0)
      && S.worldSession('BRK-B') === null && S.worldSession('DX-Y.NYB') === null && S.worldSession('ADDT-B.ST')[0] === 'Europe/Stockholm');
  }
} finally { globalThis.fetch = realFetch; }
done('sites');

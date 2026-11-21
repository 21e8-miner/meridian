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
done('sites');

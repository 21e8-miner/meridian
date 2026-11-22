// node tests/screen.mjs — screening every symbol at once (web/js/screen.js, tools/screen.mjs): the
// instant answers must be the ones a scan of the downloaded files gives.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, presetOf, scanLimit, scanBars, matchAgo, screenRow, screenSymbol, uptoBars, mergeScreens, parseAmount, validFilters, passes, rowObject, localDay, isoDay, finalAfter, atomFeed, SCREEN_KEYS, AGO_DEPTH } from '../web/js/screen.js';
import { evalRuleset, requiredTfs, cmp, num, ind } from '../web/js/conditions.js';
import { aggregate, sliceBars } from '../web/js/data.js';
import { calcIndicator } from '../web/js/ta.js';
import { screenSite, nextEntries, loadSignals, parseArgs, readSeries } from '../tools/screen.mjs';
import { gzipSync } from 'node:zlib';
import { appendAll } from '../web/js/util.js';
import { dailyBars, check, done } from './fixture.mjs';

const daily = dailyBars(3000, 42, 'TEST');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i] || (x !== x && b[i] !== b[i]));

// ── presets are recognised only when unchanged ──
check('every preset is recognised, also after a round trip through storage', Object.entries(PRESETS).every(([k, f]) => presetOf(f()) === k && presetOf(JSON.parse(JSON.stringify(f()))) === k));
{
  const rs = PRESETS['Oversold bounce — RSI crosses back above 30']();
  rs.conds[0].b.value = 25;
  const rs2 = PRESETS['Golden cross — 50 SMA crosses above 200 SMA'](); rs2.conds[0].a.params.len = 20;
  const rs3 = PRESETS['New 52-week high'](); rs3.conds[0].tf = '1w';
  const rs4 = PRESETS['New 52-week high'](); rs4.conds[0].a.offset = 0; rs4.conds[0].b.mult = 1; rs4.conds[0].tf = '';
  const rs5 = PRESETS['Golden cross — 50 SMA crosses above 200 SMA'](); rs5.mode = 'any'; rs5.conds.push(cmp(ind('rsi', { len: 14 }), 'gt', num(50)));
  check('an edited preset is not one (value, parameter, timeframe, an extra condition)', presetOf(rs) === null && presetOf(rs2) === null && presetOf(rs3) === null && presetOf(rs5) === null);
  check('builder defaults (no offset, a multiplier of 1, the chart timeframe) still count as the preset', presetOf(rs4) === 'New 52-week high');
}

// ── the bars a scan reads: the build cuts them the way the Scanner downloads them ──
{
  const rs = PRESETS['Weekly uptrend, daily pullback (multi-timeframe)'](), tfs = requiredTfs(rs, '1d');
  const { base, byTf } = scanBars(rs, '1d', daily);
  // the page: one batch per timeframe, each the newest scanLimit() daily bars, then derived
  const page = new Map(tfs.map((t) => { const lim = scanLimit(tfs, t), d = { ...daily }; for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'a']) d[k] = daily[k].slice(-lim); return [t, t === '1d' ? d : aggregate(d, t)]; }));
  check('scan cut: 2,600 daily bars when a weekly condition needs years, 800 otherwise', scanLimit(tfs, '1d') === 2600 && scanLimit(['1d'], '1d') === 800 && scanLimit(['1h'], '1h') === 0 && base.t.length === 2600);
  check('scan cut: the build reads exactly the bars the Scanner downloads, at every timeframe', tfs.every((t) => ['t', 'o', 'h', 'l', 'c', 'v'].every((k) => same(byTf.get(t)[k], page.get(t)[k]))));
}
// ── matching: the shared function is the Scanner's old loop ──
{
  let ok = true, any = 0;
  for (const [name, make] of Object.entries(PRESETS)) {
    const rs = make(), { base, byTf } = scanBars(rs, '1d', daily), { mask } = evalRuleset(rs, base, byTf), n = base.t.length;
    for (const within of [1, 3, 10, 50]) {
      let ago = -1; for (let k = 0; k < within && k < n; k++) if (mask[n - 1 - k]) { ago = k; break; }
      if (matchAgo(rs, base, byTf, within) !== ago) { ok = false; console.log('  differs:', name, within); }
      if (ago >= 0) any++;
    }
  }
  check('bars ago of the latest match: the same as the Scanner loop, for every preset and look-back', ok && any > 0);
  check('too little history is not scanned', matchAgo(PRESETS['New 52-week high'](), sliceBars(daily, 2980), new Map(), 5) === -1);
}

// The page's scan of one symbol, written out here on its own (not screen.js's scanBars / matchAgo):
// the newest scanLimit() daily bars per timeframe, derived timeframes aggregated, the rules
// evaluated, the latest match within `within` bars. What the build publishes must equal this.
const pageScan = (rs, bars, within) => {
  const tfs = requiredTfs(rs, '1d');
  const byTf = new Map(tfs.map((t) => { const lim = scanLimit(tfs, t), d = { ...bars }; for (const k of ['t', 'o', 'h', 'l', 'c', 'v']) d[k] = bars[k].slice(-lim); return [t, t === '1d' ? d : aggregate(d, t)]; }));
  const base = byTf.get('1d'), n = base.t.length; if (n < 30) return -1;
  const { mask } = evalRuleset(rs, base, byTf);
  for (let k = 0; k < within && k < n; k++) if (mask[n - 1 - k]) return k;
  return -1;
};
const matchingNow = (bars) => Object.keys(PRESETS).filter((k) => pageScan(PRESETS[k](), bars, 1) === 0).sort();

// ── the screening row ──
{
  const row = rowObject(screenRow(daily, 123456789)), b = sliceBars(daily, daily.t.length - 800), n = b.t.length, c = b.c[n - 1];
  const rsi = calcIndicator('rsi', b, { len: 14 }).value[n - 1], hi = calcIndicator('donchian', b, { len: 252 }).upper[n - 1], sma200 = calcIndicator('sma', b, { len: 200 }).value[n - 1];
  check('row: in SCREEN_COLS order, last close and 1-day change', screenRow(daily).length === SCREEN_KEYS.length && row.last === Number(c.toPrecision(6)) && row.chg === Math.round((c / b.c[n - 2] - 1) * 10000) / 100);
  check('row: RSI, SMA distance and 52-week high read the rule builder\'s own indicators', row.rsi === Math.round(rsi * 100) / 100 && row.s200 === Math.round((c / sma200 - 1) * 10000) / 100 && row.hi52 === Math.round((c / hi - 1) * 10000) / 100 && row.hi52 <= 0 && row.lo52 >= 0);
  const eq = { ...daily, meta: { ...daily.meta, type: 'EQUITY' } }, yen = { ...daily, meta: { ...daily.meta, type: 'EQUITY', currency: 'JPY' } };
  check('row: dollar volume from the summary file when given, else from the bars', row.dv === 123456789 && rowObject(screenRow(eq)).dv > 0 && row.vol === b.v[n - 1]);
  // unknown is blank, not zero: an index, a future, a stock in another currency without a rate
  const unknown = [rowObject(screenRow(daily)), rowObject(screenRow(yen)), rowObject(screenRow(eq, 0))];
  check('row: an unknown dollar volume is blank, so it passes no filter (0 would pass every "at most")', unknown.every((r) => r.dv === null) && unknown.every((r) => !passes(r, validFilters([{ k: 'dv', op: 'lte', v: '1M' }])) && !passes(r, validFilters([{ k: 'dv', op: 'gte', v: '0' }]))));
  check('row: gap and ATR', row.gap === Math.round((b.o[n - 1] / b.c[n - 2] - 1) * 10000) / 100 && row.atr > 0 && row.atr < 20);
  const short = sliceBars(daily, daily.t.length - 40), rs = rowObject(screenRow(short));
  check('row: too little history leaves the long values blank, not wrong', rs.s200 === null && rs.y1 === null && rs.hi52 === null && rs.chg !== null && screenRow(sliceBars(daily, daily.t.length - 1)) === null);
}

// ── what the build publishes for a symbol ──
{
  // two series whose newest bar changes which presets match (found by scanning seeds)
  const noonNY = (day) => day * 86400 + 17 * 3600; // 12:00 New York in winter
  let ok = true, differ = 0, hits = 0;
  for (const seed of [5, 41]) {
    const d = dailyBars(1500, seed, 'S' + seed); d.meta = { ...d.meta, type: 'EQUITY' };
    const n = d.t.length, lastDay = Math.floor(d.t[n - 1] / 86400), prevDay = Math.floor(d.t[n - 2] / 86400);
    const during = screenSymbol(d, { now: noonNY(lastDay) }), after = screenSymbol(d, { now: noonNY(lastDay + 1) });
    const full = matchingNow(d), prior = matchingNow(uptoBars(d, n - 1));
    if (full.join() !== prior.join()) differ++;
    hits += full.length + prior.length;
    // on its own day the newest bar is still forming: the bar before it is the finished one, judged on the history up to it
    ok = ok && during.final.day === prevDay && prevDay < lastDay && during.final.hits.slice().sort().join() === prior.join();
    // the next day it is finished
    ok = ok && after.final.day === lastDay && after.final.hits.slice().sort().join() === full.join();
    ok = ok && Object.values(after.ago).every((a) => a >= 0 && a < AGO_DEPTH) && Object.keys(PRESETS).every((k) => (k in after.ago ? after.ago[k] : -1) === pageScan(PRESETS[k](), d, AGO_DEPTH));
    // a copy read from the provider during the session has a half-day bar, whatever today's date is
    const midSession = lastDay * 86400 + 16 * 3600, afterClose = finalAfter(lastDay, 'EQUITY') + 60;
    ok = ok && screenSymbol(d, { now: noonNY(lastDay + 1), fetched: midSession }).final.day === prevDay && screenSymbol(d, { now: noonNY(lastDay + 1), fetched: midSession }).final.hits.slice().sort().join() === prior.join();
    ok = ok && screenSymbol(d, { now: noonNY(lastDay + 1), fetched: afterClose }).final.day === lastDay;
  }
  check('finished bars: the feed reads the newest bar only once its day is over and the copy was read after that session; matches are a scan\'s on the history up to that bar', ok && differ === 2 && hits > 0, `differ ${differ}, hits ${hits}`);
  const D = Date.UTC(2026, 10, 20) / 864e5, S = Date.UTC(2026, 6, 10) / 864e5, iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);
  check('a session is final half an hour after New York\'s close (winter and summer), a coin\'s day at midnight UTC, a future\'s an hour later, a currency\'s at its own midnight',
    iso(finalAfter(D, 'EQUITY')) === '2026-11-20T21:30' && iso(finalAfter(S, 'ETF')) === '2026-07-10T20:30' && iso(finalAfter(D, 'CRYPTOCURRENCY', 'UTC')) === '2026-11-21T00:00' && iso(finalAfter(D, 'FUTURE')) === '2026-11-20T22:30' && iso(finalAfter(S, 'CURRENCY', 'Europe/London')) === '2026-07-10T23:00');
  // a market elsewhere: Tokyo's day starts 14 hours before New York's
  const lastDay = Math.floor(daily.t[daily.t.length - 1] / 86400), tokyo = { ...daily, meta: { ...daily.meta, tz: 'Asia/Tokyo' } };
  check('a market\'s own calendar decides when its day is over (Tokyo is a day ahead of New York in the evening)', localDay('Asia/Tokyo', lastDay * 86400 + 23 * 3600) === lastDay + 1 && localDay('America/New_York', lastDay * 86400 + 23 * 3600) === lastDay && screenSymbol(tokyo, { now: lastDay * 86400 + 23 * 3600 }).final.day === lastDay);
  check('an unknown time zone falls back to New York', localDay('Not/AZone', noonNY(lastDay)) === lastDay && isoDay(0) === '1970-01-01');
}

// ── several sites' files -> one view ──
{
  const f1 = { generated: 10, cols: SCREEN_KEYS, rows: { A: SCREEN_KEYS.map((_, i) => i), B: SCREEN_KEYS.map(() => 1) }, presets: { P: { A: 0 }, Q: { B: 2 } } };
  const order = [...SCREEN_KEYS].reverse();
  const f2 = { generated: 20, cols: order, rows: { A: order.map(() => 99), C: order.map((k) => (k === 'rsi' ? 25 : 7)) }, presets: { P: { C: 1, A: 5 } } };
  const m = mergeScreens([f1, f2, null]);
  check('merge: the first site wins a symbol both have; columns are matched by name', m.row('A').rsi === SCREEN_KEYS.indexOf('rsi') && m.row('C').rsi === 25 && m.row('C').last === 7 && m.row('Z') === null && m.size === 3);
  check('merge: preset matches are combined', m.ago('P', 'A') === 0 && m.ago('P', 'C') === 1 && m.ago('Q', 'B') === 2 && m.ago('P', 'B') === undefined && m.has('P') && !m.has('R'));
  check('merge: the build time shown for an answer drawn from several sites is the oldest of them', m.generated === 20 && m.oldest === 10 && mergeScreens([f2]).oldest === 20 && mergeScreens([]).oldest === 0);
}

// ── filters ──
check('filter values: plain numbers, exponents, K/M/B, signs, commas and dollar signs', parseAmount('10M') === 1e7 && parseAmount('1.5k') === 1500 && parseAmount('-3') === -3 && parseAmount('2,500,000') === 2.5e6 && parseAmount('$5B') === 5e9 && parseAmount('.5') === 0.5 && parseAmount('1e3') === 1000 && parseAmount('2.5E-1') === 0.25 && Number.isNaN(parseAmount('abc')) && Number.isNaN(parseAmount('')) && Number.isNaN(parseAmount(null)) && Number.isNaN(parseAmount('e3')));
{
  const fs = validFilters([{ k: 'rsi', op: 'lte', v: '30' }, { k: 'dv', op: 'gte', v: '10M' }, { k: 'nope', op: 'gte', v: 1 }, { k: 'rsi', op: 'eq', v: 1 }, { k: 'rsi', op: 'gte', v: '' }]);
  check('filters: unknown fields, operators and blank values are dropped', fs.length === 2);
  check('filters: every one must pass, and a blank value passes none', passes({ rsi: 28, dv: 2e7 }, fs) && !passes({ rsi: 31, dv: 2e7 }, fs) && !passes({ rsi: 28, dv: 5e6 }, fs) && !passes({ rsi: null, dv: 2e7 }, fs) && !passes(null, fs) && passes({ rsi: 30, dv: 1e7 }, fs));
}

// ── the build step, on a small site ──
const dir = mkdtempSync(join(tmpdir(), 'meridian-screen-'));
try {
  const bars = {};
  const site = (name, syms) => {
    const out = join(dir, name); mkdirSync(join(out, 'data', '1d'), { recursive: true });
    const cat = { symbols: [], file: {} }, pack = { s: {} };
    for (const [sym, opts] of Object.entries(syms)) {
      if (opts.raw) { cat.symbols.push(opts.raw); continue; }
      const d = dailyBars(opts.n || 1500, opts.seed, sym); d.meta = { ...d.meta, tz: opts.tz || 'America/New_York', type: opts.type || 'EQUITY' };
      if (opts.shift) d.t = d.t.map((t) => t + opts.shift * 86400);
      if (opts.fetched) d.fetched = opts.fetched(d);
      bars[sym] = d;
      cat.symbols.push({ symbol: sym, tfs: opts.tfs || ['1d'], type: opts.type || 'EQUITY', ...(opts.mkt ? { mkt: opts.mkt, cur: 'JPY' } : {}) });
      cat.file[sym] = sym.replace(/[^A-Za-z0-9._-]/g, '_');
      if (!opts.tfs || opts.tfs.includes('1d')) writeFileSync(join(out, 'data', '1d', cat.file[sym] + (opts.gz ? '.json.gz' : '.json')), opts.gz ? gzipSync(JSON.stringify(d)) : JSON.stringify(d));
      pack.s[sym] = { dv: opts.dv || 0 };
    }
    writeFileSync(join(out, 'data', 'catalog.json'), JSON.stringify(cat));
    writeFileSync(join(out, 'data', 'stamp.json'), JSON.stringify({ generated: 1234 }));
    writeFileSync(join(out, 'data', 'pack.json'), JSON.stringify(pack));
    return out;
  };
  const lastDay = Math.floor(dailyBars(1500, 1).t[1499] / 86400);
  const now = (lastDay + 2) * 86400 + 17 * 3600;   // two days after the fixtures' last bar
  const US = ['AAA', 'BBB', 'CCC', 'DDD'];
  const main = site('main', {
    AAA: { seed: 1, dv: 5e6, gz: true }, BBB: { seed: 2, dv: 9e7, type: 'ETF' }, CCC: { seed: 41, dv: 3e6 }, DDD: { seed: 5, dv: 2e6, gz: true },
    HOUR: { seed: 3, tfs: ['1h'] }, '7203.T': { seed: 4, mkt: 'Nikkei 225', tz: 'Asia/Tokyo', shift: 1 }, BAD: { seed: 7 },
    STRAY: { seed: 12, shift: 1 },                                        // one US symbol with a bar a day later than the rest
    HALF: { seed: 6, fetched: (d) => Math.floor(d.t[1499] / 86400) * 86400 + 16 * 3600 }, // last read at 11:00 New York on its newest day
    NOTFS: { raw: { symbol: 'NOTFS', type: 'EQUITY' } },                  // a damaged catalog entry
  });
  writeFileSync(join(main, 'data', '1d', 'BAD.json'), '{not json');
  const r = screenSite(main, now), screened = Object.keys(r.screen.rows).sort().join();
  check('build: compressed (.json.gz) and plain files are both read', readSeries(join(main, 'data', '1d'), 'AAA').c.length === 1500 && readSeries(join(main, 'data', '1d'), 'BBB').c.length === 1500);
  check('build: every symbol with daily history here is screened; an unreadable file or a damaged catalog entry is passed over, not fatal', screened === '7203.T,AAA,BBB,CCC,DDD,HALF,STRAY' && r.failed === 1 && r.screen.rows.AAA.length === SCREEN_KEYS.length && r.screen.generated === 1234, `${screened} failed ${r.failed}`);
  check('build: dollar volume comes from the summary file, and presets are listed by name', r.screen.rows.BBB[SCREEN_KEYS.indexOf('dv')] === 9e7 && Object.keys(r.screen.presets).join() === Object.keys(PRESETS).join() && r.screen.cols.join() === SCREEN_KEYS.join());
  // A. every symbol x preset, both directions: what is published (or absent) is what a scan of that file gives
  let pairs = 0, nowHits = 0; const diff = [];
  for (const name of Object.keys(PRESETS)) for (const s of [...US, '7203.T', 'STRAY', 'HALF']) {
    const want = pageScan(PRESETS[name](), bars[s], AGO_DEPTH), got = s in r.screen.presets[name] ? r.screen.presets[name][s] : -1;
    pairs++; if (want === 0) nowHits++; if (want !== got) diff.push(`${s}/${name.slice(0, 14)}: scan ${want}, published ${got}`);
  }
  check('build: for every symbol and preset the published answer, or its absence, is what a scan of the file gives', diff.length === 0 && nowHits >= 4 && pairs === 70, `${pairs} pairs, ${nowHits} matching now; ${diff.slice(0, 3).join(' | ')}`);
  // B. the feed's session and its matches
  let hits = 0; const wrong = [];
  for (const name of Object.keys(PRESETS)) {
    const want = US.filter((s) => pageScan(PRESETS[name](), bars[s], 1) === 0).sort(), got = [...(r.screen.final.presets[name] || [])].sort();
    hits += want.length; if (want.join() !== got.join()) wrong.push(`${name.slice(0, 14)}: scan [${want}], feed [${got}]`);
  }
  check('build: the feed\'s session is the finished day most US stocks are on: one symbol a day ahead, or a market abroad, does not move it', r.screen.final.date === isoDay(lastDay));
  check('build: the session\'s matches are what a scan finds on each US symbol\'s finished bar; a symbol on another day, or last read mid-session, is left out', wrong.length === 0 && hits >= 4 && !Object.values(r.screen.final.presets).flat().some((s) => ['7203.T', 'STRAY', 'HALF'].includes(s)), `${hits} hits; ${wrong.slice(0, 3).join(' | ')}`);
  check('build: within a preset the feed lists the most traded first', r.screen.final.presets['Testing an auto support zone'].join() === 'CCC' && (() => { const all = mergeScreens([r.screen]); return Object.values(r.screen.final.presets).every((l) => l.every((s, i) => i === 0 || (all.row(l[i - 1]).dv || 0) >= (all.row(s).dv || 0))); })());

  // the feed: an entry once every site has screened the same close
  const date = r.screen.final.date, other = { cols: SCREEN_KEYS, rows: { ZZZ: SCREEN_KEYS.map((k) => (k === 'dv' ? 1e9 : 1)) }, final: { date, presets: { 'New 52-week high': ['ZZZ'] } } };
  const mine = { ...r.screen, final: { date, presets: { 'New 52-week high': ['AAA', 'BBB'] } } };
  const waiting = nextEntries([], mine, [{ ...other, final: { ...other.final, date: '2001-01-01' } }], now), unread = nextEntries([], mine, [null], now);
  check('feed: waits while the data site has not screened the same close (or cannot be read), remembering what this site had', !waiting.added && waiting.entries.length === 0 && waiting.waiting === date && !unread.added && waiting.pending.date === date && waiting.pending.presets['New 52-week high'].join() === 'BBB,AAA');
  const one = nextEntries([{ date: '2001-01-01', added: 1, presets: {} }], mine, [other], now);
  check('feed: then adds that session once, newest first, the most traded symbols first across sites', one.added && one.entries.length === 2 && one.entries[0].date === date && one.entries[0].presets['New 52-week high'].join() === 'ZZZ,BBB,AAA' && one.entries[0].added === Math.floor(now) && one.pending === null);
  const again = nextEntries(one.entries, mine, [other], now + 600);
  check('feed: a session already there is not added again, and is left alone while nothing changed; at most 30 are kept', !again.added && again.entries === one.entries && nextEntries(Array.from({ length: 40 }, (_, i) => ({ date: `2000-01-${String(i % 28 + 1).padStart(2, '0')}`, added: 1, presets: {} })), mine, [], now).entries.length === 30);
  const late = nextEntries(one.entries, { ...mine, final: { date, presets: { 'New 52-week high': ['AAA', 'BBB', 'CCC'] } } }, [other], now + 900);
  check('feed: while a session is still the newest, its entry follows the data (a series refreshed late): same place and "added" time, "updated" moves', !late.added && late.entries.length === 2 && late.entries[0].date === date && late.entries[0].added === Math.floor(now) && late.entries[0].updated === Math.floor(now + 900) && late.entries[0].presets['New 52-week high'].includes('CCC'));
  check('feed: an older session reported by a site (it fell behind) changes nothing', (() => { const x = nextEntries(one.entries, { ...mine, final: { date: '2000-12-31', presets: {} } }, [{ ...other, final: { date: '2000-12-31', presets: {} } }], now); return !x.added && x.entries === one.entries; })());
  // a session the sites never agreed on is not skipped: it is added from this site alone when the next one arrives
  const next = '2099-01-02', moved = nextEntries(one.entries.slice(1), { ...mine, final: { date: next, presets: { 'New 52-week high': ['DDD'] } } }, [{ ...other, final: { date: next, presets: {} } }], now + 86400, waiting.pending);
  check('feed: a session the sites never agreed on is added from this site alone, marked, when the next one arrives', moved.added && moved.entries[0].date === next && moved.entries[1].date === date && moved.entries[1].partial === true && moved.entries[1].presets['New 52-week high'].join() === 'BBB,AAA' && moved.entries[2].date === '2001-01-01' && moved.pending === null);
  check('feed: a pending session that did get its entry is not added twice', nextEntries(one.entries, { ...mine, final: { date: next, presets: {} } }, [{ ...other, final: { date: next, presets: {} } }], now + 86400, waiting.pending).entries.filter((e) => e.date === date).length === 1);
  const xml = atomFeed([{ date: '2026-11-20', added: 1795000000, updated: 1795003600, presets: { 'New 52-week high': ['A&B', '<X>'], 'Golden cross — 50 SMA crosses above 200 SMA': ['GC'] } }, { date: '2026-11-19', added: 1794900000, presets: {}, partial: true }], 'https://example.org/m/');
  check('feed: Atom, one entry per session with its own id, everything escaped, the time of the last change, a partial session marked', xml.startsWith('<?xml') && (xml.match(/<entry>/g) || []).length === 2 && xml.includes('<id>https://example.org/m/signals.xml#2026-11-20</id>') && xml.includes('A&amp;amp;B') && !xml.includes('<X>') && xml.includes('3 matches') && xml.includes('No preset matched') && xml.includes('#/chart/GC/1d') && xml.includes(`<updated>${new Date(1795003600e3).toISOString().replace('.000Z', 'Z')}</updated>`) && xml.includes('(main site only)'));
  // the feed's history: from the previous build's files, else the published site; an unreadable site must not become an empty feed
  mkdirSync(join(dir, 'prev', 'data'), { recursive: true }); writeFileSync(join(dir, 'prev', 'data', 'signals.json'), JSON.stringify({ entries: [{ date: 'x' }], pending: { date: 'y' } }));
  const calls = [];
  const fromPrev = await loadSignals({ prev: join(dir, 'prev'), site: 'https://s/', now: 5 }, async () => { calls.push(1); return {}; });
  const none = await loadSignals({ prev: join(dir, 'nothing'), site: 'https://s/', now: 5 }, async () => { throw new Error('HTTP 404 for x'); });
  const fromSite = await loadSignals({ prev: null, site: 'https://s/', now: 5 }, async (u) => ({ entries: [{ date: u }] }));
  let threw = '', tries = 0; try { await loadSignals({ prev: null, site: 'https://s/', now: 5 }, async () => { tries++; throw new Error('HTTP 503 for x'); }); } catch (e) { threw = e.message; }
  check('feed history: the previous build\'s file first; none yet is an empty feed; a site that cannot be read is an error after three tries, never an empty feed', fromPrev.entries[0].date === 'x' && fromPrev.pending.date === 'y' && calls.length === 0 && none.entries.length === 0 && fromSite.entries[0].date.startsWith('https://s/data/signals.json') && tries === 3 && /could not be read/.test(threw) && (await loadSignals({ prev: null, site: null, now: 5 })).entries.length === 0);
  check('arguments: part, previous build, site and data site', JSON.stringify(parseArgs(['_x', '--part=main', '--prev=p', '--shard=https://d/', '--site=https://s/', '--now=5'])) === JSON.stringify({ out: '_x', part: 'main', prev: 'p', site: 'https://s/', shard: 'https://d/', now: 5 }));
} finally { rmSync(dir, { recursive: true, force: true }); }
// the Scanner's panel is put together with appendAll: nothing-to-show entries are left out
{
  const got = [], el = { append: (...xs) => got.push(...xs) };
  appendAll(el, 'a', null, false, ['b', [null, 'c']], undefined, 0);
  check('appendAll leaves out null, false and undefined (DOM append would write "null"), keeps 0 and nested entries', got.join() === 'a,b,c,0');
}
done('screen');

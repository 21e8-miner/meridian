// node tests/screen.mjs — screening every symbol at once (web/js/screen.js, tools/screen.mjs): the
// instant answers must be the ones a scan of the downloaded files gives.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS, presetOf, scanLimit, scanBars, matchAgo, screenRow, screenSymbol, uptoBars, mergeScreens, parseAmount, validFilters, passes, rowObject, localDay, isoDay, atomFeed, SCREEN_KEYS, AGO_DEPTH } from '../web/js/screen.js';
import { evalRuleset, requiredTfs, cmp, num, ind } from '../web/js/conditions.js';
import { aggregate, sliceBars } from '../web/js/data.js';
import { calcIndicator } from '../web/js/ta.js';
import { screenSite, nextEntries, parseArgs } from '../tools/screen.mjs';
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

// ── the screening row ──
{
  const row = rowObject(screenRow(daily, 123456789)), b = sliceBars(daily, daily.t.length - 800), n = b.t.length, c = b.c[n - 1];
  const rsi = calcIndicator('rsi', b, { len: 14 }).value[n - 1], hi = calcIndicator('donchian', b, { len: 252 }).upper[n - 1], sma200 = calcIndicator('sma', b, { len: 200 }).value[n - 1];
  check('row: in SCREEN_COLS order, last close and 1-day change', screenRow(daily).length === SCREEN_KEYS.length && row.last === Number(c.toPrecision(6)) && row.chg === Math.round((c / b.c[n - 2] - 1) * 10000) / 100);
  check('row: RSI, SMA distance and 52-week high read the rule builder\'s own indicators', row.rsi === Math.round(rsi * 100) / 100 && row.s200 === Math.round((c / sma200 - 1) * 10000) / 100 && row.hi52 === Math.round((c / hi - 1) * 10000) / 100 && row.hi52 <= 0 && row.lo52 >= 0);
  const eq = { ...daily, meta: { ...daily.meta, type: 'EQUITY' } };
  check('row: dollar volume from the summary file when given, else from the bars (none for an unknown kind, as in Markets)', row.dv === 123456789 && rowObject(screenRow(eq)).dv > 0 && rowObject(screenRow(daily)).dv === 0 && row.vol === b.v[n - 1]);
  check('row: gap and ATR', row.gap === Math.round((b.o[n - 1] / b.c[n - 2] - 1) * 10000) / 100 && row.atr > 0 && row.atr < 20);
  const short = sliceBars(daily, daily.t.length - 40), rs = rowObject(screenRow(short));
  check('row: too little history leaves the long values blank, not wrong', rs.s200 === null && rs.y1 === null && rs.hi52 === null && rs.chg !== null && screenRow(sliceBars(daily, daily.t.length - 1)) === null);
}

// ── what the build publishes for a symbol ──
{
  const lastDay = Math.floor(daily.t[daily.t.length - 1] / 86400);
  const noonNY = (day) => day * 86400 + 17 * 3600; // 12:00 New York in winter
  const during = screenSymbol(daily, { now: noonNY(lastDay) }), after = screenSymbol(daily, { now: noonNY(lastDay + 1) });
  check('the newest bar is still forming on its own day: the feed reads the bar before it', during.final.day === lastDay - (new Date(lastDay * 864e5).getUTCDay() === 1 ? 3 : 1) || during.final.day === Math.floor(daily.t[daily.t.length - 2] / 86400));
  check('the next day the newest bar is finished: the feed reads it, and its matches are the bars-ago-0 ones', after.final.day === lastDay && same(after.final.hits.sort(), Object.keys(after.ago).filter((k) => after.ago[k] === 0).sort()));
  const prior = screenSymbol(uptoBars(daily, daily.t.length - 1), { now: noonNY(lastDay) });
  check('a finished bar is judged on the history up to it, not on the bar after', same(during.final.hits.sort(), Object.keys(prior.ago).filter((k) => prior.ago[k] === 0).sort()));
  check('bars ago are kept for the newest bars only', Object.values(after.ago).every((a) => a >= 0 && a < AGO_DEPTH));
  // a market elsewhere: Tokyo's day starts 14 hours before New York's
  const tokyo = { ...daily, meta: { ...daily.meta, tz: 'Asia/Tokyo' } };
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
  check('merge: preset matches are combined; the newest build time is kept', m.ago('P', 'A') === 0 && m.ago('P', 'C') === 1 && m.ago('Q', 'B') === 2 && m.ago('P', 'B') === undefined && m.has('P') && !m.has('R') && m.generated === 20);
}

// ── filters ──
check('filter values: plain numbers, K/M/B, signs, commas and dollar signs', parseAmount('10M') === 1e7 && parseAmount('1.5k') === 1500 && parseAmount('-3') === -3 && parseAmount('2,500,000') === 2.5e6 && parseAmount('$5B') === 5e9 && parseAmount('.5') === 0.5 && Number.isNaN(parseAmount('abc')) && Number.isNaN(parseAmount('')) && Number.isNaN(parseAmount(null)));
{
  const fs = validFilters([{ k: 'rsi', op: 'lte', v: '30' }, { k: 'dv', op: 'gte', v: '10M' }, { k: 'nope', op: 'gte', v: 1 }, { k: 'rsi', op: 'eq', v: 1 }, { k: 'rsi', op: 'gte', v: '' }]);
  check('filters: unknown fields, operators and blank values are dropped', fs.length === 2);
  check('filters: every one must pass, and a blank value passes none', passes({ rsi: 28, dv: 2e7 }, fs) && !passes({ rsi: 31, dv: 2e7 }, fs) && !passes({ rsi: 28, dv: 5e6 }, fs) && !passes({ rsi: null, dv: 2e7 }, fs) && !passes(null, fs) && passes({ rsi: 30, dv: 1e7 }, fs));
}

// ── the build step, on a small site ──
const dir = mkdtempSync(join(tmpdir(), 'meridian-screen-'));
try {
  const site = (name, syms) => {
    const out = join(dir, name); mkdirSync(join(out, 'data', '1d'), { recursive: true });
    const cat = { symbols: [], file: {} }, pack = { s: {} };
    for (const [sym, opts] of Object.entries(syms)) {
      const d = dailyBars(opts.n || 1500, opts.seed, sym); d.meta = { ...d.meta, tz: opts.tz || 'America/New_York', type: opts.type || 'EQUITY' };
      if (opts.shift) d.t = d.t.map((t) => t + opts.shift * 86400);
      cat.symbols.push({ symbol: sym, tfs: opts.tfs || ['1d'], type: opts.type || 'EQUITY', ...(opts.mkt ? { mkt: opts.mkt, cur: 'JPY' } : {}) });
      cat.file[sym] = sym.replace(/[^A-Za-z0-9._-]/g, '_');
      if (!opts.tfs || opts.tfs.includes('1d')) writeFileSync(join(out, 'data', '1d', cat.file[sym] + '.json'), JSON.stringify(d));
      pack.s[sym] = { dv: opts.dv || 0 };
    }
    writeFileSync(join(out, 'data', 'catalog.json'), JSON.stringify(cat));
    writeFileSync(join(out, 'data', 'stamp.json'), JSON.stringify({ generated: 1234 }));
    writeFileSync(join(out, 'data', 'pack.json'), JSON.stringify(pack));
    return out;
  };
  const lastDay = Math.floor(dailyBars(1500, 1).t[1499] / 86400);
  const now = (lastDay + 1) * 86400 + 17 * 3600;
  const main = site('main', { AAA: { seed: 1, dv: 5e6 }, BBB: { seed: 2, dv: 9e7, type: 'ETF' }, HOUR: { seed: 3, tfs: ['1h'] }, '7203.T': { seed: 4, mkt: 'Nikkei 225', tz: 'Asia/Tokyo', shift: 1 }, BAD: { seed: 5 } });
  writeFileSync(join(main, 'data', '1d', 'BAD.json'), '{not json');
  const r = screenSite(main, now);
  check('build: every symbol with daily history here is screened; one that cannot be read is counted, not fatal', r.n === 3 && r.failed === 1 && !r.screen.rows.HOUR && r.screen.rows.AAA.length === SCREEN_KEYS.length && r.screen.generated === 1234);
  check('build: dollar volume comes from the summary file, and presets are listed by name', r.screen.rows.BBB[SCREEN_KEYS.indexOf('dv')] === 9e7 && Object.keys(r.screen.presets).join() === Object.keys(PRESETS).join() && r.screen.cols.join() === SCREEN_KEYS.join());
  check('build: the feed\'s session is the newest finished US day (a later market abroad does not move it)', r.screen.final.date === isoDay(lastDay));
  const instant = Object.values(r.screen.presets).every((m) => Object.entries(m).every(([s, a]) => {
    const d = dailyBars(1500, s === 'AAA' ? 1 : s === 'BBB' ? 2 : 4, s), name = Object.keys(r.screen.presets).find((k) => r.screen.presets[k] === m), rs = PRESETS[name]();
    if (s === '7203.T') d.t = d.t.map((t) => t + 86400);
    const { base, byTf } = scanBars(rs, '1d', d); return matchAgo(rs, base, byTf, AGO_DEPTH) === a;
  }));
  check('build: each published match is what a scan of that file gives', instant);
  // the feed: an entry once every site has screened the same close
  const other = { cols: SCREEN_KEYS, rows: { ZZZ: SCREEN_KEYS.map((k) => (k === 'dv' ? 1e9 : 1)) }, final: { date: r.screen.final.date, presets: { 'New 52-week high': ['ZZZ'] } } };
  r.screen.final.presets['New 52-week high'] = ['AAA', 'BBB'];
  const waiting = nextEntries([], r.screen, [{ ...other, final: { ...other.final, date: '2001-01-01' } }], now), unread = nextEntries([], r.screen, [null], now);
  check('feed: waits while the data site has not screened the same close (or cannot be read)', !waiting.added && waiting.entries.length === 0 && waiting.waiting === r.screen.final.date && !unread.added);
  const one = nextEntries([{ date: '2001-01-01', added: 1, presets: {} }], r.screen, [other], now);
  check('feed: then adds that session once, newest first, the most traded symbols first across sites', one.added && one.entries.length === 2 && one.entries[0].date === r.screen.final.date && one.entries[0].presets['New 52-week high'].join() === 'ZZZ,BBB,AAA' && one.entries[0].added === Math.floor(now));
  check('feed: a session already there is not added again; at most 30 are kept', !nextEntries(one.entries, r.screen, [other], now + 600).added && nextEntries(Array.from({ length: 40 }, (_, i) => ({ date: `2000-01-${String(i % 28 + 1).padStart(2, '0')}`, added: 1, presets: {} })), r.screen, [], now).entries.length === 30);
  const xml = atomFeed([{ date: '2026-11-20', added: 1795000000, presets: { 'New 52-week high': ['A&B', '<X>'], 'Golden cross — 50 SMA crosses above 200 SMA': ['GC'] } }, { date: '2026-11-19', added: 1794900000, presets: {} }], 'https://example.org/m/');
  check('feed: Atom, one entry per session with its own id, everything escaped', xml.startsWith('<?xml') && (xml.match(/<entry>/g) || []).length === 2 && xml.includes('<id>https://example.org/m/signals.xml#2026-11-20</id>') && xml.includes('A&amp;amp;B') && !xml.includes('<X>') && xml.includes('3 matches') && xml.includes('No preset matched') && xml.includes('#/chart/GC/1d'));
  check('arguments: part, previous build, site and data site', JSON.stringify(parseArgs(['_x', '--part=main', '--prev=p', '--shard=https://d/', '--site=https://s/', '--now=5'])) === JSON.stringify({ out: '_x', part: 'main', prev: 'p', site: 'https://s/', shard: 'https://d/', now: 5 }));
} finally { rmSync(dir, { recursive: true, force: true }); }
// the Scanner's panel is put together with appendAll: nothing-to-show entries are left out
{
  const got = [], el = { append: (...xs) => got.push(...xs) };
  appendAll(el, 'a', null, false, ['b', [null, 'c']], undefined, 0);
  check('appendAll leaves out null, false and undefined (DOM append would write "null"), keeps 0 and nested entries', got.join() === 'a,b,c,0');
}
done('screen');

#!/usr/bin/env node
/*
Screen every symbol a built site publishes (run after tools/snapshot.py, on its output):

    node tools/screen.mjs _site --part=main --prev=prev --site=URL --shard=URL
    node tools/screen.mjs _site --part=broad --prev=prev

For each symbol with daily history on this site it writes, to <out>/data/screen.json:
  rows      the screening row the Scanner's filters read (web/js/screen.js: SCREEN_COLS)
  presets   preset name -> { symbol: bars ago } for the latest match on one of the newest bars:
            the Scanner answers an unchanged preset from this instead of downloading every file
  final     the presets each symbol matched at its newest finished daily bar, for the most recent
            finished US session, so the daily signals feed can say what matched at that close

With --part=main or all it also keeps the daily signals feed (<out>/signals.xml, an Atom feed, and
data/signals.json, its entries): a session gets an entry once this site and the data site (--shard)
have both screened its close. Entries are carried from the previous build (--prev, else --site).

The same functions run in the page, so the instant answers are the ones a scan of the downloaded
files would give. A symbol that cannot be read is left out and counted, and a failure of the
screening itself only costs the instant answers; the one thing that stops the step is the feed's
history being unreadable, because an empty feed written over it could not be undone.
*/
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSeries } from '../web/js/static.js';
import { screenSymbol, SCREEN_KEYS, PRESETS, isoDay, atomFeed } from '../web/js/screen.js';

const KEEP_ENTRIES = 30; // sessions the feed keeps

export function parseArgs(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const opts = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), ''] : [a.slice(2, i), a.slice(i + 1)]; }));
  return { out: args[0] || '_site', part: opts.part || 'all', prev: opts.prev || null, site: opts.site || null, shard: (opts.shard || '').split(',').filter(Boolean)[0] || null, now: opts.now ? Number(opts.now) : Date.now() / 1000 };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// A series file: <name>.json.gz (gzip) on sites built since files are compressed, else <name>.json.
export function readSeries(dir, name) {
  for (const ext of ['.json.gz', '.json']) {
    const p = join(dir, name + ext);
    if (!existsSync(p)) continue;
    let b = readFileSync(p);
    while (b.length > 1 && b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
    return JSON.parse(b.toString('utf8'));
  }
  throw new Error(`no file for ${name}`);
}
const tryJson = (p) => { try { return existsSync(p) ? readJson(p) : null; } catch { return null; } };
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'meridian-build' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
const usStock = (e) => (e.type === 'EQUITY' || e.type === 'ETF') && !e.mkt && !e.cur;

// Screen the site at `out`. Returns the screen file and a summary.
export function screenSite(out, now) {
  const data = join(out, 'data'), cat = readJson(join(data, 'catalog.json')), stamp = tryJson(join(data, 'stamp.json')) || {};
  const dv = {};
  for (const name of ['pack.json', 'pack-broad.json']) { const p = tryJson(join(data, name)); if (p && p.s) for (const [s, r] of Object.entries(p.s)) dv[s] = r.dv; }
  const rows = {}, presets = Object.fromEntries(Object.keys(PRESETS).map((k) => [k, {}])), finals = [];
  let failed = 0;
  for (const e of cat.symbols) {
    try {
      if (!(e.tfs || []).includes('1d')) continue;
      const d = decodeSeries(readSeries(join(data, '1d'), cat.file[e.symbol]));
      const daily = { symbol: e.symbol, tf: '1d', t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, meta: d.meta || {} };
      const r = screenSymbol(daily, { now, dv: dv[e.symbol], fetched: d.fetched });
      if (!r) continue;
      rows[e.symbol] = r.row;
      for (const [name, ago] of Object.entries(r.ago)) presets[name][e.symbol] = ago;
      if (r.final) finals.push({ e, ...r.final });
    } catch (err) { failed++; if (failed <= 5) console.warn(`  ${e.symbol}: ${err.message}`); }
  }
  // the session the feed reports: the finished day most of the US stocks here are on (all symbols
  // when there are none; the later day on a tie), and what matched on it. Most, not the newest:
  // one symbol with a stray bar must not move the session, and a close that only a few symbols
  // have been refreshed for is not ready to report.
  const us = finals.filter((f) => usStock(f.e)), pool = us.length ? us : finals;
  const count = new Map(); for (const f of pool) count.set(f.day, (count.get(f.day) || 0) + 1);
  const day = pool.length ? [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0] : null;
  const iDv = SCREEN_KEYS.indexOf('dv'), dvOf = (s) => (rows[s] && rows[s][iDv]) || 0;
  const final = { date: day == null ? null : isoDay(day), presets: {} };
  if (day != null) for (const name of Object.keys(PRESETS)) final.presets[name] = finals.filter((f) => f.day === day && f.hits.includes(name)).map((f) => f.e.symbol).sort((a, b) => dvOf(b) - dvOf(a));
  const screen = { v: 1, generated: stamp.generated || Math.floor(now), cols: SCREEN_KEYS, rows, presets, final };
  return { screen, failed, n: Object.keys(rows).length };
}

// The feed's entries after this build: the previous ones, plus the newest session once every
// site has screened its close. `others` are the other sites' screen files (null: unreadable).
// One session's matches across sites: preset -> symbols, most traded first.
function mergeFinals(files) {
  const dv = new Map(), presets = {};
  for (const f of files) { const i = (f.cols || []).indexOf('dv'); for (const [s, r] of Object.entries(f.rows || {})) if (!dv.has(s)) dv.set(s, (i >= 0 && r[i]) || 0); }
  for (const name of Object.keys(PRESETS)) {
    const syms = [...new Set(files.flatMap((f) => ((f.final && f.final.presets) || {})[name] || []))].sort((a, b) => (dv.get(b) || 0) - (dv.get(a) || 0));
    if (syms.length) presets[name] = syms;
  }
  return presets;
}

/**
 * The feed's entries after this build. `others`: the other sites' screen files (null: unreadable).
 * `pending`: the session this site was waiting on the others for, with what it had itself.
 *   - a session is added once every site has screened its close;
 *   - while that session is still the newest one, its entry follows the data (a series refreshed
 *     late), keeping its place and its "added" time;
 *   - a session the sites never agreed on within its day is added from this site alone, marked
 *     partial, when the next one arrives: one entry per session, none silently skipped.
 * Returns { entries, added, waiting, pending }.
 */
export function nextEntries(entries, mine, others, now, pending = null) {
  const date = mine.final && mine.final.date, t = Math.floor(now);
  let out = entries;
  if (pending && pending.date && date && pending.date < date && !out.some((e) => e.date === pending.date) && (!out.length || out[0].date < pending.date)) {
    out = [{ date: pending.date, added: t, presets: pending.presets || {}, partial: true }, ...out];
  }
  if (!date) return { entries: out, added: false, pending: null };
  if (others.some((o) => !o || !o.final || o.final.date !== date)) {
    const waitFor = out.length && out[0].date >= date ? null : { date, presets: mergeFinals([mine]) };
    return { entries: out.slice(0, KEEP_ENTRIES), added: false, waiting: waitFor ? date : undefined, pending: waitFor };
  }
  const presets = mergeFinals([mine, ...others]);
  if (out.length && out[0].date === date) {
    if (JSON.stringify(out[0].presets) !== JSON.stringify(presets)) { const { partial, ...rest } = out[0]; out = [{ ...rest, presets, updated: t }, ...out.slice(1)]; }
    return { entries: out, added: false, pending: null };
  }
  if (out.length && out[0].date > date) return { entries: out, added: false, pending: null };
  return { entries: [{ date, added: t, presets }, ...out].slice(0, KEEP_ENTRIES), added: true, pending: null };
}

// The feed as the previous build left it: { entries, pending }. From the previous build's files
// when there are any, else from the published site. No feed yet (404) is an empty one; a site that
// cannot be read is an error, because writing an empty feed over it would lose the history.
export async function loadSignals(o, get = fetchJson) {
  const local = o.prev ? tryJson(join(o.prev, 'data', 'signals.json')) : null;
  if (local) return local;
  if (!o.site) return { entries: [] };
  let err = null;
  for (let k = 0; k < 3; k++) {
    try { return await get(`${o.site}data/signals.json?b=${Math.floor(o.now)}-${k}`); }
    catch (e) { if (/HTTP 404/.test(e.message)) return { entries: [] }; err = e; }
  }
  throw new Error(`the signals feed's history could not be read (${err && err.message}); not replacing it`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2)), t0 = performance.now();
  // Screening must not stop the data from being published: if it fails the page downloads files
  // to scan, as it did before, and the feed is carried as it was.
  let screen = null;
  try {
    const r = screenSite(o.out, o.now);
    screen = r.screen;
    writeFileSync(join(o.out, 'data', 'screen.json'), JSON.stringify(screen));
    const hits = Object.entries(screen.presets).map(([k, v]) => `${Object.values(v).filter((a) => a === 0).length} ${k.split(/[ —,(]/)[0].toLowerCase()}`);
    console.log(`screen: ${r.n} symbols in ${((performance.now() - t0) / 1000).toFixed(0)} s${r.failed ? `, ${r.failed} unreadable` : ''}; matching now: ${hits.join(', ')}; last finished session ${screen.final.date}`);
  } catch (e) { console.log(`::warning::screening failed: ${e.stack || e}`); }
  if (o.part === 'broad') return;
  // the daily signals feed
  const carried = await loadSignals(o);
  let r = { entries: carried.entries || [], pending: carried.pending || null, added: false };
  if (screen) {
    const others = [];
    if (o.part === 'main' && o.shard) { try { others.push(await fetchJson(`${o.shard}data/screen.json?b=${Math.floor(o.now)}`)); } catch (e) { console.warn(`  data site screen unreadable: ${e.message}`); others.push(null); } }
    r = nextEntries(r.entries, screen, others, o.now, r.pending);
  }
  writeFileSync(join(o.out, 'data', 'signals.json'), JSON.stringify({ entries: r.entries, pending: r.pending || null }));
  writeFileSync(join(o.out, 'signals.xml'), atomFeed(r.entries, o.site || ''));
  console.log(`signals feed: ${r.entries.length} sessions${r.added ? `, added ${r.entries[0].date}` : r.waiting ? `; ${r.waiting} waits for the data site` : ''}`);
}

// Only the feed's history being unreadable stops the step (and with it this build): publishing
// an empty feed over it could not be undone; the next build tries again.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.log(`::error::${e.message || e}`); process.exit(1); });
}

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
files would give. A symbol that cannot be read is left out and counted; nothing here stops a build.
*/
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
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
    if (!e.tfs.includes('1d')) continue;
    try {
      const d = decodeSeries(readSeries(join(data, '1d'), cat.file[e.symbol]));
      const daily = { symbol: e.symbol, tf: '1d', t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, meta: d.meta || {} };
      const r = screenSymbol(daily, { now, dv: dv[e.symbol] });
      if (!r) continue;
      rows[e.symbol] = r.row;
      for (const [name, ago] of Object.entries(r.ago)) presets[name][e.symbol] = ago;
      if (r.final) finals.push({ e, ...r.final });
    } catch (err) { failed++; if (failed <= 5) console.warn(`  ${e.symbol}: ${err.message}`); }
  }
  // the session the feed reports: the newest finished day of the US stocks here (all symbols when
  // there are none), and what matched on it
  const us = finals.filter((f) => usStock(f.e)), pool = us.length ? us : finals;
  const day = pool.length ? Math.max(...pool.map((f) => f.day)) : null;
  const iDv = SCREEN_KEYS.indexOf('dv'), dvOf = (s) => (rows[s] && rows[s][iDv]) || 0;
  const final = { date: day == null ? null : isoDay(day), presets: {} };
  if (day != null) for (const name of Object.keys(PRESETS)) final.presets[name] = finals.filter((f) => f.day === day && f.hits.includes(name)).map((f) => f.e.symbol).sort((a, b) => dvOf(b) - dvOf(a));
  const screen = { v: 1, generated: stamp.generated || Math.floor(now), cols: SCREEN_KEYS, rows, presets, final };
  return { screen, failed, n: Object.keys(rows).length };
}

// The feed's entries after this build: the previous ones, plus the newest session once every
// site has screened its close. `others` are the other sites' screen files (null: unreadable).
export function nextEntries(entries, mine, others, now) {
  const date = mine.final && mine.final.date;
  if (!date || others.some((o) => !o || !o.final || o.final.date !== date)) return { entries, added: false, waiting: date };
  if (entries.length && entries[0].date >= date) return { entries, added: false };
  const all = [mine, ...others], dv = new Map();
  for (const f of all) { const i = (f.cols || []).indexOf('dv'); for (const [s, r] of Object.entries(f.rows || {})) if (!dv.has(s)) dv.set(s, (i >= 0 && r[i]) || 0); }
  const presets = {};
  for (const name of Object.keys(PRESETS)) {
    const syms = [...new Set(all.flatMap((f) => (f.final.presets || {})[name] || []))].sort((a, b) => (dv.get(b) || 0) - (dv.get(a) || 0));
    if (syms.length) presets[name] = syms;
  }
  return { entries: [{ date, added: Math.floor(now), presets }, ...entries].slice(0, KEEP_ENTRIES), added: true };
}

async function main() {
  const o = parseArgs(process.argv.slice(2)), t0 = performance.now();
  const { screen, failed, n } = screenSite(o.out, o.now);
  writeFileSync(join(o.out, 'data', 'screen.json'), JSON.stringify(screen));
  const hits = Object.entries(screen.presets).map(([k, v]) => `${Object.values(v).filter((a) => a === 0).length} ${k.split(/[ —,(]/)[0].toLowerCase()}`);
  console.log(`screen: ${n} symbols in ${((performance.now() - t0) / 1000).toFixed(0)} s${failed ? `, ${failed} unreadable` : ''}; matching now: ${hits.join(', ')}; last finished session ${screen.final.date}`);
  if (o.part === 'broad') return;
  // the daily signals feed
  let prev = o.prev ? tryJson(join(o.prev, 'data', 'signals.json')) : null;
  if (!prev && o.site) { try { prev = await fetchJson(`${o.site}data/signals.json?b=${Math.floor(o.now)}`); } catch { prev = null; } }
  const others = [];
  if (o.part === 'main' && o.shard) { try { others.push(await fetchJson(`${o.shard}data/screen.json?b=${Math.floor(o.now)}`)); } catch (e) { console.warn(`  data site screen unreadable: ${e.message}`); others.push(null); } }
  const r = nextEntries((prev && prev.entries) || [], screen, others, o.now);
  writeFileSync(join(o.out, 'data', 'signals.json'), JSON.stringify({ entries: r.entries }));
  writeFileSync(join(o.out, 'signals.xml'), atomFeed(r.entries, o.site || ''));
  console.log(`signals feed: ${r.entries.length} sessions${r.added ? `, added ${r.entries[0].date}` : r.waiting ? `; ${r.waiting} waits for the data site` : ''}`);
}

// A failure here must not stop the data from being published: the page then downloads files to
// scan, as it did before. The feed's entries are carried forward so its history is not lost.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.log(`::warning::screening failed: ${e.stack || e}`);
    const o = parseArgs(process.argv.slice(2));
    for (const f of ['data/signals.json', 'signals.xml']) { try { if (o.prev && existsSync(join(o.prev, f))) copyFileSync(join(o.prev, f), join(o.out, f)); } catch { /* nothing to carry */ } }
    process.exit(0);
  });
}

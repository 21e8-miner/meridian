// Alerts (price level, drawn line, rule set) and paper bots. Checked once a minute while the app is open;
// price and line alerts on a symbol that follows a Hyperliquid market are also checked on every trade.
import { h, add, clear, store, bus, toast, uid, fmtPrice, fmtStamp, fmtPct } from './util.js';
import { getBars, tfLabel, TFS, isIntraday } from './data.js';
import { ruleBuilder, evalRuleset, requiredTfs, describeRuleset, newRuleset, cmp, ind, num } from './conditions.js';
import { prepare, simulate } from './sim.js';
import { api } from './api.js';
import { follows } from './stream.js';

let list = store.get('alerts', []), bots = store.get('bots', []), log = store.get('alertlog', []), unseen = store.get('alerts.unseen', 0);
let root = null, timer = null, busy = false, again = false;
const persist = () => { store.set('alerts', list); store.set('bots', bots); store.set('alertlog', log.slice(0, 200)); store.set('alerts.unseen', unseen); bus.emit('alerts'); badge(); if (root) draw(); };
function badge() { const b = document.getElementById('alert-badge'); if (!b) return; b.hidden = !unseen; b.textContent = unseen; }

function fire(msg, symbol, tf) {
  log.unshift({ at: Date.now(), msg, symbol, tf }); unseen++;
  toast(msg, 'ok', 9000);
  try { if (window.Notification && Notification.permission === 'granted') new Notification('Meridian alert', { body: msg }); } catch { /* notifications unavailable */ }
}

export const priceLevels = (symbol) => list.filter((a) => a.active && a.kind === 'price' && a.symbol === symbol).map((a) => ({ price: a.price, label: '' }));
export function addPriceAlert(symbol, price) { list.unshift({ id: uid(), kind: 'price', symbol, price: Number(price), active: true, side: null, created: Date.now() }); persist(); tick(); }
export function addLineAlert(symbol, tf, d) { list.unshift({ id: uid(), kind: 'line', symbol, tf, type: d.type, pts: d.pts.map((p) => ({ ...p })), active: true, side: null, created: Date.now() }); persist(); tick(); }
export function addRuleAlert(symbol, tf, rs, repeat) { list.unshift({ id: uid(), kind: 'rules', symbol, tf, rs: JSON.parse(JSON.stringify(rs)), repeat: !!repeat, active: true, lastT: null, created: Date.now() }); persist(); tick(); }
export function addBot(b) { bots.unshift({ id: uid(), active: true, seen: 0, created: Date.now(), ...b }); persist(); tick(); }

// ── checked on every trade ──
// A price or line alert whose symbol follows a live Hyperliquid market (a future's live estimate, an
// XYZ: chart) need not wait for the minute: `watch` keeps, per alert, the market and ratio its last
// check found. A stock's overnight estimate is left out: the minute check reads the session's close
// there, and an alert should not fire on an estimate the chart itself draws dotted.
const watch = new Map(); // alert id -> { coin, ratio, asof }
export function watchFor(bars) {
  const f = follows(bars);
  if (!f || f.kind === 'ext') return null;
  return { coin: f.coin, ratio: f.ratio, asof: bars.live ? bars.live.asof : (bars.meta && bars.meta.asof) || 0 };
}
// The side a trade puts the price on when that is a cross of alert `a`'s level, else null.
export function liveCross(a, w, coin, px, atMs) {
  if (!a.active || !a.side || !w || w.coin !== coin || !(px > 0) || !(a.level > 0) || atMs / 1000 <= w.asof) return null;
  const side = px * w.ratio >= a.level ? 'above' : 'below';
  return side === a.side ? null : side;
}
export function streamCoins() { const out = new Set(); for (const a of list) { const w = a.active && watch.get(a.id); if (w) out.add(w.coin); } return out; }
export function onTick(coin, px, atMs) {
  let changed = false;
  for (const a of list) {
    const w = watch.get(a.id), side = liveCross(a, w, coin, px, atMs);
    if (!side) continue;
    a.lastPx = px * w.ratio; a.active = false; a.firedAt = Date.now(); changed = true;
    fire(`${a.symbol} crossed ${side} ${a.kind === 'line' ? 'your line at ' : ''}${fmtPrice(a.level)} (last ${fmtPrice(a.lastPx)}, live)`, a.symbol, a.tf);
  }
  if (changed) persist();
}

function idxOfT(bars, t) {
  const T = bars.t, n = T.length, dt = n > 1 ? T[n - 1] - T[n - 2] : 86400;
  if (t <= T[0]) return (t - T[0]) / dt;
  if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / dt;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  return lo + (t - T[lo]) / (T[hi] - T[lo]);
}
function lineLevel(a, bars) {
  if (a.type === 'hline') return a.pts[0].p;
  const i1 = idxOfT(bars, a.pts[0].t), i2 = idxOfT(bars, a.pts[1].t), n = bars.t.length;
  return i1 === i2 ? a.pts[0].p : a.pts[0].p + ((a.pts[1].p - a.pts[0].p) * (n - 1 - i1)) / (i2 - i1);
}

export async function tick() {
  if (busy) { again = true; return; } // something was added mid-check: check once more after it
  busy = true;
  let changed = false;
  try {
    for (const a of list) {
      if (!a.active) continue;
      try {
        if (a.kind === 'price' || a.kind === 'line') {
          const bars = await getBars(a.symbol, a.kind === 'line' ? a.tf : '1d', { maxAge: 50000 }), n = bars.t.length, px = bars.c[n - 1];
          const level = a.kind === 'price' ? a.price : lineLevel(a, bars), side = px >= level ? 'above' : 'below';
          a.level = level; a.lastPx = px;
          const w = watchFor(bars), had = watch.get(a.id); if (w) watch.set(a.id, w); else watch.delete(a.id);
          if ((w && w.coin) !== (had && had.coin)) changed = true; // the app follows a different set of markets
          if (a.side && side !== a.side) { fire(`${a.symbol} crossed ${side} ${a.kind === 'line' ? 'your line at ' : ''}${fmtPrice(level)} (last ${fmtPrice(px)})`, a.symbol, a.tf); a.active = false; a.firedAt = Date.now(); changed = true; }
          else if (!a.side) { a.side = side; changed = true; }
        } else {
          const base = await getBars(a.symbol, a.tf, { maxAge: 50000 }), byTf = new Map([[a.tf, base]]);
          for (const tf of requiredTfs(a.rs, a.tf)) if (!byTf.has(tf)) byTf.set(tf, await getBars(a.symbol, tf, { maxAge: 50000 }));
          const n = base.t.length, hit = evalRuleset(a.rs, base, byTf).mask[n - 1];
          a.state = hit;
          if (hit && a.lastT !== base.t[n - 1]) { a.lastT = base.t[n - 1]; fire(`${a.symbol} ${tfLabel(a.tf)}: ${describeRuleset(a.rs, a.tf)}`, a.symbol, a.tf); if (!a.repeat) { a.active = false; a.firedAt = Date.now(); } changed = true; }
        }
        a.error = null;
      } catch (e) { a.error = e.message; }
    }
    for (const b of bots) {
      if (!b.active) continue;
      try {
        const { base, byTf } = await prepare(b.symbol, b.cfg);
        let from = base.t.findIndex((t) => t >= b.deployedT); if (from < 0) from = base.t.length - 1;
        const { res, stats } = simulate(base, byTf, b.cfg, { maskBefore: b.deployedT, from });
        const events = res.trades.length * 2 - (res.position ? 1 : 0);
        if (events > (b.seen || 0)) {
          const t = res.trades[res.trades.length - 1];
          fire(t.open ? `Bot “${b.name}”: entered ${t.side} ${b.symbol} at ${fmtPrice(t.entryP)}` : `Bot “${b.name}”: exited ${b.symbol} at ${fmtPrice(t.exitP)} (${fmtPct(t.pnlPct)}, ${t.reason})`, b.symbol, b.tf);
          b.seen = events;
        }
        b.last = { trades: res.trades.map((t) => ({ side: t.side, entryT: t.entryT, entryP: t.entryP, exitT: t.exitT, exitP: t.exitP, pnlPct: t.pnlPct, reason: t.reason, open: t.open })), netPct: stats.netPct, checked: Date.now(), lastBar: base.t[base.t.length - 1] };
        b.error = null; changed = true;
      } catch (e) { b.error = e.message; }
    }
  } finally { busy = false; }
  if (changed) persist(); else if (root) draw();
  if (again) { again = false; tick(); }
}
export function start() { badge(); if (timer) return; timer = setInterval(() => { if (list.some((a) => a.active) || bots.some((b) => b.active)) tick(); }, 60000); setTimeout(tick, 2500); }

// ───────────────────────── view ─────────────────────────
const form = { symbol: '', kind: 'price', price: '', tf: '1d', repeat: false, rs: newRuleset([cmp(ind('rsi', { len: 14 }), 'xup', num(30))]) };
let formEl = null, listEl = null;

export function mount(el) {
  root = el; form.symbol = api.activeSymbol();
  formEl = h('div', { class: 'col cfg' }); listEl = h('div', { class: 'col res' });
  el.append(h('div', { class: 'cols' }, formEl, listEl));
  bus.on('view', (v) => { if (v === 'alerts') { unseen = 0; store.set('alerts.unseen', 0); badge(); draw(); } });
  unseen = 0; store.set('alerts.unseen', 0); badge();
  drawForm(); draw();
}
function drawForm() {
  clear(formEl);
  const notif = window.Notification ? Notification.permission : 'unsupported';
  add(formEl, h('h2', null, 'Alerts & Bots'), h('p', { class: 'hint' }, 'Alerts and paper bots are checked once a minute while this app is open in a browser tab; a price or line alert on a symbol with a live Hyperliquid market (a future with a live estimate, an XYZ: market) is checked on every trade. Right-click a chart to alert on a price or on a line you drew.'),
    h('h4', null, 'New alert'),
    h('div', { class: 'row' },
      h('label', { class: 'field' }, 'Symbol', h('input', { type: 'text', value: form.symbol, style: { width: '96px', textTransform: 'uppercase' }, onchange: (e) => (form.symbol = e.target.value.trim().toUpperCase()) })),
      h('label', { class: 'field' }, 'Type', h('select', { onchange: (e) => { form.kind = e.target.value; drawForm(); } }, h('option', { value: 'price', selected: form.kind === 'price' }, 'Price crosses a level'), h('option', { value: 'rules', selected: form.kind === 'rules' }, 'Multi-factor rule set'))),
      form.kind === 'price' ? h('label', { class: 'field' }, 'Level', h('input', { type: 'number', step: 'any', value: form.price, style: { width: '100px' }, onchange: (e) => (form.price = e.target.value) })) : null,
      form.kind === 'rules' ? h('label', { class: 'field' }, 'Timeframe', h('select', { onchange: (e) => { form.tf = e.target.value; drawForm(); } }, TFS.map((t) => h('option', { value: t.id, selected: form.tf === t.id }, t.label)))) : null,
      form.kind === 'rules' ? h('label', { title: 'Fire again each time a new bar meets the rules' }, h('input', { type: 'checkbox', checked: form.repeat, onchange: (e) => (form.repeat = e.target.checked) }), 'Repeat') : null),
    form.kind === 'rules' ? ruleBuilder(form.rs, { title: 'Alert when', baseTf: () => form.tf }) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => {
      if (!form.symbol) return toast('Enter a symbol.', 'err');
      if (form.kind === 'price') { if (!(Number(form.price) > 0)) return toast('Enter a price level.', 'err'); addPriceAlert(form.symbol, Number(form.price)); }
      else { if (!form.rs.conds.length) return toast('Add at least one condition.', 'err'); addRuleAlert(form.symbol, form.tf, form.rs, form.repeat); }
      toast('Alert created.', 'ok');
    } }, 'Create alert')),
    h('h4', null, 'Desktop notifications'),
    notif === 'granted' ? h('p', { class: 'hint' }, 'Enabled. Alerts also appear in the log on the right.') :
      notif === 'unsupported' ? h('p', { class: 'hint' }, 'This browser does not support notifications; alerts appear in the app only.') :
        h('div', { class: 'row' }, h('button', { onclick: async () => { try { await Notification.requestPermission(); } catch { /* denied */ } drawForm(); } }, 'Enable desktop notifications'), h('span', { class: 'hint', style: { margin: 0 } }, notif === 'denied' ? 'Blocked in browser settings.' : '')),
    h('h4', null, 'Paper bots'), h('p', { class: 'hint' }, 'A bot is a tested strategy tracked forward from the moment you deploy it, with simulated fills at the next bar’s open. No orders are sent anywhere. Deploy one from the Strategy Tester.'));
}
function describe(a) {
  if (a.kind === 'price') return `Price crosses ${fmtPrice(a.price)}`;
  if (a.kind === 'line') return `Price crosses drawn ${a.type === 'hline' ? 'level' : 'line'} (${tfLabel(a.tf)})${a.level ? ' · now at ' + fmtPrice(a.level) : ''}`;
  return `${tfLabel(a.tf)} · ${describeRuleset(a.rs, a.tf)}${a.repeat ? ' · repeating' : ''}`;
}
function draw() {
  if (!listEl) return;
  clear(listEl);
  listEl.append(h('div', { class: 'row' }, h('h2', null, 'Active alerts'), h('span', { class: 'spacer' }), h('button', { onclick: () => tick() }, 'Check now')));
  if (!list.length) listEl.append(h('div', { class: 'hint' }, 'No alerts yet.'));
  for (const a of list) listEl.append(h('div', { class: 'list-item' },
    h('span', { class: 'pill ' + (a.active ? 'on' : a.firedAt ? 'hit' : '') }, a.active ? 'active' : a.firedAt ? 'triggered' : 'paused'),
    h('div', { class: 't' }, h('b', null, a.symbol), ' ', describe(a), h('small', null, a.error ? 'Error: ' + a.error : a.kind === 'rules' ? (a.state ? 'Rules are met on the latest bar' : 'Rules not met yet') : a.lastPx ? `Last ${fmtPrice(a.lastPx)} · waiting for a cross from ${a.side || '…'}${a.active && watch.has(a.id) ? ' · checked on every trade' : ''}` : 'Waiting for first check')),
    h('button', { onclick: () => api.openChart(a.symbol, a.tf) }, 'Chart'),
    h('button', { onclick: () => { a.active = !a.active; if (a.active) { a.side = null; a.lastT = null; a.firedAt = null; } persist(); if (a.active) tick(); } }, a.active ? 'Pause' : 'Re-arm'),
    h('button', { class: 'icon-btn', title: 'Delete', onclick: () => { list = list.filter((x) => x !== a); persist(); } }, '✕')));
  listEl.append(h('h2', { style: { marginTop: '18px' } }, 'Paper bots'));
  if (!bots.length) listEl.append(h('div', { class: 'hint' }, 'No bots deployed.'));
  for (const b of bots) {
    const L = b.last, intr = isIntraday(b.tf), open = L && L.trades.find((t) => t.open);
    listEl.append(h('div', { class: 'list-item' },
      h('span', { class: 'pill ' + (b.active ? 'on' : '') }, b.active ? 'running' : 'stopped'),
      h('div', { class: 't' }, h('b', null, b.name),
        h('small', null, b.error ? 'Error: ' + b.error : !L ? 'Waiting for first check' : `Since ${fmtStamp(b.deployedT, intr)} · ${L.trades.length} trade${L.trades.length === 1 ? '' : 's'} · net ${fmtPct(L.netPct)} · ${open ? `in a ${open.side} from ${fmtPrice(open.entryP)}` : 'flat'}`),
        h('small', null, `Enter: ${describeRuleset(b.cfg.entry, b.tf)} · Exit: ${describeRuleset(b.cfg.exit, b.tf)}`)),
      h('button', { onclick: () => (L && L.trades.length ? api.showTrades(b.symbol, b.tf, L.trades) : api.openChart(b.symbol, b.tf)) }, 'Chart'),
      h('button', { onclick: () => { b.active = !b.active; persist(); } }, b.active ? 'Stop' : 'Resume'),
      h('button', { class: 'icon-btn', title: 'Delete', onclick: () => { bots = bots.filter((x) => x !== b); persist(); } }, '✕')));
  }
  listEl.append(h('div', { class: 'row', style: { marginTop: '18px' } }, h('h2', null, 'Log'), h('span', { class: 'spacer' }), log.length ? h('button', { class: 'ghost', onclick: () => { log = []; persist(); } }, 'Clear') : null));
  if (!log.length) listEl.append(h('div', { class: 'hint' }, 'Nothing has triggered yet.'));
  for (const e of log.slice(0, 100)) listEl.append(h('div', { class: 'list-item', style: { cursor: 'pointer' }, onclick: () => api.openChart(e.symbol, e.tf) }, h('span', { class: 'muted' }, new Date(e.at).toLocaleString()), h('div', { class: 't' }, e.msg)));
}

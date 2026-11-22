// Live trades pushed from Hyperliquid over its WebSocket, so a chart that follows one of its markets
// moves with every trade instead of waiting for the next poll (5-15 s, plus the server's own 3 s
// proxy cache). Three kinds of chart follow one:
//   • a Hyperliquid market charted directly (XYZ:NVDA, XYZ100): the trade price itself;
//   • a delayed future with a live estimate (NQ=F, ES=F, ...): trade x the ratio the estimate uses;
//   • a stock outside regular hours whose newest value is an estimate: the same.
// The ratio comes from the server (or static.js on the shared page) and is re-anchored on every
// poll, so a tick only ever moves the newest value along the proxy, exactly as the next poll would.
// A tick changes the newest bar only while the clock is still inside it; a new bar arrives with the
// next poll, which stays the source of truth. Pure helpers first (tests import them), then the socket.

import { TF } from './data.js';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';

// 'XYZ:NVDA' -> 'xyz:NVDA' (as server.py hl_coin), else null.
export function hlCoin(symbol) {
  const s = String(symbol || '').trim();
  return s.slice(0, 4).toLowerCase() === 'xyz:' && s.length > 4 ? 'xyz:' + s.slice(4).toUpperCase() : null;
}

// What live market moves this series, and how: { coin, ratio, kind } or null.
export function follows(b) {
  if (!b || !b.t || !b.t.length) return null;
  const own = hlCoin(b.symbol);
  if (own && b.meta && b.meta.exchange === 'Hyperliquid') return { coin: own, ratio: 1, kind: 'native' };
  const lv = b.live;
  if (lv && lv.isEst && lv.src && lv.ratio > 0) return { coin: lv.src, ratio: lv.ratio, kind: lv.kind };
  return null;
}

// Apply one trade (price `px` at `atMs`, Unix ms) to series `b` in place. `nowWall` is the clock in
// the series' own time zone (bar times are wall-clock). Returns true if anything changed. A tick no
// newer than the poll that built the series is ignored.
// `candle` is the pushed 1-minute candle ({ t: start ms, o, h, l, c, v }) when there is one: a
// Hyperliquid chart opens its next bar from it instead of waiting for the poll (its bars are
// plain UTC on Hyperliquid's own grid; weekly and monthly bars are left to the poll).
export function applyTick(b, px, atMs, nowWall, candle = null) {
  const f = follows(b);
  if (!f || !(px > 0)) return false;
  const lv = b.live;
  if (lv && atMs / 1000 <= lv.asof) return false; // the poll already holds something as new
  if (!lv && b.meta && b.meta.asof && atMs / 1000 <= b.meta.asof) return false;
  const v = roundPx(px * f.ratio), n = b.t.length;
  if (f.kind === 'native') return nativeTick(b, v, nowWall, candle);
  let changed = false;
  // live is shared by every timeframe built from one series, so `asof` (when the poll built it)
  // stays as it was; the tick's own time goes in `tick`
  if (lv) { lv.price = v; lv.tick = Math.max(lv.tick || 0, Math.floor(atMs / 1000)); changed = true; }
  // Daily (and weekly, monthly) stock bars are the regular session: outside it only live.price
  // moves, drawn dotted. Otherwise the newest bar holds the newest estimate (follows() requires
  // one), so it moves while the clock is still inside it.
  const sec = TF[b.tf] ? TF[b.tf].sec : 0;
  if (!(f.kind === 'ext' && sec >= 86400) && sec && nowWall < b.t[n - 1] + sec) {
    b.c[n - 1] = v;
    if (v > b.h[n - 1]) b.h[n - 1] = v;
    if (v < b.l[n - 1]) b.l[n - 1] = v;
    changed = true;
  }
  return changed;
}

function nativeTick(b, v, nowUtc, candle) {
  const n = b.t.length, last = b.t[n - 1], sec = TF[b.tf] ? TF[b.tf].sec : 0;
  if (b.tf === '1m' && candle && candle.t >= 0) {
    const ct = Math.floor(candle.t / 1000), bar = [+candle.o, +candle.h, +candle.l, +candle.c, +candle.v || 0].map((x, i) => (i < 4 ? roundPx(x) : x));
    if (ct < last || !bar.slice(0, 4).every((x) => x > 0)) return false;
    if (ct > last) push(b, ct, ...bar);
    else { b.o[n - 1] = bar[0]; b.h[n - 1] = Math.max(bar[1], bar[3]); b.l[n - 1] = Math.min(bar[2], bar[3]); b.c[n - 1] = bar[3]; b.v[n - 1] = bar[4]; }
    return true;
  }
  if (!sec || sec >= 604800) return false;
  const bucket = Math.floor(nowUtc / sec) * sec;
  if (bucket > last) { push(b, bucket, v, v, v, v, 0); return true; }
  if (bucket < last) return false;
  b.c[n - 1] = v;
  if (v > b.h[n - 1]) b.h[n - 1] = v;
  if (v < b.l[n - 1]) b.l[n - 1] = v;
  return true;
}
function push(b, t, o, h, l, c, v) { b.t.push(t); b.o.push(o); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(v); }

function roundPx(x) {
  const a = Math.abs(x), d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return Number(x.toFixed(d));
}

// ── the socket ──
// One connection; `want(coins)` sets which markets to follow (subscribing and unsubscribing the
// difference). Each trade calls onTick(coin, price, timeMs, candle). Reconnects with backoff; pings so
// the server does not drop an idle line (it closes after 60 s of silence).
export class Stream {
  constructor(onTick, { url = WS_URL, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.onTick = onTick; this.url = url; this.WS = WebSocketImpl;
    this.wanted = new Set(); this.subbed = new Set(); this.last = new Map();
    this.ws = null; this.backoff = 1000; this.timer = null; this.ping = null; this.lastMsg = 0;
  }
  get connected() { return !!this.ws && this.ws.readyState === 1; }
  // Newest trade seen for a coin: { px, at } or undefined.
  latest(coin) { return this.last.get(coin); }
  want(coins) {
    this.wanted = new Set(coins);
    if (!this.WS) return;
    if (!this.wanted.size) return; // keep an open line; nothing new to ask for
    if (!this.ws) return this.open();
    if (this.connected) this.sync();
  }
  open() {
    clearTimeout(this.timer);
    let ws;
    try { ws = new this.WS(this.url); } catch { return this.retry(); }
    this.ws = ws; this.subbed = new Set();
    ws.onopen = () => {
      this.backoff = 1000; this.lastMsg = Date.now(); this.sync();
      clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (Date.now() - this.lastMsg > 75000) { try { ws.close(); } catch { /* reopened below */ } return; }
        try { ws.send(JSON.stringify({ method: 'ping' })); } catch { /* onclose handles it */ }
      }, 30000);
    };
    ws.onmessage = (e) => {
      this.lastMsg = Date.now();
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.channel !== 'candle' || !m.data) return;
      const c = m.data, px = Number(c.c), coin = c.s;
      if (!(px > 0) || !this.wanted.has(coin)) return;
      const at = Date.now(); // the push is the trade; the candle's own times are its bounds
      this.last.set(coin, { px, at, candle: c });
      this.onTick(coin, px, at, c);
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; clearInterval(this.ping); this.retry(); } };
    ws.onerror = () => { try { ws.close(); } catch { /* closed already */ } };
  }
  retry() {
    clearTimeout(this.timer);
    if (!this.wanted.size) return;
    this.timer = setTimeout(() => this.open(), this.backoff);
    this.backoff = Math.min(30000, this.backoff * 2);
  }
  sync() {
    const send = (method, coin) => { try { this.ws.send(JSON.stringify({ method, subscription: { type: 'candle', coin, interval: '1m' } })); } catch { /* reconnect resubscribes */ } };
    for (const c of this.wanted) if (!this.subbed.has(c)) { send('subscribe', c); this.subbed.add(c); }
    for (const c of [...this.subbed]) if (!this.wanted.has(c)) { send('unsubscribe', c); this.subbed.delete(c); this.last.delete(c); }
  }
}

// node tests/stream.mjs — live trades pushed from Hyperliquid (web/js/stream.js): which series
// follow which market, how a trade moves a series, and the socket's subscriptions and reconnects.
import { follows, applyTick, hlCoin, Stream } from '../web/js/stream.js';
import { check, done } from './fixture.mjs';

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
// A 5-minute series whose last two bars are estimates; times are wall clock.
const T0 = 1_800_000_000 - (1_800_000_000 % 300);
const series = (extra = {}) => ({
  symbol: 'NQ=F', tf: '5m', t: [T0 - 600, T0 - 300, T0], o: [100, 101, 102], h: [101, 102, 103], l: [99, 100, 101.5], c: [101, 102, 102.5], v: [9, 9, 0],
  meta: { tz: 'America/New_York', open: true }, live: { kind: 'fill', src: 'xyz:XYZ100', ratio: 0.5, isEst: true, asof: 1000, price: 102.5, est: [[T0 - 300, T0]], from: T0 - 300 }, ...extra,
});

check('hlCoin: only XYZ: names, upper-cased the way Hyperliquid lists them', hlCoin('XYZ:nvda') === 'xyz:NVDA' && hlCoin('xyz100') === null && hlCoin('XYZ:') === null && hlCoin('NVDA') === null);
check('follows: a live estimate follows its proxy at its ratio', JSON.stringify(follows(series())) === JSON.stringify({ coin: 'xyz:XYZ100', ratio: 0.5, kind: 'fill' }));
check('follows: a Hyperliquid market follows itself', JSON.stringify(follows({ ...series({ symbol: 'XYZ:NVDA', live: undefined }), meta: { exchange: 'Hyperliquid' } })) === JSON.stringify({ coin: 'xyz:NVDA', ratio: 1, kind: 'native' }));
check('follows: nothing for real prints, a missing ratio or no live at all',
  follows(series({ live: { kind: 'ext', src: null, isEst: false, asof: 1 } })) === null && follows(series({ live: { kind: 'fill', src: 'xyz:X', isEst: true, asof: 1 } })) === null &&
  follows(series({ live: undefined })) === null && follows(null) === null);

{
  const b = series(), ok = applyTick(b, 210, 2_000_000, T0 + 120);
  check('a trade moves the newest estimate: close = trade x ratio, high stretched, earlier bars untouched',
    ok && b.c[2] === 105 && b.h[2] === 105 && b.l[2] === 101.5 && b.c[1] === 102 && b.live.price === 105 && b.live.tick === 2000 && b.live.asof === 1000);
  applyTick(b, 200, 2_001_000, T0 + 130);
  check('a lower trade stretches the low', b.c[2] === 100 && b.l[2] === 100 && b.h[2] === 105);
}
{
  const b = series(), before = JSON.stringify(b);
  check('a trade no newer than the poll is ignored', applyTick(b, 210, 1_000_000, T0 + 120) === false && JSON.stringify(b) === before);
}
{
  const b = series(), ok = applyTick(b, 210, 2_000_000, T0 + 300);
  check('once the clock leaves the newest bar only the live price moves (the next poll adds the bar)', ok && b.c[2] === 102.5 && b.live.price === 105);
}
{
  const live = series().live, a = series({ live }), w = { ...series({ live }), tf: '1h', t: [T0 - 3600, T0], o: [1, 2], h: [3, 4], l: [0.5, 1], c: [2, 3], v: [0, 0] };
  applyTick(a, 210, 2_000_000, T0 + 60); const second = applyTick(w, 210, 2_000_000, T0 + 60);
  check('two timeframes sharing one live object both move (the poll time is not overwritten)', second && a.c[2] === 105 && w.c[1] === 105 && w.h[1] === 105);
}
{
  const ext = series({ symbol: 'NVDA', live: { kind: 'ext', src: 'xyz:NVDA', ratio: 2, isEst: true, asof: 1000, price: 1, base: 1, est: [] } });
  const day = { ...ext, tf: '1d', t: [T0 - 86400, T0 - 3600 * 9], o: [1, 2], h: [3, 4], l: [0.5, 1], c: [2, 3], v: [5, 5], live: { ...ext.live } };
  applyTick(ext, 60, 2_000_000, T0 + 60); applyTick(day, 60, 2_000_000, T0 + 60);
  check('outside regular hours: the intraday estimate moves; the daily bar (the session) does not, only its indicated price',
    ext.c[2] === 120 && day.c[1] === 3 && day.h[1] === 4 && day.live.price === 120);
}
{
  const nat = { symbol: 'XYZ:GOLD', tf: '1m', t: [T0], o: [10], h: [11], l: [9], c: [10.5], v: [3], meta: { exchange: 'Hyperliquid', tz: 'UTC', asof: 1000 }, fetched: 1000 };
  check('a Hyperliquid chart takes the trade price itself', applyTick(nat, 12.25, 2_000_000, T0 + 30) && nat.c[0] === 12.25 && nat.h[0] === 12.25);
  check('a bad price is ignored', applyTick(nat, 0, 2_100_000, T0 + 31) === false && applyTick(nat, NaN, 2_100_000, T0 + 31) === false && nat.c[0] === 12.25);
  const cdl = (t, o, h, l, c, v) => ({ t: t * 1000, o: String(o), h: String(h), l: String(l), c: String(c), v: String(v) });
  check('1-minute Hyperliquid chart: the pushed candle replaces the forming bar exactly',
    applyTick(nat, 11, 2_200_000, T0 + 40, cdl(T0, 10, 12.5, 8.5, 11, 7)) && nat.t.length === 1 && nat.o[0] === 10 && nat.h[0] === 12.5 && nat.l[0] === 8.5 && nat.c[0] === 11 && nat.v[0] === 7);
  check('... and a candle of the next minute opens a new bar at once',
    applyTick(nat, 11.5, 2_300_000, T0 + 61, cdl(T0 + 60, 11, 11.5, 11, 11.5, 1)) && nat.t.length === 2 && nat.t[1] === T0 + 60 && nat.c[1] === 11.5 && nat.v[1] === 1);
  check('... while a candle older than the newest bar is ignored', applyTick(nat, 9, 2_400_000, T0 + 62, cdl(T0, 9, 9, 9, 9, 1)) === false && nat.c[0] === 11 && nat.t.length === 2);
  const h1 = { symbol: 'XYZ:GOLD', tf: '1h', t: [T0 - (T0 % 3600)], o: [10], h: [11], l: [9], c: [10], v: [5], meta: { exchange: 'Hyperliquid', tz: 'UTC', asof: 1000 } };
  const next = h1.t[0] + 3600;
  check('hourly Hyperliquid chart: a trade inside the hour moves it; one past the hour opens the next on its UTC grid',
    applyTick(h1, 10.8, 2_000_000, h1.t[0] + 100) && h1.c[0] === 10.8 && applyTick(h1, 10.9, 2_100_000, next + 5) && h1.t.length === 2 && h1.t[1] === next && h1.o[1] === 10.9 && h1.v[1] === 0);
  const wk = { ...h1, tf: '1w', t: [0], o: [1], h: [1], l: [1], c: [1], v: [1] };
  check('weekly and monthly bars are left to the poll', applyTick(wk, 2, 2_000_000, 9e9) === false && wk.c[0] === 1);
}

// ── the socket, against a stand-in ──
{
  const made = [];
  class FakeWS { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; made.push(this); } send(m) { this.sent.push(JSON.parse(m)); } close() { this.readyState = 3; this.onclose && this.onclose(); } }
  const open = (ws) => { ws.readyState = 1; ws.onopen(); };
  const ticks = [];
  const s = new Stream((c, p, at) => ticks.push([c, p]), { WebSocketImpl: FakeWS });
  s.want(new Set(['xyz:XYZ100', 'xyz:GOLD']));
  check('one socket opens when something is wanted', made.length === 1 && made[0].url === 'wss://api.hyperliquid.xyz/ws');
  open(made[0]);
  const subs = (ws, m) => ws.sent.filter((x) => x.method === m).map((x) => x.subscription.coin).sort();
  check('each wanted market is subscribed once, as 1-minute candles', JSON.stringify(subs(made[0], 'subscribe')) === '["xyz:GOLD","xyz:XYZ100"]' && made[0].sent.every((x) => x.subscription.type === 'candle' && x.subscription.interval === '1m'));
  made[0].onmessage({ data: JSON.stringify({ channel: 'candle', data: { s: 'xyz:GOLD', c: '4100.5', t: 0 } }) });
  made[0].onmessage({ data: JSON.stringify({ channel: 'candle', data: { s: 'xyz:OTHER', c: '1' } }) });
  made[0].onmessage({ data: 'not json' });
  made[0].onmessage({ data: JSON.stringify({ channel: 'pong' }) });
  check('trades of wanted markets reach the page; others, pongs and junk do not', ticks.length === 1 && ticks[0][0] === 'xyz:GOLD' && ticks[0][1] === 4100.5 && s.latest('xyz:GOLD').px === 4100.5);
  s.want(new Set(['xyz:XYZ100', 'xyz:SP500']));
  check('changing what is wanted subscribes the new and drops the old (and its last trade)',
    JSON.stringify(subs(made[0], 'unsubscribe')) === '["xyz:GOLD"]' && subs(made[0], 'subscribe').includes('xyz:SP500') && !s.latest('xyz:GOLD'));
  const realSet = globalThis.setTimeout, waits = []; globalThis.setTimeout = (f, ms) => { waits.push(ms); return 0; };
  try { made[0].close(); s.retry(); } finally { globalThis.setTimeout = realSet; }
  check('a dropped line is retried with growing waits', waits.length >= 2 && waits[1] > waits[0] && !s.connected);
  s.open(); open(made[made.length - 1]);
  check('a new line subscribes everything wanted again', JSON.stringify(subs(made[made.length - 1], 'subscribe')) === '["xyz:SP500","xyz:XYZ100"]');
  clearInterval(s.ping);
}
done('stream');

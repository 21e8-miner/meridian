#!/usr/bin/env python3
"""
Meridian data server. Standard library only.

Serves the web app from ./web and proxies price history from Yahoo's public chart endpoint,
with a memory + disk cache. A failed fetch returns the last cached copy flagged `stale`, or an error.

Free exchange data for futures is ten minutes late everywhere. For the futures in LIVE_PROXY the
gap is filled with bars projected from a market that trades the same thing live around the clock
(a Hyperliquid perpetual), scaled to the last real exchange print. Those bars are estimates, are
always labelled as such (`live` in the response), and are replaced by exchange bars as they arrive.

Bar times are sent as exchange wall-clock seconds (the exchange's local time encoded as if it
were UTC), so the client can use UTC date math everywhere. Daily bars sit at local midnight.
"""
from __future__ import annotations

import calendar
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
# The disk cache lives in the user's cache folder, not next to the code: that folder may be synced
# (iCloud Documents) and the cache churns. macOS may also clear it when the disk runs low, which
# is fine: everything in it is fetched again on demand. MERIDIAN_CACHE moves it.
CACHE = os.path.join(os.environ.get("MERIDIAN_CACHE") or os.path.join(os.path.expanduser("~"), "Library", "Caches", "meridian"), "v4")
CACHE_MAX_BYTES = 512 * 1024 * 1024   # oldest files go first once the cache is bigger than this
CACHE_MAX_AGE = 14 * 86400            # a series not fetched again for this long is dropped
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8830"))
UA = "Mozilla/5.0"  # the provider rate-limits long browser-style agents
TIMEOUT = 12

# tf -> (yahoo interval, yahoo range)
TF = {
    "1m": ("1m", "7d"),
    "5m": ("5m", "60d"),
    "15m": ("15m", "60d"),
    "30m": ("30m", "60d"),
    "1h": ("60m", "730d"),
    "1d": ("1d", None),
    "x1m": ("1m", "5d"),  # internal: 1-minute bars including pre-market and after-hours prints
}
ET = ZoneInfo("America/New_York")
INTERVAL_SEC = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400, "x1m": 60}

HL_INFO = "https://api.hyperliquid.xyz/info"
# Delayed future -> the live Hyperliquid market that tracks it. Kept only where projecting the last
# ten minutes from the proxy beat showing the ten-minute-old price by 4x or more on a week of
# 1-minute bars (measured 2026-11-15; median / 90th-percentile error of the projection, in bp):
#   NQ 0.8 / 2.3   ES 0.6 / 1.6   gold 1.5 / 3.9   silver 1.7 / 4.6   crude 1.8 / 4.9   Brent 2.9 / 7.6
# Left out because the proxy did not help: YM, RTY, HG, NG, PL, PA, HO, 6E, NKD.
LIVE_PROXY = {
    "NQ=F": "xyz:XYZ100", "MNQ=F": "xyz:XYZ100",
    "ES=F": "xyz:SP500", "MES=F": "xyz:SP500",
    "GC=F": "xyz:GOLD", "SI=F": "xyz:SILVER",
    "CL=F": "xyz:CL", "BZ=F": "xyz:BRENTOIL",
}
# Stock or ETF -> the Hyperliquid perpetual on the same thing, used only outside regular hours and
# only to fill stretches with no exchange print (overnight, weekends, thin pre-markets). Kept where,
# against a week of real extended-hours prints (measured 2026-11-16), projecting 10 minutes ahead
# beat holding the last print by 40% or more, on a perp trading at least $1M a day (median 6.9 bp
# against 18.9 bp across the list). 56 other listed names failed and are left without estimates.
# Across long stretches, reading the estimate one minute BEFORE the next real print (15 names):
#   overnight 20:00 -> 04:00   median 9.5 bp, worst 42     (holding the last print: 75 bp, worst 314)
#   weekend, Fri 20:00 -> Mon  median 14 bp,  worst 27     (holding the last print: 55 bp, worst 612)
_STOCKS = ("NVDA SKHY SNDK SOXL MU SPCX DRAM AMD GOOGL CRCL AAPL EWY INTC NBIS KORU MSFT TSLA AMZN MSTR "
           "META COIN MRVL CRWV HOOD MRNA AVGO RKLB TSM IREN ORCL SMH DELL ASML").split()
STOCK_PROXY = {**{n: "xyz:" + n for n in _STOCKS},
               "SPY": "xyz:SP500", "QQQ": "xyz:XYZ100", "GLD": "xyz:GOLD", "IAU": "xyz:GOLD", "SLV": "xyz:SILVER", "USO": "xyz:CL"}
MAX_PROXY_MINUTES = 15000  # paged, 5000 candles a request; covers a long holiday weekend
STOCK_TYPES = ("EQUITY", "ETF")

_mem: dict[tuple[str, str], tuple[float, dict]] = {}
_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=8)


def _is_crypto(symbol: str) -> bool:
    return symbol.endswith("-USD") or symbol.endswith("-USDT")


def hl_coin(symbol: str) -> str | None:
    """'XYZ:XYZ100' (as the app upper-cases it) -> Hyperliquid's 'xyz:XYZ100'; None if not one."""
    s = symbol.strip()
    return "xyz:" + s[4:].upper() if s[:4].lower() == "xyz:" and len(s) > 4 else None


# The feed runs behind the exchange (about 10 minutes for futures), so each session is treated as
# open for a while after its close: the last bars are still arriving.
LAG_MIN = 20


def session_open(symbol: str, now: datetime | None = None, lag: int = LAG_MIN) -> bool:
    """Is this instrument's market trading (or, with lag, its delayed data still arriving)?"""
    if _is_crypto(symbol) or hl_coin(symbol):
        return True
    now = now or datetime.now(ET)
    wd, mins = now.weekday(), now.hour * 60 + now.minute  # Monday = 0
    if symbol.endswith("=F"):  # futures: Sunday 18:00 to Friday 17:00 ET, shut 17:00-18:00 daily
        if wd == 5:
            return False
        if wd == 6:
            return mins >= 18 * 60
        if wd == 4:
            return mins < 17 * 60 + lag
        return not (17 * 60 + lag <= mins < 18 * 60)
    if symbol.endswith("=X"):  # currencies: Sunday 17:00 to Friday 17:00 ET
        if wd == 5:
            return False
        if wd == 6:
            return mins >= 17 * 60
        if wd == 4:
            return mins < 17 * 60 + lag
        return True
    if wd >= 5:
        return False
    return (9 * 60 + 25 if lag else 9 * 60 + 30) <= mins <= 16 * 60 + lag


def extended_hours(now: datetime | None = None) -> bool:
    """US stocks print outside the regular session on weekdays from 04:00 to 20:00 ET."""
    now = now or datetime.now(ET)
    return now.weekday() < 5 and 4 * 60 <= now.hour * 60 + now.minute < 20 * 60


def _ttl(symbol: str, tf: str) -> float:
    if tf == "x1m":
        return 12.0 if extended_hours() else 600.0
    if session_open(symbol):
        return 60.0 if tf == "1d" else 12.0
    return 1800.0


def _http_json(url: str, payload: dict | None = None):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _round(x: float) -> float:
    ax = abs(x)
    if ax >= 100:
        return round(x, 3)
    if ax >= 1:
        return round(x, 4)
    return round(x, 8)


def _fetch_yahoo(symbol: str, tf: str, rng: str | None = None) -> dict:
    """`rng` asks for a shorter window than the timeframe's default (the snapshot build uses it)."""
    interval, default = TF[tf]
    rng = rng or default
    ext = tf == "x1m"
    if rng is None:
        qs = f"interval={interval}&period1=-631152000&period2={int(time.time()) + 86400}"
    else:
        qs = f"interval={interval}&range={rng}"
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol, safe="")
        + f"?{qs}&includePrePost={'true' if ext else 'false'}&events=div%2Csplits"
    )
    try:
        doc = _http_json(url)
    except urllib.error.HTTPError as e:
        try:
            doc = json.loads(e.read().decode("utf-8"))
        except Exception:
            raise RuntimeError(f"HTTP {e.code} from data provider")
    if ext:
        data = parse_chart(doc, symbol, "1m")
        data["tf"] = "x1m"
        return data
    try:
        return parse_chart(doc, symbol, tf)
    except RuntimeError as e:
        # recently listed symbols reject the full hourly window; ask for a little less
        if rng == "730d" and "730 days" in str(e):
            return parse_chart(_http_json(url.replace("range=730d", "range=1y")), symbol, tf)
        raise


def parse_chart(doc: dict, symbol: str, tf: str) -> dict:
    """Turn a provider chart document into Meridian bars. Pure; see tests/test_server.py."""
    interval_sec = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400}[tf]
    chart = doc.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description") or "provider error")
    res = (chart.get("result") or [None])[0]
    if not res or not res.get("timestamp"):
        raise RuntimeError("no data for symbol")
    meta = res.get("meta") or {}
    ind = res.get("indicators") or {}
    q = (ind.get("quote") or [{}])[0]
    ts = res["timestamp"]
    O, H, L, C, V = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
    if not (O and H and L and C):
        raise RuntimeError("no price columns for symbol")
    daily = tf == "1d"
    ADJ = ((ind.get("adjclose") or [{}])[0].get("adjclose")) if daily else None
    tzname = meta.get("exchangeTimezoneName") or "America/New_York"
    try:
        tz = ZoneInfo(tzname)
    except Exception:
        tz = ET
    has_volume = bool(V) and any(x for x in V if x)
    session_end = ((meta.get("currentTradingPeriod") or {}).get("regular") or {}).get("end")
    off_cache: dict[int, int] = {}
    t_out, o_out, h_out, l_out, c_out, v_out, a_out = [], [], [], [], [], [], []
    for i, t in enumerate(ts):
        o, h, l, c = O[i], H[i], L[i], C[i]
        if o is None or h is None or l is None or c is None or c <= 0:
            continue
        v = V[i] if V and V[i] is not None else 0
        adj = ADJ[i] if ADJ and i < len(ADJ) and ADJ[i] is not None and ADJ[i] > 0 else c
        if daily:
            # A futures trade date starts at 18:00 the evening before, and the provider stamps the
            # live session with the current time: Sunday 18:20 belongs to Monday's bar.
            d = datetime.fromtimestamp(t + (6 * 3600 if symbol.endswith("=F") else 0), tz).date()
            lt = calendar.timegm(d.timetuple())
        else:
            day = t // 86400
            off = off_cache.get(day)
            if off is None:
                off = int(datetime.fromtimestamp(t, tz).utcoffset().total_seconds())
                off_cache[day] = off
            lt = t + off
        # The provider's last intraday row is often not a bar but a snapshot of the latest price:
        #   - stamped inside the bar that is still forming  -> fold it into that bar
        #   - stamped off the grid in a bar that has no row yet (first tick of a new session)
        #                                                   -> it starts that bar
        #   - the closing price restated at the session end (16:00, zero volume, flat)
        #                                                   -> fold it into the final bar
        # A repeat of the same bar (the live session restated) is folded too.
        fold = False
        if t_out:
            if lt <= t_out[-1]:
                if lt < t_out[-1]:
                    continue
                fold = True
            elif not daily and i == len(ts) - 1:
                grid = t_out[-1] + ((lt - t_out[-1]) // interval_sec) * interval_sec
                flat = has_volume and v == 0 and o == h == l == c
                if grid == t_out[-1]:
                    fold = True
                elif flat and lt - t_out[-1] <= interval_sec and (session_end is None or t >= session_end):
                    fold = True  # the close restated one slot after the final bar
                else:
                    lt = grid
        if fold:
            h_out[-1] = max(h_out[-1], _round(h))
            l_out[-1] = min(l_out[-1], _round(l))
            c_out[-1] = _round(c)
            v_out[-1] = max(v_out[-1], int(v)) if lt == t_out[-1] else v_out[-1] + int(v)
            a_out[-1] = _round(adj)
            continue
        t_out.append(lt)
        o_out.append(_round(o))
        h_out.append(_round(max(h, o, c)))
        l_out.append(_round(min(l, o, c)))
        c_out.append(_round(c))
        v_out.append(int(v))
        a_out.append(_round(adj))
    if not t_out:
        raise RuntimeError("no usable bars for symbol")
    out = {
        "symbol": symbol,
        "tf": tf,
        "t": t_out,
        "o": o_out,
        "h": h_out,
        "l": l_out,
        "c": c_out,
        "v": v_out,
        "meta": {
            "name": meta.get("longName") or meta.get("shortName") or symbol,
            "currency": meta.get("currency") or "",
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
            "type": meta.get("instrumentType") or "",
            "tz": tzname,
            # when the provider last saw a trade (true UTC seconds): lets the app say how old the data is
            "asof": meta.get("regularMarketTime"),
        },
        "fetched": int(time.time()),
    }
    # Dividend-and-split adjusted close, daily only, and only when it differs from the close.
    if daily and ADJ and any(abs(a_out[i] - c_out[i]) > 1e-9 for i in range(len(c_out))):
        out["a"] = a_out
    return out


# ───────────────────────── Hyperliquid: live markets and the live fill ─────────────────────────
def _hl_candles(coin: str, interval: str, start_s: int, end_s: int) -> list:
    return _http_json(HL_INFO, {"type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": int(start_s) * 1000, "endTime": int(end_s) * 1000}}) or []


def parse_hl(candles: list, symbol: str, coin: str, tf: str, now: float | None = None) -> dict:
    """Hyperliquid candles -> Meridian bars. These markets never close, so times are plain UTC."""
    now = now or time.time()
    out = {k: [] for k in "tohlcv"}
    for c in candles:
        t = int(c["t"]) // 1000
        if out["t"] and t <= out["t"][-1]:
            continue
        o, h, l, cl = float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"])
        out["t"].append(t); out["o"].append(_round(o)); out["h"].append(_round(max(h, o, cl))); out["l"].append(_round(min(l, o, cl))); out["c"].append(_round(cl)); out["v"].append(float(c.get("v") or 0))
    if not out["t"]:
        raise RuntimeError("no data for symbol")
    forming = now - out["t"][-1] < INTERVAL_SEC[tf]
    return {
        "symbol": symbol, "tf": tf, **out,
        "meta": {"name": f"{coin.split(':')[1]} perpetual (Hyperliquid, live 24/7)", "currency": "USD", "exchange": "Hyperliquid", "type": "PERP", "tz": "UTC",
                 "asof": int(now) if forming else out["t"][-1] + INTERVAL_SEC[tf]},
        "fetched": int(now),
    }


def _fetch_hl(symbol: str, tf: str) -> dict:
    coin, now = hl_coin(symbol), int(time.time())
    return parse_hl(_hl_candles(coin, tf, now - 5000 * INTERVAL_SEC[tf], now), symbol, coin, tf, now)


_proxy_cache: dict[str, tuple[float, int, list]] = {}
_hl_names: tuple[float, list] = (0.0, [])


def proxy_minutes(coin: str, start_s: int) -> list:
    """1-minute candles of a live market from start_s to now as (utc, o, h, l, c).
    The history is kept and only its last few minutes are re-fetched (at most every 3 s)."""
    hit, now = _proxy_cache.get(coin), time.time()
    if hit and now - hit[0] < 3 and hit[1] <= start_s:
        return hit[2]
    row = lambda c: (int(c["t"]) // 1000, float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"]))
    if hit and hit[1] <= start_s and hit[2] and now - hit[2][-1][0] < 4000 * 60:
        fresh = [row(c) for c in _hl_candles(coin, "1m", hit[2][-1][0] - 180, int(now) + 60)]
        cut = fresh[0][0] if fresh else None
        rows = ([r for r in hit[2] if r[0] < cut] + fresh) if fresh else hit[2]
        first = hit[1]
    else:
        rows, cur, first = [], int(start_s), int(start_s)
        for _ in range(4):  # 5000 candles a request
            page = [row(c) for c in _hl_candles(coin, "1m", cur, int(now) + 60)]
            page = [r for r in page if not rows or r[0] > rows[-1][0]]
            rows += page
            if len(page) < 4900 or now - rows[-1][0] < 180:
                break
            cur = rows[-1][0]
    _proxy_cache[coin] = (now, first, rows)
    return rows


def _wall_fn(tzname: str | None):
    try:
        tz = ZoneInfo(tzname or "America/New_York")
    except Exception:
        tz = ET
    cache: dict[int, int] = {}

    def wall(utc: float) -> int:
        day = int(utc) // 86400
        off = cache.get(day)
        if off is None:
            off = int(datetime.fromtimestamp(utc, tz).utcoffset().total_seconds())
            cache[day] = off
        return int(utc) + off

    return wall


def live_anchor(data: dict, tf: str) -> tuple[int, int] | None:
    """(index of the last bar the exchange really traded, wall-clock time its close refers to)."""
    T, V = data["t"], data["v"]
    k = len(T) - 1
    while k >= 0 and not V[k]:
        k -= 1  # zero-volume rows after the last trade are the old price restated, not trades
    if k < 0:
        return None
    asof = data["meta"].get("asof")
    asof_w = _wall_fn(data["meta"].get("tz"))(asof) if asof else None
    if tf == "1d":
        session_close = T[k] + 17 * 3600  # the trade date settles at 17:00
        live = asof_w is not None and T[k] - 6 * 3600 <= asof_w < session_close
        return k, (asof_w if live else session_close)
    end = T[k] + INTERVAL_SEC[tf]
    return k, (min(end, asof_w) if asof_w is not None and asof_w > T[k] else end)


def anchor_from_1m(m1: dict) -> tuple[int, float] | None:
    """(wall-clock time, price) at the close of the last complete 1-minute bar the exchange traded.
    Every timeframe is scaled from this one print, so all of them show the same live price."""
    T, C, V = m1["t"], m1["c"], m1["v"]
    k = len(T) - 1
    while k >= 0 and not V[k]:
        k -= 1
    if k < 0:
        return None
    asof = m1["meta"].get("asof")
    asof_w = _wall_fn(m1["meta"].get("tz"))(asof) if asof else None
    if asof_w is not None and asof_w < T[k] + 60 and k > 0:
        k -= 1  # the newest bar is still forming; its close is not final
    return T[k] + 60, C[k]


def _merge_minutes(data: dict, k: int, mins: list, tf: str):
    """Fold 1-minute samples (wall, o, h, l, c, v, is_estimate) into `data` after bar k, on data's
    own bar grid. Returns (columns, partial, bars_added, runs) where runs lists the [first, last]
    start times of consecutive added bars made only of estimates."""
    interval, daily = INTERVAL_SEC[tf], tf == "1d"
    T, O, H, L, C, V = (list(data[x][: k + 1]) for x in "tohlcv")
    flags: list[bool] = []
    partial = False
    for (wt, o, h, l, c, v, est) in mins:
        o, h, l, c = (_round(x) for x in (o, h, l, c))
        b = ((wt + 6 * 3600) // 86400) * 86400 if daily else T[k] + ((wt - T[k]) // interval) * interval
        if b <= T[-1]:
            H[-1], L[-1], C[-1] = max(H[-1], h, c), min(L[-1], l, c), c
            V[-1] += v
            if len(T) - 1 == k:
                partial = True
            else:
                flags[-1] = flags[-1] and est
        else:
            T.append(b); O.append(o); H.append(max(h, o, c)); L.append(min(l, o, c)); C.append(c); V.append(v); flags.append(est)
    runs: list[list[int]] = []
    prev = -2
    for j, f in enumerate(flags):
        if not f:
            continue
        t = T[k + 1 + j]
        if runs and prev == j - 1:
            runs[-1][1] = t
        else:
            runs.append([t, t])
        prev = j
    return (T, O, H, L, C, V), partial, len(flags), runs


def splice_live(data: dict, minutes: list, symbol: str, tf: str, coin: str, now: float, anchor: tuple[int, float] | None = None) -> dict:
    """
    Fill the stretch the delayed exchange feed has not published yet with bars projected from a
    live market. `minutes` are that market's 1-minute candles (utc, o, h, l, c), oldest first.

    The projection is  exchange_price(anchor) x proxy(now) / proxy(anchor): the proxy supplies only
    the move since the last real print, so a standing price gap between the two cancels out.
    Pure function; returns `data` untouched when there is nothing to add.
    """
    found = live_anchor(data, tf)
    if not found or not minutes:
        return data
    k, own = found
    anchor, price = anchor if anchor else (own, data["c"][k])
    wall = _wall_fn(data["meta"].get("tz"))
    pm = [(wall(u), o, h, l, c, u) for (u, o, h, l, c) in minutes]
    i = -1
    for j, m in enumerate(pm):
        if m[0] <= anchor - 1:
            i = j
        else:
            break
    if i < 0 or anchor - 1 - pm[i][0] > 180 or not pm[i][4]:
        return data  # the proxy has no candle at the anchor: nothing to scale from
    ratio = price / pm[i][4]
    mins = [(wt, ratio * o, ratio * h, ratio * l, ratio * c, 0, True) for (wt, o, h, l, c, u) in pm[i + 1:]
            if session_open(symbol, datetime.fromtimestamp(u, ET), lag=0)]
    (T, O, H, L, C, V), partial, added, runs = _merge_minutes(data, k, mins, tf)
    if not partial and not added:
        return data
    out = dict(data)
    out.update({"t": T, "o": O, "h": H, "l": L, "c": C, "v": V})
    out.pop("a", None)
    out["live"] = {
        "kind": "fill", "src": coin, "from": T[k] if partial else T[k + 1], "partial": partial, "bars": added, "est": runs,
        "anchor": anchor, "anchorAge": int(wall(now) - anchor), "ratio": round(ratio, 6), "asof": int(now), "price": C[-1], "isEst": True,
    }
    return out


def stock_minutes(rth_end: int, rth_close: float, ext: list, proxy: list, now_wall: int, min_gap: int = 120):
    """
    The 1-minute path of a stock after its regular close, up to now.

    Where the exchange printed outside regular hours (`ext`: (wall, o, h, l, c, v)) that print is
    used as it is. Where it did not - overnight, weekends, a thin pre-market - the minute is
    projected from the live proxy (`proxy`: (wall, o, h, l, c)), scaled to the most recent real
    print before it, so each real print re-anchors the estimate. A minute is only estimated once
    `min_gap` seconds have passed without a print.
    Returns (minutes as (wall, o, h, l, c, v, is_estimate), end time of the last real print).
    """
    real = {r[0]: r for r in ext if r[0] >= rth_end}
    pmap = {r[0]: r for r in proxy}
    out, last_t, last_p, ratio = [], rth_end, rth_close, None
    m, end = rth_end, (int(now_wall) // 60) * 60
    while m <= end:
        r = real.get(m)
        if r:
            out.append((m, r[1], r[2], r[3], r[4], r[5], False))
            last_t, last_p, ratio = m + 60, r[4], None
        elif pmap and m - last_t >= min_gap - 60 and m in pmap:
            if ratio is None:
                ratio = False
                for back in (60, 120, 180):  # the proxy's close at the last real print
                    a = pmap.get(last_t - back)
                    if a and a[4]:
                        ratio = last_p / a[4]
                        break
            if ratio:
                p = pmap[m]
                out.append((m, ratio * p[1], ratio * p[2], ratio * p[3], ratio * p[4], 0, True))
        m += 60
    return out, last_t


def splice_ext(data: dict, ext: dict, proxy: list, tf: str, coin: str | None, now: float) -> dict:
    """
    A stock outside regular hours: continue the chart past the close with real extended-hours
    prints and, where there are none, estimates from the live proxy. Daily bars are left alone
    (a daily bar is the regular session); they only gain the indicated price in `live`.
    Pure; `ext` is the stock's 1-minute series including pre- and post-market, `proxy` the live
    market's candles as (utc, o, h, l, c), possibly empty.
    """
    T = data["t"]
    if not T:
        return data
    k, daily = len(T) - 1, tf == "1d"
    wall = _wall_fn(data["meta"].get("tz"))
    rth_end = T[k] + 16 * 3600 if daily else T[k] + INTERVAL_SEC[tf]
    rows = [r for r in zip(ext["t"], ext["o"], ext["h"], ext["l"], ext["c"], ext["v"]) if r[0] >= rth_end]
    mins, last_real = stock_minutes(rth_end, data["c"][k], rows, [(wall(u), o, h, l, c) for (u, o, h, l, c) in proxy], wall(now))
    if not mins:
        return data
    last_real = min(last_real, wall(now))  # a print in the minute still forming ends "now"
    live = {"kind": "ext", "src": coin if any(m[6] for m in mins) else None, "anchor": last_real, "anchorAge": int(wall(now) - last_real),
            "asof": int(now), "price": _round(mins[-1][4]), "base": data["c"][k], "isEst": bool(mins[-1][6]), "partial": False}
    out = dict(data)
    if daily:
        out["live"] = {**live, "from": None, "bars": 0, "est": []}
        return out
    (T2, O, H, L, C, V), _partial, added, runs = _merge_minutes(data, k, mins, tf)
    out.update({"t": T2, "o": O, "h": H, "l": L, "c": C, "v": V})
    out.pop("a", None)
    out["live"] = {**live, "from": T2[k + 1], "bars": added, "est": runs}
    return out


def add_live(data: dict) -> dict:
    """Bring a series as close to now as the free sources allow. Never raises.
    Futures with a proxy: the ten delayed minutes are projected. Stocks outside regular hours: real
    extended-hours prints, with gaps projected where the stock has a proxy."""
    symbol, tf = data["symbol"], data["tf"]
    try:
        now = time.time()
        wall = _wall_fn(data["meta"].get("tz"))
        to_utc = lambda w: int(w - (wall(now) - now))
        coin = LIVE_PROXY.get(symbol)
        if coin:
            if not session_open(symbol, lag=0):
                return data
            found = live_anchor(data, tf)
            if not found:
                return data
            anchor = None
            try:
                anchor = anchor_from_1m(data if tf == "1m" else get_bars(symbol, "1m"))
            except Exception:
                pass  # fall back to this timeframe's own last print
            start = to_utc(anchor[0] if anchor else found[1]) - 300
            if now - start > MAX_PROXY_MINUTES * 60:
                return data
            return splice_live(data, proxy_minutes(coin, start), symbol, tf, coin, now, anchor)
        if data["meta"].get("type") in STOCK_TYPES and tf in ("1m", "5m", "15m", "30m", "1h", "1d") and data["t"] and not session_open(symbol, lag=0):
            ext = get_bars(symbol, "x1m")
            coin, proxy = STOCK_PROXY.get(symbol), []
            if coin:
                start = to_utc(data["t"][-1] + (16 * 3600 if tf == "1d" else INTERVAL_SEC[tf])) - 300
                if now - start <= MAX_PROXY_MINUTES * 60:
                    try:
                        proxy = proxy_minutes(coin, start)
                    except Exception as e:
                        sys.stderr.write(f"proxy unavailable for {symbol}: {e}\n")
            return splice_ext(data, ext, proxy, tf, coin, now)
    except Exception as e:  # the exchange bars are still good; show them
        sys.stderr.write(f"live fill failed for {symbol}: {e}\n")
    return data


def hl_markets() -> list:
    """Names of Hyperliquid's listed markets (e.g. 'XYZ100'), cached for an hour, for search."""
    global _hl_names
    if time.time() - _hl_names[0] > 3600:
        try:
            meta = _http_json(HL_INFO, {"type": "meta", "dex": "xyz"})
            _hl_names = (time.time(), [u["name"].split(":")[1] for u in meta.get("universe", []) if not u.get("isDelisted")])
        except Exception:
            _hl_names = (time.time() - 3300, _hl_names[1])  # try again in five minutes
    return _hl_names[1]


def prune_cache(root: str = None, max_bytes: int = CACHE_MAX_BYTES, max_age: float = CACHE_MAX_AGE, now: float | None = None) -> tuple[int, int]:
    """Drop cached series nobody has fetched for `max_age` seconds, then the oldest until the cache
    fits in `max_bytes`. Returns (files removed, bytes freed)."""
    root = root or CACHE
    now = time.time() if now is None else now
    files = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            try:
                st = os.stat(p)
            except OSError:
                continue
            files.append((st.st_mtime, st.st_size, p))
    files.sort()
    total = sum(sz for _, sz, _ in files)
    removed = freed = 0
    for mt, sz, p in files:
        if now - mt <= max_age and total <= max_bytes:
            break  # sorted oldest first: everything after this is newer
        try:
            os.remove(p)
        except OSError:
            continue
        total -= sz
        removed += 1
        freed += sz
    return removed, freed


def _prune_forever():
    while True:
        try:
            n, b = prune_cache()
            if n:
                print(f"cache: removed {n} old files, {b / 1e6:.0f} MB", flush=True)
        except Exception as e:  # never take the server down over housekeeping
            print("cache prune failed:", e, flush=True)
        time.sleep(3600)


def _disk_path(symbol: str, tf: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-._=^" else "_" for ch in symbol)
    return os.path.join(CACHE, tf, safe + ".json")


def get_bars(symbol: str, tf: str) -> dict:
    if tf not in TF:
        raise RuntimeError(f"unknown timeframe {tf}")
    symbol = symbol.strip().upper()
    if not symbol or len(symbol) > 24:
        raise RuntimeError("bad symbol")
    fetch = _fetch_hl if hl_coin(symbol) else _fetch_yahoo
    key = (symbol, tf)
    ttl = _ttl(symbol, tf)
    now = time.time()
    hit = _mem.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        hit = _mem.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        path = _disk_path(symbol, tf)
        disk = None
        if not hit and os.path.exists(path):
            try:
                with open(path) as f:
                    disk = json.load(f)
                if time.time() - disk.get("fetched", 0) < ttl:
                    _mem[key] = (disk["fetched"], disk)
                    return disk
            except Exception:
                disk = None
        try:
            data = fetch(symbol, tf)
        except Exception as e:  # serve the last good copy rather than nothing
            old = hit[1] if hit else disk
            if old:
                stale = dict(old)
                stale["stale"] = True
                _mem[key] = (time.time() - ttl + 20, stale)  # retry in ~20 s
                return stale
            raise RuntimeError(str(e) or e.__class__.__name__)
        _mem[key] = (time.time(), data)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, path)
        except Exception:
            pass
        return data


def _trim(data: dict, limit: int, live: bool = True) -> dict:
    # every response is a copy: live fill applied (unless the caller wants exchange bars only),
    # stamped with whether the market is open right now
    out = dict(add_live(data) if live else data)
    data = out
    out["meta"] = {**data.get("meta", {}), "open": session_open(data["symbol"])}
    if limit <= 0 or len(data["t"]) <= limit:
        return out
    out = dict(out)
    for k in ("t", "o", "h", "l", "c", "v", "a"):
        if k in data:
            out[k] = data[k][-limit:]
    return out


def search(q: str) -> list[dict]:
    url = (
        "https://query2.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&q="
        + urllib.parse.quote(q)
    )
    out = []
    ql = q.strip().upper().replace("XYZ:", "")
    live = [n for n in hl_markets() if ql and (n.startswith(ql) or (len(ql) >= 3 and ql in n))][:4]
    live.sort(key=lambda n: (n != ql, len(n)))
    hl_rows = [{"symbol": "XYZ:" + n, "name": f"{n} perpetual · live 24/7", "type": "Perp", "exch": "Hyperliquid"} for n in live]
    try:
        doc = _http_json(url)
    except Exception:
        if hl_rows:
            return hl_rows
        raise
    for it in doc.get("quotes", []):
        if not it.get("symbol"):
            continue
        out.append(
            {
                "symbol": it["symbol"],
                "name": it.get("shortname") or it.get("longname") or "",
                "type": it.get("typeDisp") or it.get("quoteType") or "",
                "exch": it.get("exchDisp") or it.get("exchange") or "",
            }
        )
    # an exact name match on a live market goes first; partial matches follow the listed symbols
    exact = [r for r in hl_rows if r["symbol"] == "XYZ:" + ql]
    return exact + out[:8] + [r for r in hl_rows if r not in exact]


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in str(args[0] if args else ""):  # args[0] is an HTTPStatus on error replies
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith("/api/"):
            return super().do_GET()
        qs = urllib.parse.parse_qs(u.query)
        g = lambda k, d="": (qs.get(k) or [d])[0]
        try:
            if u.path == "/api/bars":
                if g("tf", "1d") == "x1m":
                    raise RuntimeError("unknown timeframe x1m")
                data = get_bars(g("symbol"), g("tf", "1d"))
                return self._json(_trim(data, int(g("limit", "0") or 0), g("live", "1") != "0"))
            if u.path == "/api/batch":
                syms = [s.strip().upper() for s in g("symbols").split(",") if s.strip()][:150]
                tf = g("tf", "1d")
                if tf == "x1m":
                    raise RuntimeError("unknown timeframe x1m")
                limit = int(g("limit", "0") or 0)
                live = g("live", "0") == "1"  # scans read exchange bars; the watchlist asks for live

                def one(s):
                    try:
                        return s, _trim(get_bars(s, tf), limit, live), None
                    except Exception as e:
                        return s, None, str(e)

                bars, errors = {}, {}
                for s, d, err in _pool.map(one, syms):
                    if d is not None:
                        bars[s] = d
                    else:
                        errors[s] = err
                return self._json({"bars": bars, "errors": errors})
            if u.path == "/api/search":
                q = g("q").strip()
                return self._json({"results": search(q) if q else []})
            if u.path == "/api/health":
                return self._json({"ok": True, "cached": len(_mem)})
            return self._json({"error": "not found"}, 404)
        except Exception as e:
            return self._json({"error": str(e) or e.__class__.__name__}, 502)


def main():
    os.makedirs(CACHE, exist_ok=True)
    threading.Thread(target=_prune_forever, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"Meridian on http://127.0.0.1:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

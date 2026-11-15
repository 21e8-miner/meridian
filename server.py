#!/usr/bin/env python3
"""
Meridian data server. Standard library only.

Serves the web app from ./web and proxies price history from Yahoo's public chart endpoint,
with a memory + disk cache. Never fabricates prices: a failed fetch returns the last cached
copy flagged `stale`, or an error.

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
CACHE = os.path.join(ROOT, ".cache")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8830"))
UA = "Mozilla/5.0"  # the provider rate-limits long browser-style agents
TIMEOUT = 12

# tf -> (yahoo interval, yahoo range)
TF = {
    "5m": ("5m", "60d"),
    "15m": ("15m", "60d"),
    "30m": ("30m", "60d"),
    "1h": ("60m", "730d"),
    "1d": ("1d", None),
}
ET = ZoneInfo("America/New_York")

_mem: dict[tuple[str, str], tuple[float, dict]] = {}
_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=8)


def _is_crypto(symbol: str) -> bool:
    return symbol.endswith("-USD") or symbol.endswith("-USDT")


def _market_open(symbol: str) -> bool:
    if _is_crypto(symbol):
        return True
    now = datetime.now(ET)
    if now.weekday() >= 5:
        return False
    mins = now.hour * 60 + now.minute
    return 9 * 60 + 25 <= mins <= 16 * 60 + 10


def _ttl(symbol: str, tf: str) -> float:
    if _market_open(symbol):
        return 60.0
    return 1800.0


def _http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def _round(x: float) -> float:
    ax = abs(x)
    if ax >= 100:
        return round(x, 3)
    if ax >= 1:
        return round(x, 4)
    return round(x, 8)


def _fetch_yahoo(symbol: str, tf: str) -> dict:
    interval, rng = TF[tf]
    if rng is None:
        qs = f"interval={interval}&period1=-631152000&period2={int(time.time()) + 86400}"
    else:
        qs = f"interval={interval}&range={rng}"
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol, safe="")
        + f"?{qs}&includePrePost=false&events=div%2Csplits"
    )
    try:
        doc = _http_json(url)
    except urllib.error.HTTPError as e:
        try:
            doc = json.loads(e.read().decode("utf-8"))
        except Exception:
            raise RuntimeError(f"HTTP {e.code} from data provider")
    chart = doc.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(chart["error"].get("description") or "provider error")
    res = (chart.get("result") or [None])[0]
    if not res or not res.get("timestamp"):
        raise RuntimeError("no data for symbol")
    meta = res.get("meta") or {}
    q = (res.get("indicators") or {}).get("quote", [{}])[0]
    ts = res["timestamp"]
    O, H, L, C, V = q.get("open"), q.get("high"), q.get("low"), q.get("close"), q.get("volume")
    tzname = meta.get("exchangeTimezoneName") or "America/New_York"
    try:
        tz = ZoneInfo(tzname)
    except Exception:
        tz = ET
    daily = tf == "1d"
    off_cache: dict[int, int] = {}
    t_out, o_out, h_out, l_out, c_out, v_out = [], [], [], [], [], []
    for i, t in enumerate(ts):
        o, h, l, c = O[i], H[i], L[i], C[i]
        if o is None or h is None or l is None or c is None:
            continue
        v = V[i] if V and V[i] is not None else 0
        if daily:
            d = datetime.fromtimestamp(t, tz).date()
            lt = calendar.timegm(d.timetuple())
        else:
            day = t // 86400
            off = off_cache.get(day)
            if off is None:
                off = int(datetime.fromtimestamp(t, tz).utcoffset().total_seconds())
                off_cache[day] = off
            lt = t + off
        if t_out and lt <= t_out[-1]:
            if lt == t_out[-1]:
                # the provider sometimes repeats the live session as a second row: merge it
                h_out[-1] = max(h_out[-1], _round(h))
                l_out[-1] = min(l_out[-1], _round(l))
                c_out[-1] = _round(c)
                v_out[-1] = max(v_out[-1], int(v))
            continue
        t_out.append(lt)
        o_out.append(_round(o))
        h_out.append(_round(max(h, o, c)))
        l_out.append(_round(min(l, o, c)))
        c_out.append(_round(c))
        v_out.append(int(v))
    if not t_out:
        raise RuntimeError("no usable bars for symbol")
    return {
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
        },
        "fetched": int(time.time()),
    }


def _disk_path(symbol: str, tf: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-._=^" else "_" for ch in symbol)
    return os.path.join(CACHE, tf, safe + ".json")


def get_bars(symbol: str, tf: str) -> dict:
    if tf not in TF:
        raise RuntimeError(f"unknown timeframe {tf}")
    symbol = symbol.strip().upper()
    if not symbol or len(symbol) > 24:
        raise RuntimeError("bad symbol")
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
            data = _fetch_yahoo(symbol, tf)
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


def _trim(data: dict, limit: int) -> dict:
    if limit <= 0 or len(data["t"]) <= limit:
        return data
    out = dict(data)
    for k in ("t", "o", "h", "l", "c", "v"):
        out[k] = data[k][-limit:]
    return out


def search(q: str) -> list[dict]:
    url = (
        "https://query2.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&q="
        + urllib.parse.quote(q)
    )
    doc = _http_json(url)
    out = []
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
    return out


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
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
                data = get_bars(g("symbol"), g("tf", "1d"))
                return self._json(_trim(data, int(g("limit", "0") or 0)))
            if u.path == "/api/batch":
                syms = [s.strip().upper() for s in g("symbols").split(",") if s.strip()][:150]
                tf = g("tf", "1d")
                limit = int(g("limit", "0") or 0)

                def one(s):
                    try:
                        return s, _trim(get_bars(s, tf), limit), None
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
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"Meridian on http://127.0.0.1:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

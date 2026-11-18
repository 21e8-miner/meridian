#!/usr/bin/env python3
"""
Build the shareable static site: a copy of web/ plus a snapshot of exchange history.

A static page has no server to fetch prices for it, and the price feed cannot be read from a
browser. So a scheduled job runs this script: it writes each symbol's recent bars to
<out>/data/<tf>/<symbol>.json, and the page brings them up to the second on its own by projecting
from Hyperliquid, which a browser can read (see web/js/static.js).

Two tiers, so the data set can be wide without hammering the provider:

  core      every timeframe (1m, 5m, 1h, daily), fetched fresh on every build. Everything with a
            live proxy, plus the main futures, ETFs, indexes, currencies, crypto and mega caps.
  extended  daily and hourly history for the S&P 500, other followed stocks and a list of funds
            (web/universe.json). A build
            refreshes only the series that are due, oldest first, up to a fixed number of requests,
            and carries the others over from the previous build: a local copy of it (--prev, what
            the scheduled job uses: it downloads the last published build) or, failing that, the
            published site itself (--site). So each series is refreshed about twice an hour while
            the market is open, once after the close, and not at all overnight, at the weekend or
            on a holiday, when it cannot change.
  broad     daily history only, for the other US stocks over $2B (web/universe.json "broad").
            Refreshed the same way, about once an hour while the market is open. A refresh asks for
            the last month only and joins it onto the carried history, unless that history no longer
            matches (a split or a dividend restates it), in which case the whole series is fetched.

    python3 tools/snapshot.py _site                          # full build
    python3 tools/snapshot.py _site NQ=F SPY --ext=KO,PEP --broad=AAL,ACM   # just these (for testing)
    python3 tools/snapshot.py _site --prev=prev --site=https://example.github.io/meridian/
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_argv, sys.argv = sys.argv, ["server.py"]
import server  # noqa: E402

sys.argv = _argv

with open(os.path.join(ROOT, "web", "universe.json")) as _f:
    UNIVERSE = json.load(_f)

# ── what gets published ──
CORE = sorted(set(
    list(server.LIVE_PROXY) + list(server.STOCK_PROXY)
    + "YM=F RTY=F HG=F NG=F ZN=F ZB=F 6E=F".split()
    + "^GSPC ^NDX ^DJI ^RUT ^VIX ^TNX".split()
    + "EURUSD=X USDJPY=X GBPUSD=X AUDUSD=X USDCAD=X".split()
    + "BTC-USD ETH-USD SOL-USD XRP-USD DOGE-USD BNB-USD ADA-USD LINK-USD".split()
    + "IWM DIA TLT IEF HYG LQD UUP VXX XLK XLF XLE XLV XLI XLY XLP XLU XLB XLRE XLC SMH XBI KRE ARKK GDX EEM EFA".split()
    + ("AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM MA COST HD PG JNJ WMT NFLX ABBV BAC CRM "
       "ORCL KO CVX MRK AMD PEP PLTR ADBE QCOM IBM BA DIS").split()
    + "ZC=F ZS=F ZW=F KC=F SB=F CC=F LE=F HE=F PL=F PA=F HO=F RB=F 6J=F 6B=F 6A=F 6C=F BTC=F ETH=F".split()
    + "^IXIC ^SOX ^NYA ^N225 ^FTSE ^GDAXI ^HSI ^STOXX50E ^FCHI ^KS11 ^BSESN ^GSPTSE ^AXJO ^TYX ^FVX ^IRX ^VVIX ^MOVE DX-Y.NYB".split()
    + "USDCHF=X NZDUSD=X EURJPY=X GBPJPY=X EURGBP=X USDCNH=X USDMXN=X USDINR=X USDKRW=X".split()
    + "AVAX-USD DOT-USD LTC-USD BCH-USD TRX-USD XLM-USD SHIB-USD HBAR-USD NEAR-USD AAVE-USD UNI7083-USD SUI20947-USD".split()
))
EXTENDED = sorted((set(UNIVERSE["stocks"]) | set(UNIVERSE.get("etfs") or [])) - set(CORE))
BROAD = sorted(set(UNIVERSE.get("broad") or {}) - set(CORE) - set(EXTENDED))
SECTOR_OF = {**{k: v for k, v in (UNIVERSE.get("broad") or {}).items() if v >= 0}, **UNIVERSE["stocks"]}
SP500 = set(UNIVERSE.get("sp500") or [])

# timeframe -> how many of the most recent bars to keep (15m and 30m are built from 5m in the page)
KEEP = {"1m": 1500, "5m": 3200, "1h": 3000, "1d": 2520}
CORE_RANGE = {"1d": "10y"}  # ask for what is kept, not the provider's default window
EXT_KEEP = {"1d": 2520, "1h": 1500}
EXT_RANGE = {"1d": "10y", "1h": "1y"}
# how old an extended series may get while the stock market is open, in seconds
EXT_TARGET = {"1d": 30 * 60, "1h": 60 * 60}
EXT_BUDGET = 240       # extended refreshes per build, beyond series the site does not have at all
BROAD_KEEP = {"1d": 2520}
BROAD_TARGET = {"1d": 60 * 60}
BROAD_BUDGET = 400     # broad refreshes per build (each is a small request: a month of bars)
FULL_EVERY = 7 * 86400  # a joined-up series is fetched whole again after this long, whatever it looks like
SETTLE = 30 * 60       # a day's last bars are final this long after the close
DEADLINE = 330         # seconds into the build after which no new extended refresh starts
THROTTLE_STOP = 12     # "too many requests" answers after which extended refreshes stop
RETRY_DEAD = 6 * 3600  # a symbol the provider has no data for is asked about again this much later
PACK_DAYS = 375        # daily closes kept per symbol in the market summary (a year, plus slack)
COLS = ("t", "o", "h", "l", "c", "v", "a")


TIER: dict[str, tuple] = {}  # symbol -> (tier, what to keep), for the extended and broad symbols of this build


def safe(symbol: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-._" else "_" for ch in symbol)


# ───────────────────────── when is an extended series due? (pure) ─────────────────────────
def stock_session(now: float) -> bool:
    """Regular US stock hours, plus the settling time after the close."""
    d = datetime.fromtimestamp(now, server.ET)
    mins = d.hour * 60 + d.minute
    return d.weekday() < 5 and 9 * 60 + 30 <= mins < 16 * 60 + SETTLE // 60


def last_close(now: float) -> float:
    """The most recent weekday 16:00 New York time at or before `now`, as UTC seconds."""
    d = datetime.fromtimestamp(now, server.ET)
    c = d.replace(hour=16, minute=0, second=0, microsecond=0)
    if c > d:
        c -= timedelta(days=1)
    while c.weekday() >= 5:
        c -= timedelta(days=1)
    # rebuild from the calendar date so a daylight-saving change in between cannot shift the hour
    return datetime(c.year, c.month, c.day, 16, 0, tzinfo=server.ET).timestamp()


def due_score(stamp: float | None, tf: str, now: float, trading: bool, closed: float | None = None, targets: dict | None = None) -> float:
    """How overdue a series is: >= 1 means refresh it, larger means sooner. `trading` says the
    stock market is in session right now (false on holidays, whatever the clock says); `closed`
    is when its last session ended (by the calendar if not given: a holiday needs it given)."""
    if not stamp:
        return float("inf")
    if stamp < 0:  # the provider had nothing for it at -stamp: leave it alone for a while
        return float("inf") if now + stamp > RETRY_DEAD else -1.0
    if trading:
        return (now - stamp) / (targets or EXT_TARGET)[tf]
    # market shut: only a copy taken before the last session's bars were final still needs a fetch
    return 1.0 + (now - stamp) / 86400 if stamp < (last_close(now) if closed is None else closed) + SETTLE else 0.0


def plan_refresh(state: dict, keys: list, now: float, budget: int, trading: bool, closed: float | None = None, targets: dict | None = None):
    """Split extended series into (refresh from the provider, carry over from the previous build).
    Series the site lacks always refresh; the rest by how overdue they are, up to `budget`.
    Series the provider recently had nothing for are in neither list."""
    scored = [(due_score(state.get(f"{s}|{tf}"), tf, now, trading, closed, targets), s, tf) for s, tf in keys]
    missing = [(s, tf) for sc, s, tf in scored if sc == float("inf")]
    late = sorted((x for x in scored if 1.0 <= x[0] < float("inf")), key=lambda x: -x[0])
    due = missing + [(s, tf) for _, s, tf in late[:max(0, budget)]]
    chosen = set(due)
    dead = {(s, tf) for sc, s, tf in scored if sc < 0}
    return due, [k for k in keys if k not in chosen and k not in dead]


def join_daily(old: dict, new: dict) -> dict | None:
    """Carried daily history + a recent window of fresh bars -> one series, or None when they do not
    agree on the days both have (a split or a dividend has restated the history since: fetch it
    whole). Compared: the close and the dividend adjustment (adjusted / close) on every shared day
    but each side's newest, which may still have been forming. At least three such days are needed."""
    if not old.get("t") or not new.get("t"):
        return None
    at = {t: i for i, t in enumerate(old["t"])}
    adj = lambda d, i: (d["a"][i] if d.get("a") else d["c"][i]) / d["c"][i]
    shared = 0
    for j, t in enumerate(new["t"][:-1]):
        i = at.get(t)
        if i is None or i == len(old["t"]) - 1:
            continue
        a, b = old["c"][i], new["c"][j]
        if abs(a - b) > 1e-6 * max(1.0, abs(b)) or abs(adj(old, i) - adj(new, j)) > 1e-6:
            return None
        shared += 1
    if shared < 3:
        return None
    k = 0
    while k < len(old["t"]) and old["t"][k] < new["t"][0]:
        k += 1
    out = {key: val for key, val in new.items() if key not in COLS}
    for col in "tohlcv":
        out[col] = old[col][:k] + new[col]
    a = [old["a"][i] if old.get("a") else old["c"][i] for i in range(k)] + [new["a"][j] if new.get("a") else new["c"][j] for j in range(len(new["t"]))]
    if any(abs(x - y) > 1e-9 for x, y in zip(a, out["c"])):
        out["a"] = a
    out["full"] = old.get("full") or old.get("fetched", 0)  # when the history was last fetched whole
    return out


# ───────────────────────── market summary (pure) ─────────────────────────
def pack_row(d: dict) -> dict:
    """The last year of a daily series, small enough to ship for every symbol at once: dates as day
    numbers (first, then gaps), closes, and the average value traded a day over the 20 bars before
    the newest one. web/js/markets.js reads this (and builds the same thing from bars when a
    server is present: see packFromBars there).

    Value traded is price x shares for stocks and ETFs. Crypto volume already comes in dollars.
    For indexes, futures and currencies the feed's volume cannot be turned into dollars (no
    contract multiplier, constituent shares, or none at all), so there is no figure: 0."""
    t, c, v = d["t"], d["c"], d["v"]
    kind = (d.get("meta") or {}).get("type")
    n = len(t)
    k = n - 1
    while k > 0 and t[k - 1] >= t[-1] - PACK_DAYS * 86400:
        k -= 1
    days = [x // 86400 for x in t[k:]]
    lo = max(0, n - 21)
    per = (lambda i: c[i] * v[i]) if kind in server.STOCK_TYPES else (lambda i: v[i]) if kind == "CRYPTOCURRENCY" else (lambda i: 0)
    dv = sum(per(i) for i in range(lo, n - 1)) / max(1, n - 1 - lo)
    return {"d0": days[0], "dd": [days[i] - days[i - 1] for i in range(1, len(days))], "c": c[k:], "dv": int(dv + 0.5), "f": d.get("fetched", 0)}


# ───────────────────────── fetching ─────────────────────────
class Unreachable(Exception):
    """The previous build could not be read. Not the same as it not having the file."""


GONE = ("No data found", "delisted", "no data for symbol", "Not Found")  # the provider saying a symbol does not exist


class Build:
    def __init__(self, out: str, site: str | None, budget: int, prev: str | None = None):
        self.out, self.site, self.budget, self.prev = out, site, budget, prev
        self.t0 = time.time()
        self.lock = threading.Lock()
        self.throttled = 0
        self.info: dict[str, dict] = {}   # symbol -> catalog entry
        self.state: dict[str, int] = {}   # "SYM|tf" -> when that extended series was fetched
        self.pack: dict[str, dict] = {}
        self.notes: list[str] = []
        self.joined = 0                   # daily refreshes done by joining a month onto the carried history

    def path(self, tf: str, symbol: str) -> str:
        return os.path.join(self.out, "data", tf, safe(symbol) + ".json")

    def yahoo(self, symbol: str, tf: str, rng: str | None = None, tries: int = 4) -> dict:
        for k in range(tries):
            try:
                return server._fetch_yahoo(symbol, tf, rng)
            except Exception as e:
                msg = str(e)
                if "429" in msg:
                    with self.lock:
                        self.throttled += 1
                if ("429" in msg or "timed out" in msg) and k < tries - 1:
                    time.sleep(6 * (k + 1))
                    continue
                raise

    def previous(self, rel: str):
        """A JSON file of the previous build (path under data/): from the local copy of that build
        when there is one, else from the published site. None if that build has no such file;
        raises Unreachable if it could not be read, which must never be mistaken for "not there"."""
        if self.prev:
            path = os.path.join(self.prev, "data", rel)
            if not os.path.exists(path):
                return None
            try:
                with open(path) as f:
                    return json.load(f)
            except Exception as e:
                raise Unreachable(f"{rel}: {e}")
        if not self.site:
            return None
        url = f"{self.site}data/{urllib.parse.quote(rel)}?b={int(self.t0)}"
        err = None
        for k in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": server.UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    return json.loads(r.read().decode("utf-8"))
            except Exception as e:
                if getattr(e, "code", None) == 404:
                    return None
                err = e
                time.sleep(1 + 2 * k)
        raise Unreachable(f"{rel}: {err}")

    def previous_series(self, tf: str, symbol: str) -> dict | None:
        d = self.previous(f"{tf}/{safe(symbol)}.json")
        if d and d.get("symbol") == symbol and d.get("t") and len(d["t"]) == len(d.get("c") or []) and d.get("meta"):
            return d
        return None

    def write(self, d: dict, tier: int, keep: int, fresh: bool):
        symbol, tf = d["symbol"], d["tf"]
        for col in COLS:
            if col in d:
                d[col] = d[col][-keep:]
        d.pop("stale", None)
        with open(self.path(tf, symbol), "w") as f:
            json.dump(d, f, separators=(",", ":"))
        meta = d["meta"]
        with self.lock:
            e = self.info.setdefault(symbol, {"symbol": symbol, "name": meta.get("name") or symbol, "type": meta.get("type") or "", "exch": meta.get("exchange") or "", "tier": tier, "tfs": []})
            e["tfs"].append(tf)
            if symbol in SECTOR_OF:
                e["sector"] = SECTOR_OF[symbol]
            if symbol in SP500:
                e["sp"] = 1
            if tier >= 2:
                self.state[f"{symbol}|{tf}"] = d.get("fetched", 0)
            if tf == "1d":
                self.pack[symbol] = pack_row(d)

    # one core series: always fresh; if the provider fails, keep what is published
    def core(self, job):
        symbol, tf = job
        try:
            d = self.yahoo(symbol, tf, CORE_RANGE.get(tf))
            if tf == "1m" and d["meta"].get("type") in server.STOCK_TYPES:
                try:
                    self.ext_prints(symbol, d["t"][-1])
                except Exception as e:
                    self.notes.append(f"no extended-hours prints for {symbol}: {e}")
            self.write(d, 1, KEEP[tf], True)
            return symbol, tf, "fresh"
        except Exception as e:
            try:
                old = self.previous_series(tf, symbol)
                if old and tf == "1m" and old["meta"].get("type") in server.STOCK_TYPES:
                    ext = self.previous_series("x1m", symbol)  # its extended-hours prints go with it
                    if ext:
                        with open(self.path("x1m", symbol), "w") as f:
                            json.dump(ext, f, separators=(",", ":"))
                        with self.lock:
                            self.info.setdefault(symbol, {"symbol": symbol, "name": old["meta"].get("name") or symbol, "type": old["meta"].get("type") or "", "exch": old["meta"].get("exchange") or "", "tier": 1, "tfs": []})["tfs"].append("x1m")
            except Unreachable:
                old = None
            if old:
                self.write(old, 1, KEEP[tf], False)
                return symbol, tf, f"kept the published copy ({e})"
            return symbol, tf, f"failed: {str(e) or e.__class__.__name__}"

    def ext_prints(self, symbol: str, after: int):
        """Pre-market and after-hours prints since the last regular bar, for stocks. Small: only
        the stretch the page has to continue past the close."""
        d = self.yahoo(symbol, "x1m")
        rows = [i for i, t in enumerate(d["t"]) if t > after]
        slim = {"symbol": symbol, "tf": "x1m", **{col: [d[col][i] for i in rows] for col in "tohlcv"}, "meta": d["meta"], "fetched": d.get("fetched", 0)}
        with open(self.path("x1m", symbol), "w") as f:
            json.dump(slim, f, separators=(",", ":"))
        with self.lock:
            self.info.setdefault(symbol, {"symbol": symbol, "name": d["meta"].get("name") or symbol, "type": d["meta"].get("type") or "", "exch": d["meta"].get("exchange") or "", "tier": 1, "tfs": []})["tfs"].append("x1m")

    # one extended series from the provider. None: put off (out of time, or the provider is
    # throttling). "gone: ...": the provider says there is no such symbol. "error: ...": anything
    # else, which is taken to be passing. Whatever is not fresh is carried from the previous build.
    def refresh(self, job):
        symbol, tf = job
        if time.time() - self.t0 > DEADLINE or self.throttled >= THROTTLE_STOP:
            return symbol, tf, None
        tier, keep = TIER.get(symbol, (2, EXT_KEEP))
        try:
            if tf == "1d":
                # daily: a month of fresh bars joined onto the carried history, when they agree
                try:
                    old = self.previous_series("1d", symbol)
                except Unreachable:
                    old = None
                if old and time.time() - (old.get("full") or old.get("fetched") or 0) < FULL_EVERY:
                    joined = join_daily(old, self.yahoo(symbol, "1d", "1mo", tries=2))
                    if joined:
                        self.write(joined, tier, keep[tf], True)
                        with self.lock:
                            self.joined += 1
                        return symbol, tf, "fresh"
            d = self.yahoo(symbol, tf, EXT_RANGE[tf], tries=2)
            d["full"] = d.get("fetched", 0)
            self.write(d, tier, keep[tf], True)
            return symbol, tf, "fresh"
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            if "429" in msg or "timed out" in msg:
                return symbol, tf, None
            return symbol, tf, ("gone: " if any(g in msg for g in GONE) else "error: ") + msg

    def carry(self, job):
        symbol, tf = job
        try:
            d = self.previous_series(tf, symbol)
        except Unreachable as e:
            return symbol, tf, f"unreachable: {e}"
        if not d:
            return symbol, tf, "not in the previous build"
        tier, keep = TIER.get(symbol, (2, EXT_KEEP))
        self.write(d, tier, keep[tf], False)
        return symbol, tf, "carried"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "") for a in sys.argv[1:] if a.startswith("--"))
    out = os.path.abspath(args[0] if args else "_site")
    testing = len(args) > 1 or "ext" in opts or "broad" in opts
    pick = lambda k, full: [s.upper() for s in opts[k].split(",") if s] if k in opts else ([] if testing else full)
    core = [s.upper() for s in args[1:]] or ([] if testing else CORE)
    extended, broad = pick("ext", EXTENDED), pick("broad", BROAD)
    TIER.update({s: (2, EXT_KEEP) for s in extended})
    TIER.update({s: (3, BROAD_KEEP) for s in broad})
    site = opts.get("site") or os.environ.get("MERIDIAN_SITE") or None
    if site and not site.endswith("/"):
        site += "/"
    prev_dir = opts.get("prev") or None
    if prev_dir and not os.path.isfile(os.path.join(prev_dir, "data", "state.json")):
        prev_dir = None  # no usable local copy of the previous build: read the published site
    b = Build(out, site, int(opts.get("budget") or EXT_BUDGET), prev_dir)

    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(os.path.join(ROOT, "web"), out)
    for tf in list(KEEP) + ["x1m"]:
        os.makedirs(os.path.join(out, "data", tf), exist_ok=True)
    # tell the page it has no server behind it, so it does not go looking for one
    page = os.path.join(out, "index.html")
    with open(page) as f:
        html = f.read()
    with open(page, "w") as f:
        f.write(html.replace("<html lang=\"en\">", "<html lang=\"en\" data-backend=\"static\">", 1))

    # core: everything, every build
    jobs = [(s, tf) for s in core for tf in KEEP]
    with ThreadPoolExecutor(max_workers=4) as pool:
        core_res = list(pool.map(b.core, jobs))
    core_bad = [r for r in core_res if r[2] != "fresh"]
    t_core = time.time() - b.t0

    # extended and broad: refresh what is due, carry the rest from the previous build
    keys2 = [(s, tf) for s in extended for tf in EXT_KEEP]
    keys3 = [(s, tf) for s in broad for tf in BROAD_KEEP]
    keys = keys2 + keys3
    now = time.time()
    try:
        prev = (b.previous("state.json") or {}) if keys else {}
        last_build = (b.previous("stamp.json") or {}).get("generated") if keys else None
    except Unreachable as e:
        # without the previous build's record everything would look new and be fetched at once
        sys.exit(f"the previous build could not be read ({e}); not publishing")
    # builds are meant to run every ten minutes but the scheduler is often late: after a long gap
    # do proportionally more, so the extended set keeps to its targets
    scale = min(3, max(1, (now - last_build) / 600)) if last_build and "budget" not in opts else 1
    b.budget = int(scale * b.budget)
    broad_budget = int(scale * (int(opts["budget"]) if "budget" in opts else BROAD_BUDGET))
    # The market is in session only if the clock says so AND today has traded. On a holiday the
    # last session is the one SPY last traded in, not today's 16:00.
    trading, closed = stock_session(now), last_close(now)
    spy = os.path.join(out, "data", "1m", "SPY.json")
    if os.path.exists(spy):
        with open(spy) as f:
            day = json.load(f)["t"][-1] // 86400  # wall-clock day of the newest regular bar
        if day != int(server._wall_fn("America/New_York")(now)) // 86400:
            trading = False
            d = time.gmtime(day * 86400)
            closed = min(closed, datetime(d.tm_year, d.tm_mon, d.tm_mday, 16, 0, tzinfo=server.ET).timestamp())
    due2, rest2 = plan_refresh(prev, keys2, now, b.budget, trading, closed)
    due3, rest3 = plan_refresh(prev, keys3, now, broad_budget, trading, closed, BROAD_TARGET)
    due, rest = due2 + due3, rest2 + rest3
    with ThreadPoolExecutor(max_workers=4) as pool:
        ref = list(pool.map(b.refresh, due))
    undone = [(s, tf) for s, tf, r in ref if r != "fresh"]  # put off or refused: keep what was published
    refused = {(s, tf): r for s, tf, r in ref if r not in (None, "fresh")}
    with ThreadPoolExecutor(max_workers=16) as pool:
        car = list(pool.map(b.carry, rest + undone))
    lost = [(s, tf, f"{refused[(s, tf)]}; {r}" if (s, tf) in refused else r) for s, tf, r in car if r != "carried"]
    for s, tf in keys:
        k = f"{s}|{tf}"
        if k in b.state:
            continue
        if refused.get((s, tf), "").startswith("gone"):
            b.state[k] = -int(now)  # no such symbol, and nothing published: do not ask every build
        elif prev.get(k, 0) < 0 and (s, tf) not in due:
            b.state[k] = prev[k]
    # A build that lost a real share of what was published must not replace it: that is the
    # previous build being unreadable or the provider failing, not symbols going away.
    had = sum(1 for s, tf in keys if prev.get(f"{s}|{tf}", 0) > 0)
    have = sum(1 for s, tf in keys if b.state.get(f"{s}|{tf}", 0) > 0)
    unreachable = sum(1 for r in car if r[2].startswith("unreachable"))
    if had - have > max(3, had * 0.03) or unreachable > 5:
        sys.exit(f"extended set shrank from {had} to {have} series ({unreachable} unreadable in the previous build); not publishing")

    # index (small, polled by the page), catalog (the symbol list, fetched when it changes),
    # state (for the next build), and the market summary
    order = {s: i for i, s in enumerate(core + extended + broad)}
    symbols = sorted(b.info.values(), key=lambda e: order.get(e["symbol"], 1e9))
    for e in symbols:
        e["tfs"] = [tf for tf in list(KEEP) + ["x1m"] if tf in e["tfs"]]
    catalog = {
        "symbols": [e for e in symbols if any(tf in KEEP for tf in e["tfs"])],
        "sectors": UNIVERSE["sectors"],
        "live": server.LIVE_PROXY,
        "stocks": server.STOCK_PROXY,
        "file": {e["symbol"]: safe(e["symbol"]) for e in symbols},
    }
    blob = json.dumps(catalog, separators=(",", ":"), sort_keys=True)
    generated = int(time.time())
    data = os.path.join(out, "data")
    with open(os.path.join(data, "catalog.json"), "w") as f:
        f.write(blob)
    # index.json keeps the whole catalog too: pages opened before this layout existed read it there
    with open(os.path.join(data, "index.json"), "w") as f:
        json.dump({"generated": generated, **catalog}, f, separators=(",", ":"))
    with open(os.path.join(data, "stamp.json"), "w") as f:
        json.dump({"generated": generated, "catalog": hashlib.sha1(blob.encode()).hexdigest()[:12], "symbols": len(catalog["symbols"])}, f, separators=(",", ":"))
    with open(os.path.join(data, "state.json"), "w") as f:
        json.dump(b.state, f, separators=(",", ":"))
    with open(os.path.join(data, "pack.json"), "w") as f:
        json.dump({"generated": generated, "s": {e["symbol"]: b.pack[e["symbol"]] for e in symbols if e["symbol"] in b.pack}}, f, separators=(",", ":"))
    open(os.path.join(out, ".nojekyll"), "w").close()

    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(data) for fn in fns)
    n_ext = len({s for s, _ in keys2} & set(b.info))
    n_broad = len({s for s, _ in keys3} & set(b.info))
    print(f"core: {len(jobs) - len(core_bad)} of {len(jobs)} series fresh in {t_core:.0f} s")
    print(f"extended: {len(due)} due ({sum(1 for r in ref if r[2] == 'fresh')} refreshed, {sum(1 for r in ref if r[2] is None)} put off), "
          f"{sum(1 for r in car if r[2] == 'carried')} carried, {len(lost)} missing; {n_ext} of {len(extended)} extended and {n_broad} of {len(broad)} broad symbols; "
          f"{b.joined} daily refreshes joined onto carried history; market {'open' if trading else 'shut'}")
    ext_bad = [(s, tf, r) for (s, tf), r in refused.items() if b.state.get(f"{s}|{tf}", 0) > 0]  # refused but carried
    print(f"{len(catalog['symbols'])} symbols, {size / 1e6:.1f} MB, {b.throttled} throttled answers, {time.time() - b.t0:.0f} s")
    for line in ([f"core {s} {tf}: {r}" for s, tf, r in core_bad] + [f"extended {s} {tf}: {r}" for s, tf, r in lost] + [f"extended {s} {tf}: kept the published copy ({r})" for s, tf, r in ext_bad] + b.notes)[:60]:
        print("  ", line)
    # a build with most of its core data missing must not replace a good one
    failed = [r for r in core_bad if r[2].startswith("failed")]
    if jobs and (len(failed) > len(jobs) * 0.25 or len(core_bad) > len(jobs) * 0.5):
        sys.exit(f"too many core failures ({len(failed)} failed, {len(core_bad) - len(failed)} kept old, of {len(jobs)}); not publishing")


if __name__ == "__main__":
    main()

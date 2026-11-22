#!/usr/bin/env python3
"""
Build the shareable static site: a copy of web/ plus a snapshot of exchange history.

A static page has no server to fetch prices for it, and the price feed cannot be read from a
browser. So a scheduled job runs this script: it writes each symbol's recent bars to
<out>/data/<tf>/<symbol>.json.gz, and the page brings them up to the second on its own by projecting
from Hyperliquid, which a browser can read (see web/js/static.js).

Two tiers, so the data set can be wide without hammering the provider:

  core      every timeframe (1m, 5m, 1h, daily), fetched fresh on every build. Everything with a
            live proxy, plus the main futures, ETFs, indexes, currencies, crypto and mega caps.
  extended  daily, hourly, five-minute and one-minute history for the S&P 500, other followed
            stocks, the most traded funds and coins (web/universe.json). A build
            refreshes only the series that are due, oldest first, up to a fixed number of requests,
            and carries the others over from the previous build: a local copy of it (--prev, what
            the scheduled job uses: it downloads the last published build) or, failing that, the
            published site itself (--site). So each series is refreshed about twice an hour while
            the market is open, once after the close, and not at all overnight, at the weekend or
            on a holiday, when it cannot change.
  broad     daily (ten years), hourly, five-minute (two weeks) and one-minute (four sessions)
            history, for the other US stocks over $2B, smaller ones,
            other ETFs that trade enough and the members of world indexes (web/universe.json
            "broad" and "intl"; see tools/make_universe.py). Refreshed the same way, less often.

A refresh asks for the last few bars only and joins them onto the carried history, unless that
history no longer matches (a split or a dividend restates it), is a week old, or does not reach as
far back as is now kept; then the whole series is fetched.

    python3 tools/snapshot.py _site                          # full build
    python3 tools/snapshot.py _site NQ=F SPY --ext=KO,PEP --broad=AAL,ACM   # just these (for testing)
    python3 tools/snapshot.py _site --prev=prev --site=https://example.github.io/meridian/

The data set can be split across sites, each with its own size limit (GitHub Pages: 1 GB):

    --part=main  --shard=URL   everything but the broad tier's daily, 5- and 1-minute history; the
                               page also reads the site(s) at URL, and takes each timeframe from
                               whichever has it
    --part=broad               the broad tier's daily, 5- and 1-minute history only, as a data site
                               of its own (no app)

The default, --part=all, builds one site with everything.
"""
from __future__ import annotations

import gzip
import hashlib
import math
import re
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
    + "USDCHF=X NZDUSD=X EURJPY=X GBPJPY=X EURGBP=X USDCNH=X USDMXN=X USDINR=X USDKRW=X USDHKD=X USDSEK=X".split()
    + "AVAX-USD DOT-USD LTC-USD BCH-USD TRX-USD XLM-USD SHIB-USD HBAR-USD NEAR-USD AAVE-USD UNI7083-USD SUI20947-USD".split()
))
EXTENDED = sorted((set(UNIVERSE["stocks"]) | set(UNIVERSE.get("etfs") or [])) - set(CORE))
# coins: daily and hourly like the extended tier, but refreshed around the clock
CRYPTO = list(dict.fromkeys(s for s in (UNIVERSE.get("crypto") or []) if s not in set(CORE) | set(EXTENDED)))  # each once
# international index members: daily history, grouped by index
MKT_OF = {s: name for name, v in (UNIVERSE.get("intl") or {}).items() for s in v["members"]}
BROAD = sorted((set(UNIVERSE.get("broad") or {}) | set(MKT_OF)) - set(CORE) - set(EXTENDED) - set(CRYPTO))
SECTOR_OF = {**{k: v for k, v in (UNIVERSE.get("broad") or {}).items() if v >= 0},
             **{s: sec for v in (UNIVERSE.get("intl") or {}).values() for s, sec in v["members"].items() if sec >= 0},
             **UNIVERSE["stocks"]}
SP500 = set(UNIVERSE.get("sp500") or [])

# timeframe -> how many of the most recent bars to keep (15m and 30m are built from 5m in the page)
KEEP = {"1m": 1500, "5m": 3200, "1h": 3000, "1d": 2520}
CORE_RANGE = {"1d": "10y"}  # ask for what is kept, not the provider's default window
EXT_KEEP = {"1d": 2520, "1h": 1500, "5m": 1560, "1m": 1500}  # ten years, ten months, four weeks, four sessions
EXT_RANGE = {"1d": "10y", "1h": "1y", "5m": "1mo", "1m": "5d"}
# how old an extended series may get while the stock market is open, in seconds
EXT_TARGET = {"1d": 60 * 60, "1h": 60 * 60, "5m": 30 * 60, "1m": 30 * 60}
EXT_BUDGET = 1200       # extended refreshes per build, beyond series the site does not have at all
BROAD_KEEP = {"1d": 2520, "1h": 1200, "5m": 780, "1m": 1500}  # ten years of days, eight months of hours, two weeks of 5m, four sessions of 1m
BROAD_RANGE = {"1d": "10y", "1h": "1y", "5m": "1mo", "1m": "5d"}
BROAD_TARGET = {"1d": 90 * 60, "1h": 120 * 60, "5m": 60 * 60, "1m": 60 * 60}  # the least traded and the biggest tier: refreshed less often
BROAD_BUDGET = 1200    # broad refreshes per ten minutes and timeframe (each is a small request: the last few bars)
# Which of the broad tier's timeframes each part of a split data set publishes (see --part)
BROAD_PART = {"all": ("1d", "1h", "5m", "1m"), "main": ("1h",), "broad": ("1d", "5m", "1m")}
# how much a refresh asks for, to join onto the carried history
JOIN_RANGE = {"1d": "1mo", "1h": "5d", "5m": "5d", "1m": "1d"}
JOIN_SPAN = {"1mo": 28 * 86400, "5d": 4 * 86400, "1d": 16 * 3600}  # how far back each window is sure to reach
CRYPTO_BUDGET = 200    # coin refreshes per build
# currency -> its value in US dollars, from these core pairs (True: the pair is quoted as USD per unit)
FX_PAIRS = {"EUR": ("EURUSD=X", True), "GBP": ("GBPUSD=X", True), "AUD": ("AUDUSD=X", True), "NZD": ("NZDUSD=X", True),
            "JPY": ("USDJPY=X", False), "CAD": ("USDCAD=X", False), "CHF": ("USDCHF=X", False), "INR": ("USDINR=X", False),
            "KRW": ("USDKRW=X", False), "CNY": ("USDCNH=X", False), "MXN": ("USDMXN=X", False), "HKD": ("USDHKD=X", False),
            "SEK": ("USDSEK=X", False)}
SUBUNIT = {"GBp": ("GBP", 0.01), "GBX": ("GBP", 0.01), "ZAc": ("ZAR", 0.01), "ILA": ("ILS", 0.01)}  # quoted in hundredths
FULL_EVERY = 7 * 86400  # a joined-up series is fetched whole again after this long, whatever it looks like
SETTLE = 30 * 60       # a day's last bars are final this long after the close
SITE_LIMIT = 980e6     # bytes of data a site may publish (GitHub Pages: 1 GB, app included)
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


def join_series(old: dict, new: dict, need: int = 3) -> dict | None:
    """Carried history + a recent window of fresh bars -> one series, or None when they do not
    agree on the bars both have (a split or a dividend has restated the history since: fetch it
    whole). Compared: the close and the dividend adjustment (adjusted / close) on every shared bar
    but each side's newest, which may still have been forming. At least three such bars are needed.
    Any timeframe: intraday series have no adjusted close, so only their closes are compared.

    The carried side has been through the published file, where the adjusted close is rebuilt from
    factor runs and rounded (encode_series), so its adjustment is only as exact as adj_tolerance()
    says. Comparing more tightly than that refused every join for a month after each ex-dividend
    date, and made splice_truncated() useless for dividend payers. A restatement smaller than the
    tolerance (a dividend of a few thousandths of a percent) is picked up by the weekly whole fetch."""
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
        if abs(a - b) > 1e-6 * max(1.0, abs(b)) or abs(adj(old, i) - adj(new, j)) > adj_tolerance(old["a"][i] if old.get("a") else a) * max(1.0, abs(adj(new, j))):
            return None
        shared += 1
    if shared < need:
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
    if old.get("rng"):
        out["rng"] = old["rng"]  # and how far back that fetch went
    return out



def adj_tolerance(a: float) -> float:
    """How far adjusted / close can be off, relatively, after a series has been through the
    published file: the factor runs allow AF_TOL, and decoding rounds the adjusted close like
    server._round (3 decimals from 100, 4 from 1, 8 below), which matters for low prices."""
    a = abs(a)
    half_unit = 0.0005 if a >= 100 else 0.00005 if a >= 1 else 5e-9
    return 2.5 * AF_TOL + 2 * half_unit / max(a, 1e-12)


TRUNCATED_GAP = 10 * 86400  # a short answer is spliced on only if it starts this close to the published end
TRUNCATED_TFS = ("1d", "1h")  # timeframes whose whole history is years long: a short answer there is not normal
# For rolling windows (days of 1- and 5-minute bars): a span every whole answer surely covers. An
# answer that leaves out published bars inside it was cut short; one that only drops older bars rolled.
ROLLING_SPAN = {"5m": 20 * 86400, "1m": 3 * 86400}


def splice_truncated(old: dict | None, new: dict) -> dict | None:
    """The provider sometimes answers a request for years of history with a few bars only (seen for
    ROKU, SNDK and USDCNH=X: the history comes back days later). Publishing that answer would throw
    away what is published. So when a whole-series fetch has under half the bars of the published
    series and starts later, the published history is kept and the fresh bars are joined on, as
    long as they agree on any bars both have and do not leave a gap. None: use the fetch as it is.

    A one- or five-minute history is a window of days that rolls: for a thinly traded symbol an honest
    answer can have under half the bars of the last one (a busy session has left the window), and
    taking that for truncation would stop the file from rolling. So for those the answer must also
    leave out published bars from the last few days (ROLLING_SPAN), which a rolled window never does."""
    if not old or not old.get("t") or not new.get("t"):
        return None
    tf = new.get("tf")
    if tf not in TRUNCATED_TFS and tf not in ROLLING_SPAN:
        return None
    if len(new["t"]) >= 0.5 * len(old["t"]) or new["t"][0] <= old["t"][0] or new["t"][0] - old["t"][-1] > TRUNCATED_GAP:
        return None
    span = ROLLING_SPAN.get(tf)
    if span and sum(1 for t in old["t"] if new["t"][-1] - span <= t < new["t"][0]) < 0.25 * len(old["t"]):
        return None  # what is missing is older than the window: it rolled
    return join_series(old, new, need=0)


def can_join(old: dict, tf: str, now: float) -> bool:
    """Can the join window reach the carried series' newest bars? If they are older than the
    window (the first one-minute refresh of a session: the window is today, the bars yesterday's),
    asking for it would be a wasted request before the whole fetch that must follow."""
    wall = server._wall_fn((old.get("meta") or {}).get("tz"))
    return wall(now) - old["t"][-1] < JOIN_SPAN[JOIN_RANGE[tf]]


def history_range(d: dict, tier: int) -> str:
    """How far back a carried series was fetched. Files written before this was recorded are taken
    to be what was kept then: five years of days for the broad tier, the current window otherwise."""
    if d.get("rng"):
        return d["rng"]
    return "5y" if tier == 3 and d.get("tf") == "1d" else (BROAD_RANGE if tier == 3 else EXT_RANGE).get(d.get("tf"), "")


def build_scale(now: float, last_planned: float | None) -> float:
    """How much more than a ten-minute build's share of refreshes this build should do: the time
    since the previous build planned its own, in ten-minute units, between 1 and 3."""
    return min(3.0, max(1.0, (now - last_planned) / 600)) if last_planned else 1.0


def settle_refused(state: dict, prev: dict, keys: list, refused: dict, due: set, now: float) -> None:
    """Record, in the build's state, the series the provider had nothing for ("gone: ..."):
      - a copy is published (carried): stamp it as looked at now, so it is asked again on its
        schedule and not on every build (a delisted symbol, a fund with no trades in the window);
      - nothing is published: a negative stamp, which keeps it out of the plan for RETRY_DEAD;
    and keep earlier negative stamps of series that were not asked about this time."""
    for s, tf in keys:
        k = f"{s}|{tf}"
        gone = refused.get((s, tf), "").startswith("gone")
        if k in state:
            if gone:
                state[k] = int(now)
            elif prev.get(k, 0) > state[k]:
                state[k] = prev[k]  # carried: write() stamped the file's own fetch time; keep the later look
        elif gone:
            state[k] = -int(now)
        elif prev.get(k, 0) < 0 and (s, tf) not in due:
            state[k] = prev[k]


def published_first(due: list, state: dict) -> list:
    """Series the last build published, then the others, each in the order given."""
    pub = [k for k in due if state.get(f"{k[0]}|{k[1]}", 0) > 0]
    return pub + [k for k in due if state.get(f"{k[0]}|{k[1]}", 0) <= 0]


# ───────────────────────── the published file format (pure) ─────────────────────────
AF_TOL = 2e-5  # largest relative error allowed in a decoded adjusted close
STEP = {"1m": 60, "x1m": 60, "5m": 300, "1h": 3600, "1d": 86400}


def encode_series(d: dict) -> dict:
    """A series as published: about a third smaller than plain columns, decoded by the page
    (web/js/static.js: decodeSeries) and by decode_series here, exactly.
      t   -> t0 + dt, the gaps in steps: the largest time that divides every gap (a day, an hour, ...)
      a   -> af, runs of [first bar, factor] with a = round(c * factor). The factor only changes
             at a dividend, but the provider rounds the column its own way, so a run is kept
             while it reproduces every adjusted close within AF_TOL (a fraction of a cent);
             otherwise the column is published as it is.
    Decoding gives back t exactly, and a within AF_TOL plus the rounding of the decoded value
    (adj_tolerance(): about twice AF_TOL for prices of a few dollars); decoding and encoding again
    changes nothing, so the error does not grow from build to build."""
    if not d or not d.get("t"):
        return d
    out = {k: v for k, v in d.items() if k not in COLS}
    t = d["t"]
    gaps = [t[i] - t[i - 1] for i in range(1, len(t))]
    if all(g > 0 for g in gaps):
        # the step is the largest that divides every gap: an hour for hourly bars that start on the
        # hour, half an hour for a market that opens at 9:30, a second at worst
        step = 0
        for g in gaps:
            step = math.gcd(step, g)
        step = step or STEP.get(d.get("tf")) or 1
        out["t0"], out["step"], out["dt"] = t[0], step, [g // step for g in gaps]
    else:
        out["t"] = t
    for col in "ohlcv":
        out[col] = d[col]
    if d.get("a"):
        a, c, runs = d["a"], d["c"], []
        f = None
        for i in range(len(c)):
            if f is None or abs(c[i] * f - a[i]) > AF_TOL * abs(a[i]):
                f = a[i] / c[i]
                runs.append([i, f])
        if runs is not None and len(runs) <= max(8, len(c) // 20):
            out["af"] = runs
        else:
            out["a"] = a
    out["enc"] = 1
    return out


def decode_series(d: dict | None) -> dict | None:
    if not d or not d.get("enc"):
        return d
    out = {k: v for k, v in d.items() if k not in ("enc", "t0", "step", "dt", "af")}
    if "t0" in d:
        t = [d["t0"]]
        for g in d["dt"]:
            t.append(t[-1] + g * d["step"])
        out["t"] = t
    if "af" in d:
        c, runs, a = d["c"], d["af"], []
        for k, (start, f) in enumerate(runs):
            end = runs[k + 1][0] if k + 1 < len(runs) else len(c)
            a.extend(server._round(c[i] * f) for i in range(start, end))
        out["a"] = a
    return out


SERIES_EXT = ".json.gz"  # series files are published gzip-compressed: about a third of the size
GZIP_LEVEL = 6
GZ_MAGIC = b"\x1f\x8b"


def series_bytes(d: dict) -> bytes:
    """A series as a published file: the compact JSON (encode_series), gzip-compressed with a fixed
    time stamp, so the same series always gives the same bytes. GitHub Pages counts a site's size
    as stored, and these files would otherwise be most of it; the page inflates them itself
    (web/js/static.js: readJsonBytes)."""
    return gzip.compress(json.dumps(encode_series(d), separators=(",", ":")).encode("utf-8"), compresslevel=GZIP_LEVEL, mtime=0)


def read_json_bytes(raw: bytes):
    """A published JSON file's bytes, compressed or not (and compressed again on the way, if a
    server did that)."""
    while raw[:2] == GZ_MAGIC:
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


# ───────────────────────── market summary (pure) ─────────────────────────
def pack_row(d: dict, fx: dict | None = None) -> dict:
    """The last year of a daily series, small enough to ship for every symbol at once: dates as day
    numbers (first, then gaps), closes, and the average value traded a day over the 20 bars before
    the newest one. web/js/markets.js reads this (and builds the same thing from bars when a
    server is present: see packFromBars there).

    Value traded is price x shares for stocks and ETFs. Crypto volume already comes in dollars.
    For indexes, futures and currencies the feed's volume cannot be turned into dollars (no
    contract multiplier, constituent shares, or none at all), so there is no figure: 0.
    A series priced in another currency is converted with `fx` (currency -> US dollars; London's
    pence count as hundredths of a pound), or has no figure without it."""
    t, c, v = d["t"], d["c"], d["v"]
    kind = (d.get("meta") or {}).get("type")
    cur = (d.get("meta") or {}).get("currency") or "USD"
    base, unit = SUBUNIT.get(cur, (cur, 1.0))
    rate = 1.0 if cur == "USD" else (fx or {}).get(base, 0) * unit
    n = len(t)
    k = n - 1
    while k > 0 and t[k - 1] >= t[-1] - PACK_DAYS * 86400:
        k -= 1
    days = [x // 86400 for x in t[k:]]
    lo = max(0, n - 21)
    per = (lambda i: c[i] * v[i]) if kind in server.STOCK_TYPES else (lambda i: v[i]) if kind == "CRYPTOCURRENCY" else (lambda i: 0)
    dv = sum(per(i) for i in range(lo, n - 1)) / max(1, n - 1 - lo) * rate
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
        self.fx: dict[str, float] = {}   # currency -> US dollars, read from the core pairs once they are in
        self.joined = 0                   # refreshes done by joining the last few bars onto the carried history

    def path(self, tf: str, symbol: str) -> str:
        return os.path.join(self.out, "data", tf, safe(symbol) + SERIES_EXT)

    def yahoo(self, symbol: str, tf: str, rng: str | None = None, tries: int = 4) -> dict:
        for k in range(tries):
            try:
                return server._fetch_yahoo(symbol, tf, rng)
            except Exception as e:
                msg = str(e)
                if "429" in msg:
                    with self.lock:
                        self.throttled += 1
                # once the provider is refusing the build, stop waiting on it: the core series fall
                # back to the published copy and the build's own guards decide
                if ("429" in msg or "timed out" in msg) and k < tries - 1 and self.throttled < THROTTLE_STOP:
                    time.sleep(6 * (k + 1))
                    continue
                raise

    def previous_bytes(self, rel: str) -> bytes | None:
        """A file of the previous build (path under data/), as stored: from the local copy of that
        build when there is one, else from the published site. None if that build has no such file;
        raises Unreachable if it could not be read, which must never be mistaken for "not there"."""
        if self.prev:
            path = os.path.join(self.prev, "data", rel)
            if not os.path.exists(path):
                return None
            try:
                with open(path, "rb") as f:
                    return f.read()
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
                    return r.read()
            except Exception as e:
                if getattr(e, "code", None) == 404:
                    return None
                err = e
                time.sleep(1 + 2 * k)
        raise Unreachable(f"{rel}: {err}")

    def previous(self, rel: str):
        """A JSON file of the previous build, parsed (see previous_bytes)."""
        raw = self.previous_bytes(rel)
        if raw is None:
            return None
        try:
            return read_json_bytes(raw)
        except Exception as e:
            raise Unreachable(f"{rel}: {e}")

    def previous_file(self, tf: str, symbol: str):
        """One series of the previous build: (its file's bytes when they are this format's, gzip
        once, else None; the series) or None. Builds before the files were compressed published
        <symbol>.json: read those too."""
        for ext in (SERIES_EXT, ".json"):
            raw = self.previous_bytes(f"{tf}/{safe(symbol)}{ext}")
            if raw is None:
                continue
            try:
                inner = gzip.decompress(raw) if raw[:2] == GZ_MAGIC else raw
                d = decode_series(read_json_bytes(inner))
            except Exception as e:
                raise Unreachable(f"{tf}/{safe(symbol)}{ext}: {e}")
            if d and d.get("symbol") == symbol and d.get("t") and len(d["t"]) == len(d.get("c") or []) and d.get("meta"):
                return (raw if ext == SERIES_EXT and raw[:2] == GZ_MAGIC and inner[:1] == b"{" else None), d
            return None
        return None

    def previous_series(self, tf: str, symbol: str) -> dict | None:
        got = self.previous_file(tf, symbol)
        return got[1] if got else None

    def put(self, tf: str, symbol: str, d: dict | None, raw: bytes | None = None):
        """Publish one series file: `raw`, the previous build's own bytes for an unchanged series
        (no need to compress it again), or else `d` compressed."""
        data = raw if raw is not None else series_bytes(d)
        path = self.path(tf, symbol)
        tmp = f"{path}.{threading.get_ident()}.tmp"  # whole file or none: never a torn one
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

    def write(self, d: dict, tier: int, keep: int, fresh: bool, raw: bytes | None = None):
        symbol, tf = d["symbol"], d["tf"]
        if raw is not None and len(d["t"]) > keep:
            raw = None  # it is cut shorter here, so it is not the same file
        for col in COLS:
            if col in d:
                d[col] = d[col][-keep:]
        d.pop("stale", None)
        self.put(tf, symbol, d, raw)
        meta = d["meta"]
        with self.lock:
            e = self.info.setdefault(symbol, {"symbol": symbol, "name": meta.get("name") or symbol, "type": meta.get("type") or "", "exch": meta.get("exchange") or "", "tier": tier, "tfs": []})
            e["tfs"].append(tf)
            if symbol in SECTOR_OF:
                e["sector"] = SECTOR_OF[symbol]
            if symbol in SP500:
                e["sp"] = 1
            if symbol in MKT_OF:
                e["mkt"] = MKT_OF[symbol]
            if (meta.get("currency") or "USD") != "USD":
                e["cur"] = meta["currency"]
            if tier >= 2:
                self.state[f"{symbol}|{tf}"] = d.get("fetched", 0)
            if tf == "1d":
                self.pack[symbol] = pack_row(d, self.fx)

    def note_spliced(self, symbol, tf, d, old):
        with self.lock:
            self.notes.append(f"{symbol} {tf}: the provider sent {len(d['t'])} bars for the whole history; kept the {len(old['t'])} published and joined the new ones on")

    # one core series: always fresh; if the provider fails, keep what is published
    def core(self, job):
        symbol, tf = job
        try:
            d = self.yahoo(symbol, tf, CORE_RANGE.get(tf))
            try:
                old = self.previous_series(tf, symbol)
            except Unreachable:
                old = None
            spliced = splice_truncated(old, d)
            if spliced:
                self.note_spliced(symbol, tf, d, old)
                d = spliced
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
            except Unreachable:
                old = None
            if old and tf == "1m" and old["meta"].get("type") in server.STOCK_TYPES:
                try:
                    ext = self.previous_series("x1m", symbol)  # its extended-hours prints go with it
                except Unreachable:
                    ext = None  # the one-minute series is still good without them
                if ext:
                    self.put("x1m", symbol, ext)
                    with self.lock:
                        self.info.setdefault(symbol, {"symbol": symbol, "name": old["meta"].get("name") or symbol, "type": old["meta"].get("type") or "", "exch": old["meta"].get("exchange") or "", "tier": 1, "tfs": []})["tfs"].append("x1m")
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
        self.put("x1m", symbol, slim)
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
        want = (BROAD_RANGE if tier == 3 else EXT_RANGE)[tf]
        try:
            # the last few bars joined onto the carried history, when they agree and that history
            # was fetched whole recently enough and as far back as is now kept
            try:
                old = self.previous_series(tf, symbol)
            except Unreachable:
                old = None
            if old and time.time() - (old.get("full") or old.get("fetched") or 0) < FULL_EVERY and history_range(old, tier) == want and can_join(old, tf, time.time()):
                joined = join_series(old, self.yahoo(symbol, tf, JOIN_RANGE[tf], tries=2))
                if joined:
                    self.write(joined, tier, keep[tf], True)
                    with self.lock:
                        self.joined += 1
                    return symbol, tf, "fresh"
            d = self.yahoo(symbol, tf, want, tries=2)
            d["full"], d["rng"] = d.get("fetched", 0), want
            spliced = splice_truncated(old, d)
            if spliced:
                self.note_spliced(symbol, tf, d, old)
                d = spliced
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
            got = self.previous_file(tf, symbol)
        except Unreachable as e:
            return symbol, tf, f"unreachable: {e}"
        if not got:
            return symbol, tf, "not in the previous build"
        tier, keep = TIER.get(symbol, (2, EXT_KEEP))
        self.write(got[1], tier, keep[tf], False, raw=got[0])  # unchanged: the same bytes again
        return symbol, tf, "carried"


def stamp_assets(out: str) -> str:
    """Give every script and stylesheet address a version (a hash of the whole app), so a browser
    holding an earlier build's files fetches them all again instead of mixing old and new. The
    site serves files as fresh for ten minutes; without this a page could run one new module with
    another's old copy. An unchanged app keeps its version, and so its cache."""
    files = sorted(os.path.join(dp, fn) for dp, _, fns in os.walk(out) for fn in fns if fn.endswith((".js", ".css", ".html")) and "/data/" not in dp + "/")
    h = hashlib.sha1()
    for path in files:
        with open(path, "rb") as f:
            h.update(path[len(out):].encode() + b"\0" + f.read())
    ver = h.hexdigest()[:10]
    imp = re.compile(r"""((?:\bfrom\s*|\bimport\s*\(\s*)(['"]))(\.{1,2}/[^'"?]+\.js)(\2)""")
    for path in files:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        if path.endswith(".js"):
            new = imp.sub(lambda m: f"{m.group(1)}{m.group(3)}?v={ver}{m.group(4)}", text)
        elif path.endswith(".html"):
            new = re.sub(r'((?:src|href)=")((?:js|css)/[^"?]+\.(?:js|css))(")', lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", text)
        else:
            new = text
        if new != text:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)
    return ver


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) if "=" in a else (a[2:], "") for a in sys.argv[1:] if a.startswith("--"))
    out = os.path.abspath(args[0] if args else "_site")
    testing = len(args) > 1 or "ext" in opts or "broad" in opts
    pick = lambda k, full: [s.upper() for s in opts[k].split(",") if s] if k in opts else ([] if testing else full)
    part = opts.get("part") or "all"
    if part not in ("all", "main", "broad"):
        sys.exit(f"unknown --part={part}")
    core = [s.upper() for s in args[1:]] or ([] if testing else CORE)
    extended, broad, crypto = pick("ext", EXTENDED), pick("broad", BROAD), pick("crypto", CRYPTO)
    # a symbol listed twice would be two jobs writing one file
    core, extended, broad, crypto = (list(dict.fromkeys(x)) for x in (core, extended, broad, crypto))
    if part == "broad":
        core, extended, crypto = [], [], []
    shards = [u if u.endswith("/") else u + "/" for u in (opts.get("shard") or "").split(",") if u] if part == "main" else []
    TIER.update({s: (2, EXT_KEEP) for s in extended + crypto})
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
    if part == "broad":
        # a data site: no app, just the files and a pointer to where they are read
        os.makedirs(out)
        with open(os.path.join(out, "index.html"), "w") as f:
            f.write('<!doctype html><meta charset="utf-8"><title>Meridian data</title><p>Price history for '
                    '<a href="https://21e8-miner.github.io/meridian/">Meridian</a>. Nothing to see here.</p>\n')
    else:
        shutil.copytree(os.path.join(ROOT, "web"), out)
        # tell the page it has no server behind it, so it does not go looking for one
        page = os.path.join(out, "index.html")
        with open(page) as f:
            html = f.read()
        with open(page, "w") as f:
            f.write(html.replace("<html lang=\"en\">", "<html lang=\"en\" data-backend=\"static\">", 1))
        stamp_assets(out)
    for tf in list(KEEP) + ["x1m"]:
        os.makedirs(os.path.join(out, "data", tf), exist_ok=True)

    # core: everything, every build
    jobs = [(s, tf) for s in core for tf in KEEP]
    with ThreadPoolExecutor(max_workers=4) as pool:
        core_res = list(pool.map(b.core, jobs))
    core_bad = [r for r in core_res if r[2] != "fresh"]
    for cur, (pair, direct) in FX_PAIRS.items():
        try:
            if os.path.exists(b.path("1d", pair)):
                with open(b.path("1d", pair), "rb") as f:
                    last = read_json_bytes(f.read())["c"][-1]
            elif part == "broad":  # no core here: read the rate itself, without publishing it
                last = b.yahoo(pair, "1d", "5d")["c"][-1]
            else:
                continue
            b.fx[cur] = last if direct else 1.0 / last
        except Exception:
            pass  # that currency's dollar figures stay blank
    t_core = time.time() - b.t0

    # extended and broad: refresh what is due, carry the rest from the previous build
    keysc = [(s, tf) for s in crypto for tf in EXT_KEEP]
    keys2 = [(s, tf) for s in extended for tf in EXT_KEEP]
    keys3 = [(s, tf) for s in broad for tf in BROAD_KEEP if tf in BROAD_PART[part]]
    keys = keys2 + keysc + keys3
    now = time.time()
    try:
        prev = (b.previous("state.json") or {}) if keys else {}
        prev_stamp = (b.previous("stamp.json") or {}) if keys else {}
    except Unreachable as e:
        # without the previous build's record everything would look new and be fetched at once
        sys.exit(f"the previous build could not be read ({e}); not publishing")
    # The budgets are sized for a build every ten minutes. Builds are further apart than that (a
    # run takes minutes, then waits before booking the next, and the scheduler can be late), so do
    # proportionally more: by the time from the previous build's planning to this one's. (Its
    # "generated" is written at its end and would leave its own duration out.)
    last_build = prev_stamp.get("planned") or prev_stamp.get("generated")
    scale = build_scale(now, last_build) if "budget" not in opts else 1
    b.budget = int(scale * b.budget)
    broad_budget = int(scale * (int(opts["budget"]) if "budget" in opts else BROAD_BUDGET * len(BROAD_PART[part])))
    # The market is in session only if the clock says so AND today has traded. On a holiday the
    # last session is the one SPY last traded in, not today's 16:00.
    trading, closed = stock_session(now), last_close(now)
    spy, day = b.path("1m", "SPY"), None
    if os.path.exists(spy):
        with open(spy, "rb") as f:
            day = decode_series(read_json_bytes(f.read()))["t"][-1] // 86400  # wall-clock day of the newest regular bar
    elif part == "broad" and keys:
        try:
            day = b.yahoo("SPY", "1m")["t"][-1] // 86400
        except Exception:
            pass  # go by the clock alone
    if day is not None:
        if day != int(server._wall_fn("America/New_York")(now)) // 86400:
            trading = False
            d = time.gmtime(day * 86400)
            closed = min(closed, datetime(d.tm_year, d.tm_mon, d.tm_mday, 16, 0, tzinfo=server.ET).timestamp())
    due2, rest2 = plan_refresh(prev, keys2, now, b.budget, trading, closed)
    due3, rest3 = plan_refresh(prev, keys3, now, broad_budget, trading, closed, BROAD_TARGET)
    duec, restc = plan_refresh(prev, keysc, now, int(scale * CRYPTO_BUDGET), True, closed)  # crypto never closes
    # series already published first, so their refreshes are not put off behind a large batch of
    # new ones (a widened list, a new timeframe); those take whatever time is left, and the rest of
    # them come in on the next builds
    due, rest = published_first(due2 + duec + due3, prev), rest2 + restc + rest3
    with ThreadPoolExecutor(max_workers=6) as pool:
        ref = list(pool.map(b.refresh, due))
    undone = [(s, tf) for s, tf, r in ref if r != "fresh"]  # put off or refused: keep what was published
    refused = {(s, tf): r for s, tf, r in ref if r not in (None, "fresh")}
    with ThreadPoolExecutor(max_workers=16) as pool:
        car = list(pool.map(b.carry, rest + undone))
    lost = [(s, tf, f"{refused[(s, tf)]}; {r}" if (s, tf) in refused else r) for s, tf, r in car if r != "carried"]
    settle_refused(b.state, prev, keys, refused, set(due), now)
    # A build that lost a real share of what was published must not replace it: that is the
    # previous build being unreadable or the provider failing, not symbols going away.
    had = sum(1 for s, tf in keys if prev.get(f"{s}|{tf}", 0) > 0)
    have = sum(1 for s, tf in keys if b.state.get(f"{s}|{tf}", 0) > 0)
    unreachable = sum(1 for r in car if r[2].startswith("unreachable"))
    if had - have > max(3, had * 0.03) or unreachable > 5:
        sys.exit(f"extended set shrank from {had} to {have} series ({unreachable} unreadable in the previous build); not publishing")

    # index (small, polled by the page), catalog (the symbol list, fetched when it changes),
    # state (for the next build), and the market summary
    order = {s: i for i, s in enumerate(core + extended + crypto + broad)}
    symbols = sorted(b.info.values(), key=lambda e: order.get(e["symbol"], 1e9))
    for e in symbols:
        e["tfs"] = [tf for tf in list(KEEP) + ["x1m"] if tf in e["tfs"]]
    catalog = {
        "symbols": [e for e in symbols if any(tf in KEEP for tf in e["tfs"])],
        "sectors": UNIVERSE["sectors"],
        # fund families with a list of their own in the app: issuer -> funds published in this build
        "families": {k: [x for x in v if x in b.info] for k, v in (UNIVERSE.get("families") or {}).items() if any(x in b.info for x in v)},
        # world indexes: name -> {country, members published in this build}
        "indexes": {k: {"country": v["country"], "members": [x for x in v["members"] if x in b.info]} for k, v in (UNIVERSE.get("intl") or {}).items() if any(x in b.info for x in v["members"])},
        "live": server.LIVE_PROXY,
        "stocks": server.STOCK_PROXY,
        # other sites holding part of the data set: the page reads their catalogs too
        "shards": [{"base": u} for u in shards],
        "file": {e["symbol"]: safe(e["symbol"]) for e in symbols},
        # series files are data/<tf>/<file>.json.gz, gzip-compressed (sites built before had .json)
        "gz": 1,
    }
    blob = json.dumps(catalog, separators=(",", ":"), sort_keys=True)
    generated = int(time.time())
    data = os.path.join(out, "data")
    with open(os.path.join(data, "catalog.json"), "w") as f:
        f.write(blob)
    with open(os.path.join(data, "stamp.json"), "w") as f:
        json.dump({"generated": generated, "planned": int(now), "catalog": hashlib.sha1(blob.encode()).hexdigest()[:12], "symbols": len(catalog["symbols"])}, f, separators=(",", ":"))
    with open(os.path.join(data, "state.json"), "w") as f:
        json.dump(b.state, f, separators=(",", ":"))
    # the market summary in two files, so a view of the core and extended lists (the S&P 500, the
    # funds) does not have to download a year of closes for every broad symbol too
    packs = {"all": ("pack.json", "pack-broad.json"), "main": ("pack.json",), "broad": ("pack-broad.json",)}[part]
    for name, keep in (("pack.json", lambda e: e.get("tier") != 3), ("pack-broad.json", lambda e: e.get("tier") == 3)):
        if name not in packs:
            continue
        with open(os.path.join(data, name), "w") as f:
            json.dump({"generated": generated, "s": {e["symbol"]: b.pack[e["symbol"]] for e in symbols if e["symbol"] in b.pack and keep(e)}}, f, separators=(",", ":"))
    open(os.path.join(out, ".nojekyll"), "w").close()

    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(data) for fn in fns)
    n_ext = len({s for s, _ in keys2} & set(b.info))
    n_broad = len({s for s, _ in keys3} & set(b.info))
    n_coin = len({s for s, _ in keysc} & set(b.info))
    print(f"core: {len(jobs) - len(core_bad)} of {len(jobs)} series fresh in {t_core:.0f} s")
    print(f"extended: {len(due)} due ({sum(1 for r in ref if r[2] == 'fresh')} refreshed, {sum(1 for r in ref if r[2] is None)} put off), "
          f"{sum(1 for r in car if r[2] == 'carried')} carried, {len(lost)} missing; {n_ext} of {len(extended)} extended, {n_coin} of {len(crypto)} coin and {n_broad} of {len(broad)} broad symbols; "
          f"{b.joined} refreshes joined onto carried history; market {'open' if trading else 'shut'}")
    ext_bad = [(s, tf, r) for (s, tf), r in refused.items() if b.state.get(f"{s}|{tf}", 0) > 0]  # refused but carried
    print(f"{len(catalog['symbols'])} symbols, {size / 1e6:.1f} MB, {b.throttled} throttled answers, {time.time() - b.t0:.0f} s")
    for line in ([f"core {s} {tf}: {r}" for s, tf, r in core_bad] + [f"extended {s} {tf}: {r}" for s, tf, r in lost] + [f"extended {s} {tf}: kept the published copy ({r})" for s, tf, r in ext_bad] + b.notes)[:60]:
        print("  ", line)
    if size > SITE_LIMIT:
        sys.exit(f"{size / 1e6:.0f} MB is more than a site may publish ({SITE_LIMIT / 1e6:.0f} MB); not publishing. Keep less, or move a tier to a data site of its own (--part).")
    # a build with most of its core data missing must not replace a good one
    failed = [r for r in core_bad if r[2].startswith("failed")]
    if jobs and (len(failed) > len(jobs) * 0.25 or len(core_bad) > len(jobs) * 0.5):
        sys.exit(f"too many core failures ({len(failed)} failed, {len(core_bad) - len(failed)} kept old, of {len(jobs)}); not publishing")


if __name__ == "__main__":
    main()

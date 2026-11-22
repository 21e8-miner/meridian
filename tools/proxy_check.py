"""
python3 tools/proxy_check.py [--futures] [--stocks] [SYMBOL=COIN ...]

Measures whether a Hyperliquid market is a good live proxy, the way the ones in server.py's
LIVE_PROXY and STOCK_PROXY were admitted, on the most recent data both sides offer (Yahoo keeps
7 days of 1-minute bars; Hyperliquid its newest 5,000 1-minute candles, about 3.5 days):

  futures  The exchange feed is ten minutes late. For every minute t, project ten minutes ahead,
           F(t) x P(t+10) / P(t), and compare it with the real F(t+10); the alternative is showing
           F(t), ten minutes old. Kept if the projection's median error is a quarter of that or less.
  stocks   Outside regular hours. For each real extended-hours print S(t) with another print ten
           minutes later, project S(t) x P(t+10) / P(t) and compare with S(t+10); the alternative is
           holding S(t). Kept if the projection's median error is 60% of holding's or less, on a
           perpetual trading at least $1M a day.

Prints one row per pair: sample count, median / 90th-percentile error of both, the verdict.
With no arguments it checks the candidates listed below. Reads public endpoints only.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

HL = "https://api.hyperliquid.xyz/info"
YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1m&range=7d&includePrePost=true"
ET = ZoneInfo("America/New_York")
H = 600  # ten minutes
FUTURE_GAIN, STOCK_GAIN, MIN_VOLUME, MIN_PAIRS = 4.0, 1 / 0.6, 1e6, 100

# Not yet proxies (2026-11-22): futures left out before, and newly listed or newly liquid names.
FUTURES = {"NG=F": "xyz:NATGAS", "HG=F": "xyz:COPPER", "6E=F": "xyz:EUR", "6J=F": "xyz:JPY", "6B=F": "xyz:GBP",
           "PL=F": "xyz:PLATINUM", "PA=F": "xyz:PALLADIUM", "NKD=F": "xyz:JP225", "HO=F": "xyz:HO", "ZN=F": "xyz:TLT"}
STOCKS = {s: "xyz:" + s for s in "COST PLTR GME IBM STRC CBRS SKHX MRNA BABA TLT BE ARM LITE EWT EWZ AMAT QCOM LLY NFLX BB".split()}


def _get(req: urllib.request.Request):
    """Read JSON, waiting and retrying when the provider says to slow down (HTTP 429)."""
    for wait in (5, 10, 20, 40, None):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or wait is None:
                raise
            time.sleep(wait)


def post(body: dict):
    return _get(urllib.request.Request(HL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}))


def hl_minutes(coin: str) -> dict[int, float]:
    """UTC minute start -> close, newest 5,000 minutes."""
    now = int(time.time())
    rows = post({"type": "candleSnapshot", "req": {"coin": coin, "interval": "1m", "startTime": (now - 5000 * 60) * 1000, "endTime": now * 1000}}) or []
    return {int(c["t"]) // 1000: float(c["c"]) for c in rows}


def yahoo_minutes(symbol: str, need_volume: bool) -> tuple[dict[int, float], str]:
    """UTC minute start -> close. Futures: minutes that traded (volume > 0; a zero-volume row restates
    the old price). Stocks: every row with a close, as server.py reads extended-hours prints (Yahoo
    reports almost no volume outside regular hours)."""
    res = _get(urllib.request.Request(YAHOO.format(symbol), headers={"User-Agent": "Mozilla/5.0"}))["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    out = {}
    for t, c, v in zip(res.get("timestamp") or [], q["close"], q["volume"]):
        if c and ((v or 0) > 0 or not need_volume):
            out[int(t) // 60 * 60] = float(c)
    return out, res["meta"].get("instrumentType", "")


_volumes: dict[str, dict[str, float]] = {}


def day_volume(coin: str) -> float:
    """24-hour traded value of a perpetual, in dollars (one request per exchange, kept)."""
    dex = coin.split(":")[0] if ":" in coin else ""
    if dex not in _volumes:
        meta, ctx = post({"type": "metaAndAssetCtxs", "dex": dex})
        _volumes[dex] = {u["name"]: float(c.get("dayNtlVlm") or 0) for u, c in zip(meta["universe"], ctx)}
    return _volumes[dex].get(coin, 0.0)


def proxy_at(p: dict[int, float], t: int) -> float | None:
    for back in (0, 60, 120, 180):  # the proxy's last close at or just before t
        if t - back in p:
            return p[t - back]
    return None


def regular(t: int) -> bool:
    d = datetime.fromtimestamp(t, ET)
    return d.weekday() < 5 and 570 <= d.hour * 60 + d.minute < 960


def bp(x: float) -> float:
    return abs(x - 1) * 1e4


def measure(series: dict[int, float], proxy: dict[int, float], keep) -> tuple[list[float], list[float]]:
    """Errors (bp) of projecting ten minutes ahead from the proxy, and of holding the old price."""
    proj, hold = [], []
    for t, s in series.items():
        if not keep(t) or not keep(t + H):
            continue
        later = series.get(t + H)
        a, b = proxy_at(proxy, t), proxy_at(proxy, t + H)
        if later is None or not a or not b:
            continue
        proj.append(bp(s * b / a / later))
        hold.append(bp(s / later))
    return proj, hold


def q90(xs: list[float]) -> float:
    return sorted(xs)[int(0.9 * (len(xs) - 1))]


def check(symbol: str, coin: str, kind: str) -> dict:
    series, itype = yahoo_minutes(symbol, kind == "futures")
    proxy = hl_minutes(coin)
    first = min(proxy) if proxy else 0
    keep = (lambda t: t >= first) if kind == "futures" else (lambda t: t >= first and not regular(t))
    proj, hold = measure(series, proxy, keep)
    row = {"symbol": symbol, "coin": coin, "kind": kind, "pairs": len(proj), "type": itype}
    if len(proj) < MIN_PAIRS:
        return {**row, "verdict": "too few pairs"}
    mp, mh = statistics.median(proj), statistics.median(hold)
    row.update(proj_med=mp, proj_p90=q90(proj), hold_med=mh, hold_p90=q90(hold), gain=mh / mp if mp else float("inf"))
    if kind == "futures":
        ok = row["gain"] >= FUTURE_GAIN
    else:
        row["volume"] = day_volume(coin)
        ok = row["gain"] >= STOCK_GAIN and row["volume"] >= MIN_VOLUME
    row["verdict"] = "keep" if ok else "no"
    return row


def main(argv: list[str]) -> int:
    pairs: list[tuple[str, str, str]] = []
    for a in argv:
        if "=" in a and not a.startswith("--"):
            s, c = a.rsplit("=", 1) if a.count("=") > 1 else a.split("=", 1)
            pairs.append((s, c, "futures" if s.endswith("=F") else "stocks"))
    if not pairs:
        if "--stocks" not in argv:
            pairs += [(s, c, "futures") for s, c in FUTURES.items()]
        if "--futures" not in argv:
            pairs += [(s, c, "stocks") for s, c in STOCKS.items()]
    print(f"{'symbol':8} {'proxy':14} {'pairs':>5}  {'projected med/p90 bp':>21}  {'held med/p90 bp':>16}  {'gain':>5}  {'$/day':>6}  verdict")
    for i, (s, c, kind) in enumerate(pairs):
        if i:
            time.sleep(2)  # Hyperliquid limits requests by weight per minute; a candle request is heavy
        try:
            r = check(s, c, kind)
        except Exception as e:
            print(f"{s:8} {c:14} error: {e}")
            continue
        if "proj_med" not in r:
            print(f"{s:8} {c:14} {r['pairs']:>5}  {r['verdict']}")
            continue
        vol = f"{r['volume'] / 1e6:5.1f}M" if "volume" in r else "     -"
        print(f"{s:8} {c:14} {r['pairs']:>5}  {r['proj_med']:9.1f} / {r['proj_p90']:7.1f}  {r['hold_med']:7.1f} / {r['hold_p90']:6.1f}  {r['gain']:5.1f}  {vol}  {r['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

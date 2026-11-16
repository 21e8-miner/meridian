#!/usr/bin/env python3
"""
Build the shareable static site: a copy of web/ plus a snapshot of exchange history.

A static page has no server to fetch prices for it, and the price feed cannot be read from a
browser. So a scheduled job runs this script: it writes each symbol's recent bars to
<out>/data/<tf>/<symbol>.json, and the page brings them up to the second on its own by projecting
from Hyperliquid, which a browser can read (see web/js/static.js).

    python3 tools/snapshot.py _site            # full build
    python3 tools/snapshot.py _site NQ=F SPY   # just these symbols (for testing)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
_argv, sys.argv = sys.argv, ["server.py"]
import server  # noqa: E402

sys.argv = _argv

# What the shared site can chart. Everything with a live proxy, plus the usual reference symbols.
UNIVERSE = sorted(set(
    list(server.LIVE_PROXY) + list(server.STOCK_PROXY)
    + "YM=F RTY=F HG=F NG=F ZN=F ZB=F 6E=F".split()
    + "IWM DIA TLT XLK XLF XLE XLV XLI XLY XLP XLU SMH XBI KRE ARKK HYG UUP VXX".split()
    + "PLTR NFLX JPM V UNH XOM LLY COST WMT BRK-B AVGO CRM ADBE QCOM IBM BA DIS".split()
    + "BTC-USD ETH-USD SOL-USD".split()
))
# timeframe -> how many of the most recent bars to keep (15m and 30m are built from 5m in the page)
KEEP = {"1m": 1500, "5m": 3200, "1h": 3000, "1d": 2520}


def safe(symbol: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-._" else "_" for ch in symbol)


def fetch(symbol: str, tf: str, tries: int = 4):
    for k in range(tries):
        try:
            return server._fetch_yahoo(symbol, tf)
        except Exception as e:
            msg = str(e)
            if ("429" in msg or "timed out" in msg) and k < tries - 1:
                time.sleep(6 * (k + 1))
                continue
            raise


def ext_prints(symbol: str, out: str, after: int) -> int:
    """Pre-market and after-hours prints since the last regular bar, for stocks. Small: only the
    stretch the page has to continue past the close."""
    d = fetch(symbol, "x1m")
    rows = [i for i, t in enumerate(d["t"]) if t > after]
    slim = {"symbol": symbol, "tf": "x1m", **{col: [d[col][i] for i in rows] for col in "tohlcv"}, "meta": d["meta"]}
    with open(os.path.join(out, "data", "x1m", safe(symbol) + ".json"), "w") as f:
        json.dump(slim, f, separators=(",", ":"))
    return len(rows)


def one(job):
    symbol, tf, out = job
    try:
        d = fetch(symbol, tf)
        n = len(d["t"])
        keep = KEEP[tf]
        if tf == "1m" and d["meta"].get("type") in server.STOCK_TYPES:
            try:
                ext_prints(symbol, out, d["t"][-1])
            except Exception as e:
                print(f"  no extended-hours prints for {symbol}: {e}")
        for col in ("t", "o", "h", "l", "c", "v", "a"):
            if col in d:
                d[col] = d[col][-keep:]
        d.pop("fetched", None)
        path = os.path.join(out, "data", tf, safe(symbol) + ".json")
        with open(path, "w") as f:
            json.dump(d, f, separators=(",", ":"))
        return symbol, tf, min(n, keep), d["meta"], None
    except Exception as e:
        return symbol, tf, 0, None, str(e) or e.__class__.__name__


def main():
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "_site")
    symbols = [s.upper() for s in sys.argv[2:]] or UNIVERSE
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(os.path.join(ROOT, "web"), out)
    for tf in list(KEEP) + ["x1m"]:
        os.makedirs(os.path.join(out, "data", tf), exist_ok=True)
    t0 = time.time()
    jobs = [(s, tf, out) for s in symbols for tf in KEEP]
    info: dict[str, dict] = {}
    failed = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for symbol, tf, n, meta, err in pool.map(one, jobs):
            if err:
                failed.append(f"{symbol} {tf}: {err}")
                continue
            e = info.setdefault(symbol, {"symbol": symbol, "name": meta["name"], "type": meta["type"], "exch": meta["exchange"], "tfs": []})
            e["tfs"].append(tf)
    index = {
        "generated": int(time.time()),
        "symbols": [info[s] for s in symbols if s in info],
        "live": server.LIVE_PROXY,
        "stocks": server.STOCK_PROXY,
        "file": {s: safe(s) for s in info},
    }
    with open(os.path.join(out, "data", "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    open(os.path.join(out, ".nojekyll"), "w").close()
    size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fns in os.walk(os.path.join(out, "data")) for fn in fns)
    print(f"{len(info)} of {len(symbols)} symbols, {len(jobs) - len(failed)} of {len(jobs)} series, {size / 1e6:.1f} MB, {time.time() - t0:.0f} s")
    for line in failed[:40]:
        print("  failed:", line)
    # a build with most of its data missing must not replace a good one
    if len(failed) > len(jobs) * 0.25:
        sys.exit(f"too many failures ({len(failed)} of {len(jobs)}); not publishing")


if __name__ == "__main__":
    main()

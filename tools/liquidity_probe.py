#!/usr/bin/env python3
"""
Measure how much each candidate symbol trades, so the shared page can add only the ones worth
charting. For each symbol: one small request (a month of daily bars) gives the average dollar
volume of its last 20 sessions, its type, and when it first traded (how much history it has).

    python3 tools/liquidity_probe.py candidates.json liquidity.json

candidates.json is {"stocks": [...], "etfs": [...]}. Results are written as they come in, and a
re-run skips symbols already measured, so it can be stopped and resumed. It is paced to stay under
the provider's rate limit and backs off when told to slow down.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = "Mozilla/5.0"  # the provider rate-limits long browser-style agents
PAUSE = 0.15        # seconds between requests per worker
WORKERS = 3


def probe(symbol: str) -> dict:
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol, safe="")
           + "?interval=1d&range=1mo&includePrePost=false")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        doc = json.loads(r.read().decode("utf-8"))
    res = ((doc.get("chart") or {}).get("result") or [None])[0]
    if not res:
        return {"dv": 0, "gone": True}
    meta, q = res.get("meta") or {}, (((res.get("indicators") or {}).get("quote") or [{}])[0])
    c, v = q.get("close") or [], q.get("volume") or []
    rows = [(x, y) for x, y in zip(c, v) if x is not None and y is not None][-21:-1] or [(x, y) for x, y in zip(c, v) if x is not None and y is not None]
    dv = sum(x * y for x, y in rows) / len(rows) if rows else 0
    return {"dv": round(dv), "type": meta.get("instrumentType") or "", "first": meta.get("firstTradeDate"), "name": meta.get("longName") or meta.get("shortName") or "", "cur": meta.get("currency") or ""}


def main():
    src, out = sys.argv[1], sys.argv[2]
    with open(src) as f:
        cand = json.load(f)
    syms = [s for k in ("stocks", "etfs") for s in cand.get(k, [])]
    done = {}
    if os.path.exists(out):
        with open(out) as f:
            done = json.load(f)
    todo = [s for s in syms if s not in done]
    lock, n, t0, backoff = threading.Lock(), [0], time.time(), [0.0]
    print(f"{len(todo)} to measure ({len(done)} already)", flush=True)

    def save():
        tmp = out + ".tmp"
        with open(tmp, "w") as f:
            json.dump(done, f, separators=(",", ":"))
        os.replace(tmp, out)

    def one(s):
        for k in range(5):
            wait = backoff[0] - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                r = probe(s)
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    with lock:
                        backoff[0] = max(backoff[0], time.time() + 30 * (k + 1))
                    continue
                r = {"dv": 0, "gone": e.code == 404}
                break
            except Exception:
                time.sleep(2 * (k + 1))
                r = None
        if r is None:
            return
        with lock:
            done[s] = r
            n[0] += 1
            if n[0] % 200 == 0:
                save()
                print(f"  {n[0]} of {len(todo)}, {time.time() - t0:.0f} s", flush=True)
        time.sleep(PAUSE)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(one, todo))
    save()
    print(f"done: {len(done)} measured, {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main()

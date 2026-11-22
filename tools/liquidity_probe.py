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
    kind = meta.get("instrumentType") or ""
    out = {"type": kind, "first": meta.get("firstTradeDate"), "name": meta.get("longName") or meta.get("shortName") or "", "cur": meta.get("currency") or ""}
    return {"dv": round(dollar_volume(c, v, kind)), **out}


def dollar_volume(closes, volumes, kind: str) -> float:
    """Average value traded a day over the 20 finished sessions before the newest bar (which may
    still be forming). Shares x price for stocks and funds; a coin's volume already comes in
    dollars, so multiplying it by the price again would drop every cheap, heavily traded coin and
    keep expensive thin ones. With a single bar (a listing's first day) that bar is all there is."""
    rows = [(x, y) for x, y in zip(closes, volumes) if x is not None and y is not None]
    rows = rows[-21:-1] or rows
    if not rows:
        return 0.0
    return sum((y if kind == "CRYPTOCURRENCY" else x * y) for x, y in rows) / len(rows)


def measure(symbol: str, ask, backoff: list, lock, sleep=time.sleep, tries: int = 5):
    """One symbol's measurement, or None if the provider gave no answer in `tries` attempts.
    Only an answer is recorded. "No such symbol" (404) is one; a throttle, a server error or a
    network failure is not: the symbol stays unmeasured and the next run asks again. (A transient
    502 recorded as "trades nothing" would keep a symbol out of the lists for good, since a re-run
    skips what is already measured.) `backoff[0]` is when all workers may ask again after a 429."""
    for k in range(tries):
        wait = backoff[0] - time.time()
        if wait > 0:
            sleep(wait)
        try:
            return ask(symbol)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return {"dv": 0, "gone": True}
            if e.code == 429:
                with lock:
                    backoff[0] = max(backoff[0], time.time() + 30 * (k + 1))
            else:
                sleep(2 * (k + 1))
        except Exception:
            sleep(2 * (k + 1))
    return None


def main():
    src, out = sys.argv[1], sys.argv[2]
    with open(src) as f:
        cand = json.load(f)
    syms = list(dict.fromkeys(s for k in ("stocks", "etfs", "coins") for s in cand.get(k, [])))
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

    missed, stop, run = [], threading.Event(), [0]  # run: misses in a row

    def one(s):
        if stop.is_set():
            missed.append(s)
            return
        r = measure(s, probe, backoff, lock)
        if r is None:
            with lock:
                missed.append(s)
                run[0] += 1
                if run[0] >= 10:
                    stop.set()  # the provider has stopped answering: do not spend weeks on it
            return
        with lock:
            run[0] = 0
        with lock:
            done[s] = r
            n[0] += 1
            if n[0] % 200 == 0:
                save()
                print(f"  {n[0]} of {len(todo)}, {time.time() - t0:.0f} s", flush=True)
        time.sleep(PAUSE)

    try:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            list(pool.map(one, todo))
    finally:
        save()  # whatever was measured is kept, also when the run is interrupted
    print(f"done: {len(done)} measured, {time.time() - t0:.0f} s", flush=True)
    if missed:
        # unmeasured is not "trades nothing": say so, and fail, so the lists are not built on a partial run
        print(f"{len(missed)} got no answer and are NOT measured{' (stopped: the provider is not answering)' if stop.is_set() else ''}: {' '.join(missed[:20])}{' ...' if len(missed) > 20 else ''}; run again", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

"""python3 tests/make_parity.py — writes tests/parity.json: inputs and server.py's outputs for the
live-fill functions. tests/parity.mjs runs the browser port (web/js/static.js) on the same inputs.
Re-run this whenever that logic changes in server.py."""
import json, os, random, sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.argv = ["server.py"]
import server

rnd = random.Random(11)
cases = []
def add(fn, args, out): cases.append({"fn": fn, "args": args, "out": out})
ET = server.ET
def ts(*a): return int(datetime(*a, tzinfo=ET).timestamp())            # a wall-clock time in New York -> UTC seconds
def wall(utc): return utc + int(datetime.fromtimestamp(utc, ET).utcoffset().total_seconds())

# 1. sessions: every 37 minutes across a winter week and a summer week
for start in (ts(2026, 11, 13, 0, 0), ts(2026, 7, 9, 0, 0)):
    for k in range(0, 8 * 24 * 60, 37):
        u = start + k * 60
        for sym in ("NQ=F", "EURUSD=X", "SPY", "BTC-USD", "XYZ:XYZ100"):
            for lag in (0, 20):
                add("sessionOpen", [sym, u, lag], server.session_open(sym, datetime.fromtimestamp(u, ET), lag=lag))

def series(t0, n, step, p0, tf, sym="NQ=F", typ="FUTURE", asof=None, zero_tail=0):
    T, O, H, L, C, V, p = [], [], [], [], [], [], p0
    for i in range(n):
        o = p; c = round(o * (1 + rnd.uniform(-0.0015, 0.0015)), 2); hi = round(max(o, c) * (1 + rnd.uniform(0, 0.0006)), 2); lo = round(min(o, c) * (1 - rnd.uniform(0, 0.0006)), 2)
        T.append(t0 + i * step); O.append(o); H.append(hi); L.append(lo); C.append(c); V.append(0 if i >= n - zero_tail else rnd.randint(5, 900)); p = c
    return {"symbol": sym, "tf": tf, "t": T, "o": O, "h": H, "l": L, "c": C, "v": V, "meta": {"tz": "America/New_York", "type": typ, "asof": asof}}
def proxy(u0, n, p0):
    rows, p = [], p0
    for i in range(n):
        o = p; c = round(o * (1 + rnd.uniform(-0.001, 0.001)), 1); rows.append([u0 + 60 * i, o, round(max(o, c) + rnd.uniform(0, 3), 1), round(min(o, c) - rnd.uniform(0, 3), 1), c]); p = c
    return rows

# 2. futures: the delayed stretch projected, on each timeframe, winter and summer (DST), with and without a shared anchor
for (y, mo, d) in ((2026, 11, 17), (2026, 7, 14)):
    u10 = ts(y, mo, d, 10, 0); w10 = wall(u10); now = u10 + 14 * 60 + 20
    px = proxy(u10 - 40 * 60, 56, 20100.0)
    m1 = series(w10 - 30 * 60, 33, 60, 20000.0, "1m", asof=u10 + 150)
    anc = server.anchor_from_1m(m1)
    add("anchorFrom1m", [m1], list(anc))
    for tf, step, n in (("1m", 60, 33), ("5m", 300, 7), ("15m", 900, 3), ("1h", 3600, 2)):
        b = series(w10 - (n - 1) * step, n, step, 20000.0, tf, asof=u10 + 150) if tf != "1m" else m1
        add("liveAnchor", [b, tf], list(server.live_anchor(b, tf)))
        for a in (None, list(anc)):
            add("spliceLive", [b, px, "NQ=F", tf, "xyz:XYZ100", now, a], server.splice_live(b, [tuple(r) for r in px], "NQ=F", tf, "xyz:XYZ100", now, tuple(a) if a else None))
    day = (w10 // 86400) * 86400
    dd = series(day - 4 * 86400, 5, 86400, 19800.0, "1d", asof=u10 + 150)
    add("liveAnchor", [dd, "1d"], list(server.live_anchor(dd, "1d")))
    add("spliceLive", [dd, px, "NQ=F", "1d", "xyz:XYZ100", now, list(anc)], server.splice_live(dd, [tuple(r) for r in px], "NQ=F", "1d", "xyz:XYZ100", now, anc))
    # restated zero-volume rows at the end, and the daily 17:00-18:00 break
    st = series(w10 - 6 * 300, 9, 300, 20000.0, "5m", asof=u10 + 900, zero_tail=2)
    add("spliceLive", [st, px, "NQ=F", "5m", "xyz:XYZ100", now, None], server.splice_live(st, [tuple(r) for r in px], "NQ=F", "5m", "xyz:XYZ100", now))
    u1655 = ts(y, mo, d, 16, 55); br = series(wall(u1655) - 300, 2, 300, 20000.0, "5m", asof=u1655 + 290); pb = proxy(u1655 - 600, 95, 20100.0)
    add("spliceLive", [br, pb, "NQ=F", "5m", "xyz:XYZ100", u1655 + 80 * 60, [wall(u1655) + 240, 20010.0]], server.splice_live(br, [tuple(r) for r in pb], "NQ=F", "5m", "xyz:XYZ100", u1655 + 80 * 60, (wall(u1655) + 240, 20010.0)))
    add("spliceLive", [b, [[u10 + 7200, 1, 1, 1, 1]], "NQ=F", "1h", "xyz:XYZ100", now, None], server.splice_live(b, [(u10 + 7200, 1, 1, 1, 1)], "NQ=F", "1h", "xyz:XYZ100", now))

    # 3. stocks outside regular hours
    u16 = ts(y, mo, d, 16, 0); c16 = wall(u16); nowx = u16 + 47 * 60 + 15
    pxs = proxy(u16 - 10 * 60, 70, 163.0)
    ext = [[c16 + 60 * k, 162.0 + k * 0.01, 162.2 + k * 0.01, 161.9 + k * 0.01, 162.05 + k * 0.01, 0] for k in (0, 1, 2, 9, 10, 31, 44)]
    wpx = [[wall(r[0]), *r[1:]] for r in pxs]
    for e, p in ((ext, wpx), ([], wpx), (ext, []), (ext[:2], wpx)):
        mins, last = server.stock_minutes(c16, 162.5, [tuple(r) for r in e], [tuple(r) for r in p], wall(nowx))
        add("stockMinutes", [c16, 162.5, e, p, wall(nowx)], [[list(m) for m in mins], last])
    extd = {k: [r[i] for r in ext] for i, k in enumerate("tohlcv")}
    for tf, step, n in (("1m", 60, 12), ("5m", 300, 5), ("30m", 1800, 3), ("1h", 3600, 3)):
        rth = series(c16 - n * step, n, step, 162.0, tf, sym="NVDA", typ="EQUITY")
        add("spliceExt", [rth, extd, pxs, tf, "xyz:NVDA", nowx], server.splice_ext(rth, extd, [tuple(r) for r in pxs], tf, "xyz:NVDA", nowx))
        add("spliceExt", [rth, extd, [], tf, None, nowx], server.splice_ext(rth, extd, [], tf, None, nowx))
        add("spliceExt", [rth, {k: [] for k in "tohlcv"}, pxs, tf, "xyz:NVDA", nowx], server.splice_ext(rth, {k: [] for k in "tohlcv"}, [tuple(r) for r in pxs], tf, "xyz:NVDA", nowx))
    rd = series(day - 3 * 86400, 4, 86400, 160.0, "1d", sym="NVDA", typ="EQUITY"); rd["a"] = [x * 0.99 for x in rd["c"]]
    add("spliceExt", [rd, extd, pxs, "1d", "xyz:NVDA", nowx], server.splice_ext(rd, extd, [tuple(r) for r in pxs], "1d", "xyz:NVDA", nowx))
    k = len(rth["t"]) - 1
    mins, _ = server.stock_minutes(rth["t"][k] + 3600, rth["c"][k], [tuple(r) for r in ext], [tuple(r) for r in wpx], wall(nowx))
    cols, partial, added, runs = server._merge_minutes(rth, k, mins, "1h")
    add("mergeMinutes", [rth, k, [list(m) for m in mins], "1h"], {"cols": dict(zip("tohlcv", cols)), "partial": partial, "added": added, "runs": runs})

# 4. live-market candles
cand = [{"t": 1794785400000 + 60000 * i, "o": str(28095.0 + i), "h": str(28099.5 + i), "l": str(28086.25 + i), "c": str(28089.0 + i * 1.5), "v": str(2.9 + i), "n": 3} for i in range(6)]
for nowc in (1794785400 + 5 * 60 + 20, 1794785400 + 9 * 60):
    d = server.parse_hl(cand, "XYZ:XYZ100", "xyz:XYZ100", "1m", now=nowc); d.pop("fetched")
    add("parseHl", [cand, "XYZ:XYZ100", "xyz:XYZ100", "1m", nowc], d)
for s in ("XYZ:XYZ100", "xyz:nvda", "NQ=F", "XYZ:", "SPY"):
    add("hlCoin", [s], server.hl_coin(s))
for x in (28095.12345, 162.123456, 0.123456789, 1.00005, 99.99995, 100.0005, 3886.300048828125, 0.0625, 7583.0):
    add("round", [x], server._round(x))

# market summary rows (tools/snapshot.py: pack_row) against web/js/markets.js: packFromBars / decodePack
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import snapshot
def dec(row):
    t = [row["d0"] * 86400]
    for g in row["dd"]: t.append(t[-1] + g * 86400)
    return {"t": t, "c": row["c"], "dv": row["dv"]}
for n, every_day, kind in ((700, False, "EQUITY"), (700, True, "CRYPTOCURRENCY"), (300, False, "ETF"), (300, False, "FUTURE"), (300, False, "INDEX"), (40, False, "EQUITY"), (22, False, "EQUITY"), (21, False, "ETF"), (2, False, "EQUITY"), (1, False, "EQUITY"), (30, True, "CURRENCY"), (30, False, None)):
    day, T, C, V, p = 19000, [], [], [], 40 + rnd.random() * 400
    while len(T) < n:
        if every_day or day % 7 not in (2, 3):  # 1970-01-03 and -04 were a weekend
            if rnd.random() > 0.02:              # the odd holiday
                p *= 1 + rnd.gauss(0, 0.02); T.append(day * 86400); C.append(server._round(p)); V.append(int(rnd.random() * 9e7))
        day += 1
    bars = {"t": T, "c": C, "v": V, "meta": {"type": kind} if kind else {}}
    row = snapshot.pack_row(bars)
    add("pack", [bars, {k: row[k] for k in ("d0", "dd", "c", "dv")}], {"fromBars": dec(row), "decoded": dec(row)})

# the published file format (tools/snapshot.py: encode_series) against web/js/static.js: decodeSeries
for tf, step, n, div in (("1d", 86400, 900, True), ("1d", 86400, 300, False), ("1h", 3600, 400, False), ("5m", 300, 500, False), ("x1m", 60, 120, False)):
    t, c, a, p, f = [], [], [], 50 + rnd.random() * 300, 0.9
    cur = 1_700_000_000 // step * step
    for i in range(n):
        cur += step * (1 if rnd.random() > 0.2 else rnd.choice((2, 3, 64)))
        p *= 1 + rnd.gauss(0, 0.01)
        if div and i % 63 == 0: f *= 1.004
        t.append(cur); c.append(server._round(p)); a.append(server._round(p * min(1.0, f)))
    d = {"symbol": "P", "tf": tf, "t": t, "o": c, "h": c, "l": c, "c": c, "v": [int(rnd.random() * 1e6) for _ in t], "meta": {"type": "EQUITY"}}
    if div: d["a"] = a
    e = snapshot.encode_series(d)
    add("decode", [e], snapshot.decode_series(json.loads(json.dumps(e))))
add("decode", [{"symbol": "Q", "tf": "1d", "t": [1, 2], "c": [1, 2]}], {"symbol": "Q", "tf": "1d", "t": [1, 2], "c": [1, 2]})

json.dump({"note": "generated by tests/make_parity.py from server.py; do not edit", "cases": cases}, open(os.path.join(os.path.dirname(__file__), "parity.json"), "w"), separators=(",", ":"))
from collections import Counter
print(len(cases), "cases:", dict(Counter(c["fn"] for c in cases)), "| live results with a fill:", sum(1 for c in cases if isinstance(c["out"], dict) and c["out"].get("live")))

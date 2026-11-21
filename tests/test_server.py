"""Run: python3 tests/test_server.py — parsing of provider chart documents (no network)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.argv = ["server.py"]
import server

fails = 0
def check(name, cond, extra=""):
    global fails
    if not cond: fails += 1
    print(("ok   " if cond else "FAIL ") + name, extra)

def doc(ts, rows, tz="America/New_York", adj=None):
    q = {k: [r[i] for r in rows] for i, k in enumerate(["open", "high", "low", "close", "volume"])}
    ind = {"quote": [q]}
    if adj is not None: ind["adjclose"] = [{"adjclose": adj}]
    return {"chart": {"result": [{"meta": {"exchangeTimezoneName": tz, "longName": "Test"}, "timestamp": ts, "indicators": ind}], "error": None}}

# 2026-11-13 is in EST (UTC-5): 14:30Z = 09:30 local.
base = 1794580200
ts = [base + 300 * i for i in range(4)] + [base + 300 * 4]
rows = [[10, 11, 9, 10.5, 100], [10.5, 12, 10, 11, 200], [None, None, None, None, None], [11, 11.5, 10.8, 11.2, 300], [11.3, 11.3, 11.3, 11.3, 0]]
b = server.parse_chart(doc(ts, rows), "T", "5m")
check("null rows dropped, stub folded", len(b["t"]) == 3, str(len(b["t"])))
check("stub close carried into last bar", b["c"][-1] == 11.3 and b["h"][-1] == 11.5 and b["v"][-1] == 300)
check("wall-clock time", b["t"][0] % 86400 == 9 * 3600 + 30 * 60, str(b["t"][0] % 86400))
check("no adj on intraday", "a" not in b)
# a real last bar (has volume, on the grid) is kept
rows2 = rows[:4] + [[11.3, 11.6, 11.1, 11.4, 50]]
check("real last bar kept", len(server.parse_chart(doc(ts, rows2), "T", "5m")["t"]) == 4)
# 24h market: live price row off the grid folds into the forming bar
ts3 = [1794780000, 1794780900, 1794781296]
b3 = server.parse_chart(doc(ts3, [[5, 6, 4, 5.5, 10], [5.5, 5.8, 5.4, 5.6, 20], [5.9, 5.9, 5.9, 5.9, 0]], tz="UTC"), "X-USD", "15m")
check("off-grid live row folded", len(b3["t"]) == 2 and b3["c"][-1] == 5.9 and b3["h"][-1] == 5.9)
# a symbol that never reports volume (index, FX): a flat newest bar on the grid is a real bar
ts4 = [base + 300 * i for i in range(4)]
b4 = server.parse_chart(doc(ts4, [[20, 20.5, 19.9, 20.2, 0], [20.2, 20.6, 20.1, 20.3, 0], [20.3, 20.5, 20.2, 20.4, 0], [21, 21, 21, 21, 0]]), "^IDX", "5m")
check("zero-volume symbol keeps a flat newest bar", len(b4["t"]) == 4 and b4["c"][2] == 20.4 and b4["c"][3] == 21, str(b4["c"]))
# daily: local-midnight stamps, duplicate session row merged, adjusted close kept
d0 = 1794407400  # 2026-11-11 14:30Z
tsd = [d0, d0 + 86400, d0 + 86400 + 23400]
bd = server.parse_chart(doc(tsd, [[10, 11, 9, 10, 100], [10, 12, 10, 11, 150], [10, 12.5, 10, 11.5, 180]], adj=[9.5, 11, 11.5]), "T", "1d")
check("daily at local midnight", all(t % 86400 == 0 for t in bd["t"]) and len(bd["t"]) == 2, str(bd["t"]))
check("daily duplicate merged", bd["c"][-1] == 11.5 and bd["h"][-1] == 12.5 and bd["v"][-1] == 180)
check("adjusted close kept", bd.get("a") == [9.5, 11.5], str(bd.get("a")))
check("no adj column when identical", "a" not in server.parse_chart(doc(tsd[:2], [[10, 11, 9, 10, 100], [10, 12, 10, 11, 150]], adj=[10, 11]), "T", "1d"))
# first tick of a new session: an off-grid row two days after the last bar starts a new bar,
# it must not be folded into Friday's final bar
fri = 1794607200 - 300  # Fri 16:55 ET as UTC seconds
two = [[10, 11, 9, 10, 5], [10, 12, 10, 11, 7]]
b5 = server.parse_chart(doc([fri - 300, fri, fri + 299], two + [[11.5, 11.5, 11.5, 11.5, 0]]), "NQ=F", "5m")
check("session-end snapshot folds into the final bar", b5["c"] == [10, 11.5] and len(b5["t"]) == 2, str(b5["c"]))
# the provider pads closed hours with null rows, then stamps the first tick off the grid
gap = [fri + 300 * k for k in range(1, 4)]
b6 = server.parse_chart(doc([fri - 300, fri] + gap + [fri + 176431], two + [[None] * 5] * 3 + [[12, 12, 12, 12, 0]]), "NQ=F", "5m")
check("first tick of the next session starts its own bar, on the grid", b6["c"] == [10, 11, 12] and (b6["t"][2] - b6["t"][1]) % 300 == 0 and 176100 < b6["t"][2] - b6["t"][1] <= 176431, str(b6["t"]))
# with the session end known, a flat zero-volume bar before the close is a real (quiet) bar
def doc_end(ts, rows, end):
    d = doc(ts, rows); d["chart"]["result"][0]["meta"]["currentTradingPeriod"] = {"regular": {"start": ts[0], "end": end}}; return d
quiet = [[10, 11, 9, 10.5, 100], [10.5, 12, 10, 11, 200], [11, 11, 11, 11, 0]]
check("quiet bar before the close is kept", len(server.parse_chart(doc_end(ts[:3], quiet, ts[2] + 3000), "T", "5m")["t"]) == 3)
check("closing print at the session end is folded", len(server.parse_chart(doc_end(ts[:3], quiet, ts[2]), "T", "5m")["t"]) == 2)
check("1m timeframe parses", len(server.parse_chart(doc([base, base + 60, base + 120], rows[:2] + [rows[3]]), "T", "1m")["t"]) == 3)
check("last-trade time is passed through", server.parse_chart({"chart": {"result": [{"meta": {"regularMarketTime": 123}, "timestamp": ts[:2], "indicators": {"quote": [{"open": [1, 1], "high": [1, 1], "low": [1, 1], "close": [1, 1], "volume": [1, 1]}]}}]}}, "T", "5m")["meta"]["asof"] == 123)
# sessions: futures and currencies trade when stocks do not
from datetime import datetime
from zoneinfo import ZoneInfo
ET = ZoneInfo("America/New_York")
at = lambda *a: datetime(*a, tzinfo=ET)
sun_1810, sun_1700, sat, fri_1710, fri_1730, tue_0300, tue_1730, tue_1000, tue_1700 = at(2026, 11, 15, 18, 10), at(2026, 11, 15, 17, 0), at(2026, 11, 14, 12, 0), at(2026, 11, 13, 17, 10), at(2026, 11, 13, 17, 30), at(2026, 11, 17, 3, 0), at(2026, 11, 17, 17, 30), at(2026, 11, 17, 10, 0), at(2026, 11, 17, 17, 0)
so = server.session_open
check("futures: open Sunday evening and overnight", so("NQ=F", sun_1810) and so("ES=F", tue_0300) and so("NQ=F", tue_1000))
check("futures: shut Saturday, before the Sunday open, and in the daily break", not so("NQ=F", sat) and not so("NQ=F", sun_1700) and not so("NQ=F", tue_1730) and not so("NQ=F", fri_1730))
check("futures: delayed bars still collected just after the close", so("NQ=F", fri_1710) and so("NQ=F", tue_1700))
check("currencies: open Sunday 17:00 through Friday 17:00", so("EURUSD=X", sun_1700) and so("EURUSD=X", tue_1730) and not so("EURUSD=X", sat) and not so("EURUSD=X", fri_1730))
check("stocks: regular hours only", so("SPY", tue_1000) and not so("SPY", tue_0300) and not so("SPY", sun_1810) and not so("SPY", tue_1730))
check("crypto: always", so("BTC-USD", sat))
check("responses are stamped open/closed without touching the cache", "open" in server._trim(bd, 0)["meta"] and "open" not in bd["meta"])
# ── live fill: project the minutes the delayed feed has not published yet from a live market ──
# 5-minute bars to 10:00 ET (exchange data), proxy 1-minute candles to 10:12. 2026-11-17 is a Tuesday.
t10 = 1794927600 + 300 * 0          # 2026-11-17 10:00 ET as wall-clock seconds
utc = lambda w: w + 5 * 3600        # EST
def mk(ts, closes, vols=None, asof=None, tf="5m"):
    return {"symbol": "NQ=F", "tf": tf, "t": list(ts), "o": list(closes), "h": [c + 1 for c in closes], "l": [c - 1 for c in closes], "c": list(closes), "v": list(vols or [10] * len(ts)), "meta": {"tz": "America/New_York", "asof": asof}, "fetched": 0}
bars5 = mk([t10 - 600, t10 - 300, t10], [20000, 20010, 20020], asof=utc(t10 + 150))
# proxy trades 0.5% above the future and then rises 1% over the next 12 minutes
prox = [(utc(t10 - 300 + 60 * k), 20100 + 10 * k, 20100 + 10 * k + 5, 20100 + 10 * k - 5, 20100 + 10 * (k + 1)) for k in range(20)]
anchor = (t10 + 120, 20030.0)       # last complete 1m bar closed 10:02 at 20030
pclose = dict((u, c) for (u, o, h, l, c) in prox)[utc(t10 + 60)]   # proxy close of the 10:01 minute
out = server.splice_live(bars5, prox, "NQ=F", "5m", "xyz:XYZ100", utc(t10 + 15 * 60) - 30, anchor)
lv = out["live"]
check("live fill extends the series on the bar grid", out["t"][-1] == t10 + 600 and all((b - a) == 300 for a, b in zip(out["t"], out["t"][1:])), str(out["t"][-3:]))
check("projection = exchange price x proxy move since the anchor", abs(out["c"][-1] - 20030.0 * prox[-1][4] / pclose) < 0.01, f"{out['c'][-1]} vs {20030.0 * prox[-1][4] / pclose:.3f}")
check("a standing premium on the proxy cancels out", abs(out["c"][-1] / 20030.0 - prox[-1][4] / pclose) < 1e-6 and out["c"][-1] < prox[-1][4])
check("the forming exchange bar is updated, later bars are added with zero volume", lv["partial"] and lv["from"] == t10 and lv["bars"] == 2 and out["v"][-2:] == [0, 0] and out["v"][2] == 10)
check("exchange bars before the anchor are untouched", out["c"][:2] == [20000, 20010] and out["o"][2] == 20020 and bars5["c"][-1] == 20020 and "live" not in bars5)
check("estimate bars are well formed", all(out["l"][i] <= min(out["o"][i], out["c"][i]) and out["h"][i] >= max(out["o"][i], out["c"][i]) for i in range(len(out["t"]))))
# every timeframe scaled from the same print shows the same price
b1 = mk([t10 + 60 * k for k in range(-3, 2)], [20005, 20015, 20020, 20025, 20030], asof=utc(t10 + 150), tf="1m")
check("the 1-minute anchor skips the bar still forming", server.anchor_from_1m(mk([t10, t10 + 60, t10 + 120], [1, 2, 3], asof=utc(t10 + 150), tf="1m")) == (t10 + 120, 2) and server.anchor_from_1m(b1) == (t10 + 120, 20030))
o1 = server.splice_live(b1, prox, "NQ=F", "1m", "xyz:XYZ100", utc(t10 + 15 * 60) - 30, server.anchor_from_1m(b1))
d1 = mk([t10 - t10 % 86400 - 86400, t10 - t10 % 86400], [19900, 20020], asof=utc(t10 + 150), tf="1d")
od = server.splice_live(d1, prox, "NQ=F", "1d", "xyz:XYZ100", utc(t10 + 15 * 60) - 30, anchor)
check("1m, 5m and daily agree on the live price", o1["c"][-1] == out["c"][-1] == od["c"][-1], f"{o1['c'][-1]} {out['c'][-1]} {od['c'][-1]}")
check("1m: one new bar per minute after the anchor", o1["live"]["bars"] == len([1 for (u, *_r) in prox if u >= utc(t10 + 120)]) and not o1["live"]["partial"] and o1["t"][-1] == t10 + 840)
check("daily: today's bar is updated, not duplicated", len(od["t"]) == 2 and od["live"]["partial"] and od["live"]["bars"] == 0)
# zero-volume rows after the last trade are restatements: the fill starts from the last real bar
stale = mk([t10 - 300, t10, t10 + 300], [20010, 20020, 20020], vols=[10, 10, 0], asof=utc(t10 + 900))
os_ = server.splice_live(stale, prox, "NQ=F", "5m", "xyz:XYZ100", utc(t10 + 15 * 60) - 30)
check("restated zero-volume rows are replaced by the projection", os_["live"]["from"] == t10 + 300 and os_["c"][2] != 20020 and os_["t"].count(t10 + 300) == 1)
# nothing to scale from -> the delayed bars are returned as they are
check("no proxy candle at the anchor: data is left alone", server.splice_live(bars5, [(utc(t10 + 3600), 1, 1, 1, 1)], "NQ=F", "5m", "xyz:XYZ100", utc(t10 + 4000), anchor) is bars5 and server.splice_live(bars5, [], "NQ=F", "5m", "x", 0) is bars5)
# estimates are only made for minutes the market is open (17:00-18:00 ET is the daily break)
t1655 = t10 + 6 * 3600 + 55 * 60
brk = mk([t1655 - 300, t1655], [20000, 20010], asof=utc(t1655 + 290))
pb = [(utc(t1655 + 60 * k), 20100, 20105, 20095, 20100 + k) for k in range(0, 80)]
ob = server.splice_live(brk, pb, "NQ=F", "5m", "xyz:XYZ100", utc(t1655 + 80 * 60), (t1655 + 240, 20010.0))
check("no estimated bars inside the daily break", all(not (t10 - t10 % 86400 + 17 * 3600 <= t < t10 - t10 % 86400 + 18 * 3600) for t in ob["t"]) and ob["t"][-1] >= t10 - t10 % 86400 + 18 * 3600, str([(t % 86400) // 60 for t in ob["t"][-4:]]))
check("strict hours for estimates, grace period for collecting delayed bars", so("NQ=F", tue_1700) and not so("NQ=F", tue_1700, lag=0))
# direct live markets
check("live market symbols", server.hl_coin("XYZ:XYZ100") == "xyz:XYZ100" and server.hl_coin("xyz:nvda") == "xyz:NVDA" and server.hl_coin("NQ=F") is None and server.hl_coin("XYZ:") is None and so("XYZ:XYZ100", sat))
hl = server.parse_hl([{"t": 1794785400000, "o": "28095.0", "h": "28096.0", "l": "28086.0", "c": "28089.0", "v": "2.9", "n": 38}, {"t": 1794785460000, "o": "28089.0", "h": "28090.0", "l": "28080.0", "c": "28081.0", "v": "1.5", "n": 9}], "XYZ:XYZ100", "xyz:XYZ100", "1m", now=1794785490)
check("live market candles parse", hl["t"] == [1794785400, 1794785460] and hl["c"] == [28089.0, 28081.0] and hl["meta"]["tz"] == "UTC" and hl["meta"]["asof"] == 1794785490 and hl["v"][0] == 2.9)
check("a futures session that starts Sunday evening is Monday's daily bar", server.parse_chart(doc([1794784882], [[28062.5, 28200, 28050, 28156.75, 8062]]), "NQ=F", "1d")["t"][0] == 1794787200 and server.parse_chart(doc([1794784882], [[1, 1, 1, 1, 5]]), "SPY", "1d")["t"][0] == 1794700800)
# ── stocks outside regular hours: real extended-hours prints, gaps projected from a proxy ──
c16 = t10 + 6 * 3600                 # Tuesday 16:00 ET, the regular close
PX = lambda w, p: (w, p, p + 0.2, p - 0.2, p, 0)                    # an extended-hours print
prx = [(c16 - 300 + 60 * k, 200 + k * 0.1, 200 + k * 0.1 + 0.05, 200 + k * 0.1 - 0.05, 200 + (k + 1) * 0.1) for k in range(0, 200)]   # proxy, wall-clock, drifting up
pc = {r[0]: r[4] for r in prx}
# prints at 16:00, 16:01 and 16:30; nothing in between
mins, last_real = server.stock_minutes(c16, 100.0, [PX(c16, 100.5), PX(c16 + 60, 100.6), PX(c16 + 1800, 101.5)], prx, c16 + 2400)
by = {m[0]: m for m in mins}
check("real extended-hours prints are kept as they are", by[c16][4] == 100.5 and not by[c16][6] and by[c16 + 1800][4] == 101.5 and not by[c16 + 1800][6])
check("the minute right after a print is not estimated", c16 + 120 not in by and c16 + 180 in by and by[c16 + 180][6])
check("a gap is projected from the print before it", abs(by[c16 + 600][4] - 100.6 * pc[c16 + 600] / pc[c16 + 60]) < 1e-9)
check("each real print re-anchors the estimate", abs(by[c16 + 2100][4] - 101.5 * pc[c16 + 2100] / pc[c16 + 1800]) < 1e-9 and last_real == c16 + 1860)
check("estimates carry no volume", all(m[5] == 0 for m in mins if m[6]) and mins[-1][0] == c16 + 2400)
m2, lr2 = server.stock_minutes(c16, 100.0, [], prx, c16 + 600)
check("no prints at all: projected from the regular close", abs(m2[-1][4] - 100.0 * pc[c16 + 600] / pc[c16 - 60]) < 1e-9 and lr2 == c16 and all(x[6] for x in m2))
m3, _ = server.stock_minutes(c16, 100.0, [PX(c16 + 60, 100.6)], [], c16 + 600)
check("no proxy: only the real prints, never an invented bar", [x[0] for x in m3] == [c16 + 60])
# onto a 5-minute chart whose last regular bar is 15:55
rth = {"symbol": "NVDA", "tf": "5m", "t": [c16 - 600, c16 - 300], "o": [99.5, 99.8], "h": [100, 100.2], "l": [99.4, 99.7], "c": [99.8, 100.0], "v": [500, 900], "meta": {"tz": "America/New_York", "type": "EQUITY"}, "fetched": 0}
extd = {k: [r[i] for r in [PX(c16, 100.5), PX(c16 + 60, 100.6), PX(c16 + 1800, 101.5)]] for i, k in enumerate(["t", "o", "h", "l", "c", "v"])}
pu = [(utc(r[0]), *r[1:]) for r in prx]
oe = server.splice_ext(rth, extd, pu, "5m", "xyz:NVDA", utc(c16 + 2400) + 20)
le = oe["live"]
check("extended bars continue the 5-minute grid past the close", oe["t"][2] == c16 and all((b - a) == 300 for a, b in zip(oe["t"], oe["t"][1:])) and le["from"] == c16 and le["kind"] == "ext" and le["bars"] == len(oe["t"]) - 2)
check("regular bars are untouched", oe["c"][:2] == [99.8, 100.0] and oe["v"][:2] == [500, 900] and rth["t"] == [c16 - 600, c16 - 300] and "live" not in rth)
check("bars holding a real print are not marked as estimates", le["est"] == [[c16 + 300, c16 + 1500], [c16 + 2100, c16 + 2400]], str(le["est"]))
check("newest value and change base are reported", le["price"] == oe["c"][-1] and le["base"] == 100.0 and le["isEst"] and le["src"] == "xyz:NVDA" and le["anchor"] == c16 + 1860 and le["anchorAge"] == 2400 + 20 - 1860)
od2 = server.splice_ext({**rth, "tf": "1d", "t": [c16 - 86400 - 16 * 3600, c16 - 16 * 3600], "a": [1, 2]}, extd, pu, "1d", "xyz:NVDA", utc(c16 + 2400) + 20)
check("a daily bar is the regular session: bars unchanged, indicated price added", od2["c"] == [99.8, 100.0] and od2["live"]["from"] is None and od2["live"]["price"] == le["price"] and od2["live"]["bars"] == 0 and "a" in od2)
on = server.splice_ext(rth, extd, [], "5m", None, utc(c16 + 2400) + 20)
check("without a proxy only real prints are added, flagged as real", on["live"]["src"] is None and on["live"]["est"] == [] and not on["live"]["isEst"] and on["live"]["bars"] == 2 and on["t"][-1] == c16 + 1800)
check("nothing after the close yet: data is returned as it is", server.splice_ext(rth, {k: [] for k in "tohlcv"}, [], "5m", None, utc(c16 + 30)) is rth)
check("a print in the minute still forming is not dated in the future", server.splice_ext(rth, extd, [], "5m", None, utc(c16 + 1800) + 10)["live"]["anchorAge"] == 0)
# hours
check("regular session for estimates starts at 09:30, extended hours 04:00-20:00 on weekdays", not so("NVDA", at(2026, 11, 17, 9, 27), lag=0) and so("NVDA", at(2026, 11, 17, 9, 27)) and so("NVDA", at(2026, 11, 17, 9, 30), lag=0) and server.extended_hours(at(2026, 11, 17, 4, 0)) and server.extended_hours(at(2026, 11, 17, 19, 59)) and not server.extended_hours(at(2026, 11, 17, 20, 0)) and not server.extended_hours(sat) and not server.extended_hours(at(2026, 11, 17, 3, 59)))
check("stock proxies: same-name perps plus the index and metal ETFs, no futures roots", server.STOCK_PROXY["NVDA"] == "xyz:NVDA" and server.STOCK_PROXY["SPY"] == "xyz:SP500" and server.STOCK_PROXY["QQQ"] == "xyz:XYZ100" and "CL" not in server.STOCK_PROXY and "GOLD" not in server.STOCK_PROXY and "IBM" not in server.STOCK_PROXY and len(server.STOCK_PROXY) == 39)
try:
    server.parse_chart({"chart": {"result": None, "error": {"description": "No data found"}}}, "Z", "1d"); check("error surfaced", False)
except RuntimeError as e:
    check("error surfaced", "No data" in str(e))
check("trim keeps adj", server._trim(bd, 1).get("a") == [11.5])

# ── the snapshot build: which extended series are due, and the market summary rows ──
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import snapshot as snap
ets = lambda *a: datetime(*a, tzinfo=ET).timestamp()  # New York wall clock -> UTC seconds
mon10 = ets(2026, 11, 16, 10, 0); fri16 = ets(2026, 11, 13, 16, 0)
check("last close: Friday's from Monday morning and across the weekend", snap.last_close(mon10) == fri16 and snap.last_close(ets(2026, 11, 14, 12, 0)) == fri16 and snap.last_close(ets(2026, 11, 15, 23, 0)) == fri16)
check("last close: today's from 16:00 on, yesterday's before", snap.last_close(ets(2026, 11, 16, 16, 0)) == ets(2026, 11, 16, 16, 0) and snap.last_close(ets(2026, 11, 17, 3, 0)) == ets(2026, 11, 16, 16, 0))
check("last close holds across a daylight-saving change", snap.last_close(ets(2026, 11, 2, 9, 0)) == ets(2026, 10, 30, 16, 0))
check("stock session: 09:30 until the bars settle after the close, weekdays only", snap.stock_session(mon10) and not snap.stock_session(ets(2026, 11, 16, 9, 29)) and snap.stock_session(ets(2026, 11, 16, 16, 29)) and not snap.stock_session(ets(2026, 11, 16, 16, 30)) and not snap.stock_session(ets(2026, 11, 14, 11, 0)))
inf = float("inf")
check("due: never fetched is always due", snap.due_score(None, "1d", mon10, True) == inf and snap.due_score(0, "1h", mon10, False) == inf)
check("due while trading: by age against the target (60 min daily and hourly, 30 min five-minute)", abs(snap.due_score(mon10 - 2700, "1d", mon10, True) - 0.75) < 1e-9 and abs(snap.due_score(mon10 - 2700, "1h", mon10, True) - 0.75) < 1e-9 and abs(snap.due_score(mon10 - 2700, "5m", mon10, True) - 1.5) < 1e-9)
sat = ets(2026, 11, 14, 12, 0)
check("due while shut: only a copy from before the last session settled", snap.due_score(fri16 + 1700, "1d", sat, False) >= 1 and snap.due_score(fri16 + 1900, "1d", sat, False) == 0 and snap.due_score(fri16 - 86400 * 3, "1h", sat, False) > snap.due_score(fri16 + 60, "1h", sat, False) >= 1)
check("due on a holiday: the clock says open, but nothing trades, so nothing is refetched", snap.due_score(fri16 + 3600, "1d", mon10, False) == 0)
check("due: a symbol the provider had nothing for is left alone, then asked about again", snap.due_score(-(mon10 - 3600), "1d", mon10, True) == -1 and snap.due_score(-(mon10 - 7 * 3600), "1d", mon10, True) == inf)
keys = [(s, tf) for s in ("A", "B", "C", "D", "E") for tf in ("1d", "1h")]
state = {"A|1d": mon10 - 4000, "A|1h": mon10 - 4000, "B|1d": mon10 - 2000, "B|1h": mon10 - 2000, "C|1d": mon10 - 9000, "C|1h": mon10 - 100, "D|1d": -(mon10 - 60), "D|1h": -(mon10 - 60)}
due, carry = snap.plan_refresh(state, keys, mon10, 2, True)
check("plan: missing first, then the most overdue up to the budget", due == [("E", "1d"), ("E", "1h"), ("C", "1d"), ("A", "1d")], str(due))
check("plan: everything else published is carried; the dead are in neither list", carry == [("A", "1h"), ("B", "1d"), ("B", "1h"), ("C", "1h")], str(carry))
due0, carry0 = snap.plan_refresh(state, keys, mon10, 0, True)
check("build order: refreshes of published series go before new ones, each in plan order", snap.published_first(due, state) == [("C", "1d"), ("A", "1d"), ("E", "1d"), ("E", "1h")] and snap.published_first([("D", "1d"), ("A", "1h")], state) == [("A", "1h"), ("D", "1d")])
check("plan: with no budget only the missing are fetched", due0 == [("E", "1d"), ("E", "1h")] and len(carry0) == 6)
dueS, carryS = snap.plan_refresh({k: fri16 + 3600 for k in ("A|1d", "A|1h")}, keys[:2], sat, 99, False)
check("plan: nothing is due at the weekend once the close is in", dueS == [] and carryS == keys[:2])
days = [20000 + i for i in range(500) if (20000 + i) % 7 not in (2, 3)]
pd_ = {"t": [d * 86400 for d in days], "c": [10 + 0.01 * i for i in range(len(days))], "v": [1000 + i for i in range(len(days))], "fetched": 42, "meta": {"type": "EQUITY"}}
row = snap.pack_row(pd_)
check("pack row: a year of closes as day gaps", row["d0"] + sum(row["dd"]) == days[-1] and len(row["c"]) == len(row["dd"]) + 1 and row["c"][-1] == pd_["c"][-1] and row["d0"] >= days[-1] - 375 and days[len(days) - len(row["c"]) - 1] < days[-1] - 375 and row["f"] == 42)
nn = len(days); want = sum(pd_["c"][i] * pd_["v"][i] for i in range(nn - 21, nn - 1)) / 20
check("pack row: dollar volume of the 20 bars before the newest", row["dv"] == int(want + 0.5))
check("pack row: a one-bar series does not divide by zero", snap.pack_row({"t": [86400], "c": [5.0], "v": [9], "meta": {"type": "ETF"}})["dv"] == 0)
check("pack row: crypto volume is already dollars; indexes, futures and currencies have no dollar figure", snap.pack_row({**pd_, "meta": {"type": "CRYPTOCURRENCY"}})["dv"] == int(sum(pd_["v"][nn - 21:nn - 1]) / 20 + 0.5) and all(snap.pack_row({**pd_, "meta": {"type": k}})["dv"] == 0 for k in ("INDEX", "FUTURE", "CURRENCY", "")) and snap.pack_row({k: pd_[k] for k in "tcv"})["dv"] == 0)
thu = ets(2026, 11, 26, 16, 7); wed16 = ets(2026, 11, 25, 16, 0)
check("due on a holiday afternoon: by the calendar the close was today, but the last session was yesterday's", snap.due_score(wed16 + 3600, "1d", thu, False) >= 1 and snap.due_score(wed16 + 3600, "1d", thu, False, wed16) == 0 and snap.due_score(wed16 + 600, "1d", thu, False, wed16) >= 1)
check("plan passes the last session's close through", snap.plan_refresh({"A|1d": wed16 + 3600, "A|1h": wed16 + 3600}, keys[:2], thu, 99, False, wed16)[0] == [])
# joining a month of fresh daily bars onto the carried history
def dser(days, closes, adj=None, fetched=0):
    d = {"symbol": "X", "tf": "1d", "t": [x * 86400 for x in days], "o": list(closes), "h": list(closes), "l": list(closes), "c": list(closes), "v": [100] * len(days), "meta": {"type": "EQUITY"}, "fetched": fetched}
    if adj: d["a"] = adj
    return d
old = dser(range(100, 140), [10 + i for i in range(40)], fetched=5)
new = dser(range(118, 142), [10 + i for i in range(18, 39)] + [48.5, 50, 51], fetched=9)   # day 139 was still forming: restated
j = snap.join_series(old, new)
check("join: history before the window kept, the window taken from the fresh fetch", j is not None and j["t"][0] == 100 * 86400 and j["t"][-1] == 141 * 86400 and len(j["t"]) == 42 and j["c"][39] == 48.5 and j["c"][17] == 27 and j["fetched"] == 9 and "a" not in j)
check("join: remembers when the history was last fetched whole", j["full"] == 5 and snap.join_series({**old, "full": 3}, new)["full"] == 3)
split = dser(range(118, 142), [(10 + i) / 2 for i in range(18, 39)] + [24, 25, 25.5])
check("join: a split (every shared close restated) means fetch it whole", snap.join_series(old, split) is None)
divd = dser(range(118, 142), [10 + i for i in range(18, 39)] + [48.5, 50, 51], adj=[(10 + i) * 0.99 for i in range(18, 39)] + [48.5, 50, 51])
check("join: a dividend (adjustment restated) means fetch it whole", snap.join_series(old, divd) is None)
check("join: needs three shared days, and both sides", snap.join_series(old, dser(range(138, 145), [48, 49, 50, 51, 52, 53, 54])) is None and snap.join_series(dser([], []), new) is None and snap.join_series(old, dser([], [])) is None)
oldadj = dser(range(100, 140), [10 + i for i in range(40)], adj=[(10 + i) * 0.98 for i in range(10)] + [10 + i for i in range(10, 40)])
ja = snap.join_series(oldadj, new)
check("join: an adjusted column from before the window is carried, fresh bars are their own", ja is not None and ja["a"][0] == 10 * 0.98 and ja["a"][-1] == 51 and len(ja["a"]) == len(ja["c"]))
import make_universe as mu, tempfile, json
with tempfile.TemporaryDirectory() as tdir:
    pth = os.path.join(tdir, "etf.json")
    json.dump({"data": {"data": {"rows": [{"symbol": "QVAL", "companyName": "Alpha Architect U.S. Quantitative Value ETF"}, {"symbol": "DXJ", "companyName": "WisdomTree Japan Hedged Equity Fund"},
               {"symbol": "TAIL", "companyName": "Cambria Tail Risk ETF"}, {"symbol": "SPY", "companyName": "SPDR S&P 500 ETF Trust"}, {"symbol": "WT^X", "companyName": "WisdomTree odd listing"},
               {"symbol": "XLK", "companyName": "Technology Select Sector SPDR Fund"}, {"symbol": "VGT", "companyName": "Vanguard Information Technology ETF"},
               {"symbol": "ARKK", "companyName": "ARK Innovation ETF"}, {"symbol": "PARK", "companyName": "Benchmark Park Fund"}, {"symbol": "JEPI", "companyName": "JPMorgan Equity Premium Income ETF"}]}}}, open(pth, "w"))
    fam = mu.families_from(pth)
check("fund families: every fund named for the issuer, odd listings and look-alike names left out", fam == {"WisdomTree": ["DXJ"], "Cambria": ["TAIL"], "Alpha Architect": ["QVAL"], "Vanguard": ["VGT"], "SPDR": ["SPY", "XLK"], "ARK": ["ARKK"], "JPMorgan": ["JEPI"]}, str(fam))
check("world sectors map onto the GICS names, unknown ones stay blank", [mu.SECTORS[mu.sector_of(x)] if mu.sector_of(x) >= 0 else None for x in ("Banks", "Electric Machinery", "Electric Power", "Real Estate Investment Trusts", "Oil & Gas Producers", "Pharmaceuticals and Biotechnology", "Industrial Transportation", "Food Producers", "Services")]
      == ["Financials", "Information Technology", "Utilities", "Real Estate", "Energy", "Health Care", "Industrials", "Consumer Staples", None])
eq = {**pd_, "meta": {"type": "EQUITY", "currency": "JPY"}}
fx = {"JPY": 1 / 150, "GBP": 1.25}
check("pack row: another currency is converted to dollars, pence as hundredths of a pound, and left blank without a rate",
      abs(snap.pack_row(eq, fx)["dv"] - int(want / 150 + 0.5)) <= 1 and abs(snap.pack_row({**pd_, "meta": {"type": "EQUITY", "currency": "GBp"}}, fx)["dv"] - int(want * 1.25 / 100 + 0.5)) <= 1
      and snap.pack_row(eq)["dv"] == 0 and snap.pack_row({**pd_, "meta": {"type": "EQUITY", "currency": "SEK"}}, fx)["dv"] == 0 and snap.pack_row({**pd_, "meta": {"type": "EQUITY", "currency": "USD"}}, fx)["dv"] == int(want + 0.5))
check("coins and world stocks have tiers of their own, apart from the others", not set(snap.CRYPTO) & (set(snap.CORE) | set(snap.EXTENDED) | set(snap.BROAD)) and set(snap.MKT_OF) <= set(snap.BROAD) and len(snap.CRYPTO) > 50 and len(snap.MKT_OF) > 800 and all(c in snap.FX_PAIRS for c in ("JPY", "GBP", "EUR", "HKD", "SEK", "AUD", "CAD", "INR", "CHF")) and all(p in snap.CORE for p, _ in snap.FX_PAIRS.values()))
check("the first fund families are published at every extended timeframe", {"QVAL", "IVAL", "TAIL", "SYLD", "DXJ", "USFR", "BOXX"} <= set(snap.EXTENDED) and all(len(snap.UNIVERSE["families"][k]) >= 10 for k in mu.FULL_FAMILIES))
fam_all = {s for v in snap.UNIVERSE["families"].values() for s in v}
check("Vanguard and the other big issuers have lists; their busiest funds get five-minute bars, the rest daily and hourly",
      {"Vanguard", "iShares", "SPDR", "Schwab", "Invesco"} <= set(snap.UNIVERSE["families"]) and {"VGT", "VYM", "VHT", "VT"} <= set(snap.EXTENDED) | set(snap.CORE)
      and len(snap.UNIVERSE["families"]["Vanguard"]) >= 90 and len(fam_all & (set(snap.CORE) | set(snap.EXTENDED) | set(snap.BROAD))) >= 0.85 * len(fam_all))
check("broad tier: daily and hourly, disjoint from the others, refreshed less often", not set(snap.BROAD) & (set(snap.CORE) | set(snap.EXTENDED)) and len(snap.BROAD) > 1000 and list(snap.BROAD_KEEP) == ["1d", "1h", "5m", "1m"] and snap.due_score(mon10 - 2700, "1d", mon10, True, None, snap.BROAD_TARGET) == 0.5)
check("the two tiers do not overlap, and every proxied symbol is core", not set(snap.CORE) & set(snap.EXTENDED) and set(server.LIVE_PROXY) | set(server.STOCK_PROXY) <= set(snap.CORE) and len(snap.EXTENDED) > 350)
# cache housekeeping
import tempfile
with tempfile.TemporaryDirectory() as tdir:
    T0 = 2_000_000_000
    for i, (age_days, kb) in enumerate([(30, 10), (20, 10), (5, 300), (3, 300), (1, 300), (0, 100)]):
        p = os.path.join(tdir, "1d" if i % 2 else "5m", f"S{i}.json"); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f: f.write(b"x" * kb * 1024)
        os.utime(p, (T0 - age_days * 86400, T0 - age_days * 86400))
    n, b = server.prune_cache(tdir, max_bytes=10 ** 9, max_age=14 * 86400, now=T0)
    check("cache prune: drops series unused for two weeks, keeps the rest", n == 2 and b == 20 * 1024 and not os.path.exists(os.path.join(tdir, "5m", "S0.json")) and os.path.exists(os.path.join(tdir, "5m", "S2.json")))
    n, b = server.prune_cache(tdir, max_bytes=700 * 1024, max_age=14 * 86400, now=T0)
    check("cache prune: over the size cap, the oldest go first until it fits", n == 1 and not os.path.exists(os.path.join(tdir, "5m", "S2.json")) and os.path.exists(os.path.join(tdir, "1d", "S3.json")) and os.path.exists(os.path.join(tdir, "1d", "S5.json")))
    check("cache prune: an empty or missing folder is fine", server.prune_cache(os.path.join(tdir, "none"), now=T0) == (0, 0))
check("cache lives outside the repository (which may sit in a synced folder)", not os.path.abspath(server.CACHE).startswith(os.path.abspath(server.ROOT)))
# ── Prometheus metrics ──
import re, threading, urllib.request, urllib.error, io
import metrics as M
def parse_exposition(text):
    """A strict reading of the text format: every sample belongs to a declared family, names and
    labels are well formed, histograms are cumulative and end at +Inf = _count."""
    fams, samples, errs = {}, [], []
    for ln in text.splitlines():
        if not ln:
            continue
        m = re.fullmatch(r"# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)", ln)
        if m:
            if m.group(1) == "TYPE": fams[m.group(2)] = m.group(3)
            continue
        m = re.fullmatch(r'([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*"(?:,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*")*)\})? (\S+)', ln)
        if not m: errs.append("bad line: " + ln); continue
        name, labels, val = m.group(1), m.group(2) or "", m.group(3)
        base = re.sub(r"_(bucket|sum|count)$", "", name) if re.sub(r"_(bucket|sum|count)$", "", name) in fams and fams[re.sub(r"_(bucket|sum|count)$", "", name)] == "histogram" else name
        if base not in fams: errs.append("undeclared: " + name)
        try: float(val.replace("+Inf", "inf").replace("NaN", "nan"))
        except ValueError: errs.append("bad value: " + ln)
        samples.append((name, labels, val))
    for fam, kind in fams.items():
        if kind != "histogram": continue
        series = {}
        for name, labels, val in samples:
            if name == fam + "_bucket":
                key = re.sub(r',?le="[^"]*"', "", labels); series.setdefault(key, []).append(float(val))
        for key, vals in series.items():
            cnt = [float(v) for n, l, v in samples if n == fam + "_count" and l == (key if key != "{}" else "")]
            if vals != sorted(vals) or not cnt or vals[-1] != cnt[0]: errs.append(f"histogram {fam}{key} not cumulative or +Inf != count")
    return fams, samples, errs
h = M.Histogram("t_seconds", "test", ("route",), buckets=(0.1, 1.0))
for v in (0.05, 0.5, 0.5, 3): h.observe(v, route='a"b\\c')
text = "\n".join(h.head() + h.lines()) + "\n"
f_, smp, errs = parse_exposition(text)
check("metrics: histogram buckets are cumulative, +Inf and count agree, sum adds up", not errs and [v for n, l, v in smp if n == "t_seconds_bucket"] == ["1", "3", "4"] and ("t_seconds_sum", '{route="a\\"b\\\\c"}', "4.05") in smp, str(errs or smp))
c = M.Counter("t_total", "test", ("x",))
try: c.inc(-1, x="a"); neg = False
except ValueError: neg = True
try: c.inc(x="a", y="b"); bad = False
except ValueError: bad = True
check("metrics: counters refuse to go down and refuse unknown labels", neg and bad)
# provider outcomes, with the network faked
real = urllib.request.urlopen
def fake(exc):
    def f(*a, **k): raise exc
    return f
before = dict(server.M_UP.values)
for exc in (urllib.error.HTTPError("https://query1.finance.yahoo.com/x", 429, "Too Many", {}, io.BytesIO(b"")), TimeoutError("timed out"), urllib.error.URLError("no route")):
    urllib.request.urlopen = fake(exc)
    try: server._http_json("https://query1.finance.yahoo.com/v8/finance/chart/X")
    except Exception: pass
urllib.request.urlopen = real
grew = {k: server.M_UP.values.get(k, 0) - before.get(k, 0) for k in server.M_UP.values}
check("metrics: provider failures are counted by kind and the error still reaches the caller", grew.get(("yahoo", "throttled")) == 1 and grew.get(("yahoo", "timeout")) == 1 and grew.get(("yahoo", "network_error")) == 1, str(grew))
# the endpoint, on a real local server
from http.server import ThreadingHTTPServer
srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
get = lambda path: urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5)
get("/api/health").read()
try: get("/api/nope")
except urllib.error.HTTPError as e: e.read()
r = get("/metrics"); body = r.read().decode(); ctype = r.headers.get("Content-Type")
srv.shutdown()
fams, smp, errs = parse_exposition(body)
names = {n for n, _, _ in smp}
check("metrics endpoint: valid exposition format with the right content type", not errs and ctype.startswith("text/plain; version=0.0.4"), str(errs[:3]) + " " + str(ctype))
check("metrics endpoint: requests are counted by route and status", ("meridian_http_requests_total", '{route="health",code="200"}', "1") in smp and ("meridian_http_requests_total", '{route="unknown_api",code="404"}', "1") in smp, str([x for x in smp if x[0] == "meridian_http_requests_total"]))
check("metrics endpoint: the families an alert rule reads are all there", {"meridian_upstream_requests_total", "meridian_http_request_duration_seconds_bucket", "meridian_cache_disk_bytes", "meridian_build_info", "meridian_start_time_seconds", "meridian_threads"} <= names and {"meridian_proxy_last_candle_age_seconds", "meridian_live_anchor_age_seconds", "meridian_cache_lookups_total", "meridian_live_fill_total"} <= set(fams), str(sorted(names))[:300])
# the published file format
ser = {"symbol": "S", "tf": "1d", "t": [86400 * d for d in (100, 101, 104, 105, 106)], "o": [1, 2, 3, 4, 5], "h": [1, 2, 3, 4, 5], "l": [1, 2, 3, 4, 5], "c": [10.0, 11.0, 12.0, 13.0, 14.0], "v": [5] * 5, "a": [9.9, 10.89, 11.88, 13.0, 14.0], "meta": {}, "fetched": 7}
enc = snap.encode_series(ser); dec = snap.decode_series(json.loads(json.dumps(enc)))
check("format: bar times as gaps in days, adjustment as factor runs, decoded exactly where it can be", enc["t0"] == 8640000 and enc["dt"] == [1, 3, 1, 1] and "t" not in enc and enc["af"] == [[0, 0.99], [3, 1.0]] and dec["t"] == ser["t"] and all(abs(x - y) <= 2e-5 * y for x, y in zip(dec["a"], ser["a"])) and dec["fetched"] == 7 and snap.encode_series(dec) == enc)
odd = {**ser, "tf": "1h", "t": [0, 3600, 5400, 9000, 12600]}
eo = snap.encode_series(odd)
check("format: hourly bars on a half-hour grid (a 9:30 open) use half-hour steps, exactly", eo["step"] == 1800 and eo["dt"] == [2, 1, 2, 2] and snap.decode_series(eo)["t"] == odd["t"])
ragged = {**ser, "tf": "1h", "t": [0, 3600, 3661, 7200, 10800]}
check("format: times off any grid still round-trip (one-second steps)", snap.encode_series(ragged)["step"] == 1 and snap.decode_series(snap.encode_series(ragged))["t"] == ragged["t"])
back = {**ser, "t": [0, 3600, 3600, 7200, 10800]}
check("format: times that do not rise are published as they are", snap.encode_series(back)["t"] == back["t"])
check("format: a plain file passes through decoding unchanged", snap.decode_series(ser) is ser and snap.decode_series(None) is None)
check("broad tier keeps ten years of daily bars, eight months of hourly, two weeks of five-minute and four sessions of one-minute", snap.BROAD_KEEP == {"1d": 2520, "1h": 1200, "5m": 780, "1m": 1500} and snap.BROAD_RANGE == {"1d": "10y", "1h": "1y", "5m": "1mo", "1m": "5d"} and snap.BROAD_TARGET["5m"] == snap.BROAD_TARGET["1m"] == 3600)
check("extended tier and coins have five-minute bars too (15m and 30m are built from them)", snap.EXT_KEEP["5m"] > 1000 and snap.EXT_RANGE["5m"] == "1mo" and "5m" in snap.EXT_TARGET and "5m" in snap.JOIN_RANGE)
check("extended tier and coins have one-minute bars: four sessions, fetched within the provider's window, joined from today's", snap.EXT_KEEP["1m"] == snap.KEEP["1m"] and snap.EXT_RANGE["1m"] == "5d" and snap.JOIN_RANGE["1m"] == "1d" and snap.EXT_TARGET["1m"] == 1800 and snap.BROAD_KEEP["1m"] == snap.EXT_KEEP["1m"])
check("a split data set publishes the broad tier's daily, 5- and 1-minute history on the data site and its hourly on the main one",
      snap.BROAD_PART["broad"] == ("1d", "5m", "1m") and snap.BROAD_PART["main"] == ("1h",) and set(snap.BROAD_PART["all"]) == set(snap.BROAD_KEEP))
check("history range: files from before it was recorded count as five years (broad daily) or the current window",
      snap.history_range({"tf": "1d"}, 3) == "5y" and snap.history_range({"tf": "1h"}, 3) == "1y" and snap.history_range({"tf": "1d"}, 2) == "10y" and snap.history_range({"tf": "1d", "rng": "10y"}, 3) == "10y")
# joining works for intraday bars too, and remembers how far back the history went
def hser(hours, closes, fetched=0):
    return {"symbol": "X", "tf": "1h", "t": [x * 3600 for x in hours], "o": list(closes), "h": list(closes), "l": list(closes), "c": list(closes), "v": [1] * len(hours), "meta": {}, "fetched": fetched}
jh = snap.join_series({**hser(range(0, 50), [float(i) for i in range(50)], 4), "rng": "1y", "full": 4}, hser(range(40, 55), [float(i) for i in range(40, 49)] + [49.5] + [float(i) for i in range(50, 55)], 8))
check("join: hourly bars join like days; the range of the whole fetch is kept", jh is not None and len(jh["t"]) == 55 and jh["c"][49] == 49.5 and jh["rng"] == "1y" and jh["full"] == 4 and jh["fetched"] == 8)
# provider blanks: a zero open/high/low on a stock or coin is repaired, a rate or a future may be zero or negative
def zdoc(kind, rows):
    d = doc([86400 * 20000 + 86400 * i for i in range(len(rows))], rows, tz="UTC")
    d["chart"]["result"][0]["meta"]["instrumentType"] = kind
    return d
zc = server.parse_chart(zdoc("CRYPTOCURRENCY", [[0, 750.7, 0, 428.4, 5], [430, 440, 0, 435, 5], [0.0106, 0.0108, 0.0, 0.0106, 1]]), "ICP-USD", "1d")
check("zero prices: a coin's blank open and low become the bar's own range", zc["o"] == [428.4, 430, 0.0106] and zc["l"] == [428.4, 430, 0.0106] and zc["h"] == [750.7, 440, 0.0108] and zc["c"] == [428.4, 435, 0.0106])
zr = server.parse_chart(zdoc("INDEX", [[0.1, 0.1, -0.013, 0.003, 0], [0.0, 0.02, 0.0, 0.013, 0]]), "^IRX", "1d")
check("zero prices: a rate at or below zero is left as it is", zr["l"] == [-0.013, 0.0] and zr["o"] == [0.1, 0.0])
# a whole-series fetch that comes back truncated must not replace the published history
pub = dser(range(100, 200), [10 + i * 0.1 for i in range(100)], fetched=5)
pub["full"], pub["rng"] = 5, "10y"
short = dser([198, 199, 200, 201], [10 + 9.8, 10 + 9.9, 20.05, 20.2], fetched=9)
sp = snap.splice_truncated(pub, short)
check("truncated answer: published history kept, fresh bars joined on", sp is not None and len(sp["t"]) == 102 and sp["t"][0] == 100 * 86400 and sp["c"][-1] == 20.2 and sp["fetched"] == 9 and sp["rng"] == "10y" and sp["full"] == 5)
check("truncated answer: a full-length answer, one starting as early, or one far past the end is used as it is",
      snap.splice_truncated(pub, dser(range(120, 202), [1.0] * 82)) is None and snap.splice_truncated(pub, dser([100, 101, 102], [10, 10.1, 10.2])) is None
      and snap.splice_truncated(pub, dser([215, 216], [30, 31])) is None and snap.splice_truncated(None, short) is None)
check("truncated answer: one that disagrees with the published bars (a split) is used as it is", snap.splice_truncated(pub, dser([197, 198, 199, 200], [9.95, 9.9, 9.95, 10.1])) is None)
import time
# a refresh fetches the whole series again when the carried one does not reach as far back as is kept
with tempfile.TemporaryDirectory() as tdir:
    prevd, outd = os.path.join(tdir, "prev"), os.path.join(tdir, "out")
    os.makedirs(os.path.join(prevd, "data", "1d")); os.makedirs(os.path.join(outd, "data", "1d"))
    asked = []
    fresh = lambda rng: {**dser(range(118, 142), [10 + i for i in range(18, 39)] + [48.5, 50, 51], fetched=int(time.time())), "symbol": "ZZQ", "meta": {"type": "EQUITY"}}
    bld = snap.Build(outd, None, 9, prevd)
    bld.yahoo = lambda sym, tf, rng=None, tries=4: asked.append(rng) or fresh(rng)
    snap.TIER["ZZQ"] = (3, snap.BROAD_KEEP)
    for rng_kept, want in ((None, "10y"), ("10y", "1mo")):
        carried = {**old, "symbol": "ZZQ", "full": int(time.time()) - 60, "meta": {"type": "EQUITY"}}
        if rng_kept: carried["rng"] = rng_kept
        json.dump(snap.encode_series(carried), open(os.path.join(prevd, "data", "1d", "ZZQ.json"), "w"))
        asked.clear(); res = bld.refresh(("ZZQ", "1d"))
        check(f"refresh: carried broad daily history fetched as {rng_kept or 'five years'} -> asks for {want}", res[2] == "fresh" and asked == [want], str((res, asked)))
    written = snap.decode_series(snap.read_json_bytes(open(os.path.join(outd, "data", "1d", "ZZQ.json.gz"), "rb").read()))
    check("refresh: a joined series keeps the range its history was fetched with", written.get("rng") == "10y")
    # a weekly whole fetch that comes back truncated keeps the published history
    carried = {**pub, "symbol": "ZZQ", "full": int(time.time()) - 30 * 86400, "fetched": int(time.time()) - 3600, "meta": {"type": "EQUITY"}}
    json.dump(snap.encode_series(carried), open(os.path.join(prevd, "data", "1d", "ZZQ.json"), "w"))
    bld.yahoo = lambda sym, tf, rng=None, tries=4: {**short, "symbol": "ZZQ", "meta": {"type": "EQUITY"}}
    res = bld.refresh(("ZZQ", "1d"))
    written = snap.decode_series(snap.read_json_bytes(open(os.path.join(outd, "data", "1d", "ZZQ.json.gz"), "rb").read()))
    check("refresh: a truncated whole fetch keeps the published history and says so", res[2] == "fresh" and len(written["t"]) == 102 and any("kept the 100 published" in n for n in bld.notes), str((res, len(written["t"]), bld.notes)))
    snap.TIER.pop("ZZQ")
# published series files are gzip-compressed; builds before that published plain .json
import gzip
big = dser(range(100, 2600), [10 + (i % 97) * 0.37 for i in range(2500)], fetched=5)
zb, plain = snap.series_bytes(big), json.dumps(snap.encode_series(big), separators=(",", ":")).encode()
check("format: a series file is the compact JSON, gzip-compressed, the same bytes every time", zb[:2] == b"\x1f\x8b" and gzip.decompress(zb) == plain and snap.series_bytes(big) == zb and len(zb) * 2 < len(plain))
check("format: a JSON file reads back compressed, plain, or compressed twice on the way", snap.read_json_bytes(zb) == json.loads(plain) and snap.read_json_bytes(plain) == json.loads(plain) and snap.read_json_bytes(gzip.compress(zb)) == json.loads(plain))
with tempfile.TemporaryDirectory() as tdir:
    prevd, outd = os.path.join(tdir, "prev"), os.path.join(tdir, "out")
    for d_ in (os.path.join(prevd, "data", "1d"), os.path.join(prevd, "data", "1h"), os.path.join(outd, "data", "1d"), os.path.join(outd, "data", "1h")):
        os.makedirs(d_)
    one = {**big, "symbol": "GZA", "meta": {"type": "EQUITY", "name": "A"}}
    open(os.path.join(prevd, "data", "1d", "GZA.json.gz"), "wb").write(snap.series_bytes(one))
    old_plain = {**big, "symbol": "OLDP", "tf": "1h", "meta": {"type": "EQUITY", "name": "P"}}
    json.dump(snap.encode_series(old_plain), open(os.path.join(prevd, "data", "1h", "OLDP.json"), "w"))
    bld = snap.Build(outd, None, 9, prevd)
    snap.TIER.update({"GZA": (3, snap.BROAD_KEEP), "OLDP": (3, snap.BROAD_KEEP)})
    stored = bld.previous_file("1d", "GZA")
    check("previous build: a compressed file is read, and its bytes are offered for reuse", stored is not None and stored[0] == snap.series_bytes(one) and stored[1]["c"][-1] == one["c"][-1])
    res = [bld.carry(("GZA", "1d")), bld.carry(("OLDP", "1h"))]
    out_a = open(os.path.join(outd, "data", "1d", "GZA.json.gz"), "rb").read()
    out_p = snap.decode_series(snap.read_json_bytes(open(os.path.join(outd, "data", "1h", "OLDP.json.gz"), "rb").read()))
    check("carry: an unchanged series is published as the same bytes; a plain file from an older build comes out compressed",
          all(r[2] == "carried" for r in res) and out_a == open(os.path.join(prevd, "data", "1d", "GZA.json.gz"), "rb").read()
          and len(out_p["t"]) == snap.BROAD_KEEP["1h"] and out_p["t"][-1] == old_plain["t"][-1] and not os.path.exists(os.path.join(outd, "data", "1h", "OLDP.json")))
    check("carry: a series cut shorter than before is compressed again, not copied", len(bld.previous_file("1h", "OLDP")[1]["t"]) == 2500)
    for k_ in ("GZA", "OLDP"):
        snap.TIER.pop(k_)
print("all passed" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)

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
print("all passed" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)

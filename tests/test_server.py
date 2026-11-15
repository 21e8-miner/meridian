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
try:
    server.parse_chart({"chart": {"result": None, "error": {"description": "No data found"}}}, "Z", "1d"); check("error surfaced", False)
except RuntimeError as e:
    check("error surfaced", "No data" in str(e))
check("trim keeps adj", server._trim(bd, 1).get("a") == [11.5])
print("all passed" if not fails else f"{fails} FAILED"); sys.exit(1 if fails else 0)

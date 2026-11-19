#!/usr/bin/env python3
"""
Rebuild web/universe.json: the stock list, with sectors, that the shared page publishes and the
Markets view groups by.

    python3 tools/make_universe.py constituents.csv [screener.json] [--etfs=etf_screener.json] [--liquidity=liquidity.json]
                                   [--intl=intl.json --crypto=crypto.json --checked=liquidity_intl.json]

The CSV is the public S&P 500 constituents table (columns Symbol, Security, GICS Sector, ...), as
kept at github.com/datasets/s-and-p-500-companies. A short hand-kept list of widely followed names
outside the index is added. Those are the "stocks": daily, hourly, five-minute and one-minute
history on the shared page.

screener.json is Nasdaq's public list of US-listed stocks
(https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true). Common
stocks over BROAD_MIN_CAP that are not already listed become "broad": daily and hourly history. Their
sectors are Nasdaq's own classification mapped onto the eleven GICS names, so they are rougher than
the index members'. Without the file the previous broad list is kept.

ETFS is a hand-kept list of funds published like the followed stocks ("etfs"), with every ETF that
trades at least EXT_ETF_DV a day (needs --liquidity) and every fund of FULL_FAMILIES. The funds of
each issuer in FAMILIES are read from Nasdaq's public ETF list
(https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=10000&download=true) by the issuer's
name in the fund name, and each family gets its own list in the app; its funds that trade at all
and are not in "etfs" are in "broad". Without --etfs the previous families are kept.

--liquidity is the output of tools/liquidity_probe.py: each candidate's average dollar volume over
its last 20 sessions. With it, "broad" also takes smaller stocks (market cap from SMALL_MIN_CAP)
and any other ETF, as long as they trade at least STOCK_MIN_DV / ETF_MIN_DV a day. Run this again
when the index changes; nothing else reads the input files.

--intl and --crypto come from tools/fetch_lists.py (world index members from Wikipedia, the
largest coins from CoinGecko matched to Yahoo tickers); --checked is tools/liquidity_probe.py run
over them. Every index member the provider has data for is kept ("intl", daily history); coins
that trade at least COIN_MIN_DV a day are kept ("crypto", daily and hourly).
"""
from __future__ import annotations

import csv
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SECTORS = [
    "Information Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples",
    "Health Care", "Financials", "Industrials", "Energy", "Materials", "Utilities", "Real Estate",
]
# Followed names that are not in the index (sector by hand).
EXTRA = {
    "Information Technology": "ARM SNOW NET ZS SHOP U MSTR TSM ASML MRVL NBIS CRWV IREN SNDK TEAM MDB OKTA".split(),
    "Communication Services": "RBLX ROKU SPOT PINS SNAP RDDT".split(),
    "Consumer Discretionary": "MELI SE RIVN LCID NIO DKNG PDD BABA JD CHWY ETSY".split(),
    "Consumer Staples": "CELH ELF".split(),
    "Health Care": "AZN NVO HIMS".split(),
    "Financials": "SOFI AFRM UPST CRCL NU".split(),
    "Industrials": "LYFT PLUG RKLB".split(),
}


# funds beyond the ones every timeframe is kept for (CORE in tools/snapshot.py)
ETFS = ("XME XOP XHB XRT ITB IBB IYR VNQ KWEB FXI EWJ EWZ EWG EWU EWT EWW EWC EWA INDA VWO VEA ACWI VXUS "
        "SHY IEI TLH AGG BND BIL SGOV TIP EMB JNK MUB VCIT VCSH BNDX SLV IAU UNG DBA DBC PDBC CPER URA LIT REMX "
        "ICLN TAN QCLN BOTZ SOXX IGV HACK CIBR SKYY BLOK BITO IBIT FBTC ETHA ARKG ARKW JETS PAVE "
        "TQQQ SQQQ SPXL SPXS UPRO SOXS TNA TZA LABU UVXY SVXY TMF SH PSQ "
        "MTUM QUAL USMV VLUE SPLV RSP IWF IWD VUG VTV IJH IJR VB VO VOO VTI IVV SCHD VIG DGRO JEPI JEPQ QQQM OEF").split()
# issuers whose whole US fund line-up is published, matched in the fund's name
# issuer -> how its funds are named. Each family gets a list of its own in the app; the first three
# (FULL_FAMILIES) are published at every extended timeframe whatever they trade, the others go by
# how much each fund trades like any other ETF.
FAMILIES = {
    "WisdomTree": r"\bWisdomTree\b", "Cambria": r"\bCambria\b", "Alpha Architect": r"\bAlpha Architect\b",
    "Vanguard": r"^Vanguard\b", "iShares": r"\biShares\b", "SPDR": r"\bSPDR\b", "Schwab": r"^Schwab\b",
    "Invesco": r"^Invesco\b", "First Trust": r"^First Trust\b", "ProShares": r"^ProShares\b", "Direxion": r"^Direxion\b",
    "Global X": r"^Global X\b", "ARK": r"^ARK\b", "JPMorgan": r"^J\.?P\.? ?Morgan\b", "Dimensional": r"^Dimensional\b",
    "Fidelity": r"^Fidelity\b", "Avantis": r"\bAvantis\b", "VanEck": r"^VanEck\b", "Pacer": r"^Pacer\b",
    "Franklin": r"^Franklin\b", "Goldman Sachs": r"^Goldman Sachs\b", "Xtrackers": r"^Xtrackers\b", "Capital Group": r"^Capital Group\b",
    "PIMCO": r"^PIMCO\b", "Innovator": r"^Innovator\b", "Roundhill": r"^Roundhill\b", "Defiance": r"^Defiance\b",
    "YieldMax": r"\bYieldMax\b", "Simplify": r"^Simplify\b", "Amplify": r"^Amplify\b", "KraneShares": r"^KraneShares\b",
    "GraniteShares": r"^GraniteShares\b", "T. Rowe Price": r"^T\. ?Rowe Price\b", "Grayscale": r"^Grayscale\b",
}
FULL_FAMILIES = ("WisdomTree", "Cambria", "Alpha Architect")
EXT_ETF_DV = 5e7       # ETFs that trade this much a day get every extended timeframe (5-minute bars)
BROAD_MIN_CAP = 2e9    # US stocks this big are always included
SMALL_MIN_CAP = 2e8    # smaller ones, from this size, only if they trade enough (needs --liquidity)
STOCK_MIN_DV = 1e6     # dollars traded a day, 20-session average
ETF_MIN_DV = 2.5e5
COIN_MIN_DV = 1e6      # crypto volume comes in dollars
# Sector names used abroad (ICB, the exchanges' own, Wikipedia's wording) -> the GICS eleven, first
# match wins. Anything that matches none is left without a sector.
SECTOR_WORDS = [
    ("Real Estate", r"real estate|reit|propert"),
    ("Health Care", r"health|pharma|biotech|medic|drug"),  # before technology: "biotechnology"
    ("Information Technology", r"technolog|software|semiconductor|electronic|electric machinery|precision instrument|it serv|computer"),
    ("Communication Services", r"telecom|communication|media|entertainment|broadcast|publishing|internet"),
    ("Financials", r"bank|financ|insur|securities|investment|asset manag|capital market|exchange"),
    ("Energy", r"oil|petroleum|coal|energy|gas producer|mining.*fuel"),
    ("Utilities", r"utilit|electric power|electricity|water|^gas$|gas, water"),
    ("Materials", r"material|chemical|mining|metal|steel|paper|pulp|glass|ceramic|basic resource|rubber|forestry|cement|mineral"),
    ("Consumer Staples", r"food|beverage|tobacco|staple|grocer|personal care|household product|agricultur|fishery|brew"),
    ("Consumer Discretionary", r"auto|retail|discretionary|travel|leisure|hotel|apparel|textile|luxury|personal goods|consumer product|homebuild|household goods|restaurant|gaming|casino|consumer serv"),
    ("Industrials", r"industr|aerospace|defen[cs]e|construct|machinery|transport|engineering|electrical equipment|shipping|shipbuild|rail|airline|air transport|logistic|trading compan|warehous|business serv|support serv|marine"),
]


def sector_of(text: str) -> int:
    t = (text or "").lower()
    for name, pat in SECTOR_WORDS:
        if re.search(pat, t):
            return SECTORS.index(name)
    return -1
NASDAQ_SECTOR = {"Technology": "Information Technology", "Telecommunications": "Communication Services", "Finance": "Financials",
                 "Basic Materials": "Materials", "Consumer Discretionary": "Consumer Discretionary", "Consumer Staples": "Consumer Staples",
                 "Health Care": "Health Care", "Industrials": "Industrials", "Energy": "Energy", "Utilities": "Utilities", "Real Estate": "Real Estate"}
NOT_COMMON = re.compile(r"\b(preferred|warrants?|rights|units|notes|debentures|subordinated|perpetual|depositary shares,? each representing)\b", re.I)


def broad_from(path: str, taken: set, liq: dict | None = None) -> dict:
    with open(path) as f:
        rows = json.load(f)["data"]["rows"]
    liq = liq or {}
    out = {}
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper().replace("/", "-")
        try:
            cap = float(r.get("marketCap") or 0)
        except ValueError:
            cap = 0
        traded = (liq.get(sym) or {}).get("dv", 0)
        big_enough = cap >= BROAD_MIN_CAP or (cap >= SMALL_MIN_CAP and traded >= STOCK_MIN_DV)
        if not big_enough or sym in taken or not re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", sym):
            continue
        name = r.get("name") or ""
        if NOT_COMMON.search(name) or "%" in name:
            continue
        sec = NASDAQ_SECTOR.get((r.get("sector") or "").strip())
        out[sym] = SECTORS.index(sec) if sec else -1
    return dict(sorted(out.items()))


def etfs_from(path: str, taken: set, liq: dict) -> list:
    """Every other listed ETF that trades at least ETF_MIN_DV a day."""
    with open(path) as f:
        data = json.load(f)["data"]
    rows = (data.get("data") or data)["rows"]
    out = set()
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper()
        m = liq.get(sym) or {}
        if sym not in taken and re.fullmatch(r"[A-Z]{1,5}", sym) and not m.get("gone") and m.get("type") == "ETF" and m.get("dv", 0) >= ETF_MIN_DV:
            out.add(sym)
    return sorted(out)


def families_from(path: str) -> dict:
    with open(path) as f:
        data = json.load(f)["data"]
    rows = (data.get("data") or data)["rows"]
    out = {}
    for fam, pat in FAMILIES.items():
        rx = re.compile(pat, re.I)
        out[fam] = sorted({(r.get("symbol") or "").strip().upper() for r in rows
                           if rx.search((r.get("companyName") or "").strip()) and re.fullmatch(r"[A-Z]{1,5}", (r.get("symbol") or "").strip().upper())})
    return {k: v for k, v in out.items() if v}


def main():
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    sys.argv = [a for a in sys.argv if not a.startswith("--")]
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    stocks: dict[str, int] = {}
    with open(sys.argv[1], newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sym = row["Symbol"].strip().upper().replace(".", "-")  # BRK.B -> BRK-B, as the data provider writes it
            stocks[sym] = SECTORS.index(row["GICS Sector"].strip())
    n_index = len(stocks)
    sp500 = list(stocks)
    for sector, names in EXTRA.items():
        for sym in names:
            stocks.setdefault(sym, SECTORS.index(sector))
    path = os.path.join(ROOT, "web", "universe.json")
    try:
        with open(path) as f:
            old = json.load(f)
    except Exception:
        old = {}
    families = families_from(opts["etfs"]) if "etfs" in opts else (old.get("families") or {})
    liq = None
    if "liquidity" in opts:
        with open(opts["liquidity"]) as f:
            liq = json.load(f)
    funds = sorted(set(ETFS) | {s for k in FULL_FAMILIES for s in families.get(k, [])}
                   | {s for s, m in (liq or {}).items() if m.get("type") == "ETF" and not m.get("gone") and m.get("dv", 0) >= EXT_ETF_DV and re.fullmatch(r"[A-Z]{1,5}", s)})
    if liq is None:
        funds = sorted(set(funds) | set(old.get("etfs") or []))  # without the volumes, keep who was promoted before
    taken = set(stocks) | set(funds)
    broad = broad_from(sys.argv[2], taken, liq) if len(sys.argv) > 2 else {k: v for k, v in (old.get("broad") or {}).items() if k not in taken}
    if liq is not None and "etfs" in opts:
        for sym in etfs_from(opts["etfs"], taken | set(broad), liq):
            broad[sym] = -1  # funds have no sector
        # every fund of a listed family that still trades, however little
        for sym in {s for v in families.values() for s in v} - taken - set(broad):
            m = liq.get(sym) or {}
            if m.get("type") == "ETF" and not m.get("gone") and m.get("dv", 0) > 0:
                broad[sym] = -1
        broad = dict(sorted(broad.items()))
    intl, crypto = old.get("intl") or {}, old.get("crypto") or []
    if "intl" in opts and "checked" in opts:
        with open(opts["intl"]) as f:
            lists = json.load(f)
        with open(opts["checked"]) as f:
            checked = json.load(f)
        ok = lambda s: (checked.get(s) or {}).get("type") == "EQUITY" and not checked[s].get("gone")
        intl = {name: {"country": v["country"], "members": {m[0]: sector_of(m[2]) for m in v["members"] if ok(m[0])}}
                for name, v in lists.items()}
        intl = {k: v for k, v in intl.items() if v["members"]}
    if "crypto" in opts and "checked" in opts:
        with open(opts["crypto"]) as f:
            coins = json.load(f)
        with open(opts["checked"]) as f:
            checked = json.load(f)
        crypto = [c["yahoo"] for c in coins if c.get("yahoo") and (checked.get(c["yahoo"]) or {}).get("type") == "CRYPTOCURRENCY" and checked[c["yahoo"]].get("dv", 0) >= COIN_MIN_DV]
    out = {
        "asof": time.strftime("%Y-%m-%d"),
        "sectors": SECTORS,
        "index": n_index,  # how many of the stocks are index members (the rest are the hand-kept extras)
        "sp500": sorted(sp500),
        "stocks": dict(sorted(stocks.items())),
        "etfs": funds,
        "families": families,  # issuer -> its funds (each in "etfs" or "broad", if it trades)
        "broad": broad,  # symbol -> sector index, -1 when the source had none (and for funds)
        "intl": intl,  # index -> {country, members: {symbol: sector index or -1}}
        "crypto": crypto,  # Yahoo tickers of the coins kept, largest first
        "rules": {"broad_min_cap": BROAD_MIN_CAP, "small_min_cap": SMALL_MIN_CAP, "stock_min_dv": STOCK_MIN_DV, "etf_min_dv": ETF_MIN_DV, "liquidity": liq is not None},
    }
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{sum(len(v['members']) for v in intl.values())} international stocks in {len(intl)} indexes, {len(crypto)} coins")
    print(f"{len(stocks)} stocks ({n_index} index members), {len(funds)} funds ({', '.join(f'{k} {len(v)}' for k, v in families.items())}), {len(broad)} broad -> {path}")


if __name__ == "__main__":
    main()

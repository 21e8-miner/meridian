#!/usr/bin/env python3
"""
Rebuild web/universe.json: the stock list, with sectors, that the shared page publishes and the
Markets view groups by.

    python3 tools/make_universe.py constituents.csv [screener.json]

The CSV is the public S&P 500 constituents table (columns Symbol, Security, GICS Sector, ...), as
kept at github.com/datasets/s-and-p-500-companies. A short hand-kept list of widely followed names
outside the index is added. Those are the "stocks": daily and hourly history on the shared page.

screener.json is Nasdaq's public list of US-listed stocks
(https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true). Common
stocks over BROAD_MIN_CAP that are not already listed become "broad": daily history only. Their
sectors are Nasdaq's own classification mapped onto the eleven GICS names, so they are rougher than
the index members'. Without the file the previous broad list is kept.

ETFS is a hand-kept list of funds with daily and hourly history. Run this again when the index
changes; nothing else reads the input files.
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
BROAD_MIN_CAP = 2e9
NASDAQ_SECTOR = {"Technology": "Information Technology", "Telecommunications": "Communication Services", "Finance": "Financials",
                 "Basic Materials": "Materials", "Consumer Discretionary": "Consumer Discretionary", "Consumer Staples": "Consumer Staples",
                 "Health Care": "Health Care", "Industrials": "Industrials", "Energy": "Energy", "Utilities": "Utilities", "Real Estate": "Real Estate"}
NOT_COMMON = re.compile(r"\b(preferred|warrants?|rights|units|notes|debentures|subordinated|perpetual|depositary shares,? each representing)\b", re.I)


def broad_from(path: str, taken: set) -> dict:
    with open(path) as f:
        rows = json.load(f)["data"]["rows"]
    out = {}
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper().replace("/", "-")
        try:
            cap = float(r.get("marketCap") or 0)
        except ValueError:
            cap = 0
        if cap < BROAD_MIN_CAP or sym in taken or not re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", sym):
            continue
        name = r.get("name") or ""
        if NOT_COMMON.search(name) or "%" in name:
            continue
        sec = NASDAQ_SECTOR.get((r.get("sector") or "").strip())
        out[sym] = SECTORS.index(sec) if sec else -1
    return dict(sorted(out.items()))


def main():
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
    taken = set(stocks) | set(ETFS)
    broad = broad_from(sys.argv[2], taken) if len(sys.argv) > 2 else {k: v for k, v in (old.get("broad") or {}).items() if k not in taken}
    out = {
        "asof": time.strftime("%Y-%m-%d"),
        "sectors": SECTORS,
        "index": n_index,  # how many of the stocks are index members (the rest are the hand-kept extras)
        "sp500": sorted(sp500),
        "stocks": dict(sorted(stocks.items())),
        "etfs": sorted(ETFS),
        "broad": broad,  # symbol -> sector index, -1 when the source had none
    }
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(stocks)} stocks ({n_index} index members), {len(ETFS)} funds, {len(broad)} broad -> {path}")


if __name__ == "__main__":
    main()

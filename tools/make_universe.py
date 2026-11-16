#!/usr/bin/env python3
"""
Rebuild web/universe.json: the stock list, with sectors, that the shared page publishes and the
Markets view groups by.

    python3 tools/make_universe.py constituents.csv

The CSV is the public S&P 500 constituents table (columns Symbol, Security, GICS Sector, ...), as
kept at github.com/datasets/s-and-p-500-companies. A short hand-kept list of widely followed names
outside the index is added. Run it again when the index changes; nothing else depends on the CSV.
"""
from __future__ import annotations

import csv
import json
import os
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


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    stocks: dict[str, int] = {}
    with open(sys.argv[1], newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sym = row["Symbol"].strip().upper().replace(".", "-")  # BRK.B -> BRK-B, as the data provider writes it
            stocks[sym] = SECTORS.index(row["GICS Sector"].strip())
    n_index = len(stocks)
    for sector, names in EXTRA.items():
        for sym in names:
            stocks.setdefault(sym, SECTORS.index(sector))
    out = {
        "asof": time.strftime("%Y-%m-%d"),
        "sectors": SECTORS,
        "index": n_index,  # how many of the stocks are index members (the rest are the hand-kept extras)
        "stocks": dict(sorted(stocks.items())),
    }
    path = os.path.join(ROOT, "web", "universe.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(stocks)} stocks ({n_index} index members) -> {path}")


if __name__ == "__main__":
    main()

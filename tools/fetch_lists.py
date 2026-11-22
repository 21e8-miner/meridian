#!/usr/bin/env python3
"""
Fetch the lists tools/make_universe.py builds from that come from outside the US exchanges:

  intl.json    members of major world stock indexes, from their Wikipedia articles, as Yahoo
               symbols (FTSE 100 -> "AZN.L", Nikkei 225 -> "7203.T", ...), with name and sector
  crypto.json  the largest cryptocurrencies by market cap, from CoinGecko's public API, each
               matched to the Yahoo ticker that is the same coin: several coins share a symbol,
               so Yahoo numbers the others ("UNI7083-USD"). A ticker is accepted only when its
               last price is within 8% of CoinGecko's.

    python3 tools/fetch_lists.py OUTDIR [--only=intl|crypto]

Wikipedia pages are cached in OUTDIR/wiki and fetched slowly (Wikimedia rate-limits bursts); delete
a cached page to fetch it again. Nothing here is personal: requests carry a generic agent name.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

AGENT = "meridian-list-builder/1.0 (+https://github.com/21e8-miner/meridian)"

# index -> (Wikipedia article, Yahoo suffix, country, how to turn the table's ticker into Yahoo's)
INDEXES = {
    "FTSE 100": ("FTSE 100 Index", ".L", "United Kingdom", "dot-dash"),
    "DAX 40": ("DAX", ".DE", "Germany", "plain"),
    "CAC 40": ("CAC 40", ".PA", "France", "plain"),
    "AEX": ("AEX index", ".AS", "Netherlands", "plain"),
    "IBEX 35": ("IBEX 35", ".MC", "Spain", "plain"),
    "FTSE MIB": ("FTSE MIB", ".MI", "Italy", "plain"),
    "SMI": ("Swiss Market Index", ".SW", "Switzerland", "plain"),
    "OMX Stockholm 30": ("OMX Stockholm 30", ".ST", "Sweden", "space-dash"),
    "Nikkei 225": ("Nikkei 225", ".T", "Japan", "digits4"),
    "Hang Seng": ("Hang Seng Index", ".HK", "Hong Kong", "hk"),
    "S&P/TSX 60": ("S&P/TSX 60", ".TO", "Canada", "dot-dash"),
    "S&P/ASX 200": ("S&P/ASX 200", ".AX", "Australia", "plain"),
    "NIFTY 50": ("NIFTY 50", ".NS", "India", "plain"),
}  # (the English Ibovespa article lists no members; Brazil's large companies trade in the US as ADRs)
TICKER_COL = re.compile(r"^(ticker|symbol|code|epic|stock code|ticker symbol|tickersymbol|securities code|ticker\s*\(.*\))", re.I)
NAME_COL = re.compile(r"^(company|name|constituent|company name|stock|issuer)", re.I)
SECTOR_COL = re.compile(r"(sector|industry|classification|sub-?index)", re.I)  # Hang Seng's table calls it "Sub-index"


class Tables(HTMLParser):
    """Every <table> as a list of rows of cell texts (nested tables kept apart)."""

    def __init__(self):
        super().__init__()
        self.tables, self.stack, self.cell, self.rows = [], [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.stack.append({"rows": [], "row": None})
        elif not self.stack:
            return
        elif tag == "tr":
            self.stack[-1]["row"] = []
        elif tag in ("td", "th") and self.stack[-1]["row"] is not None:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag):
        if not self.stack:
            return
        top = self.stack[-1]
        if tag in ("td", "th") and self.cell is not None and top["row"] is not None:
            top["row"].append(re.sub(r"\[\d+\]|\[[a-z]\]", "", re.sub(r"\s+", " ", "".join(self.cell))).strip())
            self.cell = None
        elif tag == "tr" and top["row"] is not None:
            top["rows"].append(top["row"])
            top["row"] = None
        elif tag == "table":
            self.tables.append(self.stack.pop()["rows"])

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def get(url: str, tries: int = 6):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and k < tries - 1:
                time.sleep(20 * (k + 1))
                continue
            raise
        except json.JSONDecodeError:  # Wikimedia answers a rate-limit notice as plain text
            if k < tries - 1:
                time.sleep(20 * (k + 1))
                continue
            raise


def wiki_html(title: str, cache: str) -> str:
    path = os.path.join(cache, re.sub(r"[^A-Za-z0-9]", "_", title) + ".json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                d = json.load(f)
            if "parse" in d:
                return d["parse"]["text"]
        except ValueError:
            pass  # a saved rate-limit notice, not a page: fetch it again
    q = urllib.parse.urlencode({"action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": 2, "redirects": 1})
    d = get("https://en.wikipedia.org/w/api.php?" + q)
    if "parse" not in d:
        raise RuntimeError(f"{title}: {d.get('error')}")
    with open(path, "w") as f:
        json.dump(d, f)
    time.sleep(4)
    return d["parse"]["text"]


def to_yahoo(t: str, suffix: str, rule: str) -> str | None:
    t = t.strip().upper()
    t = re.sub(r"^(LSE|LON|TSX|TSE|ASX|NSE|BSE|BVMF|HKEX|SEHK|XETRA|FWB|EPA|AMS|BME|BIT|SIX|STO|TYO|OMX)\s*[:\-]\s*", "", t)
    t = re.sub(r"\.(L|DE|PA|AS|MC|MI|SW|ST|T|HK|TO|AX|NS|SA)$", "", t)  # a table that already gives the suffix
    if not t:
        return None
    if rule == "digits4":
        m = re.search(r"\d{4}", t)
        return m.group(0) + suffix if m else None
    if rule == "hk":
        m = re.search(r"\d{1,5}", t)
        return f"{int(m.group(0)):04d}{suffix}" if m else None
    if rule in ("dot-dash", "space-dash"):
        t = re.sub(r"[.\s]+", "-", t)
    t = t.split()[0] if " " in t else t
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9&\-]{0,11}", t):
        return None
    return t + suffix


def members(html: str, suffix: str, rule: str) -> list[list[str]]:
    p = Tables()
    p.feed(html)
    best = []
    for rows in p.tables:
        if len(rows) < 10:
            continue
        head = rows[0]
        ti = next((i for i, h in enumerate(head) if TICKER_COL.match(h)), None)
        if ti is None:
            continue
        ni = next((i for i, h in enumerate(head) if NAME_COL.match(h) and i != ti), None)
        si = next((i for i, h in enumerate(head) if SECTOR_COL.search(h) and i not in (ti, ni)), None)
        out = []
        for r in rows[1:]:
            if len(r) <= ti:
                continue
            y = to_yahoo(r[ti], suffix, rule)
            if y:
                out.append([y, r[ni] if ni is not None and ni < len(r) else "", r[si] if si is not None and si < len(r) else ""])
        if len(out) > len(best):
            best = out
    if len(best) < 10 and rule == "digits4":
        best = listed_codes(html, suffix)
    seen, uniq = set(), []
    for m in best:
        if m[0] not in seen:
            seen.add(m[0])
            uniq.append(m)
    return uniq


def listed_codes(html: str, suffix: str) -> list[list[str]]:
    """Members written as list items, "Toyota Motor Corp. (TYO: 7203)", under sector headings
    (the Nikkei 225 article)."""
    out, sector = [], ""
    for part in re.split(r"(<h[2-4][^>]*>.*?</h[2-4]>)", html, flags=re.S):
        if re.match(r"<h[2-4]", part):
            sector = re.sub(r"\s+", " ", re.sub(r"<[^>]+>|\[edit\]", "", part)).strip()
            continue
        for li in re.findall(r"<li[^>]*>(.*?)</li>", part, flags=re.S):
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", li)).strip()
            m = re.search(r"^(.*?)\s*\(\s*(?:TYO|TSE)\s*:\s*(\d{4})\s*\)", text)
            if m:
                out.append([m.group(2) + suffix, m.group(1).strip(), sector])
    return out


def fetch_intl(outdir: str):
    cache = os.path.join(outdir, "wiki")
    os.makedirs(cache, exist_ok=True)
    out = {}
    for name, (title, suffix, country, rule) in INDEXES.items():
        try:
            m = members(wiki_html(title, cache), suffix, rule)
        except Exception as e:
            print(f"  {name}: FAILED {e}", flush=True)
            continue
        out[name] = {"country": country, "suffix": suffix, "members": m}
        print(f"  {name}: {len(m)} members, e.g. {', '.join(x[0] for x in m[:4])}", flush=True)
    with open(os.path.join(outdir, "intl.json"), "w") as f:
        json.dump(out, f, indent=0)


# stablecoins, wrapped and staked copies of other coins: they add nothing to chart
NOT_A_COIN = re.compile(r"(usd|eur|gold|wrapped|staked|bridged|liquid staking|restaked|tokenized|wbtc|weth|steth|cbbtc|bitcoin bep2|tether|stable|dollar)", re.I)
STABLE = {"USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "PYUSD", "USD1", "RLUSD", "BUSD", "USDD", "USDX", "FRAX", "USDP", "GUSD", "LUSD", "USDB", "USDY", "USDF", "USDG", "USDTB", "BUIDL", "USYC", "XAUT", "PAXG", "EURC", "SUSDS", "SUSDE", "USD0", "USR", "DEUSD", "USTB", "OUSG", "USDO", "BFUSD", "USDAI", "SYRUPUSDC", "SYRUPUSDT", "GHO", "YLDS", "USAT", "USX"}


def fetch_crypto(outdir: str, n: int = 250):
    rows = []
    for page in (1, 2):
        q = urllib.parse.urlencode({"vs_currency": "usd", "order": "market_cap_desc", "per_page": n // 2 if n > 125 else n, "page": page})
        rows += get("https://api.coingecko.com/api/v3/coins/markets?" + q)
        time.sleep(3)
        if n <= 125:
            break
    out = []
    for r in rows:
        name, sym = r.get("name") or "", (r.get("symbol") or "").upper()
        if sym in STABLE or NOT_A_COIN.search(name) or NOT_A_COIN.search(r.get("id") or "") or not re.fullmatch(r"[A-Z0-9]{2,10}", sym):
            continue
        out.append({"symbol": sym, "name": name, "id": r.get("id"), "price": r.get("current_price"), "cap": r.get("market_cap"), "volume": r.get("total_volume")})
    matched = 0
    known, taken = {}, set()
    path = os.path.join(outdir, "crypto.json")
    if os.path.exists(path):
        with open(path) as f:
            known = {c["id"]: c.get("yahoo") for c in json.load(f) if c.get("yahoo")}
    for c in out:
        c["yahoo"] = known.get(c["id"]) or match_yahoo(c)  # a match from an earlier run is kept
        # Two coins can share a symbol and a price close enough to pass (a token and its wrapped or
        # renamed twin): the list is largest first, so the first one keeps the ticker.
        if c["yahoo"] in taken:
            c["yahoo"] = None
        elif c["yahoo"]:
            taken.add(c["yahoo"])
        matched += bool(c["yahoo"])
        time.sleep(0.3)
    with open(os.path.join(outdir, "crypto.json"), "w") as f:
        json.dump(out, f, indent=0)
    print(f"  crypto: {len(out)} coins (of {len(rows)} listed), {matched} matched to a Yahoo ticker, e.g. {', '.join(c['yahoo'] for c in out[:8] if c['yahoo'])}", flush=True)
    miss = [c["symbol"] for c in out if not c["yahoo"]]
    if miss:
        print("  no Yahoo ticker with a matching price:", " ".join(miss), flush=True)


def yahoo_last(symbol: str):
    url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol) + "?interval=1d&range=5d"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            res = json.loads(r.read().decode("utf-8"))["chart"]["result"][0]
        closes = [x for x in res["indicators"]["quote"][0]["close"] if x]
        return closes[-1] if closes and res["meta"].get("instrumentType") == "CRYPTOCURRENCY" else None
    except Exception:
        return None


def match_yahoo(coin: dict) -> str | None:
    """The Yahoo ticker that is this coin, judged by price."""
    price = coin.get("price") or 0
    same = lambda p: p and price and abs(p / price - 1) < 0.08
    first = coin["symbol"] + "-USD"
    if same(yahoo_last(first)):
        return first
    quotes = []
    for term in (coin["symbol"] + " USD", coin.get("name") or "", (coin.get("name") or "") + " USD"):
        if not term.strip():
            continue
        try:
            q = urllib.parse.urlencode({"q": term, "quotesCount": 10, "newsCount": 0})
            req = urllib.request.Request("https://query1.finance.yahoo.com/v1/finance/search?" + q, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as r:
                quotes += json.loads(r.read().decode("utf-8")).get("quotes") or []
        except Exception:
            pass
        time.sleep(0.3)
    tried = set()
    for qt in quotes:
        sym = qt.get("symbol") or ""
        if qt.get("quoteType") == "CRYPTOCURRENCY" and sym != first and re.fullmatch(re.escape(coin["symbol"]) + r"\d*-USD", sym) and sym not in tried:
            tried.add(sym)
            time.sleep(0.3)
            if same(yahoo_last(sym)):
                return sym
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    outdir = sys.argv[1]
    only = next((a.split("=", 1)[1] for a in sys.argv[2:] if a.startswith("--only=")), None)
    os.makedirs(outdir, exist_ok=True)
    if only in (None, "intl"):
        fetch_intl(outdir)
    if only in (None, "crypto"):
        fetch_crypto(outdir)


if __name__ == "__main__":
    main()

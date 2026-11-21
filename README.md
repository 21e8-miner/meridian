# Meridian

A local market-analysis workstation: charting with automated technical analysis, a market heat map,
a multi-timeframe scanner, a strategy tester, alerts and paper bots, a JavaScript indicator studio,
a small model lab and seasonality tables. One Python file serves it; the front end is plain ES modules with no build
step and no dependencies.

**Shared page:** https://21e8-miner.github.io/meridian/ — runs in the browser with no install, on
about 6,100 symbols (every US stock over $2B and the liquid smaller ones, the S&P 500 with sectors,
about 2,100 ETFs, 940 stocks from 13 world indexes, 120 cryptocurrencies, futures,
world indexes, currencies, crypto) plus Hyperliquid's live markets. Run it locally (below) to chart any symbol.

## Run

```bash
python3 server.py        # http://127.0.0.1:8830  (any Python 3.9+; pass a port to change it)
```

Tests run on deterministic synthetic data, so they need no network and no cache:

```bash
npm test
```

| File | Covers |
| --- | --- |
| `tests/smoke.mjs` | all 66 indicators on daily and 5-minute bars (one value per bar, finite, unchanged when the future is removed), reference values by hand, timeframe aggregation, higher-timeframe alignment, dividend adjustment, automated analysis |
| `tests/engine.mjs` | fills, fees, slippage, sizing, stops, targets, trailing and time exits, short side, rule evaluation, multi-timeframe rules, yearly table, parameter sweep, statistics |
| `tests/formula.mjs` | rules as text: round trips, alternate spellings, error messages |
| `tests/lab.mjs` | model lab: split, embargo, no output on training bars |
| `tests/markets.mjs` | Markets view: period changes by calendar (holidays, month ends, year to date), breadth, treemap layout (areas, bounds, no overlap), tile colors |
| `tests/parity.mjs` | the browser port of the live fill and of the market summary rows gives the same results as the Python (cases written by `tests/make_parity.py`) |
| `tests/test_server.py` | provider parsing: null rows, stub bars, wall-clock times, duplicate sessions, adjusted closes; market sessions; the live fill (projection maths, agreement across timeframes, market hours); the shared-site build (which series are due, across closes, weekends, holidays and a clock change); the metrics (text format, histogram arithmetic, provider failure counting, the `/metrics` endpoint on a live local server) |

## What is in it

| Area | What it does |
| --- | --- |
| **Charts** | Candles, hollow, Heikin-Ashi, OHLC bars, line, area. 1m to monthly; intraday charts of an open market refresh every 15 seconds. Log scale, volume, volume-by-price. 1, 2 or 4 charts side by side. 66 built-in indicators, each of which can be computed on a higher timeframe and overlaid. Right-click a bar to anchor a VWAP there. Optional dividend-adjusted prices. Drawing tools: trendline, ray, horizontal line, rectangle, Fibonacci, note, measure; points snap to the nearest open/high/low/close (hold Alt for free placement). Drawings are saved per symbol. Crosshairs are linked across charts; drag the price axis to zoom it, arrow keys pan. |
| **Markets** | A whole list at once: heat map grouped by sector (color = change over 1 day to 1 year, area = dollar volume or equal), advancers and decliners, share above the 50- and 200-day averages, 52-week closing highs and lows, a table per sector, strongest and weakest. Click a tile to open its chart, a sector to zoom into it. |
| **Auto analysis** | Trendlines through swing pivots (with touch counts and break detection), support / resistance zones, Fibonacci retracement of the dominant swing, 20 candlestick patterns, chart patterns (double top / bottom, head & shoulders, triangles, wedges, channels, rectangle), open gaps. A side panel lists what was found plus a multi-timeframe trend table. |
| **Scanner** | Filters on daily values (change over 1 day to 1 year, dollar and relative volume, RSI, distance from the 50 and 200 SMA and the 52-week range, ATR, gap), then conditions built by pointing and clicking or typed as text (`close > sma(200) and rsi(14) < 30 @1w`): indicator vs indicator or value, crosses, candlestick patterns, auto-analysis signals, each on its own timeframe. Built-in lists or any watchlist. Ten presets. Results save to a watchlist or CSV. On the shared page the filters and the presets run on all 8,834 symbols at once (below). |
| **Strategy Tester** | Entry and exit rules from the same builder, long or short, stop / target / trailing stop / time exit, fees and slippage. Report with equity vs buy & hold, drawdown, a year-by-year table, trade list (CSV export), trades drawn on the chart. Dividends included by default. **Sweep a setting** runs a range of values for any number in the strategy and shows in-sample next to out-of-sample. Runs one symbol or a whole list. |
| **Alerts & Bots** | Price-level alerts, alerts on a line you drew (right-click the chart), multi-factor rule alerts. Paper bots track a tested strategy forward from the moment of deployment. |
| **Indicator Studio** | Write indicators in JavaScript. Saved scripts work on charts and inside scan, strategy and alert conditions. |
| **Model Lab** | Logistic regression or boosted stumps predicting "up more than X% in N bars" from indicator inputs. Fitted on the first 70% of history, scored on the last 30% with an embargo between them. A saved model becomes an indicator. |
| **Seasonality** | Month-by-year return grid, per-month averages and hit rates, day-of-week returns. |
| **Checklists** | Any saved rule set can be checked condition by condition against the chart you are looking at. |
| **Links** | The address names what is on screen (`#/chart/NQ=F/5m`, `#/markets`); the 🔗 button copies it. Layouts, drawings and indicators stay in each browser. |
| **Touch** | On a phone or tablet one finger pans, draws and moves the crosshair; two fingers pinch to zoom. |
| **Backup** | The ⇅ button exports everything saved in the browser to one file and restores it. |

## How it avoids fooling you

- Indicators never read the future; `tests/smoke.mjs` proves it for every one by truncating history.
- A higher-timeframe value reaches a lower-timeframe bar only after the higher bar has closed. A
  higher-timeframe *cross* counts once, on the bar where that higher bar closes; a higher-timeframe
  *state* (above, below) holds until the next higher bar closes.
- Indicator settings are clamped to their allowed range, so a negative length cannot read ahead.
- Backtest signals are read at a bar's close and filled at the next bar's open. A stop and a target
  inside the same bar resolve as the stop; a bar that opens through either level fills at the open.
- Auto-analysis scan signals build their trendlines and zones from bars before the latest one.
- The Model Lab reports the test period only, next to the do-nothing baseline. A saved model is
  blank before its test period began, so a backtest cannot grade it on the data it learned from.
- A parameter sweep never shows a best value without its out-of-sample result beside it.
- Backtests use total-return prices by default, so buy & hold is not understated by missing dividends.

## Near-real-time futures

Free exchange data for futures is ten minutes late on every public source (measured on Yahoo and
CNBC, 2026-11-15). Meridian closes that gap for the contracts below by projecting the missing
minutes from a market that trades the same thing live, around the clock: a Hyperliquid perpetual.

    estimate(now) = last exchange print x proxy(now) / proxy(at that print)

The proxy only supplies the move since the last real print, so a standing price difference between
the two markets cancels. Every timeframe is scaled from the same last complete 1-minute exchange
bar, so they all show the same live price. Estimated bars are shaded on the chart, tagged
`LIVE EST`, carry zero volume, and are replaced by exchange bars as those arrive. Charts showing
an estimate refresh every 5 seconds.

| Future | Live proxy | Projection error, 10 min ahead (median / 90th pct) | Showing the 10-min-old price instead |
| --- | --- | --- | --- |
| `NQ=F`, `MNQ=F` | `XYZ100` | 0.8 bp / 2.3 bp (about 2 / 6 NQ points) | 8.6 bp / 26.7 bp |
| `ES=F`, `MES=F` | `SP500` | 0.6 bp / 1.6 bp | 4.6 bp / 15.7 bp |
| `GC=F` | `GOLD` | 1.5 bp / 3.9 bp | 6.7 bp / 19.1 bp |
| `SI=F` | `SILVER` | 1.7 bp / 4.6 bp | 11.8 bp / 34.7 bp |
| `CL=F` | `CL` | 1.8 bp / 4.9 bp | 11.2 bp / 33.2 bp |
| `BZ=F` | `BRENTOIL` | 2.9 bp / 7.6 bp | 12.6 bp / 35.5 bp |

Measured on about 1,900 one-minute bars per contract. Contracts where the proxy did not beat the
delayed price by at least 4x are left on the delayed feed (Dow, Russell, copper, natural gas,
platinum, palladium, heating oil, euro, Nikkei).

What to keep in mind:

- It is an estimate of the exchange price, not the exchange price. Alerts, bots and scans read it
  like any other bar.
- It is weakest right after a closure. Across a weekend the projection was 43 bp off at the reopen
  (the perpetual carries its own weekend premium); the status line says "rough" until the exchange
  has printed again.
- The live markets can also be charted directly, with real volume and no estimate involved: type
  `XYZ100`, or any `XYZ:` name (`XYZ:SP500`, `XYZ:GOLD`, `XYZ:NVDA`, …). They trade 24/7.
- Other symbols are unchanged: currencies run about a minute behind, crypto a few seconds. The
  status line at the top right always says what the active chart is showing: live estimate
  (green), delayed, market closed, or amber when a market is open but no new bars have arrived.

### Stocks outside regular hours

A stock chart continues past the 16:00 close. Where the exchange printed in the pre-market or
after hours (04:00–20:00 ET on weekdays) those prints are shown as they are; that works for every
stock. Where there are no prints — overnight, weekends, a thin pre-market — 39 stocks and ETFs
are filled in from the Hyperliquid perpetual on the same name, scaled to the last real print, so
each new print re-anchors the estimate. Estimated bars are faded; the stretch is shaded and
labelled "outside regular hours". Daily bars are never changed (a daily bar is the regular
session): the latest print or estimate is drawn as a dotted line instead, and the watchlist shows
it with a dot beside the price.

Measured against a week of real extended-hours prints, reading the estimate one minute before the
next real print arrived (15 liquid names):

| Stretch with no prints | Estimate error (median / worst) | Holding the last print |
| --- | --- | --- |
| 10 minutes | 6.9 bp across the list (NVDA 2.3, SPY 1.2, QQQ 1.3) | 18.9 bp |
| Overnight, 20:00 → 04:00 | 9.5 bp / 42 bp | 75 bp / 314 bp |
| Weekend, Fri 20:00 → Mon 04:00 | 14 bp / 27 bp | 55 bp / 612 bp |

A name is only given a proxy if the 10-minute projection beat holding the last print by 40% or
more on a perp trading at least $1M a day; 56 other listed names failed that and get real prints
only. Backtests, the model lab and seasonality always read exchange bars only.

## The shared page

`tools/snapshot.py` builds a static copy of the app: `web/` plus recent exchange history. A GitHub
Actions job (`.github/workflows/pages.yml`) rebuilds and publishes it about every ten minutes
while US stocks are printing (weekdays 04:00–20:00 New York) and every half hour otherwise.
GitHub's own scheduler starts runs late or not at all when it is busy, so each run books the next
one itself and the schedule only restarts that chain if it stops; disabling the workflow stops
it. A
static page cannot fetch the exchange feed itself, so between builds the page keeps itself current
in the browser: it reads Hyperliquid directly and applies the same projection as the server
(`web/js/static.js`, a port of the server code that `tests/parity.mjs` checks against it on 6,300
shared cases).

The data set has two tiers, so it can be wide without flooding the provider with requests:

| Tier | Symbols | History | Refreshed |
| --- | --- | --- | --- |
| Core | 184: everything with a live proxy; grains, meats, softs, metals, energy, currency and crypto futures; US and world indexes; 20 currency pairs; 20 cryptocurrencies; the main ETFs; mega caps | 1m, 5m (15m and 30m are built from it), hourly, 10 years daily | every build |
| Extended | 1,073: the rest of the S&P 500 and other followed stocks, with sectors; every ETF that trades at least $50M a day (VGT, VYM, ...); about 100 more chosen funds; and every WisdomTree, Cambria and Alpha Architect fund (`web/universe.json`) | 1-minute (about four sessions), 5-minute (about four weeks; 15m and 30m are built from it), hourly (about 10 months), 10 years daily | on a rolling basis: 1- and 5-minute bars within about 30 minutes, daily and hourly within about an hour while the market is open, once more after the close, not at all overnight or at weekends |
| Crypto | 102: the largest coins by market cap (CoinGecko) that trade at least $1M a day, each matched to the Yahoo ticker with the same price (several coins share a symbol) | 1-minute (about a day), 5-minute, hourly, daily | like extended, but around the clock: crypto never closes |
| Broad | 7,477: every other US-listed common stock over $2B market cap; smaller ones (from $200M) that trade at least $1M a day; every other US ETF that trades at least $250K a day, and every fund of 34 issuers (Vanguard, iShares, SPDR, Schwab, Invesco, First Trust, ProShares, Direxion, Global X, ARK, JPMorgan, Dimensional, Fidelity, Avantis, VanEck, ...) that trades at all; and the members of 13 world indexes (FTSE 100, DAX 40, CAC 40, AEX, IBEX 35, FTSE MIB, SMI, OMX Stockholm 30, Nikkei 225, Hang Seng, S&P/TSX 60, S&P/ASX 200, NIFTY 50) from their Wikipedia articles. Each issuer and each index has a list of its own in the Scanner and Markets (sectors for stocks are Nasdaq's, mapped onto the GICS names, so rougher) | 5-minute (about two weeks; 15m and 30m are built from it), hourly (about 8 months), 10 years daily; the daily and 5-minute history on a site of its own (below) | 5-minute within about an hour, daily within about 90 minutes, hourly within about two hours while the market is open |

Every refresh asks for the last few bars only and joins them onto the carried history; if the two
disagree on any shared bar (a split or dividend restated the history), the history is a week old,
or it does not reach as far back as is now kept, the whole series is fetched again.

A build fetches only the extended series that are due and carries the others over from the last
published build, which the job downloads as it was uploaded (reading it back through the public
site would spend the site's bandwidth allowance on its own upkeep; that route is only the fallback).
Nothing else is stored. A symbol the provider stops answering for keeps its last published history,
and a build that would lose a real share of what is published stops instead of replacing it.

**Two sites.** GitHub Pages allows 1 GB a site, so the broad tier's daily and 5-minute history is
published separately, at https://21e8-miner.github.io/meridian-data/ (repository `21e8-miner/meridian-data`,
built by the same `tools/snapshot.py --part=broad`; its workflow is kept here as
`data-site/pages.yml`); its hourly history is on the main site. The main site's catalog names the
data site as a shard and the page merges the two, taking each timeframe of a symbol from whichever
site has it; if the data site cannot be read, what is on it is left out and everything else works.
More shards can be added the same way, and a build that would publish more than a site may hold
stops instead. Files are published in a compact form (bar times as gaps in the largest step that
divides them, the dividend adjustment as runs of a factor), about 30% smaller than plain columns,
and gzip-compressed on top (`<symbol>.json.gz`): Pages counts a site's size as stored, so this
gives each site about three times the room. The page inflates them itself (the browser's
`DecompressionStream`: Chrome 80, Safari 16.4, Firefox 113 or newer). A build copies a carried,
unchanged file's bytes rather than compressing it again, so only refreshed series cost time.

Foreign stocks are priced in their own currency; the Markets view converts their dollar volume
with the core currency pairs. World markets are refreshed on the US schedule, so a market that
has closed has its final bar within the day. Script and stylesheet addresses carry a build
version, so a browser never runs a mix of two builds' code.

What differs from running locally: only the listed symbols have history (plus any `XYZ:` live
market); broad symbols have no timeframe shorter than five minutes (two weeks of it), extended
ones keep about four sessions of one-minute bars, and neither has a live estimate; a scan with
conditions other than an unchanged preset downloads about 0.13 MB per symbol that passes its
filters, the first time; 1-minute
history is about a day deep; and exchange prints are as old as that series' last refresh (the
status line says how old) with estimates bridging to now where a proxy exists. The Markets view
reads a year of daily closes per symbol from one file for the core and extended lists, and a
second, larger one only when a list includes broad symbols.

**Screening every symbol at once.** A scan of every shared symbol would download over a gigabyte
of history, so each build answers the common questions in advance: after the snapshot,
`tools/screen.mjs` runs the page's own code (`web/js/screen.js`, the same indicators and rule
evaluator) over every daily file the site publishes and writes `data/screen.json`, about 1 MB for
all 8,834 symbols across both sites: each symbol's filter values, and for every preset how many
bars ago it last matched (the newest ten bars). The Scanner answers filters, and an unchanged
preset on the daily timeframe, from those files in a fraction of a second; other conditions are
scanned from downloaded history, for the symbols that passed the filters only. `tests/screen.mjs`
checks that the instant answers equal a scan of the files, and they were compared on 900 real
symbols for every preset (no differences).

**Daily signals feed.** The main site's build also keeps `signals.xml`, an Atom feed with one entry
per US session: what each preset matched at that close, across both sites, most traded first.
A session is added once both sites have screened its finished bars (its day must be over where
each market is), so it appears shortly after midnight New York time. Subscribe in any feed reader:
https://21e8-miner.github.io/meridian/signals.xml

**Tests gate publishing.** Both workflows run `npm test` before building; a commit that fails them
is not published, and the sites keep their last good build until a later run passes.

To change the lists, edit `tools/make_universe.py` or feed it newer input files (its docstring
says where each comes from) and run it. The liquidity cutoffs need `tools/liquidity_probe.py`
first, which measures each candidate's dollar volume with one small request (about 11 minutes for
7,000 symbols); and the world indexes and coins come from `tools/fetch_lists.py` (also probed before use); `CORE` in `tools/snapshot.py` is the list that gets every timeframe.

## Monitoring with Prometheus

The local server publishes its own health at `http://127.0.0.1:8830/metrics` in Prometheus' text
format (`metrics.py`, standard library only). `monitoring/prometheus.yml` scrapes it and loads
`monitoring/alerts.yml`:

```bash
brew install prometheus
prometheus --config.file=monitoring/prometheus.yml
```

Then open http://localhost:9090. What is measured:

| Metric | What it says |
| --- | --- |
| `meridian_upstream_requests_total{provider, outcome}` and `_duration_seconds` | every request to Yahoo and Hyperliquid: ok, throttled, http_error, timeout, network_error; and how long it took |
| `meridian_cache_lookups_total{result}` | where each series came from: memory, disk, fetched, stale (provider failed, last good copy served), error |
| `meridian_live_fill_total{outcome}` | live estimates put on a response: fill (delayed futures), ext (stocks outside regular hours), none, error |
| `meridian_live_anchor_age_seconds{symbol}` | how old the newest real exchange print was when a live estimate was last built (proxied symbols, last 10 minutes) |
| `meridian_proxy_last_candle_age_seconds{coin}` | how old the newest Hyperliquid candle is for each live proxy in use |
| `meridian_http_requests_total{route, code}` and `_duration_seconds` | the app's own requests |
| `meridian_cache_disk_bytes`, `_files`, `meridian_cache_series`, `meridian_cache_pruned_*` | cache size and housekeeping |
| `meridian_process_*`, `meridian_threads`, `meridian_start_time_seconds`, `meridian_build_info` | the process |

The alert rules: server down, a provider throttling or failing, stale copies being served, a live
proxy with no recent candles, an exchange feed that has gone quiet, slow answers. The server
listens on 127.0.0.1 only, so Prometheus must run on the same machine. The shared page has no
server, so it has no metrics.

## Rules as text

The text box above every rule builder shows the same rule the rows do; edit either.

```
close > sma(200) and rsi(2) < 10
sma(50) crosses above sma(200)
close > sma(30) @1w and macd crosses above macd.signal
volume > 1.5 * volume(20).avg[1]        multiplier, and [n] = n bars ago
candle(hammer, 3) or candle(any_bull)    pattern within the last 3 bars
auto(break_res)                          scans and alerts only
```

Indicators are named by id (`sma`, `bb`, `macd`, …) with their settings in order; a second output
is written `bb(20, 2).lower`. A timeframe is `@1w` or `on weekly`. One rule set uses only `and` or
only `or`.

## Limits

- **Data** is Yahoo's public chart feed through the local server, cached in `~/Library/Caches/meridian` (set `MERIDIAN_CACHE` to move it). The cache keeps itself under 512 MB and drops series not fetched for two weeks. History goes
  back 7 days for 1-minute bars, 60 days for 5–30 minute bars and about two years for hourly bars.
  US-listed stocks, ETFs, indexes, futures, currencies and crypto pairs work; there are no options,
  fundamentals, filings or news.
- **Alerts and bots run in the browser tab.** Close the tab and they stop. Nothing is sent to a broker.
- Everything you save (layouts, watchlists, drawings, rules, scripts, models) lives in this browser's
  local storage. Use the backup button to keep a copy or move it.
- There is no AI assistant; that needs a model API key and is not wired up.

## Layout

```
server.py            static files, cached price proxy, live fill for futures (/api/bars, /api/batch, /api/search)
web/js/ta.js         indicator math and registry
web/js/auto.js       pivots, trendlines, zones, Fibonacci, candlestick and chart patterns
web/js/chart.js      canvas chart
web/js/data.js       fetch, cache, derived timeframes, higher-timeframe alignment
metrics.py           Prometheus metrics registry and text format    monitoring/  scrape config, alert rules
web/js/static.js     data backend for the shared page: snapshot + live fill in the browser
web/js/markets.js    Markets view: breadth, heat map, sector table, movers
web/universe.json    stock list with sectors (written by tools/make_universe.py)
tools/snapshot.py    builds the shared site (three tiers, rolling refresh)
tools/screen.mjs     screens every symbol a built site publishes; the daily signals feed
web/js/screen.js     screening row, presets, instant answers (page and build share it)
web/js/conditions.js rule model, evaluator and builder UI      web/js/formula.js  rules as text
web/js/engine.js     backtest engine        web/js/sim.js   rules -> engine glue
web/js/research.js   yearly breakdown and parameter sweep
web/js/app.js        shell, panels, toolbar, watchlist, analysis panel
web/js/{scanner,backtest,alerts,studio,lab,seasonality}.js   the other views
```

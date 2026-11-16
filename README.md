# Meridian

A local market-analysis workstation: charting with automated technical analysis, a multi-timeframe
scanner, a strategy tester, alerts and paper bots, a JavaScript indicator studio, a small model lab
and seasonality tables. One Python file serves it; the front end is plain ES modules with no build
step and no dependencies.

**Shared page:** https://21e8-miner.github.io/meridian/ — runs in the browser with no install, on
90 symbols plus Hyperliquid's live markets. Run it locally (below) to chart any symbol.

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
| `tests/parity.mjs` | the browser port of the live fill gives the same results as `server.py` (cases written by `tests/make_parity.py`) |
| `tests/test_server.py` | provider parsing: null rows, stub bars, wall-clock times, duplicate sessions, adjusted closes; market sessions; the live fill (projection maths, agreement across timeframes, market hours) |

## What is in it

| Area | What it does |
| --- | --- |
| **Charts** | Candles, hollow, Heikin-Ashi, OHLC bars, line, area. 1m to monthly; intraday charts of an open market refresh every 15 seconds. Log scale, volume, volume-by-price. 1, 2 or 4 charts side by side. 66 built-in indicators, each of which can be computed on a higher timeframe and overlaid. Right-click a bar to anchor a VWAP there. Optional dividend-adjusted prices. Drawing tools: trendline, ray, horizontal line, rectangle, Fibonacci, note, measure; points snap to the nearest open/high/low/close (hold Alt for free placement). Drawings are saved per symbol. Crosshairs are linked across charts; drag the price axis to zoom it, arrow keys pan. |
| **Auto analysis** | Trendlines through swing pivots (with touch counts and break detection), support / resistance zones, Fibonacci retracement of the dominant swing, 20 candlestick patterns, chart patterns (double top / bottom, head & shoulders, triangles, wedges, channels, rectangle), open gaps. A side panel lists what was found plus a multi-timeframe trend table. |
| **Scanner** | Conditions built by pointing and clicking or typed as text (`close > sma(200) and rsi(14) < 30 @1w`): indicator vs indicator or value, crosses, candlestick patterns, auto-analysis signals, each on its own timeframe. Built-in lists or any watchlist. Ten presets. Results save to a watchlist or CSV. |
| **Strategy Tester** | Entry and exit rules from the same builder, long or short, stop / target / trailing stop / time exit, fees and slippage. Report with equity vs buy & hold, drawdown, a year-by-year table, trade list (CSV export), trades drawn on the chart. Dividends included by default. **Sweep a setting** runs a range of values for any number in the strategy and shows in-sample next to out-of-sample. Runs one symbol or a whole list. |
| **Alerts & Bots** | Price-level alerts, alerts on a line you drew (right-click the chart), multi-factor rule alerts. Paper bots track a tested strategy forward from the moment of deployment. |
| **Indicator Studio** | Write indicators in JavaScript. Saved scripts work on charts and inside scan, strategy and alert conditions. |
| **Model Lab** | Logistic regression or boosted stumps predicting "up more than X% in N bars" from indicator inputs. Fitted on the first 70% of history, scored on the last 30% with an embargo between them. A saved model becomes an indicator. |
| **Seasonality** | Month-by-year return grid, per-month averages and hit rates, day-of-week returns. |
| **Checklists** | Any saved rule set can be checked condition by condition against the chart you are looking at. |
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

`tools/snapshot.py` builds a static copy of the app: `web/` plus recent exchange history for a
fixed list of 90 symbols. A GitHub Actions job (`.github/workflows/pages.yml`) rebuilds and
publishes it every ten minutes. A static page cannot fetch the exchange feed itself, so between
builds the page keeps itself current in the browser: it reads Hyperliquid directly and applies
the same projection as the server (`web/js/static.js`, a port of the server code that
`tests/parity.mjs` checks against it on 6,300 shared cases).

What differs from running locally: only the listed symbols have history (plus any `XYZ:` live
market), 1-minute history is about a day deep, and exchange prints are as old as the last build
(the status line says how old) with estimates bridging to now where a proxy exists.

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

- **Data** is Yahoo's public chart feed through the local server, cached in `.cache/`. History goes
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
web/js/static.js     data backend for the shared page: snapshot + live fill in the browser
tools/snapshot.py    builds the shared site
web/js/conditions.js rule model, evaluator and builder UI      web/js/formula.js  rules as text
web/js/engine.js     backtest engine        web/js/sim.js   rules -> engine glue
web/js/research.js   yearly breakdown and parameter sweep
web/js/app.js        shell, panels, toolbar, watchlist, analysis panel
web/js/{scanner,backtest,alerts,studio,lab,seasonality}.js   the other views
```

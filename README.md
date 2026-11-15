# Meridian

A local market-analysis workstation: charting with automated technical analysis, a multi-timeframe
scanner, a strategy tester, alerts and paper bots, a JavaScript indicator studio, a small model lab
and seasonality tables. One Python file serves it; the front end is plain ES modules with no build
step and no dependencies.

## Run

```bash
python3 server.py        # http://127.0.0.1:8830  (any Python 3.9+; pass a port to change it)
```

Tests (they read the server's disk cache, so load SPY once in the app first):

```bash
node tests/smoke.mjs     # every indicator: length, finite, no lookahead; auto-analysis sanity
node tests/engine.mjs    # backtest fills, stops, fees, short side, no lookahead, multi-timeframe
```

## What is in it

| Area | What it does |
| --- | --- |
| **Charts** | Candles, hollow, Heikin-Ashi, OHLC bars, line, area. 5m to monthly. Log scale, volume, volume-by-price. 1, 2 or 4 charts side by side. 36 built-in indicators, each of which can be computed on a higher timeframe and overlaid. Drawing tools: trendline, ray, horizontal line, rectangle, Fibonacci, note, measure. Drawings are saved per symbol. |
| **Auto analysis** | Trendlines through swing pivots (with touch counts and break detection), support / resistance zones, Fibonacci retracement of the dominant swing, 20 candlestick patterns, chart patterns (double top / bottom, head & shoulders, triangles, wedges, channels, rectangle), open gaps. A side panel lists what was found plus a multi-timeframe trend table. |
| **Scanner** | Point-and-click conditions (indicator vs indicator or value, crosses, candlestick patterns, auto-analysis signals), each on its own timeframe. Built-in lists or any watchlist. Ten presets. Results save to a watchlist. |
| **Strategy Tester** | Entry and exit rules from the same builder, long or short, stop / target / trailing stop / time exit, fees and slippage. Report with equity vs buy & hold, drawdown, trade list, trades drawn on the chart. Runs one symbol or a whole list. |
| **Alerts & Bots** | Price-level alerts, alerts on a line you drew (right-click the chart), multi-factor rule alerts. Paper bots track a tested strategy forward from the moment of deployment. |
| **Indicator Studio** | Write indicators in JavaScript. Saved scripts work on charts and inside scan, strategy and alert conditions. |
| **Model Lab** | Logistic regression or boosted stumps predicting "up more than X% in N bars" from indicator inputs. Fitted on the first 70% of history, scored on the last 30% with an embargo between them. A saved model becomes an indicator. |
| **Seasonality** | Month-by-year return grid, per-month averages and hit rates, day-of-week returns. |
| **Checklists** | Any saved rule set can be checked condition by condition against the chart you are looking at. |

## How it avoids fooling you

- Indicators never read the future; `tests/smoke.mjs` proves it for every one by truncating history.
- A higher-timeframe value reaches a lower-timeframe bar only after the higher bar has closed.
- Backtest signals are read at a bar's close and filled at the next bar's open. A stop and a target
  inside the same bar resolve as the stop.
- Auto-analysis scan signals build their trendlines and zones from bars before the latest one.
- The Model Lab reports the test period only, next to the do-nothing baseline.

## Limits

- **Data** is Yahoo's public chart feed through the local server, cached in `.cache/`. It is delayed,
  regular-session only, split-adjusted but not dividend-adjusted, and goes back 60 days for 5–30 minute
  bars and about two years for hourly bars. US-listed stocks, ETFs, indexes and crypto pairs work;
  there are no options, fundamentals, filings or news.
- **Alerts and bots run in the browser tab.** Close the tab and they stop. Nothing is sent to a broker.
- Everything you save (layouts, watchlists, drawings, rules, scripts, models) lives in this browser's
  local storage.
- There is no AI assistant; that needs a model API key and is not wired up.

## Layout

```
server.py            static files + cached price proxy (/api/bars, /api/batch, /api/search)
web/js/ta.js         indicator math and registry
web/js/auto.js       pivots, trendlines, zones, Fibonacci, candlestick and chart patterns
web/js/chart.js      canvas chart
web/js/data.js       fetch, cache, derived timeframes, higher-timeframe alignment
web/js/conditions.js rule model, evaluator and builder UI
web/js/engine.js     backtest engine        web/js/sim.js   rules -> engine glue
web/js/app.js        shell, panels, toolbar, watchlist, analysis panel
web/js/{scanner,backtest,alerts,studio,lab,seasonality}.js   the other views
```

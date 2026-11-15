# Meridian

A local market-analysis workstation: charting with automated technical analysis, a multi-timeframe
scanner, a strategy tester, alerts and paper bots, a JavaScript indicator studio, a small model lab
and seasonality tables. One Python file serves it; the front end is plain ES modules with no build
step and no dependencies.

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
| `tests/test_server.py` | provider parsing: null rows, stub bars, wall-clock times, duplicate sessions, adjusted closes |

## What is in it

| Area | What it does |
| --- | --- |
| **Charts** | Candles, hollow, Heikin-Ashi, OHLC bars, line, area. 5m to monthly. Log scale, volume, volume-by-price. 1, 2 or 4 charts side by side. 66 built-in indicators, each of which can be computed on a higher timeframe and overlaid. Right-click a bar to anchor a VWAP there. Optional dividend-adjusted prices. Drawing tools: trendline, ray, horizontal line, rectangle, Fibonacci, note, measure; points snap to the nearest open/high/low/close (hold Alt for free placement). Drawings are saved per symbol. Crosshairs are linked across charts; drag the price axis to zoom it, arrow keys pan. |
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

- **Data** is Yahoo's public chart feed through the local server, cached in `.cache/`. It is delayed,
  regular-session only, and goes back 60 days for 5–30 minute bars and about two years for hourly bars.
  Charts and scans use split-adjusted prices; the tester and seasonality add dividends (daily and longer
  only, where the feed has them). US-listed stocks, ETFs, indexes and crypto pairs work;
  there are no options, fundamentals, filings or news.
- **Alerts and bots run in the browser tab.** Close the tab and they stop. Nothing is sent to a broker.
- Everything you save (layouts, watchlists, drawings, rules, scripts, models) lives in this browser's
  local storage. Use the backup button to keep a copy or move it.
- There is no AI assistant; that needs a model API key and is not wired up.

## Layout

```
server.py            static files + cached price proxy (/api/bars, /api/batch, /api/search)
web/js/ta.js         indicator math and registry
web/js/auto.js       pivots, trendlines, zones, Fibonacci, candlestick and chart patterns
web/js/chart.js      canvas chart
web/js/data.js       fetch, cache, derived timeframes, higher-timeframe alignment
web/js/conditions.js rule model, evaluator and builder UI      web/js/formula.js  rules as text
web/js/engine.js     backtest engine        web/js/sim.js   rules -> engine glue
web/js/research.js   yearly breakdown and parameter sweep
web/js/app.js        shell, panels, toolbar, watchlist, analysis panel
web/js/{scanner,backtest,alerts,studio,lab,seasonality}.js   the other views
```

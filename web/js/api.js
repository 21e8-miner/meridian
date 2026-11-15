// Late-bound handle to the app shell, filled in by app.js, so feature modules do not import it.
export const api = {
  openChart(symbol, tf) {},      // show symbol (and optionally timeframe) on the active chart, switch to Charts
  activeSymbol() { return 'SPY'; },
  activeTf() { return '1d'; },
  showTrades(symbol, tf, trades) {}, // open the chart with backtest trades marked
  watchlists() { return {}; },
  setWatchlist(name, symbols) {},
  addIndicator(id) {},           // add an indicator to the active chart and show it
  refreshCharts() {},            // recompute indicators (after a custom indicator or model changes)
  goto(view) {},
};

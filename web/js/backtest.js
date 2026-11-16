// Strategy Tester: point-and-click entry/exit rules, risk settings, report, parameter sweeps,
// multi-symbol runs.
import { h, add, clear, store, toast, menu, modal, lineChart, downloadText, toCsv, fmtPct, fmtNum, fmtPrice, fmtStamp, fmtIso, fmtIsoTime } from './util.js';
import { TFS, tfLabel, isIntraday, universes } from './data.js';
import { IND, defaultParams } from './ta.js';
import { ruleBuilder, describeRuleset, cmp, price, num, ind, newRuleset } from './conditions.js';
import { prepare, simulate } from './sim.js';
import { yearly, knobs, getPath, setPath, sweep } from './research.js';
import { api } from './api.js';
import { addBot } from './alerts.js';

const PRESETS = {
  'RSI(2) pullback in an uptrend': () => ({ side: 'long', entry: newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 200 })), cmp(ind('rsi', { len: 2 }), 'lt', num(10))]), exit: newRuleset([cmp(ind('rsi', { len: 2 }), 'gt', num(70))]), stopPct: 0, targetPct: 0, trailPct: 0, maxBars: 10 }),
  '50 / 200 moving-average crossover': () => ({ side: 'long', entry: newRuleset([cmp(ind('sma', { len: 50 }), 'xup', ind('sma', { len: 200 }))]), exit: newRuleset([cmp(ind('sma', { len: 50 }), 'xdn', ind('sma', { len: 200 }))]), stopPct: 0, targetPct: 0, trailPct: 0, maxBars: 0 }),
  'Donchian 55-bar breakout': () => ({ side: 'long', entry: newRuleset([cmp(price('close'), 'gt', { ...ind('donchian', { len: 55 }, 'upper'), offset: 1 })]), exit: newRuleset([cmp(price('close'), 'lt', { ...ind('donchian', { len: 20 }, 'lower'), offset: 1 })]), stopPct: 0, targetPct: 0, trailPct: 0, maxBars: 0 }),
  'Bollinger band reversion': () => ({ side: 'long', entry: newRuleset([cmp(price('close'), 'lt', ind('bb', { len: 20, mult: 2 }, 'lower'))]), exit: newRuleset([cmp(price('close'), 'gt', ind('bb', { len: 20, mult: 2 }, 'mid'))]), stopPct: 8, targetPct: 0, trailPct: 0, maxBars: 0 }),
  'Supertrend follow': () => ({ side: 'long', entry: newRuleset([cmp(price('close'), 'xup', ind('supertrend', {}, 'line'))]), exit: newRuleset([cmp(price('close'), 'xdn', ind('supertrend', {}, 'line'))]), stopPct: 0, targetPct: 0, trailPct: 0, maxBars: 0 }),
  'Weekly uptrend, daily MACD cross': () => ({ side: 'long', entry: newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 30 }), '1w'), cmp(ind('macd', {}, 'macd'), 'xup', ind('macd', {}, 'signal'))]), exit: newRuleset([cmp(ind('macd', {}, 'macd'), 'xdn', ind('macd', {}, 'signal'))]), stopPct: 0, targetPct: 0, trailPct: 10, maxBars: 0 }),
};
const WINDOWS = [['1', '1 year'], ['2', '2 years'], ['5', '5 years'], ['10', '10 years'], ['20', '20 years'], ['0', 'All history']];

const blank = () => ({ symbol: api.activeSymbol(), tf: '1d', years: '10', capital: 10000, sizePct: 100, feeBps: 0, slipBps: 2, adjusted: true, ...PRESETS['RSI(2) pullback in an uptrend']() });
let cfg, resEl, drawCfg = () => {}, last = null;
const persist = () => store.set('bt.cfg', cfg);
const sign = (x) => (x >= 0 ? 'up' : 'dn');
const stat = (l, v, s, cls) => h('div', { class: 'stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (cls || '') }, v), s ? h('div', { class: 's' }, s) : null);
// Draw once the canvas has a width; rAF alone never fires in a background tab.
function whenVisible(canvas, paint) { let did = false; const once = () => { if (!did && canvas.clientWidth) { did = true; paint(); } }; requestAnimationFrame(once); setTimeout(once, 120); }

function numField(label, key, { step = 1, min = 0, title } = {}) {
  return h('label', { class: 'field', title }, label, h('input', { type: 'number', step, min, value: cfg[key], onchange: (e) => { cfg[key] = Number(e.target.value); persist(); } }));
}

export function mount(el) {
  cfg = store.get('bt.cfg', null) || blank();
  if (cfg.adjusted === undefined) cfg.adjusted = true;
  const left = h('div', { class: 'col cfg' }), right = h('div', { class: 'col res' });
  resEl = right;
  el.append(h('div', { class: 'cols' }, left, right));
  drawCfg = () => {
    clear(left);
    left.append(h('h2', null, 'Strategy Tester'), h('p', { class: 'hint' }, 'Define entry and exit rules, then test them on history. Signals are read at a bar’s close and filled at the next bar’s open.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Symbol', h('input', { type: 'text', value: cfg.symbol, style: { width: '96px', textTransform: 'uppercase' }, onchange: (e) => { cfg.symbol = e.target.value.trim().toUpperCase(); persist(); } })),
        h('label', { class: 'field' }, 'Timeframe', h('select', { onchange: (e) => { cfg.tf = e.target.value; persist(); drawCfg(); } }, TFS.map((t) => h('option', { value: t.id, selected: cfg.tf === t.id }, t.label)))),
        h('label', { class: 'field' }, 'History', h('select', { onchange: (e) => { cfg.years = e.target.value; persist(); } }, WINDOWS.map(([v, l]) => h('option', { value: v, selected: String(cfg.years) === v }, l)))),
        h('label', { class: 'field' }, 'Direction', h('select', { onchange: (e) => { cfg.side = e.target.value; persist(); } }, h('option', { value: 'long', selected: cfg.side !== 'short' }, 'Long'), h('option', { value: 'short', selected: cfg.side === 'short' }, 'Short'))),
        h('label', { class: 'field' }, 'Start from', h('select', { onchange: (e) => { const f = PRESETS[e.target.value]; if (f) { Object.assign(cfg, f()); persist(); drawCfg(); } } }, h('option', { value: '' }, 'Preset…'), Object.keys(PRESETS).map((k) => h('option', { value: k }, k))))),
      ruleBuilder(cfg.entry, { title: 'Enter when', baseTf: () => cfg.tf, onChange: persist, allowAuto: false }),
      ruleBuilder(cfg.exit, { title: 'Exit when', baseTf: () => cfg.tf, onChange: persist, allowAuto: false }),
      h('h4', null, 'Risk and costs'),
      h('div', { class: 'row' },
        numField('Stop loss %', 'stopPct', { step: 0.5, title: '0 = off' }), numField('Take profit %', 'targetPct', { step: 0.5, title: '0 = off' }), numField('Trailing stop %', 'trailPct', { step: 0.5, title: '0 = off' }), numField('Max bars held', 'maxBars', { title: '0 = off' })),
      h('div', { class: 'row' },
        numField('Starting capital', 'capital', { step: 1000 }), numField('Position size %', 'sizePct', { step: 5, title: 'Share of current equity put into each trade' }), numField('Fee (bps / side)', 'feeBps', { step: 0.5 }), numField('Slippage (bps)', 'slipBps', { step: 0.5 })),
      h('div', { class: 'row' }, h('label', { title: 'Use total-return prices on daily and longer timeframes, as if dividends were reinvested. Applies to the strategy and to buy & hold alike.' },
        h('input', { type: 'checkbox', checked: cfg.adjusted !== false, onchange: (e) => { cfg.adjusted = e.target.checked; persist(); } }), 'Include dividends')),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'primary', onclick: run }, 'Run backtest'),
        h('button', { onclick: sweepDialog, title: 'Try a range of values for one setting, judged on data it was not chosen on' }, 'Sweep a setting…'),
        h('button', { onclick: runList, title: 'Run the same rules on every symbol in a list' }, 'Run on a list…'),
        h('button', { onclick: deploy, title: 'Track this strategy forward from now as a paper bot' }, 'Deploy as paper bot')));
  };
  drawCfg();
  right.append(h('div', { class: 'empty' }, 'Run a backtest to see the report.'));
}

async function run() {
  clear(resEl); resEl.append(h('div', { class: 'empty' }, `Loading ${cfg.symbol}…`));
  try {
    const { base, byTf } = await prepare(cfg.symbol, cfg), out = simulate(base, byTf, cfg);
    last = { base, ...out, cfg: JSON.parse(JSON.stringify(cfg)) };
    report();
  } catch (e) { clear(resEl); resEl.append(h('div', { class: 'empty' }, `Could not run: ${e.message}`)); }
}

function report() {
  const { base, res, stats: s, cfg: c } = last, intr = isIntraday(c.tf), n = base.t.length;
  clear(resEl);
  const eqCanvas = h('canvas', { class: 'plot' }), ddCanvas = h('canvas', { class: 'plot' });
  const yrs = yearly(base, res), pos = yrs.filter((r) => r.ret > 0).length, beat = yrs.filter((r) => r.ret > r.bh).length;
  add(resEl,
    h('div', { class: 'row' }, h('h2', null, `${c.symbol} · ${tfLabel(c.tf)} · ${c.side}`), h('span', { class: 'muted' }, `${fmtStamp(base.t[res.from], intr)} → ${fmtStamp(base.t[n - 1], intr)} (${s.years.toFixed(1)} years)${base.adjusted ? ' · dividends included' : ''}`), h('span', { class: 'spacer' }),
      h('button', { onclick: exportTrades, title: 'Download every trade as a CSV file' }, 'Export CSV'),
      h('button', { onclick: () => api.showTrades(c.symbol, c.tf, res.trades) }, 'Show trades on chart')),
    h('p', { class: 'hint' }, `Enter: ${describeRuleset(c.entry, c.tf)}  ·  Exit: ${describeRuleset(c.exit, c.tf)}`),
    h('div', { class: 'cards' },
      stat('Net return', fmtPct(s.netPct, 1), `buy & hold ${fmtPct(s.buyHold, 1)}`, sign(s.netPct)),
      stat('CAGR', fmtPct(s.cagr, 1), `buy & hold ${fmtPct(s.buyHoldCagr, 1)}`, sign(s.cagr)),
      stat('Max drawdown', fmtPct(s.maxDD, 1), null, 'dn'),
      stat('Sharpe', fmtNum(s.sharpe, 2), 'per-bar returns, annualized'),
      stat('Trades', String(s.trades), res.position ? 'last one still open' : null),
      stat('Win rate', s.trades ? fmtNum(s.winRate, 1) + '%' : '–'),
      stat('Profit factor', s.profitFactor === Infinity ? '∞' : fmtNum(s.profitFactor, 2)),
      stat('Avg trade', fmtPct(s.avgTrade, 2), `win ${fmtPct(s.avgWin, 1)} · loss ${fmtPct(s.avgLoss, 1)}`, sign(s.avgTrade)),
      stat('Avg bars held', fmtNum(s.avgBars, 1)),
      stat('Time in market', fmtNum(s.exposure, 0) + '%')),
    s.trades < 30 ? h('p', { class: 'hint' }, `Only ${s.trades} trades: too few to tell skill from luck. Treat every number above as rough.`) : null,
    h('h4', null, 'Equity vs buy & hold'), eqCanvas, h('h4', null, 'Drawdown'), ddCanvas,
    h('h4', null, `By year · up in ${pos} of ${yrs.length}, ahead of buy & hold in ${beat}`),
    h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Year', 'Strategy', 'Buy & hold', 'Difference', 'Trades'].map((x) => h('th', null, x)))),
      h('tbody', null, yrs.slice().reverse().map((r) => h('tr', null, h('td', null, String(r.year)), h('td', { class: sign(r.ret) }, fmtPct(r.ret, 1)), h('td', { class: sign(r.bh) }, fmtPct(r.bh, 1)), h('td', { class: sign(r.ret - r.bh) }, fmtPct(r.ret - r.bh, 1)), h('td', null, String(r.trades)))))),
    h('h4', null, `Trades (${res.trades.length})`));
  const eq = res.equity.slice(res.from), bh = base.c.slice(res.from).map((v) => (res.capital * v) / base.c[res.from]);
  const css = getComputedStyle(document.documentElement), col = (k) => css.getPropertyValue(k).trim(), xl = (i) => fmtIso(base.t[res.from + i]);
  whenVisible(eqCanvas, () => {
    lineChart(eqCanvas, [{ values: bh, color: col('--muted'), width: 1 }, { values: eq, color: col('--accent'), width: 1.8 }], { xLabels: xl, yFmt: (v) => '$' + fmtNum(v, 0) });
    lineChart(ddCanvas, [{ values: s.dd.slice(res.from), color: col('--down'), fill: true }], { xLabels: xl, zero: true, height: 120, yFmt: (v) => v.toFixed(0) + '%' });
  });
  const tb = h('tbody');
  for (const t of res.trades.slice().reverse().slice(0, 500)) tb.append(h('tr', { onclick: () => api.showTrades(c.symbol, c.tf, res.trades) },
    h('td', null, fmtStamp(t.entryT, intr)), h('td', null, fmtPrice(t.entryP)), h('td', null, t.open ? 'open' : fmtStamp(t.exitT, intr)), h('td', null, fmtPrice(t.exitP)), h('td', null, String(t.bars)), h('td', { class: 'l' }, t.reason), h('td', { class: sign(t.pnlPct) }, fmtPct(t.pnlPct, 2)), h('td', { class: sign(t.pnl) }, fmtNum(t.pnl, 0))));
  resEl.append(h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Entry', 'Price', 'Exit', 'Price', 'Bars', 'Exit reason', 'Return', 'P&L $'].map((x, i) => h('th', { class: i === 5 ? 'l' : '' }, x)))), tb));
}

function exportTrades() {
  const { res, cfg: c } = last, f = isIntraday(c.tf) ? fmtIsoTime : fmtIso;
  const rows = [['symbol', 'side', 'entry_time', 'entry_price', 'exit_time', 'exit_price', 'bars', 'exit_reason', 'return_pct', 'pnl', 'open']];
  for (const t of res.trades) rows.push([c.symbol, t.side, f(t.entryT), t.entryP.toFixed(4), f(t.exitT), t.exitP.toFixed(4), t.bars, t.reason, t.pnlPct.toFixed(4), t.pnl.toFixed(2), t.open ? 'yes' : '']);
  downloadText(`${c.symbol}-${c.tf}-trades.csv`, toCsv(rows), 'text/csv');
}

// ───────────────────────── parameter sweep ─────────────────────────
function sweepDialog() {
  const ks = knobs(cfg, IND, defaultParams);
  let k = ks.find((x) => x.path[0] === 'entry') || ks[0];
  const cur = () => { const v = Number(getPath(cfg, k.path)); return Number.isFinite(v) ? v : Number(k.fallback) || 0; };
  const from = h('input', { type: 'number', step: 'any' }), to = h('input', { type: 'number', step: 'any' }), step = h('input', { type: 'number', step: 'any', min: 0 });
  const fill = () => {
    const v = cur(), whole = k.step >= 1, s = whole ? Math.max(1, Math.round(Math.abs(v) / 8)) : Math.max(0.1, +(Math.abs(v) / 8).toFixed(1));
    from.value = whole ? Math.max(1, v - 4 * s) : +Math.max(0, v - 4 * s).toFixed(2); to.value = +(v + 4 * s).toFixed(2); step.value = s;
  };
  fill();
  const go = () => {
    const a = Number(from.value), b = Number(to.value), s = Number(step.value);
    if (!(s > 0) || !(b >= a)) return toast('Give a start, an end at or above it, and a step above zero.', 'err');
    const values = []; for (let v = a; v <= b + 1e-9 && values.length < 60; v += s) values.push(+v.toFixed(4));
    m.close(); runSweep(k, values);
  };
  const m = modal('Sweep a setting', h('div', null,
    h('p', { class: 'hint' }, 'The strategy is run once for each value. The first 70% of the history is “in-sample”, the last 30% “out-of-sample”. Choose by the first, judge by the second.'),
    h('div', { class: 'form' },
      h('label', null, 'Setting'), h('select', { onchange: (e) => { k = ks[Number(e.target.value)]; fill(); } }, ks.map((x, i) => h('option', { value: i, selected: x === k }, `${x.label} (now ${getPath(cfg, x.path) ?? x.fallback})`))),
      h('label', null, 'From'), from, h('label', null, 'To'), to, h('label', null, 'Step'), step),
    h('div', { class: 'modal-foot' }, h('button', { class: 'primary', onclick: go }, 'Run sweep'))));
}

async function runSweep(k, values) {
  clear(resEl); resEl.append(h('div', { class: 'empty' }, `Sweeping ${values.length} values…`));
  try {
    const c = JSON.parse(JSON.stringify(cfg)), { base, byTf } = await prepare(c.symbol, c);
    await new Promise((r) => setTimeout(r, 20));
    const sw = sweep(base, byTf, c, k, values), intr = isIntraday(c.tf), n = base.t.length, now = Number(getPath(c, k.path));
    const bestIs = sw.rows.reduce((a, b) => (b.is.net > a.is.net ? b : a)), rank = sw.rows.slice().sort((a, b) => b.oos.net - a.oos.net).indexOf(bestIs) + 1;
    clear(resEl);
    const canvas = h('canvas', { class: 'plot' });
    add(resEl,
      h('div', { class: 'row' }, h('h2', null, `Sweep · ${k.label}`), h('span', { class: 'muted' }, `${c.symbol} · ${tfLabel(c.tf)} · ${values.length} values`)),
      h('p', { class: 'hint' }, `In-sample ${fmtStamp(base.t[sw.from], intr)} → ${fmtStamp(base.t[sw.split - 1], intr)} (buy & hold ${fmtPct(sw.bhIs, 1)}). Out-of-sample ${fmtStamp(base.t[sw.split], intr)} → ${fmtStamp(base.t[n - 1], intr)} (buy & hold ${fmtPct(sw.bhOos, 1)}).`),
      h('div', { class: 'cards' },
        stat('Best in-sample value', String(bestIs.v), `in-sample ${fmtPct(bestIs.is.net, 1)}`),
        stat('That value out-of-sample', fmtPct(bestIs.oos.net, 1), `ranked ${rank} of ${sw.rows.length}`, sign(bestIs.oos.net)),
        stat('In vs out agreement', fmtNum(sw.agreement, 2), 'correlation across values: near 1 = the pattern held')),
      h('p', { class: 'hint' }, 'A setting that only looks good in-sample was fitted to noise. Prefer a broad range of values that all do acceptably in both columns over a single peak.'),
      h('h4', null, 'Net return by value · grey in-sample, amber out-of-sample'), canvas,
      h('table', { class: 'grid' }, h('thead', null, h('tr', null, [k.label, 'In-sample net', 'Trades', 'Win %', 'Out-of-sample net', 'Trades', 'Win %', ''].map((x) => h('th', null, x)))),
        h('tbody', null, sw.rows.map((r) => h('tr', { title: 'Use this value and run the full backtest', onclick: () => { setPath(cfg, k.path, r.v); persist(); drawCfg(); run(); } },
          h('td', null, h('b', null, String(r.v)), r.v === now ? ' (current)' : ''), h('td', { class: sign(r.is.net) }, fmtPct(r.is.net, 1)), h('td', null, String(r.is.trades)), h('td', null, fmtNum(r.is.win, 0)),
          h('td', { class: sign(r.oos.net) }, fmtPct(r.oos.net, 1)), h('td', null, String(r.oos.trades)), h('td', null, fmtNum(r.oos.win, 0)), h('td', { class: 'muted' }, r === bestIs ? 'best in-sample' : ''))))),
      h('p', { class: 'hint' }, 'Click a row to use that value and run the full backtest.'));
    const css = getComputedStyle(document.documentElement), col = (x) => css.getPropertyValue(x).trim();
    whenVisible(canvas, () => lineChart(canvas, [{ values: sw.rows.map((r) => r.is.net), color: col('--muted'), width: 1.4 }, { values: sw.rows.map((r) => r.oos.net), color: col('--accent'), width: 1.8 }], { xLabels: (i) => String(sw.rows[i].v), yFmt: (v) => v.toFixed(0) + '%', height: 180, zero: true }));
  } catch (e) { clear(resEl); resEl.append(h('div', { class: 'empty' }, `Could not sweep: ${e.message}`)); }
}

// ───────────────────────── multi-symbol ─────────────────────────
async function runList(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const lists = { ...Object.fromEntries(Object.entries(api.watchlists()).map(([k, v]) => ['Watchlist: ' + k, v])), ...(await universes()) };
  menu(r.left, r.top - 8 - 28 * Object.keys(lists).length, Object.entries(lists).map(([name, syms]) => ({ label: `${name}`, fn: () => runMany(name, syms) })));
}
async function runMany(name, syms) {
  clear(resEl);
  const bar = h('i'), status = h('span', { class: 'muted' }, '');
  resEl.append(h('div', { class: 'row' }, h('h2', null, `${name} · ${tfLabel(cfg.tf)}`), status), h('div', { class: 'progress' }, bar));
  const rows = [], c = JSON.parse(JSON.stringify(cfg));
  for (let k = 0; k < syms.length; k++) {
    status.textContent = `${k + 1} / ${syms.length} · ${syms[k]}`; bar.style.width = ((k + 1) / syms.length) * 100 + '%';
    try { const { base, byTf } = await prepare(syms[k], c), { res, stats } = simulate(base, byTf, c); rows.push({ sym: syms[k], ...stats, res }); } catch { /* skip symbols without data */ }
  }
  status.textContent = `${rows.length} of ${syms.length} symbols tested`;
  const all = rows.flatMap((r) => r.res.trades), wins = all.filter((t) => t.pnl > 0).length, avg = all.length ? all.reduce((s, t) => s + t.pnlPct, 0) / all.length : NaN;
  const med = (f) => { const a = rows.map(f).filter((x) => x === x).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
  resEl.append(h('p', { class: 'hint' }, `Enter: ${describeRuleset(c.entry, c.tf)}  ·  Exit: ${describeRuleset(c.exit, c.tf)}`),
    h('div', { class: 'cards' }, stat('Trades (all symbols)', String(all.length)), stat('Win rate', all.length ? fmtNum((wins / all.length) * 100, 1) + '%' : '–'), stat('Avg trade', fmtPct(avg, 2), null, sign(avg)),
      stat('Median net return', fmtPct(med((r) => r.netPct), 1), `buy & hold ${fmtPct(med((r) => r.buyHold), 1)}`), stat('Beat buy & hold', `${rows.filter((r) => r.netPct > r.buyHold).length} / ${rows.length}`), stat('Median max drawdown', fmtPct(med((r) => r.maxDD), 1), null, 'dn')));
  const cols = [['sym', 'Symbol', (r) => r.sym], ['trades', 'Trades', (r) => r.trades], ['winRate', 'Win %', (r) => fmtNum(r.winRate, 0)], ['netPct', 'Net %', (r) => fmtPct(r.netPct, 1)], ['buyHold', 'Buy & hold %', (r) => fmtPct(r.buyHold, 1)], ['profitFactor', 'Profit factor', (r) => (r.profitFactor === Infinity ? '∞' : fmtNum(r.profitFactor, 2))], ['maxDD', 'Max DD %', (r) => fmtPct(r.maxDD, 1)], ['exposure', 'In market %', (r) => fmtNum(r.exposure, 0)]];
  let sortK = 'netPct', desc = true;
  const tbl = h('table', { class: 'grid' });
  const draw = () => {
    clear(tbl);
    rows.sort((a, b) => { const x = a[sortK], y = b[sortK]; return (typeof x === 'string' ? x.localeCompare(y) : (x === x ? x : -Infinity) - (y === y ? y : -Infinity)) * (desc ? -1 : 1); });
    tbl.append(h('thead', null, h('tr', null, cols.map(([k, l]) => h('th', { onclick: () => { desc = sortK === k ? !desc : true; sortK = k; draw(); } }, l + (sortK === k ? (desc ? ' ▾' : ' ▴') : ''))))),
      h('tbody', null, rows.map((r) => h('tr', { onclick: () => { cfg.symbol = r.sym; persist(); api.showTrades(r.sym, c.tf, r.res.trades); } }, cols.map(([k, , f]) => h('td', { class: k === 'netPct' ? sign(r.netPct) : '' }, f(r)))))));
  };
  draw(); resEl.append(tbl);
}

async function deploy() {
  try {
    const { base } = await prepare(cfg.symbol, cfg);
    addBot({ name: `${cfg.symbol} ${tfLabel(cfg.tf)} · ${Object.keys(PRESETS).find((k) => JSON.stringify(PRESETS[k]().entry) === JSON.stringify(cfg.entry)) || 'custom rules'}`, symbol: cfg.symbol, tf: cfg.tf, cfg: JSON.parse(JSON.stringify(cfg)), deployedT: base.t[base.t.length - 1] });
    toast(`Paper bot deployed on ${cfg.symbol}. See Alerts & Bots.`, 'ok');
  } catch (e) { toast('Could not deploy: ' + e.message, 'err'); }
}

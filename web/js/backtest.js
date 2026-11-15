// Strategy Tester: point-and-click entry/exit rules, risk settings, report, multi-symbol runs.
import { h, add, clear, store, toast, menu, lineChart, fmtPct, fmtNum, fmtPrice, fmtStamp, fmtIso } from './util.js';
import { TFS, tfLabel, isIntraday, UNIVERSES } from './data.js';
import { ruleBuilder, describeRuleset, cmp, price, num, ind, newRuleset } from './conditions.js';
import { prepare, simulate } from './sim.js';
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

const blank = () => ({ symbol: api.activeSymbol(), tf: '1d', years: '10', capital: 10000, sizePct: 100, feeBps: 0, slipBps: 2, ...PRESETS['RSI(2) pullback in an uptrend']() });
let cfg, resEl, last = null;
const persist = () => store.set('bt.cfg', cfg);

function numField(label, key, { step = 1, min = 0, title } = {}) {
  return h('label', { class: 'field', title }, label, h('input', { type: 'number', step, min, value: cfg[key], onchange: (e) => { cfg[key] = Number(e.target.value); persist(); } }));
}

export function mount(el) {
  cfg = store.get('bt.cfg', null) || blank();
  const left = h('div', { class: 'col cfg' }), right = h('div', { class: 'col res' });
  resEl = right;
  el.append(h('div', { class: 'cols' }, left, right));
  const drawCfg = () => {
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
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'primary', onclick: run }, 'Run backtest'),
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

function stat(l, v, s, cls) { return h('div', { class: 'stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (cls || '') }, v), s ? h('div', { class: 's' }, s) : null); }
const sign = (x) => (x >= 0 ? 'up' : 'dn');

function report() {
  const { base, res, stats: s, cfg: c } = last, intr = isIntraday(c.tf), n = base.t.length;
  clear(resEl);
  const eqCanvas = h('canvas', { class: 'plot' }), ddCanvas = h('canvas', { class: 'plot' });
  add(resEl,
    h('div', { class: 'row' }, h('h2', null, `${c.symbol} · ${tfLabel(c.tf)} · ${c.side}`), h('span', { class: 'muted' }, `${fmtStamp(base.t[res.from], intr)} → ${fmtStamp(base.t[n - 1], intr)} (${s.years.toFixed(1)} years)`), h('span', { class: 'spacer' }),
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
    h('h4', null, 'Equity vs buy & hold'), eqCanvas, h('h4', null, 'Drawdown'), ddCanvas, h('h4', null, `Trades (${res.trades.length})`));
  const eq = res.equity.slice(res.from), bh = base.c.slice(res.from).map((v) => (res.capital * v) / base.c[res.from]);
  const css = getComputedStyle(document.documentElement), col = (k) => css.getPropertyValue(k).trim();
  const xl = (i) => fmtIso(base.t[res.from + i]);
  requestAnimationFrame(() => { lineChart(eqCanvas, [{ values: bh, color: col('--muted'), width: 1 }, { values: eq, color: col('--accent'), width: 1.8 }], { xLabels: xl, yFmt: (v) => '$' + fmtNum(v, 0) }); lineChart(ddCanvas, [{ values: s.dd.slice(res.from), color: col('--down'), fill: true }], { xLabels: xl, zero: true, height: 120, yFmt: (v) => v.toFixed(0) + '%' }); });
  setTimeout(() => { if (!eqCanvas.width || eqCanvas.width < 10) { lineChart(eqCanvas, [{ values: bh, color: col('--muted'), width: 1 }, { values: eq, color: col('--accent'), width: 1.8 }], { xLabels: xl, yFmt: (v) => '$' + fmtNum(v, 0) }); lineChart(ddCanvas, [{ values: s.dd.slice(res.from), color: col('--down'), fill: true }], { xLabels: xl, zero: true, height: 120, yFmt: (v) => v.toFixed(0) + '%' }); } }, 120);
  const tb = h('tbody');
  for (const t of res.trades.slice().reverse().slice(0, 500)) tb.append(h('tr', { onclick: () => api.showTrades(c.symbol, c.tf, res.trades) },
    h('td', null, fmtStamp(t.entryT, intr)), h('td', null, fmtPrice(t.entryP)), h('td', null, t.open ? 'open' : fmtStamp(t.exitT, intr)), h('td', null, fmtPrice(t.exitP)), h('td', null, String(t.bars)), h('td', { class: 'l' }, t.reason), h('td', { class: sign(t.pnlPct) }, fmtPct(t.pnlPct, 2)), h('td', { class: sign(t.pnl) }, fmtNum(t.pnl, 0))));
  resEl.append(h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Entry', 'Price', 'Exit', 'Price', 'Bars', 'Exit reason', 'Return', 'P&L $'].map((x, i) => h('th', { class: i === 5 ? 'l' : '' }, x)))), tb));
}

function runList(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const lists = { ...Object.fromEntries(Object.entries(api.watchlists()).map(([k, v]) => ['Watchlist: ' + k, v])), ...UNIVERSES };
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

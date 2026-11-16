// Model Lab: train a small classifier to estimate P(price is up by X% in N bars) from indicator
// features, score it on data it never saw, and use its probability as an indicator.
import { h, clear, store, toast, uid, fmtNum, fmtPct, fmtStamp } from './util.js';
import { TFS, tfLabel, isIntraday, getBars } from './data.js';
import * as T from './ta.js';
import { api } from './api.js';

const div = (a, b) => a.map((x, i) => (b[i] ? x / b[i] : NaN));
const FEATURES = [
  ['rsi14', 'RSI 14', (b) => T.rsi(b.c, 14)],
  ['rsi2', 'RSI 2', (b) => T.rsi(b.c, 2)],
  ['d20', 'Close vs SMA 20', (b) => div(b.c, T.sma(b.c, 20)).map((x) => x - 1)],
  ['d50', 'Close vs SMA 50', (b) => div(b.c, T.sma(b.c, 50)).map((x) => x - 1)],
  ['d200', 'Close vs SMA 200', (b) => div(b.c, T.sma(b.c, 200)).map((x) => x - 1)],
  ['macdh', 'MACD histogram / ATR', (b) => div(T.macd(b.c, 12, 26, 9).hist, T.atr(b, 14))],
  ['atrp', 'ATR % of price', (b) => div(T.atr(b, 14), b.c)],
  ['pctb', 'Bollinger %B', (b) => { const x = T.bollinger(b.c, 20, 2); return x.mid.map((_, i) => (b.c[i] - x.lower[i]) / (x.upper[i] - x.lower[i])); }],
  ['bbw', 'Bollinger width', (b) => { const x = T.bollinger(b.c, 20, 2); return x.mid.map((m, i) => (x.upper[i] - x.lower[i]) / m); }],
  ['roc5', 'Return, 5 bars', (b) => T.roc(b.c, 5)],
  ['roc20', 'Return, 20 bars', (b) => T.roc(b.c, 20)],
  ['rvol', 'Relative volume', (b) => { const a = T.sma(b.v, 20); return b.v.map((v, i) => (i > 0 && a[i - 1] ? v / a[i - 1] : NaN)); }],
  ['adx', 'ADX 14', (b) => T.adx(b, 14).adx],
  ['stoch', 'Stochastic %K', (b) => T.stoch(b, 14, 3, 3).k],
  ['z20', 'Z-score 20', (b) => T.zscore(b.c, 20)],
];
const FEAT = Object.fromEntries(FEATURES.map((f) => [f[0], f]));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function matrix(bars, feats) {
  const cols = feats.map((id) => FEAT[id][2](bars)), n = bars.t.length, X = new Array(n);
  for (let i = 0; i < n; i++) { const r = new Array(cols.length); let okk = true; for (let j = 0; j < cols.length; j++) { const v = cols[j][i]; if (!Number.isFinite(v)) { okk = false; break; } r[j] = v; } X[i] = okk ? r : null; }
  return X;
}
function standardize(rows) {
  const d = rows[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j];
  for (let j = 0; j < d; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / rows.length) || 1;
  return { mean, sd };
}
const scale = (r, m) => r.map((v, j) => Math.max(-5, Math.min(5, (v - m.mean[j]) / m.sd[j])));

function fitLogistic(X, y, { iters = 400, lr = 0.2, l2 = 0.01 } = {}) {
  const n = X.length, d = X[0].length, w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; const r = X[i]; for (let j = 0; j < d; j++) z += w[j] * r[j]; const e = sigmoid(z) - y[i]; gb += e; for (let j = 0; j < d; j++) g[j] += e * r[j]; }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
    b -= (lr * gb) / n;
  }
  return { kind: 'logistic', w, b };
}
// Gradient-boosted decision stumps on logistic loss.
function fitBoost(X, y, { rounds = 80, lr = 0.1, bins = 16, lambda = 1 } = {}) {
  const n = X.length, d = X[0].length, cuts = [];
  for (let j = 0; j < d; j++) { const col = X.map((r) => r[j]).sort((a, b) => a - b), c = []; for (let k = 1; k < bins; k++) c.push(col[Math.floor((k * n) / bins)]); cuts.push([...new Set(c)]); }
  const pos = y.reduce((s, v) => s + v, 0), base = Math.log((pos + 1) / (n - pos + 1)), F = new Array(n).fill(base), stumps = [];
  for (let r = 0; r < rounds; r++) {
    const g = new Array(n), hs = new Array(n); let G = 0, H = 0;
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = y[i] - p; hs[i] = p * (1 - p); G += g[i]; H += hs[i]; }
    let best = null;
    for (let j = 0; j < d; j++) for (const c of cuts[j]) {
      let gl = 0, hl = 0; for (let i = 0; i < n; i++) if (X[i][j] <= c) { gl += g[i]; hl += hs[i]; }
      const gr = G - gl, hr = H - hl, gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda);
      if (!best || gain > best.gain) best = { gain, j, c, l: (lr * gl) / (hl + lambda), r: (lr * gr) / (hr + lambda) };
    }
    if (!best) break;
    stumps.push({ j: best.j, c: best.c, l: best.l, r: best.r });
    for (let i = 0; i < n; i++) F[i] += X[i][best.j] <= best.c ? best.l : best.r;
  }
  return { kind: 'boost', base, stumps };
}
function predict(m, r) {
  if (m.kind === 'logistic') { let z = m.b; for (let j = 0; j < r.length; j++) z += m.w[j] * r[j]; return sigmoid(z); }
  let f = m.base; for (const s of m.stumps) f += r[s.j] <= s.c ? s.l : s.r; return sigmoid(f);
}
function auc(p, y) {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]); let rank = 0, pos = 0;
  for (let k = 0; k < idx.length; k++) { let e = k; while (e + 1 < idx.length && p[idx[e + 1]] === p[idx[k]]) e++; const avg = (k + e) / 2 + 1; for (let q = k; q <= e; q++) if (y[idx[q]]) { rank += avg; pos++; } k = e; }
  const neg = p.length - pos; return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

export function train(bars, c) {
  const n = bars.t.length, H = c.horizon, X = matrix(bars, c.features), samples = [];
  for (let i = 0; i < n - H; i++) if (X[i]) samples.push(i);
  if (samples.length < 300) throw new Error(`only ${samples.length} usable bars; need at least 300`);
  if (H * 4 > samples.length * 0.3) throw new Error(`looking ${H} bars ahead leaves too little history to test on; use a shorter horizon`);
  const fwd = (i) => (bars.c[i + H] / bars.c[i] - 1) * 100, label = (i) => (fwd(i) > c.threshold ? 1 : 0);
  const split = Math.floor(samples.length * 0.7), testIdx = samples.slice(split);
  // embargo: drop training rows whose label window reaches into the test period
  const trainIdx = samples.slice(0, split).filter((i) => i + H < testIdx[0]);
  const norm = standardize(trainIdx.map((i) => X[i])), Xtr = trainIdx.map((i) => scale(X[i], norm)), ytr = trainIdx.map(label), Xte = testIdx.map((i) => scale(X[i], norm)), yte = testIdx.map(label);
  const model = c.kind === 'boost' ? fitBoost(Xtr, ytr) : fitLogistic(Xtr, ytr);
  const ptr = Xtr.map((r) => predict(model, r)), pte = Xte.map((r) => predict(model, r));
  const base = yte.reduce((s, v) => s + v, 0) / yte.length, acc = pte.filter((p, i) => (p >= 0.5 ? 1 : 0) === yte[i]).length / yte.length;
  const order = pte.map((_, i) => i).sort((a, b) => pte[a] - pte[b]), q = [];
  for (let k = 0; k < 5; k++) { const ids = order.slice(Math.floor((k * order.length) / 5), Math.floor(((k + 1) * order.length) / 5)); q.push({ lo: pte[ids[0]], hi: pte[ids[ids.length - 1]], n: ids.length, hit: ids.reduce((s, i) => s + yte[i], 0) / ids.length, ret: ids.reduce((s, i) => s + fwd(testIdx[i]), 0) / ids.length }); }
  let imp;
  if (model.kind === 'logistic') imp = c.features.map((f, j) => ({ f, v: model.w[j] }));
  else { const cnt = {}; for (const s of model.stumps) cnt[s.j] = (cnt[s.j] || 0) + Math.abs(s.l - s.r); const tot = Object.values(cnt).reduce((s, v) => s + v, 0) || 1; imp = c.features.map((f, j) => ({ f, v: (cnt[j] || 0) / tot })); }
  imp.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  return {
    model, norm, features: c.features, horizon: H, threshold: c.threshold, kind: c.kind, symbol: bars.symbol, tf: bars.tf,
    splitT: bars.t[testIdx[0]], trainFrom: bars.t[trainIdx[0]], testTo: bars.t[testIdx[testIdx.length - 1]],
    metrics: { nTrain: trainIdx.length, nTest: testIdx.length, base, baseTrain: ytr.reduce((s, v) => s + v, 0) / ytr.length, acc, naive: Math.max(base, 1 - base), aucTest: auc(pte, yte), aucTrain: auc(ptr, ytr), q, avgRet: testIdx.reduce((s, i) => s + fwd(i), 0) / testIdx.length, imp },
  };
}

export function toIndicator(m) {
  return {
    id: 'model:' + m.id, name: `Model · ${m.name}`, short: m.name, group: 'Models', overlay: false, params: [], rev: m.id,
    outputs: [{ k: 'p', label: 'P(up)', color: '#f0b34a', style: 'line' }], levels: [0.5], range: [0, 1],
    // Blank before the test period began: those bars were used to fit the model, so a backtest
    // or scan reading them would be grading the model on its own training data.
    calc: (bars) => { const X = matrix(bars, m.features), from = m.splitT || 0; return { p: X.map((r, i) => (r && bars.t[i] >= from ? predict(m.model, scale(r, m.norm)) : NaN)) }; },
  };
}
let models = null;
const persist = () => store.set('models', models);
export function loadModels() { models = store.get('models', []); for (const m of models) T.registerIndicator(toIndicator(m)); }

const cfg = { symbol: '', tf: '1d', horizon: 5, threshold: 0, kind: 'logistic', features: ['rsi14', 'd20', 'd50', 'd200', 'macdh', 'atrp', 'pctb', 'roc5', 'roc20', 'rvol'] };
let el = null, resEl = null, last = null;

export function mount(root) {
  el = root; if (!models) loadModels(); cfg.symbol = api.activeSymbol();
  const left = h('div', { class: 'col cfg' }); resEl = h('div', { class: 'col res' });
  el.append(h('div', { class: 'cols' }, left, resEl));
  const drawCfg = () => {
    clear(left);
    left.append(h('h2', null, 'Model Lab'), h('p', { class: 'hint' }, 'Train a model to estimate the chance that price is higher by a chosen amount a few bars from now. It is fitted on the first 70% of history and scored on the last 30%, which it never sees.'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Train on', h('input', { type: 'text', value: cfg.symbol, style: { width: '96px', textTransform: 'uppercase' }, onchange: (e) => (cfg.symbol = e.target.value.trim().toUpperCase()) })),
        h('label', { class: 'field' }, 'Timeframe', h('select', { onchange: (e) => (cfg.tf = e.target.value) }, TFS.map((t) => h('option', { value: t.id, selected: cfg.tf === t.id }, t.label)))),
        h('label', { class: 'field', title: 'How many bars ahead the target looks' }, 'Bars ahead', h('input', { type: 'number', min: 1, max: 60, value: cfg.horizon, onchange: (e) => (cfg.horizon = Math.max(1, e.target.value | 0)) })),
        h('label', { class: 'field', title: 'Target is 1 when the forward return exceeds this' }, 'Move > %', h('input', { type: 'number', step: 0.5, value: cfg.threshold, onchange: (e) => (cfg.threshold = Number(e.target.value)) })),
        h('label', { class: 'field' }, 'Model', h('select', { onchange: (e) => (cfg.kind = e.target.value) }, h('option', { value: 'logistic', selected: cfg.kind === 'logistic' }, 'Logistic regression'), h('option', { value: 'boost', selected: cfg.kind === 'boost' }, 'Boosted stumps')))),
      h('h4', null, 'Inputs'),
      h('div', { class: 'chips' }, FEATURES.map(([id, label]) => h('label', null, h('input', { type: 'checkbox', checked: cfg.features.includes(id), onchange: (e) => { cfg.features = e.target.checked ? [...cfg.features, id] : cfg.features.filter((x) => x !== id); } }), label))),
      h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'primary', onclick: go }, 'Train model')),
      h('h4', null, 'Saved models'));
    if (!models.length) left.append(h('div', { class: 'hint' }, 'None yet. Train one, then save it to use its probability as an indicator in charts, scans and strategies.'));
    for (const m of models) left.append(h('div', { class: 'list-item' },
      h('div', { class: 't' }, h('b', null, m.name), h('small', null, `${m.symbol} ${tfLabel(m.tf)} · up > ${m.threshold}% in ${m.horizon} bars · test AUC ${fmtNum(m.metrics.aucTest, 3)}`)),
      h('button', { onclick: () => api.addIndicator('model:' + m.id) }, 'Add to chart'),
      h('button', { class: 'icon-btn', title: 'Delete', onclick: () => { models = models.filter((x) => x !== m); T.unregisterIndicator('model:' + m.id); persist(); api.refreshCharts(); drawCfg(); } }, '✕')));
  };
  drawCfg(); mount.redraw = drawCfg;
  resEl.append(h('div', { class: 'empty' }, 'Train a model to see how it scores out of sample.'));
}

async function go() {
  if (cfg.features.length < 2) return toast('Pick at least two inputs.', 'err');
  clear(resEl); resEl.append(h('div', { class: 'empty' }, `Training on ${cfg.symbol}…`));
  try {
    const bars = await getBars(cfg.symbol, cfg.tf, { live: false });
    await new Promise((r) => setTimeout(r, 30));
    last = train(bars, { ...cfg, features: [...cfg.features] });
    report();
  } catch (e) { clear(resEl); resEl.append(h('div', { class: 'empty' }, 'Could not train: ' + e.message)); }
}
const stat = (l, v, s, cls) => h('div', { class: 'stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v ' + (cls || '') }, v), s ? h('div', { class: 's' }, s) : null);

function report() {
  const m = last, k = m.metrics, intr = isIntraday(m.tf), edge = k.aucTest - 0.5;
  clear(resEl);
  const verdict = !(k.aucTest === k.aucTest) ? 'The test period has only one outcome, so the model cannot be scored.' :
    edge < 0.02 ? 'No usable edge out of sample: the model ranks future moves about as well as a coin flip.' :
      edge < 0.05 ? 'A faint edge out of sample. Small enough that costs or a different period could erase it.' : 'A measurable edge out of sample on this one split. Check it on other symbols and periods before relying on it.';
  resEl.append(h('div', { class: 'row' }, h('h2', null, `${m.symbol} · ${tfLabel(m.tf)} · up more than ${m.threshold}% in ${m.horizon} bars`), h('span', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: async () => { const { ask } = await import('./conditions.js'); const name = await ask('Save model', `${m.symbol} ${m.horizon}-bar`, 'Name'); if (!name) return; const rec = { ...m, id: uid(), name }; models.unshift(rec); persist(); T.registerIndicator(toIndicator(rec)); mount.redraw(); toast('Saved under “Models”. It is blank before its test period, so it cannot be backtested on the data it learned from.', 'ok', 9000); } }, 'Save as indicator')),
    h('p', { class: 'hint' }, `Fitted on ${fmtStamp(m.trainFrom, intr)} → ${fmtStamp(m.splitT, intr)} (${k.nTrain} bars), scored on ${fmtStamp(m.splitT, intr)} → ${fmtStamp(m.testTo, intr)} (${k.nTest} bars).`),
    h('div', { class: 'card', style: { margin: '8px 0' } }, h('b', null, verdict)),
    h('div', { class: 'cards' },
      stat('Test AUC', fmtNum(k.aucTest, 3), '0.5 = no skill', edge >= 0.02 ? 'up' : ''),
      stat('Train AUC', fmtNum(k.aucTrain, 3), k.aucTrain - k.aucTest > 0.08 ? 'well above test: overfit' : 'in-sample'),
      stat('Test accuracy', fmtNum(k.acc * 100, 1) + '%', `always guessing the common side: ${fmtNum(k.naive * 100, 1)}%`),
      stat('Base rate', fmtNum(k.base * 100, 1) + '%', 'share of test bars that hit the target'),
      stat('Avg forward return', fmtPct(k.avgRet, 2), `all test bars, ${m.horizon} bars ahead`)),
    h('h4', null, 'Test period, sorted by predicted probability'),
    h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Fifth', 'Predicted', 'Bars', 'Hit rate', 'Avg forward return'].map((x) => h('th', null, x)))),
      h('tbody', null, k.q.map((q, i) => h('tr', null, h('td', null, ['Lowest', '2nd', '3rd', '4th', 'Highest'][i]), h('td', null, `${fmtNum(q.lo, 2)} – ${fmtNum(q.hi, 2)}`), h('td', null, String(q.n)), h('td', null, fmtNum(q.hit * 100, 1) + '%'), h('td', { class: q.ret >= 0 ? 'up' : 'dn' }, fmtPct(q.ret, 2)))))),
    h('p', { class: 'hint' }, 'If the model has skill, hit rate and forward return rise from the lowest fifth to the highest.'),
    h('h4', null, m.kind === 'logistic' ? 'Input weights (standardized)' : 'Input importance'),
    h('table', { class: 'grid' }, h('tbody', null, k.imp.map((x) => h('tr', null, h('td', null, FEAT[x.f][1]), h('td', { class: m.kind === 'logistic' ? (x.v >= 0 ? 'up' : 'dn') : '' }, m.kind === 'logistic' ? (x.v >= 0 ? '+' : '') + x.v.toFixed(3) : fmtNum(x.v * 100, 1) + '%'))))));
}

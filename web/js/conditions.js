// Rules: one condition model shared by the scanner, strategy tester, alerts, bots and checklists.
//   cond    = { kind:'cmp', tf, a, op, b } | { kind:'candle', tf, pattern, within } | { kind:'auto', tf, signal }
//   operand = { type:'price', field } | { type:'num', value } | { type:'ind', id, params, out }  (+ offset, mult)
//   ruleset = { mode:'all'|'any', conds:[...] }
import { IND, calcIndicator, defaultParams, indLabel } from './ta.js';
import { TF, tfLabel, alignToBase, tfsAtOrAbove } from './data.js';
import { candlePatterns, CANDLES, CANDLE_BY_ID, autoSignals, AUTO_SIGNALS } from './auto.js';
import { h, clear, store, modal } from './util.js';
import { formatRuleset, parseRuleset } from './formula.js';

export const OPS = [
  { id: 'gt', label: 'is above' }, { id: 'lt', label: 'is below' },
  { id: 'xup', label: 'crosses above' }, { id: 'xdn', label: 'crosses below' },
  { id: 'gte', label: 'is at or above' }, { id: 'lte', label: 'is at or below' },
];
const OP_LABEL = Object.fromEntries(OPS.map((o) => [o.id, o.label]));
const PRICE = { close: 'Close', open: 'Open', high: 'High', low: 'Low', volume: 'Volume' };
const FIELD = { close: 'c', open: 'o', high: 'h', low: 'l', volume: 'v' };

export const price = (field = 'close') => ({ type: 'price', field });
export const num = (value) => ({ type: 'num', value });
export const ind = (id, params = {}, out) => ({ type: 'ind', id, params: { ...defaultParams(IND.get(id)), ...params }, out: out || IND.get(id).outputs[0].k });
export const cmp = (a, op, b, tf) => ({ kind: 'cmp', tf: tf || null, a, op, b });
export const newRuleset = (conds = [], mode = 'all') => ({ mode, conds });

function resolve(o, bars) {
  if (o.type === 'num') return { k: Number(o.value) };
  let a;
  if (o.type === 'price') a = bars[FIELD[o.field] || 'c'];
  else {
    const def = IND.get(o.id); if (!def) return null;
    const out = calcIndicator(o.id, bars, o.params); if (!out || out.__error) return null;
    a = out[o.out] || out[def.outputs[0].k];
  }
  return a ? { a, off: o.offset | 0, m: o.mult == null || o.mult === '' ? 1 : Number(o.mult) } : null;
}
const at = (s, i) => (s.k !== undefined ? s.k : i - s.off >= 0 ? s.a[i - s.off] * s.m : NaN);

export function evalCond(c, bars) {
  const n = bars.t.length, out = new Array(n).fill(false);
  if (c.kind === 'candle') {
    const src = candlePatterns(bars)[c.pattern]; if (!src) return out;
    const w = Math.max(1, c.within | 0);
    let last = -Infinity;
    for (let i = 0; i < n; i++) { if (src[i]) last = i; out[i] = i - last < w; }
    return out;
  }
  if (c.kind === 'auto') { if (n) out[n - 1] = !!autoSignals(bars)[c.signal]; return out; }
  const A = resolve(c.a, bars), B = resolve(c.b, bars);
  if (!A || !B) return out;
  for (let i = 0; i < n; i++) {
    const x = at(A, i), y = at(B, i);
    if (x !== x || y !== y) continue;
    switch (c.op) {
      case 'gt': out[i] = x > y; break;
      case 'lt': out[i] = x < y; break;
      case 'gte': out[i] = x >= y; break;
      case 'lte': out[i] = x <= y; break;
      case 'xup': { const px = at(A, i - 1), py = at(B, i - 1); out[i] = x > y && px <= py; break; }
      case 'xdn': { const px = at(A, i - 1), py = at(B, i - 1); out[i] = x < y && px >= py; break; }
    }
  }
  return out;
}

const condTf = (c, baseTf) => (c.tf && TF[c.tf] && TF[c.tf].rank > TF[baseTf].rank ? c.tf : baseTf);
export function requiredTfs(rs, baseTf) { const s = new Set([baseTf]); for (const c of rs.conds) s.add(condTf(c, baseTf)); return [...s]; }

/** Evaluate a ruleset on `base` bars. `byTf` maps timeframe id -> bars of the same symbol. */
export function evalRuleset(rs, base, byTf) {
  const n = base.t.length, per = [];
  for (const c of rs.conds) {
    const tf = condTf(c, base.tf), bars = tf === base.tf ? base : byTf && byTf.get ? byTf.get(tf) : null;
    if (!bars) { per.push(new Array(n).fill(false)); continue; }
    let m = evalCond(c, bars);
    if (tf !== base.tf) {
      // src[i] = index of the higher-timeframe bar whose value base bar i can see
      const src = alignToBase(base, bars, m.map((_, k) => k)), event = c.kind === 'cmp' && (c.op === 'xup' || c.op === 'xdn'), hm = m;
      // A state ("above") holds for as long as that higher bar is the latest one. A cross is an
      // event: it counts only on the base bar where it first becomes visible, not on every bar after.
      m = src.map((k, i) => k === k && hm[k] && (!event || i === 0 || src[i - 1] !== k));
    }
    per.push(m);
  }
  const mask = new Array(n).fill(false);
  if (per.length) for (let i = 0; i < n; i++) { let v = rs.mode !== 'any'; for (const m of per) { if (rs.mode === 'any') { if (m[i]) { v = true; break; } } else if (!m[i]) { v = false; break; } } mask[i] = v; }
  return { mask, per };
}

export function operandLabel(o) {
  if (!o) return '?';
  let s;
  if (o.type === 'num') return String(o.value);
  if (o.type === 'price') s = PRICE[o.field] || 'Close';
  else { const def = IND.get(o.id); if (!def) return `(missing ${o.id})`; s = indLabel(def, o.params); const vis = def.outputs.filter((q) => !q.hidden || q.k === o.out); if (vis.length > 1) { const q = def.outputs.find((x) => x.k === o.out), l = q ? q.label : o.out; if (l !== (def.short || def.name)) s += ' ' + l; } }
  if (o.mult != null && o.mult !== '' && Number(o.mult) !== 1) s = `${o.mult} × ${s}`;
  if (o.offset) s += ` [${o.offset} ago]`;
  return s;
}
export function describeCond(c, baseTf) {
  const tf = c.tf && (!baseTf || c.tf !== baseTf) ? ` · ${tfLabel(c.tf)}` : '';
  if (c.kind === 'candle') { const nm = c.pattern === 'any_bull' ? 'Any bullish candlestick' : c.pattern === 'any_bear' ? 'Any bearish candlestick' : (CANDLE_BY_ID[c.pattern] || {}).name; return `${nm} within ${c.within || 1} bar${c.within > 1 ? 's' : ''}${tf}`; }
  if (c.kind === 'auto') return ((AUTO_SIGNALS.find((s) => s.id === c.signal) || {}).name || c.signal) + tf;
  return `${operandLabel(c.a)} ${OP_LABEL[c.op]} ${operandLabel(c.b)}${tf}`;
}
export const describeRuleset = (rs, baseTf) => rs.conds.map((c) => describeCond(c, baseTf)).join(rs.mode === 'any' ? '  OR  ' : '  AND  ') || '(no conditions)';

// Latest value of a condition's left side, for result columns.
export function leftValue(c, bars) {
  if (c.kind !== 'cmp') return null;
  const A = resolve(c.a, bars); if (!A) return null;
  return at(A, bars.t.length - 1);
}

// ───────────────────────── saved rulesets ─────────────────────────
export const savedRulesets = () => store.get('rulesets', {});
export function saveRuleset(name, rs) { const all = savedRulesets(); all[name] = JSON.parse(JSON.stringify(rs)); store.set('rulesets', all); }
export function deleteRuleset(name) { const all = savedRulesets(); delete all[name]; store.set('rulesets', all); }

export function ask(title, def = '', label = 'Name') {
  return new Promise((res) => {
    let done = false;
    const inp = h('input', { type: 'text', value: def, style: { width: '100%' } });
    const finish = (v) => { if (done) return; done = true; m.close(); res(v); };
    const m = modal(title, h('div', null, h('div', { class: 'hint' }, label), inp,
      h('div', { class: 'modal-foot' }, h('button', { onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'primary', onclick: () => finish(inp.value.trim() || null) }, 'OK'))), { onClose: () => finish(null) });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(inp.value.trim() || null); });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}

// ───────────────────────── builder UI ─────────────────────────
function operandEditor(o, isB, changed, adv) {
  const wrap = h('span', { class: 'opd' });
  const draw = () => {
    clear(wrap);
    const sel = h('select', { onchange: () => {
      const v = sel.value, keep = { offset: o.offset, mult: o.mult };
      for (const k of Object.keys(o)) delete o[k];
      if (v === 'num') Object.assign(o, num(0));
      else if (v.startsWith('p:')) Object.assign(o, price(v.slice(2)), keep);
      else Object.assign(o, ind(v.slice(2)), keep);
      draw(); changed();
    } });
    sel.append(h('optgroup', { label: 'Price' }, Object.entries(PRICE).map(([k, l]) => h('option', { value: 'p:' + k, selected: o.type === 'price' && o.field === k }, l))));
    sel.append(h('option', { value: 'num', selected: o.type === 'num' }, 'Value…'));
    const groups = {};
    for (const def of IND.values()) (groups[def.group || 'Other'] = groups[def.group || 'Other'] || []).push(def);
    for (const [gname, defs] of Object.entries(groups)) sel.append(h('optgroup', { label: gname }, defs.map((d) => h('option', { value: 'i:' + d.id, selected: o.type === 'ind' && o.id === d.id }, d.name))));
    if (isB && o.type !== 'num' && (adv() || (o.mult != null && Number(o.mult) !== 1))) wrap.append(h('input', { type: 'number', step: 'any', value: o.mult == null ? 1 : o.mult, title: 'Multiplier', style: { width: '46px' }, onchange: (e) => { o.mult = Number(e.target.value) || 1; changed(); } }), h('span', { class: 'lbl' }, '×'));
    wrap.append(sel);
    if (o.type === 'num') wrap.append(h('input', { type: 'number', step: 'any', value: o.value, style: { width: '74px' }, onchange: (e) => { o.value = Number(e.target.value); changed(); } }));
    if (o.type === 'ind') {
      const def = IND.get(o.id);
      if (def) {
        for (const p of def.params) {
          if (p.hidden) continue;
          if (p.type === 'source' || p.type === 'select') {
            const opts = p.type === 'source' ? ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'] : p.options;
            wrap.append(h('select', { title: p.label, onchange: (e) => { o.params[p.k] = e.target.value; changed(); } }, opts.map((v) => h('option', { value: v, selected: o.params[p.k] === v }, v))));
          } else wrap.append(h('input', { type: 'number', step: p.step || 1, min: p.min, title: p.label, value: o.params[p.k], onchange: (e) => { o.params[p.k] = Number(e.target.value); changed(); } }));
        }
        const outs = def.outputs;
        if (outs.length > 1) wrap.append(h('select', { title: 'Output', onchange: (e) => { o.out = e.target.value; changed(); } }, outs.map((q) => h('option', { value: q.k, selected: o.out === q.k }, q.label))));
      }
    }
    if (o.type !== 'num' && (adv() || o.offset)) wrap.append(h('input', { type: 'number', min: 0, step: 1, value: o.offset || 0, title: 'Bars ago (0 = current bar)', style: { width: '40px' }, onchange: (e) => { o.offset = Math.max(0, e.target.value | 0); changed(); } }), h('span', { class: 'lbl', title: 'Bars ago' }, 'ago'));
  };
  draw();
  return wrap;
}

/**
 * Mounts an editor for `rs` (mutated in place). opts: title, baseTf() -> tf id, onChange(), allowAuto.
 */
export function ruleBuilder(rs, { title = 'Conditions', baseTf = () => '1d', onChange = () => {}, allowAuto = true } = {}) {
  const root = h('div', { class: 'rb' }), advanced = new Set();
  let tx = null, err = null;
  const changed = () => { if (tx && document.activeElement !== tx) tx.value = formatRuleset(rs); if (err) err.textContent = ''; onChange(rs); };
  const applyText = () => {
    try { const r = parseRuleset(tx.value); rs.mode = r.mode; rs.conds = r.conds.filter((c) => allowAuto || c.kind !== 'auto'); draw(); onChange(rs); }
    catch (e) { err.textContent = e.message; }
  };
  const draw = () => {
    clear(root);
    const saved = savedRulesets();
    const load = h('select', { title: 'Load a saved rule set', onchange: () => { const s = saved[load.value]; if (s) { const c = JSON.parse(JSON.stringify(s)); rs.mode = c.mode; rs.conds = c.conds; draw(); changed(); } } },
      h('option', { value: '' }, 'Load saved…'), Object.keys(saved).map((k) => h('option', { value: k }, k)));
    root.append(h('div', { class: 'rb-head' }, h('span', { class: 't' }, title),
      h('select', { onchange: (e) => { rs.mode = e.target.value; changed(); } }, h('option', { value: 'all', selected: rs.mode !== 'any' }, 'Match ALL'), h('option', { value: 'any', selected: rs.mode === 'any' }, 'Match ANY')),
      load,
      h('button', { class: 'ghost', title: 'Save these conditions for reuse', onclick: async () => { const name = await ask('Save rule set', '', 'Name for this rule set'); if (name) { saveRuleset(name, rs); draw(); } } }, 'Save')));
    tx = h('input', { type: 'text', class: 'rb-formula', value: formatRuleset(rs), spellcheck: 'false', autocomplete: 'off', placeholder: 'Type a rule and press Enter:  close > sma(200) and rsi(14) < 30 @1w',
      title: 'The same rule as text. Edit it and press Enter. Examples: sma(50) crosses above sma(200) · volume > 1.5 * volume(20).avg · candle(hammer, 3) · close > sma(30) @1w',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); applyText(); } }, onchange: applyText });
    err = h('div', { class: 'rb-err' });
    root.append(tx, err);
    if (!rs.conds.length) root.append(h('div', { class: 'rb-empty' }, 'No conditions yet. Type one above or add one below.'));
    const tfs = tfsAtOrAbove(baseTf());
    rs.conds.forEach((c, k) => {
      const tfSel = h('select', { class: 'tfsel', title: 'Timeframe this condition is evaluated on', onchange: (e) => { c.tf = e.target.value || null; changed(); } },
        h('option', { value: '' }, 'Chart TF'), tfs.slice(1).map((t) => h('option', { value: t.id, selected: c.tf === t.id }, t.label)));
      const rm = h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { rs.conds.splice(k, 1); draw(); changed(); } }, '✕');
      let body;
      if (c.kind === 'candle') {
        body = [h('span', { class: 'lbl' }, 'Candlestick'),
          h('select', { onchange: (e) => { c.pattern = e.target.value; changed(); } }, h('option', { value: 'any_bull', selected: c.pattern === 'any_bull' }, 'Any bullish pattern'), h('option', { value: 'any_bear', selected: c.pattern === 'any_bear' }, 'Any bearish pattern'), CANDLES.map((p) => h('option', { value: p.id, selected: c.pattern === p.id }, p.name))),
          h('span', { class: 'lbl' }, 'within last'), h('input', { type: 'number', min: 1, value: c.within || 1, onchange: (e) => { c.within = Math.max(1, e.target.value | 0); changed(); } }), h('span', { class: 'lbl' }, 'bars')];
      } else if (c.kind === 'auto') {
        body = [h('span', { class: 'lbl' }, 'Auto-analysis'), h('select', { onchange: (e) => { c.signal = e.target.value; changed(); } }, AUTO_SIGNALS.map((s) => h('option', { value: s.id, selected: c.signal === s.id }, s.name))), h('span', { class: 'lbl' }, 'on the latest bar')];
      } else {
        const adv = () => advanced.has(c);
        body = [operandEditor(c.a, false, changed, adv), h('select', { onchange: (e) => { c.op = e.target.value; changed(); } }, OPS.map((o) => h('option', { value: o.id, selected: c.op === o.id }, o.label))), operandEditor(c.b, true, changed, adv),
          h('button', { class: 'icon-btn', title: 'More: multiplier and bars-ago offset', onclick: () => { if (advanced.has(c)) advanced.delete(c); else advanced.add(c); draw(); } }, '⋯')];
      }
      root.append(h('div', { class: 'rb-cond' }, tfSel, body, h('span', { class: 'spacer' }), rm));
    });
    root.append(h('div', { class: 'rb-add' },
      h('button', { onclick: () => { rs.conds.push(cmp(price('close'), 'gt', ind('sma', { len: 50 }))); draw(); changed(); } }, '+ Condition'),
      h('button', { onclick: () => { rs.conds.push({ kind: 'candle', tf: null, pattern: 'any_bull', within: 1 }); draw(); changed(); } }, '+ Candlestick pattern'),
      allowAuto ? h('button', { onclick: () => { rs.conds.push({ kind: 'auto', tf: null, signal: 'break_res' }); draw(); changed(); } }, '+ Auto-analysis signal') : null));
  };
  draw();
  root.redraw = draw;
  return root;
}

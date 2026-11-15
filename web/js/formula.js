// Rules as text. The builder and this text are two views of the same rule set:
//
//   close > sma(200) and rsi(2) < 10
//   sma(50) crosses above sma(200)
//   close > sma(30) @1w and macd.macd crosses above macd.signal
//   volume > 1.5 * volume.avg(20)[1]          (multiplier, and [n] = n bars ago)
//   candle(hammer, 3) and close > bb(20, 2).lower
//   auto(break_res)
//
// formatRuleset(parseRuleset(text)) is stable, and parseRuleset(formatRuleset(rs)) rebuilds rs.
import { IND, defaultParams } from './ta.js';
import { TF } from './data.js';
import { CANDLE_BY_ID, AUTO_SIGNALS } from './auto.js';

const PRICE = ['close', 'open', 'high', 'low', 'volume'];
const OP_TEXT = { gt: '>', lt: '<', gte: '>=', lte: '<=', xup: 'crosses above', xdn: 'crosses below' };
const TF_WORDS = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '60m': '1h', hourly: '1h', '4h': '4h', '1d': '1d', d: '1d', daily: '1d', day: '1d', '1w': '1w', w: '1w', weekly: '1w', week: '1w', '1mo': '1mo', m: '1mo', mo: '1mo', monthly: '1mo', month: '1mo' };
const visibleParams = (def) => def.params.filter((p) => !p.hidden);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
// The output a bare name refers to: the one named after the indicator (macd -> the MACD line), else the first.
const mainOut = (def) => (def.outputs.find((o) => o.k === def.id) || def.outputs[0]).k;

function findIndicator(name) {
  const lc = name.toLowerCase();
  if (IND.has(name)) return IND.get(name);
  for (const def of IND.values()) if (def.id.toLowerCase() === lc) return def;
  // exact label before the loose match, so "ATR%" is ATR % and not ATR
  for (const def of IND.values()) if ((def.short || '').toLowerCase() === lc || def.name.toLowerCase() === lc) return def;
  const s = slug(name);
  for (const def of IND.values()) if (slug(def.short || '') === s || slug(def.name) === s) return def;
  return null;
}

// ───────────────────────── format ─────────────────────────
// plain decimals only: the parser does not read exponents
const numText = (v) => { const n = Number(v); if (!Number.isFinite(n)) return '0'; const s = String(n); return /e/i.test(s) ? n.toFixed(12).replace(/\.?0+$/, '') : s; };
function operandText(o) {
  let s;
  if (o.type === 'num') return numText(o.value);
  if (o.type === 'price') s = o.field || 'close';
  else {
    const def = IND.get(o.id);
    if (!def) s = o.id;
    else {
      const p = { ...defaultParams(def), ...(o.params || {}) }, vis = visibleParams(def).slice();
      // trailing choice settings left at their default (source = close, anchor = session) are not written
      while (vis.length && vis[vis.length - 1].type && p[vis[vis.length - 1].k] === vis[vis.length - 1].def) vis.pop();
      s = def.id + (vis.length ? `(${vis.map((q) => p[q.k]).join(', ')})` : '');
      if (o.out && o.out !== mainOut(def)) s += '.' + o.out;
    }
  }
  if (o.mult != null && o.mult !== '' && Number(o.mult) !== 1) s = `${numText(o.mult)} * ${s}`;
  if (o.offset) s += `[${o.offset | 0}]`;
  return s;
}
export function condText(c) {
  const tf = c.tf ? ` @${c.tf}` : '';
  if (c.kind === 'candle') return `candle(${c.pattern}${c.within > 1 ? ', ' + (c.within | 0) : ''})${tf}`;
  if (c.kind === 'auto') return `auto(${c.signal})${tf}`;
  return `${operandText(c.a)} ${OP_TEXT[c.op] || '>'} ${operandText(c.b)}${tf}`;
}
export const formatRuleset = (rs) => rs.conds.map(condText).join(rs.mode === 'any' ? ' or ' : ' and ');

// ───────────────────────── parse ─────────────────────────
function tokenize(src) {
  const out = [], re = /\s*(?:(\d+\.?\d*|\.\d+)|([A-Za-z_][A-Za-z0-9_:%]*(?:-[A-Za-z0-9_:%]+)*)|(>=|<=|>|<|\(|\)|,|\.|\*|@|\[|\]|-))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Cannot read “${src.slice(i).trim().slice(0, 12)}”`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else out.push({ t: m[3] });
  }
  return out;
}

export function parseRuleset(text) {
  const tk = tokenize(String(text || '')), conds = [];
  let i = 0, mode = null;
  const peek = (k = 0) => tk[i + k], word = (k = 0) => (tk[i + k] && tk[i + k].t === 'id' ? tk[i + k].v.toLowerCase() : null);
  const eat = (t) => { if (!tk[i] || tk[i].t !== t) throw new Error(`Expected “${t}”${tk[i] ? ` before “${tk[i].v ?? tk[i].t}”` : ' at the end'}`); return tk[i++]; };
  const number = () => { let sign = 1; if (peek() && peek().t === '-') { sign = -1; i++; } if (!peek() || peek().t !== 'num') throw new Error('Expected a number'); return sign * tk[i++].v; };
  const isNumberAhead = () => peek() && (peek().t === 'num' || (peek().t === '-' && peek(1) && peek(1).t === 'num'));

  function timeframe() {
    if (peek() && peek().t === '@') i++; else if (word() === 'on') i++; else return null;
    if (word() === 'the') i++;
    const w = peek() && peek().t === 'num' ? String(tk[i++].v) + (word() ? tk[i++].v.toLowerCase() : '') : word() ? tk[i++].v.toLowerCase() : null;
    const tf = TF_WORDS[w];
    if (!tf || !TF[tf]) throw new Error(`Unknown timeframe “${w ?? ''}”. Use 5m, 15m, 30m, 1h, 4h, 1d, 1w or 1mo.`);
    return tf;
  }
  function atom() {
    if (isNumberAhead()) return { type: 'num', value: number() };
    if (!word()) throw new Error(`Expected a price, an indicator or a number${peek() ? ` at “${peek().t}”` : ''}`);
    const name = tk[i++].v, lc = name.toLowerCase();
    // a bare price word is the price; "volume(20).avg" or "volume.avg" is the Volume indicator
    if (PRICE.includes(lc) && !(peek() && (peek().t === '.' || peek().t === '('))) return { type: 'price', field: lc };
    const def = findIndicator(name);
    if (!def) throw new Error(`Unknown indicator “${name}”`);
    const params = defaultParams(def), vis = visibleParams(def);
    let out = mainOut(def), sawOut = false;
    const readOut = () => { i++; const w = word(); if (!w) throw new Error(`Expected an output name after “${name}.”`); i++; const q = def.outputs.find((x) => x.k.toLowerCase() === w || slug(x.label) === slug(w)); if (!q) throw new Error(`“${def.id}” has no output “${w}”. Outputs: ${def.outputs.map((x) => x.k).join(', ')}`); out = q.k; sawOut = true; };
    if (peek() && peek().t === '.') readOut();
    if (peek() && peek().t === '(') {
      i++; let k = 0;
      while (peek() && peek().t !== ')') {
        const p = vis[k++]; if (!p) throw new Error(`“${def.id}” takes ${vis.length} setting${vis.length === 1 ? '' : 's'}`);
        if (p.type === 'source' || p.type === 'select') { const w = word(); const opts = p.type === 'source' ? ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'] : p.options; if (!w || !opts.includes(w)) throw new Error(`“${p.label}” of ${def.id} must be one of: ${opts.join(', ')}`); params[p.k] = w; i++; }
        else params[p.k] = number();
        if (peek() && peek().t === ',') i++; else break;
      }
      eat(')');
    }
    if (!sawOut && peek() && peek().t === '.') readOut();
    return { type: 'ind', id: def.id, params, out };
  }
  function operand() {
    let mult = null;
    if (isNumberAhead()) { const save = i, v = number(); if (peek() && peek().t === '*') { i++; mult = v; } else i = save; }
    const o = atom();
    if (mult != null && o.type !== 'num') o.mult = mult; else if (mult != null) o.value *= mult;
    if (peek() && peek().t === '[') {
      i++; const k = number(); if (word() === 'ago') i++; eat(']');
      if (!Number.isInteger(k) || k < 0) throw new Error(`“[${k}]” must be a whole number of bars ago, 0 or more (a rule cannot look ahead)`);
      if (o.type !== 'num') o.offset = k;
    }
    return o;
  }
  function operator() {
    const t = peek(); if (!t) throw new Error('The condition is missing a comparison');
    if (t.t === '>') { i++; return 'gt'; } if (t.t === '<') { i++; return 'lt'; } if (t.t === '>=') { i++; return 'gte'; } if (t.t === '<=') { i++; return 'lte'; }
    if (word() === 'is') i++;
    const w = word();
    if (w === 'crosses' || w === 'cross' || w === 'crossing' || w === 'crossed') { i++; const d = word(); i++; if (d === 'above' || d === 'over' || d === 'up') return 'xup'; if (d === 'below' || d === 'under' || d === 'down') return 'xdn'; throw new Error('Write “crosses above” or “crosses below”'); }
    if (w === 'above' || w === 'over') { i++; return 'gt'; }
    if (w === 'below' || w === 'under') { i++; return 'lt'; }
    throw new Error(`Expected a comparison (>, <, >=, <=, crosses above, crosses below)${t.v !== undefined ? ` at “${t.v}”` : ''}`);
  }
  function condition() {
    const w = word();
    if ((w === 'candle' || w === 'auto') && peek(1) && peek(1).t === '(') {
      i += 2; const id = word(); if (!id) throw new Error(`Name a ${w === 'candle' ? 'pattern' : 'signal'} inside ${w}(…)`); const raw = tk[i++].v;
      if (w === 'candle') {
        const pid = raw.toLowerCase(), known = pid === 'any_bull' || pid === 'any_bear' || CANDLE_BY_ID[pid] || Object.values(CANDLE_BY_ID).find((c) => slug(c.name) === slug(raw));
        if (!known) throw new Error(`Unknown candlestick pattern “${raw}”. Try: any_bull, any_bear, ${Object.keys(CANDLE_BY_ID).join(', ')}`);
        let within = 1; if (peek() && peek().t === ',') { i++; within = Math.max(1, number() | 0); }
        eat(')');
        return { kind: 'candle', tf: timeframe(), pattern: known === true ? pid : known.id || pid, within };
      }
      if (!AUTO_SIGNALS.some((s) => s.id === raw)) throw new Error(`Unknown auto signal “${raw}”. Use: ${AUTO_SIGNALS.map((s) => s.id).join(', ')}`);
      eat(')');
      return { kind: 'auto', tf: timeframe(), signal: raw };
    }
    const a = operand(), op = operator(), b = operand();
    return { kind: 'cmp', tf: timeframe(), a, op, b };
  }
  if (!tk.length) return { mode: 'all', conds: [] };
  for (;;) {
    conds.push(condition());
    const w = word();
    if (!peek()) break;
    if (w !== 'and' && w !== 'or') throw new Error(`Expected “and” or “or”${peek().v !== undefined ? ` before “${peek().v}”` : ` at “${peek().t}”`}`);
    const m = w === 'or' ? 'any' : 'all';
    if (mode && mode !== m) throw new Error('Use only “and” or only “or” in one rule set, not both');
    mode = m; i++;
    if (!peek()) throw new Error(`Nothing follows “${w}”`);
  }
  return { mode: mode || 'all', conds };
}

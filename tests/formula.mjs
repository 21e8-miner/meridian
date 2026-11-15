// node tests/formula.mjs — rules as text: parse, format, round trip, and helpful errors.
import { parseRuleset, formatRuleset } from '../web/js/formula.js';
import { cmp, price, num, ind, newRuleset, evalRuleset } from '../web/js/conditions.js';
import { aggregate } from '../web/js/data.js';
import { dailyBars, check, done } from './fixture.mjs';

const rules = [
  newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 200 })), cmp(ind('rsi', { len: 2 }), 'lt', num(10))]),
  newRuleset([cmp(ind('sma', { len: 50 }), 'xup', ind('sma', { len: 200 }))]),
  newRuleset([cmp(price('close'), 'gt', { ...ind('donchian', { len: 55 }, 'upper'), offset: 1 })]),
  newRuleset([cmp(price('close'), 'gt', ind('sma', { len: 30 }), '1w'), cmp(ind('macd', {}, 'macd'), 'xup', ind('macd', {}, 'signal'))]),
  newRuleset([cmp(price('volume'), 'gt', { ...ind('volume', { len: 20 }, 'avg'), mult: 1.5, offset: 1 }), cmp(ind('cci', { len: 20 }), 'lte', num(-100))], 'any'),
  newRuleset([{ kind: 'candle', tf: null, pattern: 'any_bull', within: 1 }, { kind: 'candle', tf: '1w', pattern: 'hammer', within: 3 }, { kind: 'auto', tf: null, signal: 'break_res' }]),
  newRuleset([cmp(ind('sma', { len: 20, src: 'high' }), 'gte', ind('vwap', { anchor: 'month' })), cmp({ ...ind('bbw', { len: 20, mult: 2 }), offset: 1 }, 'lt', num(8.5))]),
  newRuleset([cmp(ind('squeeze', {}, 'on'), 'gt', num(0)), cmp(ind('supertrend', {}, 'dir'), 'xdn', num(0))]),
];
const norm = (rs) => JSON.stringify(rs, (k, v) => (k === 'tf' && !v ? undefined : v));
for (const rs of rules) {
  const text = formatRuleset(rs), back = parseRuleset(text);
  check('round trip: ' + text, norm(back) === norm(rs) && formatRuleset(back) === text, norm(back) === norm(rs) ? '' : `\n   got  ${norm(back)}\n   want ${norm(rs)}`);
}
// the text and the builder give the same answers on data
const d = dailyBars(), w = aggregate(d, '1w'), byTf = new Map([['1w', w]]);
{ const a = evalRuleset(rules[3], d, byTf).mask, b = evalRuleset(parseRuleset('close > sma(30) @1w and macd crosses above macd.signal'), d, byTf).mask; check('parsed rule evaluates identically', a.every((v, i) => v === b[i]) && a.some(Boolean)); }
// friendlier spellings
const same = (x, y) => check(`“${x}” = “${y}”`, norm(parseRuleset(x)) === norm(parseRuleset(y)));
same('Close is above SMA(200)', 'close > sma(200)');
same('rsi(14) crossed below 70 on the weekly', 'rsi(14) crosses below 70 @1w');
same('close > ema(21) on daily', 'close > ema(21) @1d');
same('RSI < 30', 'rsi(14) < 30');
same('macd.signal < 0 @4h', 'macd(12, 26, 9).signal < 0 @4h');
same('macd > 0', 'macd.macd > 0');
same('close >= 2 * atr(14)[3]', 'close >= 2 * atr(14)[3 ago]');
same('candle(Bullish Engulfing)'.replace(' ', ''), 'candle(bullengulf)');
check('negative numbers', parseRuleset('cci(20) < -100').conds[0].b.value === -100 && parseRuleset('roc(12) > -2.5').conds[0].b.value === -2.5);
check('empty text is an empty rule set', parseRuleset('   ').conds.length === 0);
check('the label “ATR%” is ATR %, not ATR', parseRuleset('ATR%(14) > 3').conds[0].a.id === 'atrp' && parseRuleset('atr(14) > 3').conds[0].a.id === 'atr');
check('tiny and huge numbers survive a round trip', parseRuleset(formatRuleset(newRuleset([cmp(price('close'), 'gt', num(1e-7))]))).conds[0].b.value === 1e-7 && formatRuleset(newRuleset([cmp(price('volume'), 'gt', num(25000000))])) === 'volume > 25000000');
// errors say what is wrong
const err = (text, re) => { let m = ''; try { parseRuleset(text); } catch (e) { m = e.message; } check(`error for “${text}”`, re.test(m), m || '(no error)'); };
err('close > smaa(20)', /Unknown indicator/);
err('close > sma(20) and rsi(14) < 30 or adx(14) > 20', /only “and” or only “or”/);
err('close sma(20)', /comparison/);
err('close > sma(20) @2w', /Unknown timeframe/);
err('macd.foo > 0', /no output/);
err('close > sma(20) and', /Nothing follows/);
err('close > sma(1, close, 3)', /takes 2 settings/);
err('candle(nope)', /Unknown candlestick/);
err('close > sma(20) # x', /Cannot read/);
err('close[-1] > close', /cannot look ahead/);
err('close[1.9] > close', /whole number/);
err('sma(20, typical) > 1', /must be one of/);
done('formula');

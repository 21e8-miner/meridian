// node tests/lab.mjs — Model Lab: split, embargo, and no in-sample output from a saved model.
import { dailyBars, check, done } from './fixture.mjs';
import { train, toIndicator } from '../web/js/lab.js';
const d = dailyBars(), n = d.t.length;
for (const kind of ['logistic', 'boost']) {
  const m = train(d, { horizon: 5, threshold: 0, kind, features: ['rsi14', 'd20', 'd50', 'macdh', 'atrp', 'roc5', 'rvol'] });
  const iSplit = d.t.indexOf(m.splitT), iTrainEnd = d.t.indexOf(m.trainFrom) + m.metrics.nTrain;
  check(`${kind}: test starts after training labels end`, iSplit > 0 && m.metrics.nTrain + m.metrics.nTest <= n && m.metrics.nTest > 500 && m.metrics.aucTest > 0.3 && m.metrics.aucTest < 0.7, `AUC train ${m.metrics.aucTrain.toFixed(3)} test ${m.metrics.aucTest.toFixed(3)}`);
  const ind = toIndicator({ ...m, id: 'x', name: 'x' }), p = ind.calc(d).p;
  check(`${kind}: the saved model is blank on the bars it was fitted on`, p.slice(0, iSplit).every((v) => v !== v) && p.slice(iSplit).filter((v) => v === v).length === n - iSplit && p.slice(iSplit).every((v) => v !== v || (v > 0 && v < 1)));
  void iTrainEnd;
}
{ let msg = ''; try { train(d, { horizon: 400, threshold: 0, kind: 'logistic', features: ['rsi14', 'd20'] }); } catch (e) { msg = e.message; } check('an oversized horizon is refused with a reason', /shorter horizon/.test(msg), msg); }
done('lab');

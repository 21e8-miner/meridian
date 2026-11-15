// Canvas chart: price panes, indicator panes, automated overlays, user drawings, crosshair.
// The chart is a view: the app computes indicators/analysis and hands them in.
import { fmtPrice, fmtVol, fmtStamp, fmtNum, fmtPct, clamp, h, clear, MON, uid } from './util.js';
import { isIntraday, tfLabel } from './data.js';

const AX = 66, TH = 22;
const TWO_POINT = new Set(['trend', 'ray', 'rect', 'fib', 'measure']);
const FIB_DRAW = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
}

export class Chart {
  constructor(el, cb = {}) {
    this.el = el; this.cb = cb;
    el.classList.add('chart'); el.tabIndex = 0;
    this.canvas = h('canvas');
    this.legend = h('div', { class: 'legend' });
    this.paneLegends = h('div', { class: 'pane-legends' });
    this.msgEl = h('div', { class: 'chart-msg' });
    el.append(this.canvas, this.legend, this.paneLegends, this.msgEl);
    this.g = this.canvas.getContext('2d');
    this.bars = null; this.inds = []; this.auto = {}; this.drawings = []; this.trades = []; this.alertLines = [];
    this.opt = { type: 'candles', log: false, volume: true, vp: false };
    this.view = { right: 0, barW: 8, yScale: 1 };
    this.ghostT = null;
    this.tool = 'cursor'; this.mouse = null; this.sel = null; this.draft = null; this.measure = null; this.drag = null;
    this.readTheme();
    this.bind();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
    this.th = { bg: v('--chart-bg'), grid: v('--grid'), line: v('--line'), text: v('--text'), muted: v('--muted'), up: v('--up'), down: v('--down'), accent: v('--accent'), panel: v('--panel') };
    this.invalidate();
  }

  // Detach from the window and stop observing; call before discarding a chart.
  destroy() { window.removeEventListener('mousemove', this.onMove); window.removeEventListener('mouseup', this.onUp); this.ro.disconnect(); this.pending = true; }

  // ── data in ──
  setBars(bars, { keepView = false } = {}) {
    const same = this.bars && bars && this.bars.symbol === bars.symbol && this.bars.tf === bars.tf;
    const grew = same ? bars.t.length - this.bars.t.length : 0;
    this.bars = bars; this.ha = null; this.msgEl.textContent = '';
    if (bars) {
      const n = bars.t.length, d = [];
      for (let i = Math.max(1, n - 60); i < n; i++) d.push(bars.t[i] - bars.t[i - 1]);
      d.sort((a, b) => a - b);
      this.dt = d.length ? d[Math.floor(d.length / 2)] : 86400;
      if (same && keepView) this.view.right += grew; else this.resetView();
    }
    this.buildLegend(); this.invalidate();
  }
  setMessage(m) { this.msgEl.textContent = m || ''; }
  setIndicators(list) { this.inds = list; this.buildLegend(); this.invalidate(); }
  setAuto(a) { this.auto = a || {}; this.lgI = -1; this.invalidate(); }
  setDrawings(list) { this.drawings = list || []; this.sel = null; this.invalidate(); }
  setTrades(t) { this.trades = t || []; this.invalidate(); }
  setAlertLines(a) { this.alertLines = a || []; this.invalidate(); }
  setOptions(o) { Object.assign(this.opt, o); this.ha = null; this.invalidate(); }
  setTool(t) { this.tool = t; this.draft = null; this.el.style.cursor = t === 'cursor' ? '' : 'crosshair'; this.invalidate(); }
  resetView() { if (!this.bars) return; this.view.barW = 8; this.view.yScale = 1; this.view.right = this.bars.t.length - 1 + 6; this.invalidate(); }
  // Crosshair mirrored from another chart (linked charts): a bar time, or null.
  setGhost(t) { if (t === this.ghostT) return; this.ghostT = t; this.invalidate(); }
  focusIndex(i) { const pw = this.w - AX; this.view.right = i + (pw / this.view.barW) * 0.35; this.invalidate(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(200, this.el.clientWidth); this.h = Math.max(160, this.el.clientHeight);
    this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px'; this.canvas.style.height = this.h + 'px';
    this.dpr = dpr; this.render();
  }
  invalidate() {
    if (this.pending) return;
    this.pending = true;
    const run = () => { if (!this.pending) return; this.pending = false; this.render(); };
    requestAnimationFrame(run); setTimeout(run, 60); // the timer covers hidden tabs, where rAF is paused
  }

  // ── geometry ──
  layout() {
    const lower = this.inds.filter((x) => !x.def.overlay && !x.hidden && x.out && !x.out.__error);
    const avail = this.h - TH;
    let ph = lower.length ? clamp(Math.floor(avail * 0.19), 64, 132) : 0;
    if (lower.length * ph > avail * 0.6) ph = Math.floor((avail * 0.6) / lower.length);
    const mainH = avail - lower.length * ph;
    this.L = { pw: this.w - AX, main: { y: 0, h: mainH }, panes: lower.map((ind, k) => ({ ind, y: mainH + k * ph, h: ph })) };
    return this.L;
  }
  xOf(i) { return this.L.pw - (this.view.right - i) * this.view.barW; }
  idxOf(x) { return this.view.right - (this.L.pw - x) / this.view.barW; }
  yOf(p) { const s = this.ms; return s.log ? s.y0 + (1 - (Math.log(p) - s.lo) / (s.hi - s.lo)) * s.hh : s.y0 + (1 - (p - s.lo) / (s.hi - s.lo)) * s.hh; }
  priceOf(y) { const s = this.ms, f = 1 - (y - s.y0) / s.hh; return s.log ? Math.exp(s.lo + f * (s.hi - s.lo)) : s.lo + f * (s.hi - s.lo); }
  tToIdx(t) {
    const T = this.bars.t, n = T.length;
    if (t <= T[0]) return (t - T[0]) / this.dt;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.dt;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }
  idxToT(i) {
    const T = this.bars.t, n = T.length;
    if (i <= 0) return T[0] + i * this.dt;
    if (i >= n - 1) return T[n - 1] + (i - (n - 1)) * this.dt;
    const f = Math.floor(i);
    return T[f] + (i - f) * (T[f + 1] - T[f]);
  }
  ptXY(pt) { return [this.xOf(this.tToIdx(pt.t)), this.yOf(pt.p)]; }
  xyPt(x, y) { return { t: this.idxToT(this.idxOf(x)), p: this.priceOf(y) }; }

  series() {
    const b = this.bars;
    if (this.opt.type !== 'ha') return b;
    if (this.ha) return this.ha;
    const n = b.t.length, o = new Array(n), hh = new Array(n), l = new Array(n), c = new Array(n);
    for (let i = 0; i < n; i++) {
      c[i] = (b.o[i] + b.h[i] + b.l[i] + b.c[i]) / 4;
      o[i] = i === 0 ? (b.o[0] + b.c[0]) / 2 : (o[i - 1] + c[i - 1]) / 2;
      hh[i] = Math.max(b.h[i], o[i], c[i]); l[i] = Math.min(b.l[i], o[i], c[i]);
    }
    return (this.ha = { ...b, o, h: hh, l, c });
  }

  // ── render ──
  render() {
    // ResizeObserver is not delivered while a tab is in the background; catch up here.
    const cw = Math.max(200, this.el.clientWidth), ch = Math.max(160, this.el.clientHeight);
    if (this.el.clientWidth > 0 && (cw !== this.w || ch !== this.h)) return this.resize();
    const g = this.g, th = this.th;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = th.bg; g.fillRect(0, 0, this.w, this.h);
    const L = this.layout();
    this.positionLegends();
    if (!this.bars || !this.bars.t.length) return;
    const b = this.series(), n = b.t.length, pw = L.pw;
    const i0 = Math.max(0, Math.floor(this.idxOf(0)) - 1), i1 = Math.min(n - 1, Math.ceil(this.view.right) + 1);
    this.vis = [i0, i1];
    g.font = '11px system-ui, -apple-system, sans-serif'; g.textBaseline = 'middle'; g.lineJoin = 'round';

    // main scale
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (b.l[i] < lo) lo = b.l[i]; if (b.h[i] > hi) hi = b.h[i]; }
    if (!(hi > lo)) { hi = lo * 1.01 + 0.01; lo = lo * 0.99 - 0.01; }
    const R = hi - lo, xl = lo - 0.25 * R, xh = hi + 0.25 * R;
    for (const ind of this.inds) {
      if (!ind.def.overlay || ind.hidden || !ind.out || ind.out.__error) continue;
      for (const o of ind.def.outputs) {
        if (o.hidden) continue; const a = ind.out[o.k]; if (!a) continue;
        for (let i = i0; i <= i1; i++) { const v = a[i]; if (v === v && v >= xl && v <= xh) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      }
    }
    const log = this.opt.log && lo > 0;
    const padT = 0.08, padB = this.opt.volume ? 0.2 : 0.08;
    let slo = log ? Math.log(lo) : lo, shi = log ? Math.log(hi) : hi;
    const sr = shi - slo; shi += sr * padT / (1 - padT - padB); slo -= sr * padB / (1 - padT - padB);
    if (this.view.yScale !== 1) { const mid = (slo + shi) / 2, half = ((shi - slo) / 2) * this.view.yScale; slo = mid - half; shi = mid + half; }
    this.ms = { lo: slo, hi: shi, y0: L.main.y, hh: L.main.h, log };

    this.tticks = this.timeTicks(b, i0, i1);
    g.save(); g.beginPath(); g.rect(0, 0, pw, L.main.h); g.clip();
    this.drawGrid(i0, i1);
    if (this.opt.vp) this.drawVP(b, i0, i1);
    this.drawAutoUnder(i0, i1);
    if (this.opt.volume) this.drawVolume(b, i0, i1);
    this.drawPrice(b, i0, i1);
    for (const ind of this.inds) if (ind.def.overlay && !ind.hidden && ind.out && !ind.out.__error) this.drawInd(ind, i0, i1, (v) => this.yOf(v), L.main, b);
    this.drawAutoOver(b, i0, i1);
    this.drawTrades();
    for (const d of this.drawings) this.drawDrawing(d, d === this.sel);
    if (this.draft) this.drawDrawing(this.draft, true);
    if (this.measure) this.drawDrawing(this.measure, true);
    g.restore();

    this.drawPriceAxis(b);
    for (const p of L.panes) this.drawPane(p, b, i0, i1);
    this.drawTimeAxis(b, i0, i1);
    this.drawCrosshair(b);
    this.updateLegend();
  }

  drawGrid(i0, i1) {
    const g = this.g, L = this.L, s = this.ms;
    const pLo = this.priceOf(L.main.y + L.main.h), pHi = this.priceOf(L.main.y);
    const step = niceStep((pHi - pLo) / Math.max(2, Math.floor(L.main.h / 56)));
    this.pticks = [];
    g.strokeStyle = this.th.grid; g.lineWidth = 1; g.beginPath();
    let lastY = Infinity;
    for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
      if (s.log && p <= 0) continue;
      const y = Math.round(this.yOf(p)) + 0.5;
      if (lastY - y < 18) continue; lastY = y;
      g.moveTo(0, y); g.lineTo(L.pw, y); this.pticks.push([p, y]);
    }
    for (const k of this.tticks) { const x = Math.round(k.x) + 0.5; g.moveTo(x, 0); g.lineTo(x, L.main.h); }
    g.stroke();
  }

  drawPriceAxis(b) {
    const g = this.g, L = this.L, th = this.th, n = b.t.length;
    g.fillStyle = th.bg; g.fillRect(L.pw, 0, AX, this.h);
    g.strokeStyle = th.line; g.beginPath(); g.moveTo(L.pw + 0.5, 0); g.lineTo(L.pw + 0.5, this.h - TH); g.stroke();
    g.fillStyle = th.muted; g.textAlign = 'left';
    for (const [p, y] of this.pticks || []) g.fillText(fmtPrice(p), L.pw + 7, y);
    const last = this.bars.c[n - 1], prev = n > 1 ? this.bars.c[n - 2] : last, col = last >= prev ? th.up : th.down, y = this.yOf(last);
    if (y > 0 && y < L.main.h) {
      g.save(); g.setLineDash([2, 3]); g.strokeStyle = col; g.globalAlpha = 0.7; g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(L.pw, Math.round(y) + 0.5); g.stroke(); g.restore();
      this.axisTag(y, fmtPrice(last), col, '#0b0e12');
    }
    for (const a of this.alertLines) {
      const ay = this.yOf(a.price); if (!(ay > 0 && ay < L.main.h)) continue;
      g.save(); g.setLineDash([6, 4]); g.strokeStyle = th.accent; g.beginPath(); g.moveTo(0, Math.round(ay) + 0.5); g.lineTo(L.pw, Math.round(ay) + 0.5); g.stroke(); g.restore();
      g.fillStyle = th.accent; g.textAlign = 'right'; g.fillText('ALERT ' + (a.label || ''), L.pw - 6, ay - 8); g.textAlign = 'left';
      this.axisTag(ay, fmtPrice(a.price), th.accent, '#0b0e12');
    }
  }
  axisTag(y, text, bg, fg) {
    const g = this.g, L = this.L;
    g.fillStyle = bg; g.fillRect(L.pw + 1, Math.round(y) - 9, AX - 1, 18);
    g.fillStyle = fg; g.textAlign = 'left'; g.fillText(text, L.pw + 7, Math.round(y));
  }

  drawVolume(b, i0, i1) {
    const g = this.g, L = this.L, bw = Math.max(1, Math.floor(this.view.barW * 0.7));
    let mx = 0; for (let i = i0; i <= i1; i++) if (b.v[i] > mx) mx = b.v[i];
    if (!mx) return;
    const base = L.main.y + L.main.h, vh = L.main.h * 0.15;
    for (let i = i0; i <= i1; i++) {
      const x = Math.round(this.xOf(i) - bw / 2), hh = Math.max(1, (b.v[i] / mx) * vh);
      g.fillStyle = rgba(this.bars.c[i] >= this.bars.o[i] ? this.th.up : this.th.down, 0.28);
      g.fillRect(x, base - hh, bw, hh);
    }
  }

  drawVP(b, i0, i1) {
    const g = this.g, L = this.L, bins = 48, pLo = this.priceOf(L.main.h), pHi = this.priceOf(0), bs = (pHi - pLo) / bins, vol = new Array(bins).fill(0);
    for (let i = i0; i <= i1; i++) {
      const a = clamp(Math.floor((b.l[i] - pLo) / bs), 0, bins - 1), z = clamp(Math.floor((b.h[i] - pLo) / bs), 0, bins - 1), share = b.v[i] / (z - a + 1);
      for (let k = a; k <= z; k++) vol[k] += share;
    }
    let mx = 0, poc = 0; for (let k = 0; k < bins; k++) if (vol[k] > mx) { mx = vol[k]; poc = k; }
    if (!mx) return;
    const maxW = L.pw * 0.2;
    for (let k = 0; k < bins; k++) {
      const y1 = this.yOf(pLo + (k + 1) * bs), y2 = this.yOf(pLo + k * bs);
      g.fillStyle = k === poc ? rgba(this.th.accent, 0.5) : rgba(this.th.muted, 0.22);
      g.fillRect(0, y1 + 0.5, (vol[k] / mx) * maxW, Math.max(1, y2 - y1 - 1));
    }
  }

  drawPrice(b, i0, i1) {
    const g = this.g, th = this.th, type = this.opt.type, bwRaw = this.view.barW;
    if (type === 'line' || type === 'area') {
      g.beginPath();
      for (let i = i0; i <= i1; i++) { const x = this.xOf(i), y = this.yOf(b.c[i]); if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.strokeStyle = th.accent; g.lineWidth = 1.6; g.stroke();
      if (type === 'area') { g.lineTo(this.xOf(i1), this.L.main.h); g.lineTo(this.xOf(i0), this.L.main.h); g.closePath(); g.fillStyle = rgba(th.accent, 0.1); g.fill(); }
      g.lineWidth = 1; return;
    }
    const bw = Math.max(1, Math.floor(bwRaw * 0.7)), half = bw / 2;
    for (let pass = 0; pass < 2; pass++) {
      const upPass = pass === 0, col = upPass ? th.up : th.down;
      g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 1; g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const up = b.c[i] >= b.o[i]; if (up !== upPass) continue;
        const x = Math.round(this.xOf(i)) + 0.5, yo = this.yOf(b.o[i]), yc = this.yOf(b.c[i]), yh = this.yOf(b.h[i]), yl = this.yOf(b.l[i]);
        if (type === 'bars') {
          g.moveTo(x, yh); g.lineTo(x, yl);
          if (bw >= 3) { g.moveTo(x - half, Math.round(yo) + 0.5); g.lineTo(x, Math.round(yo) + 0.5); g.moveTo(x, Math.round(yc) + 0.5); g.lineTo(x + half, Math.round(yc) + 0.5); }
          continue;
        }
        const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
        if (bw < 3) { g.moveTo(x, yh); g.lineTo(x, yl); continue; }
        if (type === 'hollow' && up) {
          g.moveTo(x, yh); g.lineTo(x, top); g.moveTo(x, top + bh); g.lineTo(x, yl);
          g.rect(Math.round(x - half) + 0.5, Math.round(top) + 0.5, bw - 1, Math.max(1, Math.round(bh) - 1));
        } else {
          g.moveTo(x, yh); g.lineTo(x, yl);
          g.fillRect(Math.round(x - half), Math.round(top), bw, Math.round(bh) || 1);
        }
      }
      g.stroke();
    }
  }

  drawInd(ind, i0, i1, Y, pane, b) {
    const g = this.g, th = this.th, def = ind.def, out = ind.out, bw = Math.max(1, Math.floor(this.view.barW * 0.7));
    if (def.fill) {
      const A = out[def.fill[0]], B = out[def.fill[1]];
      if (A && B) {
        let s = -1;
        const flush = (e) => {
          if (s < 0 || e - s < 1) return;
          g.beginPath();
          for (let i = s; i <= e; i++) { const x = this.xOf(i); if (i === s) g.moveTo(x, Y(A[i])); else g.lineTo(x, Y(A[i])); }
          for (let i = e; i >= s; i--) g.lineTo(this.xOf(i), Y(B[i]));
          g.closePath(); g.fillStyle = rgba(ind.colors[def.fill[0]] || th.muted, 0.07); g.fill();
        };
        for (let i = i0; i <= i1; i++) { const okk = A[i] === A[i] && B[i] === B[i]; if (okk && s < 0) s = i; if (!okk && s >= 0) { flush(i - 1); s = -1; } }
        if (s >= 0) flush(i1);
      }
    }
    for (const o of def.outputs) {
      if (o.hidden) continue;
      const a = out[o.k]; if (!a) continue;
      const col = ind.colors[o.k] || th.muted;
      if (o.style === 'hist') {
        const zero = Y(0), base = pane.y + pane.h;
        for (let i = i0; i <= i1; i++) {
          const v = a[i]; if (v !== v) continue;
          g.fillStyle = o.colorBy === 'sign' ? rgba(v >= 0 ? th.up : th.down, 0.75) : o.colorBy === 'bar' ? rgba(b.c[i] >= b.o[i] ? th.up : th.down, 0.6) : rgba(col, 0.7);
          const y = Y(v), from = pane.zeroBase ? Math.min(zero, base) : zero;
          g.fillRect(Math.round(this.xOf(i) - bw / 2), Math.min(y, from), bw, Math.max(1, Math.abs(from - y)));
        }
        continue;
      }
      if (o.style === 'dots') {
        g.fillStyle = col;
        for (let i = i0; i <= i1; i++) { const v = a[i]; if (v === v) g.fillRect(Math.round(this.xOf(i)) - 1, Math.round(Y(v)) - 1, 2.5, 2.5); }
        continue;
      }
      const dir = o.colorBy === 'dir' ? out.dir : null;
      g.lineWidth = 1.4;
      let open = false, curCol = null;
      for (let i = i0; i <= i1; i++) {
        const v = a[i];
        if (v !== v) { if (open) { g.stroke(); open = false; } continue; }
        const c = dir ? (dir[i] >= 0 ? th.up : th.down) : col, x = this.xOf(i), y = Y(v);
        const jump = o.style === 'step' && i > i0 && a[i - 1] === a[i - 1] && a[i - 1] !== v;
        if (!open || c !== curCol || jump) {
          if (open) { if (!jump) g.lineTo(x, y); g.stroke(); }
          g.beginPath(); g.strokeStyle = c; curCol = c; g.moveTo(x, y); open = true;
        } else g.lineTo(x, y);
      }
      if (open) g.stroke();
      g.lineWidth = 1;
    }
  }

  drawPane(p, b, i0, i1) {
    const g = this.g, th = this.th, L = this.L, ind = p.ind, def = ind.def;
    g.strokeStyle = th.line; g.beginPath(); g.moveTo(0, p.y + 0.5); g.lineTo(this.w, p.y + 0.5); g.stroke();
    let lo = Infinity, hi = -Infinity;
    if (def.range) { lo = def.range[0]; hi = def.range[1]; }
    else {
      for (const o of def.outputs) { if (o.hidden) continue; const a = ind.out[o.k]; if (!a) continue; for (let i = i0; i <= i1; i++) { const v = a[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } } }
      const allHist = def.outputs.some((o) => o.style === 'hist');
      if (allHist) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      for (const lv of def.levels || []) { if (lv < lo && lo - lv < (hi - lo)) lo = lv; if (lv > hi && lv - hi < (hi - lo)) hi = lv; }
    }
    if (!(hi > lo)) { hi = (hi === hi && hi !== -Infinity ? hi : 0) + 1; lo = hi - 2; }
    const pad = def.range ? 0 : (hi - lo) * 0.1, top = p.y + 16, hh = p.h - 22, slo = lo - (lo < 0 || !def.outputs.some((o) => o.style === 'hist') ? pad : 0), shi = hi + pad;
    const Y = (v) => top + (1 - (v - slo) / (shi - slo)) * hh;
    p.Y = Y; p.inv = (y) => slo + (1 - (y - top) / hh) * (shi - slo);
    const fmt = def.fmt === 'vol' ? fmtVol : (v) => fmtNum(v, Math.abs(shi - slo) < 4 ? 2 : Math.abs(shi - slo) < 40 ? 1 : 0);
    p.fmt = fmt;
    g.save(); g.beginPath(); g.rect(0, p.y + 1, L.pw, p.h - 1); g.clip();
    g.setLineDash([3, 4]); g.strokeStyle = rgba(th.muted, 0.55); g.beginPath();
    for (const lv of def.levels || []) { const y = Math.round(Y(lv)) + 0.5; g.moveTo(0, y); g.lineTo(L.pw, y); }
    g.stroke(); g.setLineDash([]);
    this.drawInd(ind, i0, i1, Y, { y: p.y, h: p.h }, this.bars);
    g.restore();
    g.fillStyle = th.muted; g.textAlign = 'left';
    const ticks = def.levels && def.levels.length ? def.levels : [slo + (shi - slo) * 0.25, slo + (shi - slo) * 0.75];
    for (const v of ticks) { const y = Y(v); if (y > p.y + 8 && y < p.y + p.h - 6) g.fillText(fmt(v), L.pw + 7, y); }
  }

  timeTicks(b, i0, i1) {
    const L = this.L, intr = isIntraday(b.tf), tf = b.tf, c = [];
    for (let i = Math.max(i0, 0); i <= i1; i++) {
      const d = new Date(b.t[i] * 1000), pd = i > 0 ? new Date(b.t[i - 1] * 1000) : null;
      let rank = -1, label = '';
      if (!pd || d.getUTCFullYear() !== pd.getUTCFullYear()) { rank = 4; label = String(d.getUTCFullYear()); }
      else if (d.getUTCMonth() !== pd.getUTCMonth()) { rank = 3; label = MON[d.getUTCMonth()]; }
      else if (intr && d.getUTCDate() !== pd.getUTCDate()) { rank = 2; label = String(d.getUTCDate()); }
      else if (!intr && tf !== '1mo') { rank = 1; label = String(d.getUTCDate()); }
      else if (intr && d.getUTCMinutes() === 0) { rank = d.getUTCHours() % 2 === 0 ? 1 : 0; label = `${d.getUTCHours()}:00`; }
      if (rank >= 0) c.push({ x: this.xOf(i), rank, label });
    }
    c.sort((a, z) => z.rank - a.rank || a.x - z.x);
    const placed = [];
    for (const k of c) {
      if (k.x < 16 || k.x > L.pw - 16) continue;
      if (placed.some((q) => Math.abs(q.x - k.x) < 54)) continue;
      placed.push(k);
    }
    return placed;
  }

  drawTimeAxis() {
    const g = this.g, th = this.th, y = this.h - TH;
    g.fillStyle = th.bg; g.fillRect(0, y, this.w, TH);
    g.strokeStyle = th.line; g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(this.w, y + 0.5); g.stroke();
    g.textAlign = 'center';
    for (const k of this.tticks) { g.fillStyle = k.rank >= 3 ? th.text : th.muted; g.fillText(k.label, k.x, y + TH / 2 + 1); }
    g.textAlign = 'left';
  }

  hoverIndex() {
    if (!this.bars) return null;
    if (!this.mouse) { if (this.ghostT == null) return null; const g = Math.floor(this.tToIdx(this.ghostT) + 1e-9); return g >= 0 && g < this.bars.t.length ? g : null; }
    const i = Math.round(this.idxOf(this.mouse.x));
    return i >= 0 && i < this.bars.t.length ? i : null;
  }
  // Snap a point to the nearest bar and, when close, to that bar's open/high/low/close. Alt = free.
  snapPt(x, y, e) {
    const pt = this.xyPt(x, y), b = this.bars, i = Math.round(this.idxOf(x));
    if ((e && e.altKey) || i < 0 || i >= b.t.length) return pt;
    let best = null, bd = 10;
    for (const p of [b.o[i], b.h[i], b.l[i], b.c[i]]) { const d = Math.abs(this.yOf(p) - y); if (d < bd) { bd = d; best = p; } }
    return best == null ? pt : { t: b.t[i], p: best };
  }

  drawCrosshair(b) {
    const m = this.mouse, g = this.g, th = this.th, L = this.L;
    if (!m) {
      const gi = this.hoverIndex(); if (gi == null) return;
      const gx = Math.round(this.xOf(gi)) + 0.5; if (gx < 0 || gx > L.pw) return;
      g.save(); g.setLineDash([4, 4]); g.strokeStyle = rgba(th.accent, 0.7); g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, this.h - TH); g.stroke(); g.restore();
      return;
    }
    if (m.x > L.pw || m.y > this.h - TH) return;
    const i = clamp(Math.round(this.idxOf(m.x)), 0, b.t.length - 1), x = Math.round(this.xOf(i)) + 0.5, y = Math.round(m.y) + 0.5;
    g.save(); g.setLineDash([4, 4]); g.strokeStyle = rgba(th.muted, 0.8); g.beginPath();
    g.moveTo(x, 0); g.lineTo(x, this.h - TH); g.moveTo(0, y); g.lineTo(L.pw, y); g.stroke(); g.restore();
    let txt = null;
    if (m.y < L.main.h) txt = fmtPrice(this.priceOf(m.y));
    else { const p = L.panes.find((q) => m.y >= q.y && m.y < q.y + q.h); if (p && p.inv) txt = p.fmt(p.inv(m.y)); }
    if (txt) this.axisTag(m.y, txt, th.line, th.text);
    const label = fmtStamp(b.t[i], isIntraday(b.tf)), tw = g.measureText(label).width + 14, lx = clamp(x - tw / 2, 0, L.pw - tw);
    g.fillStyle = th.line; g.fillRect(lx, this.h - TH + 1, tw, TH - 2);
    g.fillStyle = th.text; g.textAlign = 'left'; g.fillText(label, lx + 7, this.h - TH / 2 + 1);
  }

  // ── automated analysis layers ──
  drawAutoUnder(i0, i1) {
    const g = this.g, th = this.th, L = this.L, a = this.auto;
    let lastLabelY = -99;
    for (const z of a.levels || []) {
      const y1 = this.yOf(z.hi), y2 = this.yOf(z.lo), col = z.kind === 'sup' ? th.up : th.down;
      g.fillStyle = rgba(col, Math.min(0.2, 0.06 + z.touches * 0.018)); g.fillRect(0, y1, L.pw, Math.max(2, y2 - y1));
      if (Math.abs(y1 - lastLabelY) > 16) {
        g.fillStyle = rgba(col, 0.95); g.textAlign = 'right';
        g.fillText(`${z.kind === 'sup' ? 'Support' : 'Resistance'} ${fmtPrice(z.price)} · ${z.touches} touches`, L.pw - 8, y1 - 7); g.textAlign = 'left';
        lastLabelY = y1;
      }
    }
    for (const gp of a.gaps || []) {
      const x = this.xOf(gp.i), y1 = this.yOf(gp.top), y2 = this.yOf(gp.bottom);
      g.fillStyle = rgba(th.accent, 0.1); g.fillRect(x, y1, L.pw - x, Math.max(1, y2 - y1));
      g.fillStyle = rgba(th.accent, 0.9); g.fillText('Gap', x + 4, (y1 + y2) / 2);
    }
    if (a.fib) {
      const x0 = Math.min(this.xOf(a.fib.from.i), this.xOf(a.fib.to.i));
      g.save(); g.setLineDash([5, 3]); g.strokeStyle = rgba(th.accent, 0.5); g.beginPath();
      g.moveTo(this.xOf(a.fib.from.i), this.yOf(a.fib.from.p)); g.lineTo(this.xOf(a.fib.to.i), this.yOf(a.fib.to.p)); g.stroke(); g.restore();
      for (const lv of a.fib.levels) {
        if (lv.r > 1) continue;
        const y = Math.round(this.yOf(lv.p)) + 0.5;
        g.strokeStyle = rgba(th.accent, lv.r === 0.5 || lv.r === 0.618 ? 0.75 : 0.4); g.beginPath(); g.moveTo(x0, y); g.lineTo(L.pw, y); g.stroke();
        g.fillStyle = rgba(th.accent, 0.95); g.fillText(`${(lv.r * 100).toFixed(1)}%  ${fmtPrice(lv.p)}`, x0 < 0 ? L.pw * 0.44 : x0 + 4, y - 7);
      }
    }
  }

  drawAutoOver(b, i0, i1) {
    const g = this.g, th = this.th, L = this.L, a = this.auto;
    for (const ln of a.trendlines || []) {
      const col = ln.kind === 'sup' ? th.up : th.down, iR = this.view.right + 2;
      g.save(); g.strokeStyle = col; g.lineWidth = 1.6; if (ln.broken) g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(this.xOf(ln.i1), this.yOf(Math.max(1e-9, ln.p1))); g.lineTo(this.xOf(iR), this.yOf(Math.max(1e-9, ln.valueAt(iR)))); g.stroke(); g.restore();
      g.fillStyle = col;
      for (const ti of ln.touches) { g.beginPath(); g.arc(this.xOf(ti), this.yOf(ln.valueAt(ti)), 3, 0, 6.3); g.fill(); }
    }
    for (const p of a.patterns || []) {
      const col = th.accent;
      g.save(); g.strokeStyle = col; g.lineWidth = 1.6;
      if (p.points && p.points.length) { g.beginPath(); p.points.forEach((q, k) => { const x = this.xOf(q.i), y = this.yOf(q.p); if (k) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
      g.setLineDash([6, 4]);
      for (const ln of p.lines || []) { g.beginPath(); g.moveTo(this.xOf(ln[0].i), this.yOf(ln[0].p)); g.lineTo(this.xOf(ln[1].i), this.yOf(ln[1].p)); g.stroke(); }
      g.restore();
      const at = p.labelAt || (p.points && p.points[Math.floor(p.points.length / 2)]);
      if (at) { g.fillStyle = col; g.font = '600 11px system-ui, sans-serif'; g.fillText(p.name + (p.confirmed ? ' ✓' : ''), this.xOf(at.i) + 6, this.yOf(at.p) - (p.bias < 0 ? 12 : -14)); g.font = '11px system-ui, -apple-system, sans-serif'; }
    }
    if (a.candles && this.view.barW >= 3) {
      for (const c of a.candles) {
        if (c.i < i0 || c.i > i1) continue;
        const x = this.xOf(c.i), up = c.bias > 0, y = up ? this.yOf(b.l[c.i]) + 9 : this.yOf(b.h[c.i]) - 9, s = 4;
        g.fillStyle = c.bias > 0 ? th.up : c.bias < 0 ? th.down : th.muted;
        g.beginPath();
        if (up) { g.moveTo(x, y - s); g.lineTo(x - s, y + s); g.lineTo(x + s, y + s); } else { g.moveTo(x, y + s); g.lineTo(x - s, y - s); g.lineTo(x + s, y - s); }
        g.closePath(); g.fill();
      }
    }
  }

  drawTrades() {
    const g = this.g, th = this.th;
    for (const t of this.trades) {
      const x1 = this.xOf(this.tToIdx(t.entryT)), y1 = this.yOf(t.entryP), x2 = this.xOf(this.tToIdx(t.exitT)), y2 = this.yOf(t.exitP);
      if (x2 < -20 || x1 > this.L.pw + 20) continue;
      const win = t.pnlPct >= 0, long = t.side !== 'short';
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = rgba(win ? th.up : th.down, 0.9); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.restore();
      g.fillStyle = long ? th.up : th.down; g.beginPath();
      if (long) { g.moveTo(x1, y1 + 4); g.lineTo(x1 - 5, y1 + 13); g.lineTo(x1 + 5, y1 + 13); } else { g.moveTo(x1, y1 - 4); g.lineTo(x1 - 5, y1 - 13); g.lineTo(x1 + 5, y1 - 13); }
      g.closePath(); g.fill();
      g.strokeStyle = th.text; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x2 - 4, y2 - 4); g.lineTo(x2 + 4, y2 + 4); g.moveTo(x2 + 4, y2 - 4); g.lineTo(x2 - 4, y2 + 4); g.stroke(); g.lineWidth = 1;
    }
  }

  // ── user drawings ──
  drawDrawing(d, selected) {
    const g = this.g, th = this.th, L = this.L, col = d.color || '#5aa9e6';
    g.save(); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = selected ? 2 : 1.5;
    const P = d.pts.map((p) => this.ptXY(p));
    const handles = () => { if (!selected) return; g.fillStyle = th.bg; g.strokeStyle = col; g.lineWidth = 1.5; for (const [x, y] of P) { g.beginPath(); g.arc(x, y, 4, 0, 6.3); g.fill(); g.stroke(); } };
    if (d.type === 'trend' || d.type === 'ray') {
      let [x1, y1] = P[0], [x2, y2] = P[1];
      g.beginPath(); g.moveTo(x1, y1);
      if (d.type === 'ray' && x2 !== x1) { const k = (L.pw + 50 - x1) / (x2 - x1); if (k > 1) { x2 = x1 + (x2 - x1) * k; y2 = y1 + (y2 - y1) * k; } }
      g.lineTo(x2, y2); g.stroke(); handles();
    } else if (d.type === 'hline') {
      const y = Math.round(P[0][1]) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(L.pw, y); g.stroke();
      g.fillText(fmtPrice(d.pts[0].p), 6, y - 8);
    } else if (d.type === 'rect') {
      const x = Math.min(P[0][0], P[1][0]), y = Math.min(P[0][1], P[1][1]), w = Math.abs(P[1][0] - P[0][0]), hh = Math.abs(P[1][1] - P[0][1]);
      g.fillStyle = rgba(col, 0.12); g.fillRect(x, y, w, hh); g.strokeRect(x + 0.5, y + 0.5, w, hh); handles();
    } else if (d.type === 'fib') {
      const x0 = Math.min(P[0][0], P[1][0]), p0 = d.pts[0].p, p1 = d.pts[1].p;
      g.save(); g.setLineDash([4, 4]); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(P[0][0], P[0][1]); g.lineTo(P[1][0], P[1][1]); g.stroke(); g.restore();
      for (const r of FIB_DRAW) {
        const p = p1 + (p0 - p1) * r, y = Math.round(this.yOf(p)) + 0.5;
        g.globalAlpha = r === 0.5 || r === 0.618 ? 1 : 0.6; g.beginPath(); g.moveTo(x0, y); g.lineTo(L.pw, y); g.stroke();
        g.fillText(`${(r * 100).toFixed(1)}%  ${fmtPrice(p)}`, x0 + 4, y - 7);
      }
      g.globalAlpha = 1; handles();
    } else if (d.type === 'text') {
      g.font = '12px system-ui, sans-serif'; g.fillText(d.text || 'Note', P[0][0] + 6, P[0][1]);
      g.beginPath(); g.arc(P[0][0], P[0][1], 2.5, 0, 6.3); g.fill();
    } else if (d.type === 'measure') {
      const [x1, y1] = P[0], [x2, y2] = P[1], dp = d.pts[1].p - d.pts[0].p, pct = (dp / d.pts[0].p) * 100;
      const barsN = Math.round(this.tToIdx(d.pts[1].t) - this.tToIdx(d.pts[0].t)), c2 = dp >= 0 ? th.up : th.down;
      g.fillStyle = rgba(c2, 0.14); g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      const txt = `${dp >= 0 ? '+' : ''}${fmtPrice(dp)}  (${fmtPct(pct)})  ·  ${barsN} bars`, tw = g.measureText(txt).width + 12;
      const bx = clamp((x1 + x2) / 2 - tw / 2, 2, L.pw - tw - 2), by = Math.min(y1, y2) - 22;
      g.fillStyle = c2; g.fillRect(bx, Math.max(2, by), tw, 18); g.fillStyle = '#0b0e12'; g.fillText(txt, bx + 6, Math.max(2, by) + 9);
    }
    g.restore();
  }

  hitTest(x, y) {
    const near = (px, py) => Math.hypot(px - x, py - y) <= 7;
    const seg = (x1, y1, x2, y2) => { const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy; const t = l2 ? clamp(((x - x1) * dx + (y - y1) * dy) / l2, 0, 1) : 0; return Math.hypot(x1 + t * dx - x, y1 + t * dy - y); };
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k], P = d.pts.map((p) => this.ptXY(p));
      for (let j = 0; j < P.length; j++) if (near(P[j][0], P[j][1]) && d.type !== 'hline' && d.type !== 'text') return { d, part: j };
      let hit = false;
      if (d.type === 'trend') hit = seg(P[0][0], P[0][1], P[1][0], P[1][1]) <= 5;
      else if (d.type === 'ray') { const kx = P[1][0] !== P[0][0] ? Math.max(1, (this.L.pw + 50 - P[0][0]) / (P[1][0] - P[0][0])) : 1; hit = seg(P[0][0], P[0][1], P[0][0] + (P[1][0] - P[0][0]) * kx, P[0][1] + (P[1][1] - P[0][1]) * kx) <= 5; }
      else if (d.type === 'hline') hit = Math.abs(P[0][1] - y) <= 5;
      else if (d.type === 'rect') hit = x >= Math.min(P[0][0], P[1][0]) - 3 && x <= Math.max(P[0][0], P[1][0]) + 3 && y >= Math.min(P[0][1], P[1][1]) - 3 && y <= Math.max(P[0][1], P[1][1]) + 3;
      else if (d.type === 'fib') { const x0 = Math.min(P[0][0], P[1][0]); hit = x >= x0 && FIB_DRAW.some((r) => Math.abs(this.yOf(d.pts[1].p + (d.pts[0].p - d.pts[1].p) * r) - y) <= 4); }
      else if (d.type === 'text') hit = x >= P[0][0] - 6 && x <= P[0][0] + 14 + (d.text || 'Note').length * 7 && Math.abs(P[0][1] - y) <= 9;
      if (hit) return { d, part: 'body' };
    }
    return null;
  }
  changed() { if (this.cb.onDrawings) this.cb.onDrawings(this.drawings); this.invalidate(); }
  deleteSelected() { if (!this.sel) return false; this.drawings = this.drawings.filter((d) => d !== this.sel); this.sel = null; this.changed(); return true; }
  // value of a drawn line at the latest bar (for line alerts)
  lineValueAt(d, t) { if (d.type === 'hline') return d.pts[0].p; const i1 = this.tToIdx(d.pts[0].t), i2 = this.tToIdx(d.pts[1].t), i = this.tToIdx(t); return i2 === i1 ? d.pts[0].p : d.pts[0].p + ((d.pts[1].p - d.pts[0].p) * (i - i1)) / (i2 - i1); }

  // ── interaction ──
  bind() {
    const el = this.el, pos = (e) => { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    el.addEventListener('wheel', (e) => {
      if (!this.bars) return; e.preventDefault();
      const m = pos(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) { this.view.right += ((e.deltaX || e.deltaY) / this.view.barW) * 0.6; }
      else { const idx = this.idxOf(m.x), nb = clamp(this.view.barW * Math.exp(-e.deltaY * 0.0018), 1.2, 60); this.view.barW = nb; this.view.right = idx + (this.L.pw - m.x) / nb; }
      this.clampView(); this.invalidate();
    }, { passive: false });
    el.addEventListener('mousedown', (e) => {
      if (!this.bars || e.button !== 0) return;
      if (e.target.closest && e.target.closest('.legend, .pane-legends')) return;
      if (this.cb.onFocus) this.cb.onFocus();
      const m = pos(e); this.measure = null;
      if (m.x > this.L.pw && m.y < this.L.main.h) { this.drag = { kind: 'yzoom', y: m.y, s: this.view.yScale }; return; }
      if (m.x > this.L.pw || m.y > this.L.main.h) { this.drag = { kind: 'pan', x: m.x, right: this.view.right }; return; }
      if (this.draft && this.draft.mode === 'click') { this.draft.pts[1] = this.snapPt(m.x, m.y, e); this.finishDraft(); return; }
      if (this.tool === 'cursor') {
        const hit = this.hitTest(m.x, m.y);
        if (hit) { this.sel = hit.d; this.drag = { kind: 'draw', part: hit.part, x: m.x, y: m.y, orig: hit.d.pts.map((p) => ({ ...p })), moved: false }; }
        else { this.sel = null; this.drag = { kind: 'pan', x: m.x, right: this.view.right }; }
        this.invalidate(); return;
      }
      const pt = this.snapPt(m.x, m.y, e);
      if (this.tool === 'hline') { this.addDrawing({ type: 'hline', pts: [pt] }); return; }
      if (this.tool === 'text') { const d = this.addDrawing({ type: 'text', pts: [pt], text: 'Note' }); if (this.cb.onText) this.cb.onText(d); return; }
      if (TWO_POINT.has(this.tool)) { this.draft = { id: uid(), type: this.tool, pts: [pt, { ...pt }], mode: 'drag', x: m.x, y: m.y }; this.invalidate(); }
    });
    this.onMove = (e) => {
      if (!this.bars) return;
      const m = pos(e), inside = m.x >= 0 && m.y >= 0 && m.x <= this.w && m.y <= this.h;
      if (this.drag && this.drag.kind === 'pan') { this.view.right = this.drag.right - (m.x - this.drag.x) / this.view.barW; this.clampView(); }
      else if (this.drag && this.drag.kind === 'yzoom') this.view.yScale = clamp(this.drag.s * Math.exp((m.y - this.drag.y) * 0.006), 0.15, 10);
      else if (this.drag && this.drag.kind === 'draw') {
        const dg = this.drag, d = this.sel; dg.moved = true;
        if (dg.part === 'body') {
          const di = (m.x - dg.x) / this.view.barW;
          d.pts = dg.orig.map((p) => { const y = this.yOf(p.p) + (m.y - dg.y); return { t: this.idxToT(this.tToIdx(p.t) + di), p: this.priceOf(y) }; });
        } else d.pts[dg.part] = this.snapPt(m.x, m.y, e);
      } else if (this.draft) this.draft.pts[1] = this.snapPt(m.x, m.y, e);
      const was = this.mouse;
      this.mouse = inside && !(e.target.closest && e.target.closest('.legend button')) ? m : null;
      if (this.cb.onHover) { const hi = this.mouse && this.mouse.x <= this.L.pw ? this.hoverIndex() : null, ht = hi == null ? null : this.bars.t[hi]; if (ht !== this.lastHoverT) { this.lastHoverT = ht; this.cb.onHover(ht); } }
      if (this.mouse || was || this.drag) this.invalidate();
    };
    this.onUp = (e) => {
      if (this.drag) { if (this.drag.kind === 'draw' && this.drag.moved) this.changed(); this.drag = null; }
      if (this.draft && this.draft.mode === 'drag') {
        const m = pos(e);
        if (Math.hypot(m.x - this.draft.x, m.y - this.draft.y) < 4) this.draft.mode = 'click'; else this.finishDraft();
      }
    };
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    el.addEventListener('mouseleave', () => { if (!this.drag) { this.mouse = null; if (this.cb.onHover && this.lastHoverT != null) { this.lastHoverT = null; this.cb.onHover(null); } this.invalidate(); } });
    el.addEventListener('dblclick', (e) => {
      const m = pos(e);
      if (m.x > this.L.pw) { this.view.yScale = 1; this.invalidate(); return; }
      const hit = this.hitTest(m.x, m.y);
      if (hit && hit.d.type === 'text' && this.cb.onText) this.cb.onText(hit.d); else if (!hit) this.resetView();
    });
    el.addEventListener('contextmenu', (e) => {
      if (!this.bars) return; e.preventDefault();
      const m = pos(e); if (m.x > this.L.pw || m.y > this.L.main.h) return;
      const hit = this.hitTest(m.x, m.y); if (hit) { this.sel = hit.d; this.invalidate(); }
      const bi = clamp(Math.round(this.idxOf(m.x)), 0, this.bars.t.length - 1);
      if (this.cb.onContext) this.cb.onContext({ x: e.clientX, y: e.clientY, price: this.priceOf(m.y), t: this.idxToT(this.idxOf(m.x)), barT: this.bars.t[bi], drawing: hit ? hit.d : null });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') { if (this.deleteSelected()) e.preventDefault(); }
      else if (e.key === 'Escape') { this.draft = null; this.measure = null; this.sel = null; if (this.cb.onTool) this.cb.onTool('cursor'); this.invalidate(); }
      else if (this.bars && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { this.view.right += (e.key === 'ArrowLeft' ? -1 : 1) * Math.max(1, (this.L.pw / this.view.barW) * 0.1); this.clampView(); this.invalidate(); e.preventDefault(); }
      else if (this.bars && (e.key === '+' || e.key === '=' || e.key === '-')) { this.view.barW = clamp(this.view.barW * (e.key === '-' ? 0.8 : 1.25), 1.2, 60); this.clampView(); this.invalidate(); }
    });
  }
  clampView() { const n = this.bars.t.length, vis = this.L.pw / this.view.barW; this.view.right = clamp(this.view.right, Math.min(n - 1, 5), n - 1 + vis * 0.8); }
  addDrawing(d) { d.id = d.id || uid(); this.drawings.push(d); this.sel = d; this.changed(); if (this.cb.onTool) this.cb.onTool('cursor'); return d; }
  finishDraft() {
    const d = this.draft; this.draft = null; if (!d) return;
    const clean = { id: d.id, type: d.type, pts: d.pts };
    if (d.type === 'measure') { this.measure = clean; if (this.cb.onTool) this.cb.onTool('cursor'); this.invalidate(); return; }
    this.addDrawing(clean);
  }

  // ── legends (DOM, so indicator rows are clickable) ──
  buildLegend() {
    clear(this.legend); clear(this.paneLegends); this.lgI = -1;
    if (!this.bars) return;
    const b = this.bars;
    this.lgO = h('span', { class: 'lg-ohlc' });
    this.legend.append(h('div', { class: 'lg-title' }, h('b', null, b.symbol), h('span', { class: 'lg-tf' }, tfLabel(b.tf)), h('span', { class: 'lg-name' }, b.meta.name || ''), b.adjusted ? h('span', { class: 'lg-adj', title: 'Prices include reinvested dividends' }, 'adj') : null, b.stale ? h('span', { class: 'lg-stale', title: 'The data provider did not answer; showing the last saved copy.' }, 'stale') : null), this.lgO);
    this.lgRows = [];
    const row = (ind) => {
      const vals = h('span', { class: 'lg-vals' });
      const el = h('div', { class: 'lg-row' + (ind.hidden ? ' off' : '') },
        h('span', { class: 'lg-label', title: ind.out && ind.out.__error ? ind.out.__error : ind.def.name }, ind.label + (ind.tf ? ` · ${tfLabel(ind.tf)}` : '')), vals,
        h('span', { class: 'lg-btns' },
          h('button', { title: ind.hidden ? 'Show' : 'Hide', onclick: () => this.cb.onLegend && this.cb.onLegend('toggle', ind.uid) }, ind.hidden ? '○' : '●'),
          h('button', { title: 'Settings', onclick: () => this.cb.onLegend && this.cb.onLegend('settings', ind.uid) }, '⚙'),
          h('button', { title: 'Remove', onclick: () => this.cb.onLegend && this.cb.onLegend('remove', ind.uid) }, '✕')));
      if (ind.out && ind.out.__error) el.classList.add('err');
      this.lgRows.push({ ind, vals });
      return el;
    };
    for (const ind of this.inds) if (ind.def.overlay || ind.hidden || (ind.out && ind.out.__error)) this.legend.append(row(ind));
    this.paneRows = [];
    for (const ind of this.inds) if (!ind.def.overlay && !ind.hidden && ind.out && !ind.out.__error) { const el = h('div', { class: 'legend pane' }, row(ind)); this.paneRows.push(el); this.paneLegends.append(el); }
  }
  positionLegends() { const L = this.L; if (!L || !this.paneRows) return; L.panes.forEach((p, k) => { if (this.paneRows[k]) this.paneRows[k].style.top = p.y + 2 + 'px'; }); }
  updateLegend() {
    if (!this.bars || !this.lgO) return;
    const b = this.bars, n = b.t.length, hi = this.hoverIndex(), i = hi == null ? n - 1 : hi;
    if (i === this.lgI && n === this.lgN && this.lgInds === this.inds) return;
    this.lgI = i; this.lgN = n; this.lgInds = this.inds;
    const prev = i > 0 ? b.c[i - 1] : b.o[i], ch = b.c[i] - prev, pct = (ch / prev) * 100, cls = ch >= 0 ? 'up' : 'dn';
    const pat = (this.auto.candles || []).find((c) => c.i === i);
    this.lgO.innerHTML = `O <i class="${cls}">${fmtPrice(b.o[i])}</i> H <i class="${cls}">${fmtPrice(b.h[i])}</i> L <i class="${cls}">${fmtPrice(b.l[i])}</i> C <i class="${cls}">${fmtPrice(b.c[i])}</i> <i class="${cls}">${ch >= 0 ? '+' : ''}${fmtPrice(ch)} (${fmtPct(pct)})</i> Vol <i>${fmtVol(b.v[i])}</i>${pat ? ` <i class="${pat.bias > 0 ? 'up' : pat.bias < 0 ? 'dn' : ''}">▸ ${pat.name}</i>` : ''}`;
    for (const r of this.lgRows) {
      const ind = r.ind; if (!ind.out || ind.out.__error) { r.vals.textContent = ind.out ? 'error' : ''; continue; }
      const f = ind.def.fmt === 'vol' ? fmtVol : (v) => (ind.def.overlay ? fmtPrice(v) : fmtNum(v, 2));
      r.vals.innerHTML = ind.def.outputs.filter((o) => !o.hidden).map((o) => { const v = ind.out[o.k] ? ind.out[o.k][i] : NaN; return `<i style="color:${ind.colors[o.k] || ''}">${v === v ? f(v) : '–'}</i>`; }).join(' ');
    }
  }
}

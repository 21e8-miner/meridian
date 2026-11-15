// Small DOM + formatting helpers shared by every view.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Like el.append, but skips null/false so callers can write `cond ? node : null`.
export const add = (el, ...kids) => { for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k))); return el; };
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Math.random().toString(36).slice(2, 10);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function fmtPrice(p) {
  if (p == null || p !== p) return '–';
  const a = Math.abs(p);
  const d = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtNum(x, d = 2) {
  if (x == null || x !== x) return '–';
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtVol(v) {
  if (v == null || v !== v) return '–';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}
export function fmtPct(x, d = 2) {
  if (x == null || x !== x) return '–';
  return (x > 0 ? '+' : '') + x.toFixed(d) + '%';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => (n < 10 ? '0' : '') + n;
// Bar times are exchange wall-clock seconds encoded as UTC, so UTC getters give local time.
export function fmtDate(t) { const d = new Date(t * 1000); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; }
export function fmtTime(t) { const d = new Date(t * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; }
export function fmtStamp(t, intraday) { return intraday ? `${fmtDate(t)} ${fmtTime(t)}` : fmtDate(t); }
export function fmtIso(t) { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; }
export function fmtIsoTime(t) { const d = new Date(t * 1000); return `${fmtIso(t)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; }
export { MON };

// Offer text as a file download (CSV exports, workspace backup).
export function downloadText(name, text, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mime })), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Validate a workspace backup and return its [key, value] pairs. Throws with a reason if it is not one.
export function parseWorkspace(text, prefix = 'meridian.') {
  const j = JSON.parse(text);
  if (!j || j.app !== 'meridian' || typeof j.data !== 'object' || !j.data) throw new Error('not a Meridian workspace file');
  const entries = Object.entries(j.data).filter(([k, v]) => k.startsWith(prefix) && typeof v === 'string');
  for (const [k, v] of entries) { try { JSON.parse(v); } catch { throw new Error(`item “${k}” is damaged`); } }
  if (!entries.length) throw new Error('the file holds no saved items');
  return entries;
}
export function toCsv(rows) { return rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n') + '\n'; }

const NS = 'meridian.';
export const store = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const listeners = new Map();
export const bus = {
  on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
  emit(ev, data) { for (const fn of listeners.get(ev) || []) { try { fn(data); } catch (e) { console.error(e); } } },
};

export function toast(msg, kind = 'info', ms = 5000) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const el = h('div', { class: 'toast ' + kind }, msg);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

// Modal dialog. Returns { el, close }.
export function modal(title, body, { wide = false, onClose } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h3', null, title), h('button', { class: 'icon-btn', onclick: close, title: 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, body)));
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  return { el: back, close };
}

export function menu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const el = h('div', { class: 'ctx-menu' }, items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'sep' }) :
    h('button', { onclick: () => { el.remove(); it.fn(); } }, it.label)));
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const off = (e) => { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  return el;
}

// Draws a simple line chart on a canvas: series = [{values, color, fill?}], shared x.
export function lineChart(canvas, series, { yFmt = (v) => fmtNum(v, 0), xLabels = null, zero = false, height = 220 } = {}) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 600, hh = height;
  canvas.width = w * dpr; canvas.height = hh * dpr; canvas.style.height = hh + 'px';
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
  const cs = getComputedStyle(document.documentElement), muted = cs.getPropertyValue('--muted').trim(), grid = cs.getPropertyValue('--line').trim();
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const s of series) { n = Math.max(n, s.values.length); for (const v of s.values) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = (hi - lo) * 0.06; if (!(zero && lo === 0)) lo -= pad; if (!(zero && hi === 0)) hi += pad;
  const L = 8, R = 64, T = 8, B = 20, pw = w - L - R, ph = hh - T - B;
  const X = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * pw), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * ph;
  g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillStyle = muted; g.strokeStyle = grid; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4, y = Math.round(Y(v)) + 0.5;
    g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke();
    g.fillText(yFmt(v), L + pw + 6, y);
  }
  if (xLabels) {
    g.textBaseline = 'alphabetic';
    const step = Math.max(1, Math.floor(n / 6));
    for (let i = 0; i < n; i += step) g.fillText(xLabels(i), Math.min(X(i), L + pw - 40), hh - 5);
  }
  for (const s of series) {
    g.beginPath(); let started = false;
    for (let i = 0; i < s.values.length; i++) { const v = s.values[i]; if (v !== v) continue; if (!started) { g.moveTo(X(i), Y(v)); started = true; } else g.lineTo(X(i), Y(v)); }
    g.strokeStyle = s.color; g.lineWidth = s.width || 1.5; g.stroke();
    if (s.fill && started) { g.lineTo(X(s.values.length - 1), Y(zero ? 0 : lo)); g.lineTo(X(0), Y(zero ? 0 : lo)); g.closePath(); g.globalAlpha = 0.12; g.fillStyle = s.color; g.fill(); g.globalAlpha = 1; }
  }
}

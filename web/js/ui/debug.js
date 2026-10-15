// Debug view: raw-vs-shown charts and the packet log.
import { parseRowerData, parseMachineStatus, bytesToHex } from '../protocol/ftms.js';

const HISTORY_S = 180;
const LOG_LINES = 60;

export class DebugView {
  constructor() {
    this.points = []; // {t, rawPace, pace, rawPower, power}
    this.lines = [];
    this.paceCanvas = document.getElementById('chart-pace');
    this.powerCanvas = document.getElementById('chart-power');
    this.logEl = document.getElementById('pkt-log');
    this.countEl = document.getElementById('pkt-count');
    this.dirty = false;
  }

  reset() {
    this.points = [];
    this.lines = [];
    this.dirty = true;
  }

  onPacket(pkt, recorded) {
    let text = '';
    if (pkt.char === 'rower') {
      const p = parseRowerData(pkt.bytes);
      text = Object.entries(p.fields).map(([k, v]) => `${k}=${v}`).join(' ');
    } else if (pkt.char === 'status') {
      text = parseMachineStatus(pkt.bytes).event;
    }
    this.lines.push(`${pkt.t.toFixed(2).padStart(8)}  ${pkt.char.padEnd(8)} ${bytesToHex(pkt.bytes).padEnd(30)} ${text}`);
    if (this.lines.length > LOG_LINES) this.lines.shift();
    this.recorded = recorded;
    this.dirty = true;
  }

  onSample(t, view) {
    const raw = view.raw ?? {};
    this.points.push({
      t,
      rawPace: raw.pace > 0 && raw.pace < 3600 ? raw.pace : null,
      pace: view.pace,
      rawPower: raw.power || null,
      power: view.power,
    });
    while (this.points.length && this.points[0].t < t - HISTORY_S) this.points.shift();
    this.dirty = true;
  }

  render(visible) {
    if (!visible || !this.dirty) return;
    this.dirty = false;
    this.logEl.textContent = this.lines.join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
    this.countEl.textContent = `${this.recorded ?? 0} recorded`;
    // pace axis is inverted: faster (lower) at the top
    drawChart(this.paceCanvas, this.points, 'rawPace', 'pace', { invert: true, fmt: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}` });
    drawChart(this.powerCanvas, this.points, 'rawPower', 'power', { fmt: (v) => `${Math.round(v)} W` });
  }
}

function drawChart(canvas, pts, rawKey, key, { invert = false, fmt }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const vals = pts.flatMap((p) => [p[rawKey], p[key]]).filter((v) => v != null);
  if (vals.length < 2) return;
  const sorted = [...vals].sort((a, b) => a - b);
  // clip to the 2nd-98th percentile so one wild raw value doesn't flatten the chart
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  const pad = (hi - lo) * 0.1 || 10;
  const min = lo - pad;
  const max = hi + pad;
  const t1 = pts[pts.length - 1].t;
  const t0 = t1 - HISTORY_S;
  const left = 48;
  const x = (t) => left + ((t - t0) / (t1 - t0)) * (w - left - 4);
  const y = (v) => {
    const f = Math.min(1, Math.max(0, (v - min) / (max - min)));
    return 4 + (invert ? f : 1 - f) * (h - 8);
  };

  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = css.getPropertyValue('--muted');
  ctx.strokeStyle = css.getPropertyValue('--border');
  ctx.lineWidth = 1;
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.beginPath();
    ctx.moveTo(left, y(v));
    ctx.lineTo(w, y(v));
    ctx.stroke();
    ctx.fillText(fmt(v), 2, y(v) + 4);
  }

  const line = (k, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p[k] == null) { pen = false; continue; }
      if (pen) ctx.lineTo(x(p.t), y(p[k]));
      else ctx.moveTo(x(p.t), y(p[k]));
      pen = true;
    }
    ctx.stroke();
  };
  line(rawKey, css.getPropertyValue('--raw'), 1.5);
  line(key, css.getPropertyValue('--accent'), 3);
}

// Live visuals: rolling pace/stroke-rate chart (pace tile) and the stroke-rate gauge (rate tile).

import { fmtPace } from './format.js';

export const ROLLING_S = 180; // chart shows the last 3 minutes

// ---------- rolling chart ----------

const PACE_STEPS = [5, 10, 15, 30, 60, 120, 300];

/** Round pace values (s/500m) for gridlines inside [lo, hi]: the smallest step giving at most 3. */
export function paceGridlines(lo, hi) {
  for (const step of PACE_STEPS) {
    const lines = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) lines.push(v);
    if (lines.length <= 3) return lines;
  }
  return [];
}

/** Stroke-rate scale snapped to multiples of 5, at least 10 spm tall, with room around the line. */
export function rateScale(min, max) {
  const hi = Math.ceil((max + 2) / 5) * 5;
  const lo = Math.max(0, Math.min(Math.floor((min - 2) / 5) * 5, hi - 10));
  return [lo, Math.max(hi, lo + 10)];
}

const css = () => getComputedStyle(document.documentElement);

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

/**
 * @param canvas
 * @param points [{t, pace, spm}] oldest first; null values break the lines (paused)
 * @param now current time on the same clock as t
 * @param paceBand [fast, slow] s/500m target, or null
 */
export function drawRolling(canvas, points, now, paceBand) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const style = css();
  const accent = style.getPropertyValue('--accent').trim();
  const rate = style.getPropertyValue('--rate').trim();
  const muted = style.getPropertyValue('--muted').trim();

  const t0 = now - ROLLING_S;
  const pts = points.filter((p) => p.t >= t0 - 2);
  const gutter = 18; // right margin for the rate labels, so they never cover the newest data
  const x = (t) => ((t - t0) / ROLLING_S) * (w - gutter);

  // pace scale: faster at the top; robust to outliers; at least 20 s tall; always includes the target band
  const paces = pts.map((p) => p.pace).filter((v) => v != null).sort((a, b) => a - b);
  if (paces.length || paceBand) {
    let lo = paces.length ? percentile(paces, 0.05) : paceBand[0];
    let hi = paces.length ? percentile(paces, 0.95) : paceBand[1];
    if (paceBand) {
      lo = Math.min(lo, paceBand[0]);
      hi = Math.max(hi, paceBand[1]);
    }
    if (hi - lo < 20) {
      const mid = (lo + hi) / 2;
      lo = mid - 10;
      hi = mid + 10;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
    const y = (pace) => 3 + ((Math.min(hi, Math.max(lo, pace)) - lo) / (hi - lo)) * (h - 6);

    // faint gridlines at round paces, labelled on the left (clear of "3 min" in the corner)
    ctx.font = '10px system-ui, sans-serif';
    for (const v of paceGridlines(lo, hi)) {
      const gy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w - gutter, gy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (gy < 12 || gy > h - 16) continue;
      ctx.fillStyle = muted;
      ctx.fillText(fmtPace(v), 4, gy - 3);
    }

    if (paceBand) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(0, y(paceBand[0]), w - gutter, y(paceBand[1]) - y(paceBand[0]));
      ctx.globalAlpha = 1;
    }

    // pace: filled area under a line
    const segments = [];
    let seg = [];
    for (const p of pts) {
      if (p.pace == null) {
        if (seg.length) segments.push(seg);
        seg = [];
      } else seg.push(p);
    }
    if (seg.length) segments.push(seg);
    for (const s of segments) {
      if (s.length < 2) continue;
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.moveTo(x(s[0].t), h);
      for (const p of s) ctx.lineTo(x(p.t), y(p.pace));
      ctx.lineTo(x(s.at(-1).t), h);
      ctx.closePath();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.pace)) : ctx.moveTo(x(p.t), y(p.pace))));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // stroke rate: thin line on its own round-number scale, its ends labelled on the right
  const rates = pts.map((p) => p.spm).filter((v) => v != null);
  if (rates.length > 1) {
    const [rlo, rhi] = rateScale(Math.min(...rates), Math.max(...rates));
    const ry = (v) => h - 3 - ((v - rlo) / (rhi - rlo || 1)) * (h - 6);
    ctx.fillStyle = rate;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(rhi), w - 4, 11);
    ctx.fillText(String(rlo), w - 4, h - 4);
    ctx.textAlign = 'left';
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p.spm == null) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x(p.t), ry(p.spm));
      else ctx.moveTo(x(p.t), ry(p.spm));
      pen = true;
    }
    ctx.strokeStyle = rate;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = muted;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText('3 min', 4, h - 4);
}

// ---------- stroke-rate gauge ----------

export const GAUGE_MIN = 14;
export const GAUGE_MAX = 44;
const CX = 100;
const CY = 100;
const R = 80;

function point(spm, r) {
  const f = (Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, spm)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN);
  const a = Math.PI * (1 - f); // 180° (left) .. 0° (right)
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

function arcPath(from, to, r = R) {
  const [x1, y1] = point(from, r);
  const [x2, y2] = point(to, r);
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** Static parts (track and end labels); call once. */
export function setupGauge(svg) {
  svg.querySelector('.g-track').setAttribute('d', arcPath(GAUGE_MIN, GAUGE_MAX));
  svg.querySelector('.g-min').textContent = GAUGE_MIN;
  svg.querySelector('.g-max').textContent = GAUGE_MAX;
}

/**
 * @param spm current stroke rate or null
 * @param target [lo, hi] or null
 * @param status 'low' | 'ok' | 'high' | null
 */
export function updateGauge(svg, spm, target, status) {
  const wedge = svg.querySelector('.g-target');
  if (target) {
    wedge.setAttribute('d', arcPath(target[0], target[1]));
    wedge.dataset.status = status ?? '';
    wedge.style.display = '';
  } else {
    wedge.style.display = 'none';
  }
  // the target's numbers just outside the ends of the wedge (the viewBox has a margin for them)
  for (const [cls, value] of [['.g-tlo', target?.[0]], ['.g-thi', target?.[1]]]) {
    const label = svg.querySelector(cls);
    label.style.display = value == null ? 'none' : '';
    if (value == null) continue;
    const [x, y] = point(value, R + 21);
    label.setAttribute('x', x.toFixed(1));
    label.setAttribute('y', y.toFixed(1));
    if (label.textContent !== String(value)) label.textContent = value;
  }
  const needle = svg.querySelector('.g-needle');
  needle.style.display = spm == null ? 'none' : '';
  if (spm != null) {
    const [x1, y1] = point(spm, R - 13); // crosses the track only: clear of the reading and the target numbers
    const [x2, y2] = point(spm, R + 11);
    needle.setAttribute('x1', x1.toFixed(1));
    needle.setAttribute('y1', y1.toFixed(1));
    needle.setAttribute('x2', x2.toFixed(1));
    needle.setAttribute('y2', y2.toFixed(1));
    needle.dataset.status = status ?? '';
  }
}

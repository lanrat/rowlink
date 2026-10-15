// Small canvas line chart for session detail. x = seconds, y = values (nulls break the line).

export function drawLineChart(canvas, xs, ys, { invert = false, step = false, fmt = (v) => String(Math.round(v)), xFmt = (s) => `${Math.round(s / 60)}m`, color } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted');
  const border = css.getPropertyValue('--border');
  const vals = ys.filter((v) => v != null);
  if (vals.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('No data', 8, h / 2);
    return;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  // ignore the extreme 2% so one outlier doesn't flatten the chart
  let lo = sorted[Math.floor(sorted.length * 0.02)];
  let hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  if (hi === lo) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  const min = lo - pad;
  const max = hi + pad;
  const x0 = xs[0];
  const x1 = xs[xs.length - 1] || 1;
  const left = 44;
  const bottom = 16;
  const x = (v) => left + ((v - x0) / (x1 - x0 || 1)) * (w - left - 6);
  const y = (v) => {
    const f = Math.min(1, Math.max(0, (v - min) / (max - min)));
    return 4 + (invert ? f : 1 - f) * (h - 8 - bottom);
  };

  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  for (const v of [lo, (lo + hi) / 2, hi]) {
    ctx.beginPath();
    ctx.moveTo(left, y(v));
    ctx.lineTo(w, y(v));
    ctx.stroke();
    ctx.fillText(fmt(v), 2, y(v) + 4);
  }
  for (const f of [0, 0.5, 1]) {
    const xv = x0 + (x1 - x0) * f;
    const label = xFmt(xv);
    const tx = Math.min(w - ctx.measureText(label).width - 2, Math.max(left, x(xv) - 10));
    ctx.fillText(label, tx, h - 3);
  }

  ctx.strokeStyle = color || css.getPropertyValue('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pen = false;
  let prevY = null;
  xs.forEach((xv, i) => {
    const v = ys[i];
    if (v == null) { pen = false; return; }
    if (!pen) ctx.moveTo(x(xv), y(v));
    else if (step) { ctx.lineTo(x(xv), prevY); ctx.lineTo(x(xv), y(v)); }
    else ctx.lineTo(x(xv), y(v));
    prevY = y(v);
    pen = true;
  });
  ctx.stroke();
}

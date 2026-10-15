// One row per second, metric units, for spreadsheets.

const COLUMNS = [
  ['time', (p, start) => new Date(start + p.t * 1000).toISOString()],
  ['elapsed_s', (p) => p.t],
  ['moving_s', (p) => p.mv],
  ['distance_m', (p) => p.d],
  ['strokes', (p) => p.k],
  ['stroke_rate_spm', (p) => p.r],
  ['pace_s_per_500m', (p) => p.p],
  ['power_w', (p) => p.w],
  ['calories_kcal', (p) => p.c],
  ['knob', (p) => p.n],
  ['paused', (p) => p.z],
];

export function encodeCsv(session, data) {
  const rows = [COLUMNS.map(([name]) => name).join(',')];
  for (const p of data.samples) rows.push(COLUMNS.map(([, get]) => get(p, session.startedAt) ?? '').join(','));
  return rows.join('\n') + '\n';
}

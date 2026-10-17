export function fmtPace(s) {
  if (s == null || !isFinite(s)) return '–:––';
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
}

/** A workout's planned length; distance steps make it an estimate. */
export function fmtLength(s, estimated) {
  return `${estimated ? '≈ ' : ''}${fmtTime(s)}`;
}

export function fmtTime(s) {
  const t = Math.max(0, Math.floor(s ?? 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const M_PER_MILE = 1609.344;
export const KG_PER_LB = 0.45359237;

/** Distance value and unit label. Imperial: miles to 2 decimals (0.01 mi = 16 m). */
export function fmtDistance(m, units) {
  if (units === 'metric') return { value: fmtInt(m), unit: 'm' };
  return { value: ((m ?? 0) / M_PER_MILE).toFixed(2), unit: 'mi' };
}

export function fmtInt(n) {
  return n == null || !isFinite(n) ? '–' : String(Math.round(n));
}

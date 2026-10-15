import { encodeFit } from './fit.js';
import { encodeTcx } from './tcx.js';
import { encodeCsv } from './csv.js';

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** e.g. rowing-2026-10-15-0735 */
export function baseName(session) {
  const d = new Date(session.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `rowing-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const FORMATS = {
  fit: (s, d) => new Blob([encodeFit(s, d)], { type: 'application/vnd.ant.fit' }),
  tcx: (s, d) => new Blob([encodeTcx(s, d)], { type: 'application/vnd.garmin.tcx+xml' }),
  csv: (s, d) => new Blob([encodeCsv(s, d)], { type: 'text/csv' }),
  json: (s, d) => new Blob([JSON.stringify({ session: s, data: d })], { type: 'application/json' }),
};

export function exportSession(format, session, data) {
  downloadBlob(FORMATS[format](session, data), `${baseName(session)}.${format}`);
}

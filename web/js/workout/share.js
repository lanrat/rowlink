// Sharing your own workouts: a small JSON file that Import on the Workouts tab reads back,
// or a GitHub issue suggesting the workout for everyone. Pure, so it is tested in Node.

export const WORKOUT_FORMAT = 'rowlink-workout';
const NEW_ISSUE_URL = 'https://github.com/lanrat/rowlink/issues/new';
const MAX_URL = 8000; // GitHub refuses new-issue links much past 8 KB
const INTENSITIES = new Set(['warmup', 'active', 'interval', 'recovery', 'cooldown']);

const num = (x, lo, hi) => (typeof x === 'number' && x >= lo && x <= hi ? x : undefined);
const pair = (r, lo, hi) => (Array.isArray(r) && r.length === 2 && r.every((x) => num(x, lo, hi) != null) ? [...r].sort((a, b) => a - b) : undefined);
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined);

/** A segment with only the fields the app uses, or null if it can't be rowed. */
function cleanSegment(s) {
  if (!['row', 'rest', 'free'].includes(s?.type)) return null;
  const row = s.type === 'row';
  const distanceM = num(s.distanceM, 1, 100000);
  const out = {
    type: s.type,
    durationS: distanceM ? undefined : num(s.durationS, 1, 86400),
    distanceM,
    knob: row ? num(s.knob, 1, 16) : undefined,
    spm: row ? pair(s.spm, 10, 60) : undefined,
    pacePct: row ? pair(s.pacePct, 50, 150) : undefined,
    intensity: INTENSITIES.has(s.intensity) ? s.intensity : undefined,
    label: text(s.label, 40),
  };
  if (!out.durationS && !out.distanceM) return null;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** The shareable file for one of your workouts (no local id). */
export function workoutFile(w) {
  const description = text(w.description, 160);
  return {
    format: WORKOUT_FORMAT,
    version: 1,
    workout: { name: w.name, ...(description ? { description } : {}), segments: w.segments.map(cleanSegment).filter(Boolean) },
  };
}

/** The file's text, one segment per line: easy to read, and keeps the GitHub link short. */
export function workoutText(w) {
  const f = workoutFile(w);
  const segments = f.workout.segments.map((s) => `      ${JSON.stringify(s)}`).join(',\n');
  const outline = JSON.stringify({ ...f, workout: { ...f.workout, segments: [] } }, null, 2);
  return `${outline.replace('"segments": []', () => `"segments": [\n${segments}\n    ]`)}\n`;
}

/** e.g. workout-8-500-m-copy.json */
export function workoutFileName(w) {
  const slug = w.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `workout-${slug || 'shared'}.json`;
}

/**
 * A workout from a shared file, ready to save as one of yours (it still needs an id).
 * Throws with a reason the user can act on.
 */
export function parseWorkoutFile(json) {
  if (json?.format !== WORKOUT_FORMAT || !json.workout) throw new Error('This is not a Rowlink workout file.');
  const w = json.workout;
  const name = text(w.name, 60);
  const segments = Array.isArray(w.segments) ? w.segments.map(cleanSegment) : [];
  if (!name || !segments.length || segments.includes(null)) throw new Error('The workout in this file is incomplete.');
  return { name, description: text(w.description, 160) ?? '', category: 'Mine', segments };
}

/**
 * A link that opens a new GitHub issue suggesting the workout for Rowlink's built-in list.
 * A workout too long for a link gets a request to paste it instead (`complete: false`):
 * the caller puts workoutText() on the clipboard.
 * @param summary e.g. "≈ 46:00 · 4,000 m of distance pieces · knob 4–9"
 */
export function suggestionUrl(w, summary) {
  const title = `Workout suggestion: ${w.name}`;
  const description = text(w.description, 160);
  const intro = [
    'I made this workout in Rowlink and would like to suggest it for everyone.',
    '',
    `**${w.name}**`,
    ...(description ? [description] : []),
    summary,
    '',
    '<!-- Anything else to add? Who it suits, what it trains, where it comes from. -->',
    '',
  ];
  const link = (file) => `${NEW_ISSUE_URL}?${new URLSearchParams({ title, body: [...intro, '```json', file, '```'].join('\n') })}`;
  const full = link(workoutText(w).trimEnd());
  if (full.length <= MAX_URL) return { url: full, complete: true };
  return { url: link('Paste the workout here (Rowlink copied it), or attach the file from Share › Save as a file.'), complete: false };
}

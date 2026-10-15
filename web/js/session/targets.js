// Scores a rowed workout against its targets, per step and overall.
// Pure: runs on saved sessions (history) and in tests.

export const GRACE_S = 10; // the first seconds of each step aren't scored: time to change pace and for smoothing to catch up

const inPace = (pace, [fast, slow]) => pace >= fast && pace <= slow;
const inSpm = (spm, [lo, hi]) => spm >= lo - 0.5 && spm <= hi + 0.5; // same tolerance as the live tile outline

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/**
 * @param steps session.workout.steps (each may have paceRange [fast, slow] s/500m and spm [lo, hi])
 * @param samples session samples with g (step index), mv (moving s), p (pace), r (spm), z (paused)
 * @returns {null | {steps: Array, pace: {onPct, scored}|null, spm: {onPct, scored}|null}}
 *          null when the workout had no targets.
 */
export function targetResults(steps, samples, { graceS = GRACE_S } = {}) {
  if (!steps?.some((s) => s.paceRange || s.spm)) return null;
  const totals = { pace: { on: 0, n: 0 }, spm: { on: 0, n: 0 } };
  const byStep = steps.map((step, i) => {
    const ps = samples.filter((p) => p.g === i && !p.z);
    const startMv = ps[0]?.mv ?? 0;
    const scored = ps.filter((p) => (p.mv ?? 0) - startMv >= graceS);
    const result = { index: i, label: step.label, type: step.type, pace: null, spm: null };
    for (const [key, field, range, test] of [['pace', 'p', step.paceRange, inPace], ['spm', 'r', step.spm, inSpm]]) {
      if (step.type !== 'row' || !range) continue;
      const vals = scored.map((p) => p[field]).filter((v) => v != null);
      const on = vals.filter((v) => test(v, range)).length;
      totals[key].on += on;
      totals[key].n += vals.length;
      result[key] = { target: range, avg: mean(ps.map((p) => p[field]).filter((v) => v != null)), onPct: vals.length ? (100 * on) / vals.length : null };
    }
    return result;
  });
  const overall = (k) => (totals[k].n ? { onPct: (100 * totals[k].on) / totals[k].n, scored: totals[k].n } : null);
  return { steps: byStep, pace: overall('pace'), spm: overall('spm') };
}

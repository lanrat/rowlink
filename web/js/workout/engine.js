// Runs a workout against the live session. Pure: driven by pipeline views and a
// wall-clock time passed in, so it is tested in Node.
//
// Row segments by time count the rower's moving time (they wait while you're paused);
// rest segments count wall-clock time; distance segments count session distance.

export const KNOB_PROMPT_S = 10; // warn this long before a knob change
const COUNTDOWN_FROM_S = 3;

/** Expand {repeat, segments} groups into a flat list of steps with labels like "500 m (3/8)". */
export function flatten(workout) {
  const steps = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.repeat) {
        for (let r = 1; r <= item.repeat; r++) {
          for (const s of item.segments) steps.push({ ...s, label: `${s.label ?? defaultLabel(s)} (${r}/${item.repeat})` });
        }
      } else if (item.segments) {
        walk(item.segments);
      } else {
        steps.push({ ...item, label: item.label ?? defaultLabel(item) });
      }
    }
  };
  walk(workout.segments ?? []);
  return steps;
}

function defaultLabel(s) {
  if (s.type === 'rest') return 'Rest';
  if (s.distanceM) return `${s.distanceM} m`;
  const d = s.durationS ?? 0;
  return d % 60 ? `${d} s` : `${d / 60} min`;
}

/** Total planned time in seconds (distance steps estimated at `paceS` per 500 m). */
export function plannedDurationS(steps, paceS = 150) {
  return steps.reduce((t, s) => t + (s.durationS ?? (s.distanceM ?? 0) * (paceS / 500)), 0);
}

/** Planned seconds for one step; distance steps estimated at `paceS` per 500 m. */
export function stepDurationS(step, paceS = 150) {
  return step.durationS ?? (step.distanceM ?? 0) * (paceS / 500);
}

/**
 * Blocks for a segmented timeline: one per step, sized by planned time.
 * @returns {Array<{start:number, end:number, step:object}>} start/end as fractions 0..1
 */
export function timeline(steps, paceS = 150) {
  const total = plannedDurationS(steps, paceS) || 1;
  let t = 0;
  return steps.map((step) => {
    const start = t / total;
    t += stepDurationS(step, paceS);
    return { start, end: t / total, step };
  });
}

export function plannedDistanceM(steps) {
  return steps.reduce((d, s) => d + (s.distanceM ?? 0), 0);
}

/**
 * A step is "hard" (worth the quicker smoothing) when it asks for speed or rate above steady.
 */
export function isHard(step) {
  return step.type === 'row' && (step.intensity === 'interval' || (step.pacePct?.[0] ?? 0) >= 100 || (step.spm?.[0] ?? 0) >= 26);
}

export class WorkoutRun {
  /**
   * @param workout preset or user workout
   * @param o.referencePaceS reference pace (s/500m) for % targets; null = no pace targets
   * @param o.knobOffset shifts every suggested knob level
   */
  constructor(workout, { referencePaceS = null, knobOffset = 0, maxKnob = 16 } = {}) {
    this.workout = workout;
    this.steps = flatten(workout).map((s) => personalise(s, { referencePaceS, knobOffset, maxKnob }));
    this.i = -1; // -1: waiting for the first stroke
    this.stepStart = null;
    this.done = false;
    this.lastRemainingS = null;
    this.knob = firstKnob(this.steps);
  }

  get step() {
    return this.steps[this.i] ?? null;
  }

  /** Step after the current one (or the first, before starting). */
  get next() {
    return this.steps[this.i + 1] ?? null;
  }

  /**
   * Advance with the latest view.
   * @returns {Array<{type:string, step?:object, knob?:number, s?:number}>} events:
   *   'start' | 'step' (moved to a new step) | 'countdown' (s left) | 'knob' (change coming) | 'done'
   */
  update(view, wallS) {
    const events = [];
    if (this.done) return events;
    if (this.i < 0) {
      if (view.state === 'idle') return events;
      this.begin(0, view, wallS, events);
      events.unshift({ type: 'start' });
    }
    // advance through any steps that are complete (a long gap can finish more than one)
    for (let guard = 0; guard < this.steps.length && !this.done; guard++) {
      const p = this.progress(view, wallS);
      if (p.remaining > 0) {
        this.prompts(p, events);
        break;
      }
      this.begin(this.i + 1, view, wallS, events);
    }
    return events;
  }

  /** Jump to the next step now. */
  skip(view, wallS) {
    const events = [];
    if (this.i < 0 || this.done) return events;
    this.begin(this.i + 1, view, wallS, events);
    return events;
  }

  begin(i, view, wallS, events) {
    this.i = i;
    // Infinity: a step that is already inside the prompt window prompts as soon as it starts
    this.lastRemainingS = Infinity;
    this.stepStart = { movingS: view.movingS, distance: view.distance, wallS };
    if (i >= this.steps.length) {
      this.done = true;
      events.push({ type: 'done' });
      return;
    }
    const step = this.steps[i];
    if (step.knob != null) this.knob = step.knob;
    events.push({ type: 'step', step });
  }

  /** {elapsed, total, remaining, unit: 's'|'m', remainingS (seconds left, estimated for distance)} */
  progress(view, wallS) {
    const step = this.step;
    if (!step) return null;
    if (step.distanceM != null) {
      const elapsed = view.distance - this.stepStart.distance;
      const remaining = step.distanceM - elapsed;
      const speed = view.pace ? 500 / view.pace : null;
      return { elapsed, total: step.distanceM, remaining, unit: 'm', remainingS: speed ? remaining / speed : null };
    }
    const elapsed = step.type === 'rest' ? wallS - this.stepStart.wallS : view.movingS - this.stepStart.movingS;
    const remaining = step.durationS - elapsed;
    return { elapsed, total: step.durationS, remaining, unit: 's', remainingS: remaining };
  }

  /**
   * Whole-workout position: fraction done (for the timeline marker) and estimated seconds left.
   * Distance steps use the current pace when there is one, else `paceS`.
   */
  overall(view, wallS, paceS = 150) {
    const total = plannedDurationS(this.steps, paceS) || 1;
    if (this.i < 0) return { fraction: 0, remainingS: total };
    if (this.done) return { fraction: 1, remainingS: 0 };
    const p = this.progress(view, wallS);
    const before = this.steps.slice(0, this.i).reduce((t, s) => t + stepDurationS(s, paceS), 0);
    const planned = stepDurationS(this.step, paceS);
    const doneInStep = planned * Math.min(1, Math.max(0, p.elapsed / p.total));
    const after = this.steps.slice(this.i + 1).reduce((t, s) => t + stepDurationS(s, paceS), 0);
    const leftInStep = p.remainingS ?? planned - doneInStep;
    return { fraction: Math.min(1, (before + doneInStep) / total), remainingS: Math.max(0, leftInStep) + after };
  }

  prompts(p, events) {
    const prev = this.lastRemainingS;
    const now = p.remainingS;
    if (now == null) return; // distance step without a pace yet
    this.lastRemainingS = now;
    const crossed = (mark) => prev > mark && now <= mark;
    for (let s = COUNTDOWN_FROM_S; s >= 1; s--) if (crossed(s)) events.push({ type: 'countdown', s });
    // knob prompt: KNOB_PROMPT_S before the step that needs a different knob actually starts
    const change = this.nextKnobChange();
    if (change && prev + change.betweenS > KNOB_PROMPT_S && now + change.betweenS <= KNOB_PROMPT_S) {
      events.push({ type: 'knob', knob: change.knob });
    }
  }

  /**
   * The next knob level that differs from now, and the seconds of steps between the
   * current one and it (e.g. a rest). Null if none, or if a distance step is in between.
   */
  nextKnobChange() {
    let betweenS = 0;
    for (let j = this.i + 1; j < this.steps.length; j++) {
      const s = this.steps[j];
      if (s.knob != null) return s.knob !== this.knob ? { knob: s.knob, betweenS } : null;
      if (s.type === 'row' || s.durationS == null) return null;
      betweenS += s.durationS;
    }
    return null;
  }

  /**
   * How the current numbers compare with the step's targets.
   * @returns {{pace: 'fast'|'ok'|'slow'|null, spm: 'low'|'ok'|'high'|null}}
   */
  targetStatus(view) {
    const step = this.step;
    const out = { pace: null, spm: null };
    if (!step || step.type !== 'row') return out;
    if (step.paceRange && view.pace != null) {
      const [fast, slow] = step.paceRange;
      out.pace = view.pace < fast ? 'fast' : view.pace > slow ? 'slow' : 'ok';
    }
    if (step.spm && view.spm != null) {
      const [lo, hi] = step.spm;
      out.spm = view.spm < lo - 0.5 ? 'low' : view.spm > hi + 0.5 ? 'high' : 'ok';
    }
    return out;
  }
}

function firstKnob(steps) {
  return steps.find((s) => s.knob != null)?.knob ?? null;
}

/** Apply knob offset and turn % targets into pace seconds: paceRange = [fastest, slowest]. */
function personalise(step, { referencePaceS, knobOffset, maxKnob }) {
  const out = { ...step };
  if (out.knob != null) out.knob = Math.min(maxKnob, Math.max(1, Math.round(out.knob + knobOffset)));
  if (out.pacePct && referencePaceS) {
    const [lo, hi] = out.pacePct;
    out.paceRange = [(referencePaceS * 100) / hi, (referencePaceS * 100) / lo];
  }
  return out;
}

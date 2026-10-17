// Smoothed display metrics. The rower's instantaneous pace/power swing 2x
// stroke to stroke, so display values come from its counters instead:
//   pace  <- slope of the distance counter over a time window
//   spm   <- slope of the stroke counter over a time window
//   power <- rolling median of reported power, one value per stroke

/**
 * Rate of a cumulative counter (distance or strokes): least-squares slope over a
 * time window, then a light exponential filter. The regression averages out the
 * per-stroke chunks the rower reports counters in; the filter removes what's left.
 *
 * Adaptive: a short window runs alongside the long one. When the two disagree by
 * more than `threshold` (a real change of pace, or the ramp after a pause) the
 * short window wins and the filter speeds up, so the display catches up in a few
 * seconds instead of a whole long window.
 */
export class LinearRate {
  constructor(windowS, { minSpanS = 5, alpha = 0.3, shortS = 10, threshold = 0.2, alphaFast = 0.3, persist = 2 } = {}) {
    this.windowS = windowS;
    this.minSpanS = minSpanS;
    this.alpha = alpha;
    this.shortS = Math.min(shortS, windowS);
    this.threshold = threshold;
    this.alphaFast = alphaFast;
    this.persist = persist; // consecutive disagreeing updates before switching to the short window
    this.reset();
  }

  reset() {
    this.pts = [];
    this.moving = false;
    this.out = null;
    this.streak = 0;
  }

  add(t, value) {
    // Ignore the flat lead-in before the counter first moves (start of session / after a pause).
    if (!this.moving) {
      if (this.pts.length && value !== this.pts[0].v) this.moving = true;
      else {
        this.pts = [{ t, v: value }];
        return;
      }
    }
    this.pts.push({ t, v: value });
    while (this.pts.length > 2 && this.pts[0].t < t - this.windowS) this.pts.shift();
    const span = t - this.pts[0].t;
    if (this.pts.length < 4 || span < this.minSpanS) return;

    const long = Math.max(0, regressionSlope(this.pts));
    const recent = this.pts.filter((p) => p.t >= t - this.shortS);
    const short = recent.length >= 4 ? Math.max(0, regressionSlope(recent)) : null;
    const disagree = short != null && long > 0 && Math.abs(short - long) / long > this.threshold;
    this.streak = disagree ? this.streak + 1 : 0;
    const changing = this.streak >= this.persist;
    // While the long window is still filling (session start, after a pause) it still
    // holds the slow spin-up strokes, so follow the short window then too.
    const filling = span < this.windowS * 0.9;
    const fast = (changing || filling) && short != null;
    const target = fast ? short : long;
    const alpha = fast ? this.alphaFast : this.alpha;
    this.out = this.out == null ? target : this.out + alpha * (target - this.out);
  }

  /** units per second, or null if not enough data */
  rate() {
    return this.out;
  }
}

function regressionSlope(pts) {
  const n = pts.length;
  let mt = 0;
  let mv = 0;
  for (const p of pts) {
    mt += p.t / n;
    mv += p.v / n;
  }
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.t - mt) * (p.v - mv);
    sxx += (p.t - mt) ** 2;
  }
  return sxx ? sxy / sxx : 0;
}

/**
 * Median of the values added within a time window. Always keeps the last `minCount`
 * values however old, and has no value until it has seen that many: right after a
 * reset one strong stroke would otherwise be shown as-is.
 */
export class RollingMedian {
  constructor(windowS, minCount = 1) {
    this.windowS = windowS;
    this.minCount = minCount;
    this.items = [];
  }

  reset() {
    this.items = [];
  }

  add(t, value) {
    if (value != null) this.items.push({ t, v: value });
    while (this.items.length > this.minCount && this.items[0].t < t - this.windowS) this.items.shift();
  }

  value() {
    if (this.items.length < Math.max(1, this.minCount)) return null;
    const s = this.items.map((i) => i.v).sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
}

// FED app's calorie fallback (RowerDataCompat.getMETs): MET by knob position x stroke rate.
const MET_TABLE = {
  low: [4, 5, 6, 7.5, 9],
  mid: [5, 6, 8, 9.5, 12],
  high: [6, 8, 10, 12.5, 15],
};

export function metFor(knob, maxKnob, spm) {
  if (!spm || spm <= 0) return 0;
  const ratio = knob / maxKnob;
  const row = ratio <= 0.3 ? MET_TABLE.low : ratio <= 0.7 ? MET_TABLE.mid : MET_TABLE.high;
  const i = spm <= 20 ? 0 : spm <= 30 ? 1 : spm <= 40 ? 2 : spm <= 50 ? 3 : 4;
  return row[i];
}

const POWER_MIN_STROKES = 3;

export class Metrics {
  constructor({ paceWindowS = 15, spmWindowS = 15, powerWindowS = 10, adaptive } = {}) {
    this.distRate = new LinearRate(paceWindowS, adaptive);
    this.strokeRate = new LinearRate(spmWindowS, adaptive);
    // The rower repeats each stroke's power every second until the next stroke, so per-second
    // samples would weight long strokes more and, after a resume, let one stroke fill the window.
    this.power = new RollingMedian(powerWindowS, POWER_MIN_STROKES);
    this.lastReport = null; // raw pace/power of the last stroke report
    this.kcalEstimate = 0;
    this.powerSum = 0;
    this.powerCount = 0;
    this.lastT = null;
  }

  /** Change smoothing mid-session (e.g. quicker during hard intervals). Keeps the data already collected. */
  setSmoothing({ paceWindowS, spmWindowS, powerWindowS, adaptive = {} }) {
    for (const [rate, windowS] of [[this.distRate, paceWindowS], [this.strokeRate, spmWindowS]]) {
      if (windowS) rate.windowS = windowS;
      for (const k of ['shortS', 'threshold', 'alphaFast', 'persist']) if (adaptive[k] != null) rate[k] = adaptive[k];
      rate.shortS = Math.min(rate.shortS, rate.windowS);
    }
    if (powerWindowS) this.power.windowS = powerWindowS;
  }

  clearWindows() {
    for (const w of [this.distRate, this.strokeRate, this.power]) w.reset();
  }

  /**
   * @param sample from Sanitizer.process()
   * @param ctx {knob, maxKnob, weightKg}
   */
  update(sample, ctx) {
    const { t } = sample;
    if (sample.paused || sample.resumed) this.clearWindows();
    if (!sample.paused) {
      // distance during flywheel spin-up is unreliable: start the pace window after it
      if (!sample.spinup) this.distRate.add(t, sample.distance);
      this.strokeRate.add(t, sample.strokes);
      // a new stroke report is a change in the rower's pace/power pair
      const report = `${sample.raw.pace}/${sample.raw.power}`;
      this.power.add(t, report !== this.lastReport ? sample.power : null);
      this.lastReport = report;
      if (sample.power != null) {
        this.powerSum += sample.power;
        this.powerCount++;
      }
    }
    const spm = this.spm();
    if (this.lastT != null && !sample.paused) {
      const dt = Math.min(2, t - this.lastT);
      this.kcalEstimate += (ctx.weightKg * metFor(ctx.knob, ctx.maxKnob, spm) * dt) / 3600;
    }
    this.lastT = t;
  }

  /** seconds per 500 m */
  /** seconds per 500 m; null for the first few seconds (the rower's own pace is too noisy to fall back on) */
  pace() {
    const r = this.distRate.rate();
    return r != null && r > 0.2 ? 500 / r : null;
  }

  spm() {
    const r = this.strokeRate.rate();
    return r != null ? r * 60 : null;
  }

  powerW() {
    return this.power.value();
  }

  avgPowerW() {
    return this.powerCount ? this.powerSum / this.powerCount : null;
  }
}

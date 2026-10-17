// Turns raw rower frames into trustworthy samples:
//  - session counters start at 0 and only ever increase
//  - device counter resets (sleep/wake) are absorbed into an offset
//  - impossible jumps (e.g. 0 -> 82 m in 3 s at session start) are rejected
//  - invalid markers (pace 0 / 0xFFFF) and paused zeros become null
//  - the first strokes after start/resume (425 W spikes) are ignored
//  - distance during flywheel spin-up (+139 m on stroke 2 of a fresh session) is held to a strict limit

const PACE_INVALID_MIN = 1;
const PACE_INVALID_MAX = 3600; // > 1 h per 500 m is not a pace; also catches 0xFFFF
const WARMUP_STROKES = 2; // power/spm ignored for this many strokes after start/resume
// distance is unreliable for this many strokes: ~4 on a fresh start, 1 bad stroke after a pause
const SPINUP_STROKES_START = 4;
const SPINUP_STROKES_RESUME = 2;

/** A device counter mapped to a monotonic session value. */
export class Counter {
  /**
   * @param {number} maxRate max plausible increase per second
   * @param {number} slack extra allowance per update (the rower reports distance in per-stroke chunks)
   */
  constructor(maxRate, slack = 0, strictRate = maxRate) {
    this.maxRate = maxRate;
    this.slack = slack;
    this.strictRate = strictRate; // limit used by update(..., strict = true)
    this.value = 0;
    this.last = null;
    this.lastT = null;
    this.rejected = 0;
  }

  update(raw, t, strict = false) {
    if (raw == null) return this.value;
    if (this.last == null) {
      this.last = raw; // baseline: whatever the rower had before the session
      this.lastT = t;
      return this.value;
    }
    const delta = raw - this.last;
    const dt = Math.max(1, t - this.lastT);
    if (delta < 0) {
      // Small decreases are glitches; a big drop means the rower reset its counters.
      if (raw < this.last * 0.5) {
        this.value += raw;
        this.last = raw;
      }
    } else if (delta > (strict ? this.strictRate * dt : this.maxRate * dt + this.slack)) {
      this.rejected += delta; // skip the jump, keep counting from the new raw value
      this.last = raw;
    } else {
      this.value += delta;
      this.last = raw;
    }
    this.lastT = t;
    return this.value;
  }
}

export class Sanitizer {
  constructor() {
    // 7 m/s = 1:11/500m, a world-class sprint. The rower reports distance in lumps: one
    // second often carries ~3x (up to ~4x) the average speed, so the slack must cover a
    // lump at fast paces (~19 m at 1:45/500m). During spin-up: 6 m/s with no slack.
    this.distance = new Counter(7, 15, 6);
    this.strokes = new Counter(1.5, 1); // 90 spm
    this.kcal = new Counter(3, 1);
    this.elapsed = new Counter(1.5, 1); // rower's moving time (freezes while paused)
    this.statusPaused = false;
    this.paused = true;
    this.warmupUntil = null; // raw stroke count before which power/spm are ignored
    this.spinupUntil = null; // raw stroke count before which distance is unreliable
    this.hasRowed = false;
    this.lastRawStrokes = null;
  }

  /** Machine Status event from parseMachineStatus(). */
  onStatus(event) {
    if (event === 'paused' || event === 'stopped') this.statusPaused = true;
    if (event === 'started') this.statusPaused = false;
  }

  /** Call after a reconnect: counters keep their values, warm-up restarts. */
  onReconnect() {
    this.warmupUntil = null;
    this.spinupUntil = null;
  }

  /** @param {{t:number, fields:object}} frame from the Assembler */
  process(frame) {
    const { t, fields: f } = frame;
    const strokesRaw = f.strokes ?? this.lastRawStrokes;
    const newStroke = this.lastRawStrokes != null && strokesRaw > this.lastRawStrokes;

    const wasPaused = this.paused;
    const zeros = f.spm === 0 && (f.power ?? 0) === 0;
    if (newStroke) this.statusPaused = false;
    this.paused = (this.statusPaused || zeros) && !newStroke;

    const starting = !this.paused && (wasPaused || this.warmupUntil == null);
    if (strokesRaw != null && starting) {
      const fresh = !this.hasRowed; // first rowing of this session vs resuming after a pause
      this.hasRowed = true;
      this.warmupUntil = strokesRaw + WARMUP_STROKES;
      this.spinupUntil = strokesRaw + (fresh ? SPINUP_STROKES_START : SPINUP_STROKES_RESUME);
    }
    const warming = strokesRaw != null && strokesRaw < this.warmupUntil;
    const spinup = strokesRaw != null && strokesRaw < this.spinupUntil;

    const sample = {
      t,
      paused: this.paused,
      resumed: wasPaused && !this.paused,
      newStroke,
      spinup,
      distance: this.distance.update(f.distance, t, spinup),
      strokes: this.strokes.update(f.strokes, t),
      kcal: this.kcal.update(f.kcal, t),
      movingS: this.elapsed.update(f.elapsed, t),
      pace: validPace(f.pace),
      power: this.paused || warming || f.power == null ? null : f.power,
      spm: this.paused || warming || f.spm == null ? null : f.spm,
      raw: f,
    };
    if (this.paused) sample.pace = null;
    this.lastRawStrokes = strokesRaw;
    return sample;
  }
}

function validPace(p) {
  return p != null && p >= PACE_INVALID_MIN && p <= PACE_INVALID_MAX ? p : null;
}

// Stroke-rate pacer: a free-running beat at the target rate, shaped like a stroke.
// Pure (time is passed in), so it is tested in Node.
//
// It can't follow your actual strokes: the rower reports once a second, too coarse to time
// a catch inside a 2-3 s stroke. So it sets the beat and you follow it, like a metronome.

export const DRIVE_FRACTION = 1 / 3; // drive : recovery = 1 : 2

const ease = (x) => x * x * (3 - 2 * x);

/** Seat position 0 (catch) .. 1 (finish) at `phase` 0..1 through the stroke. */
export function seatPosition(phase, drive = DRIVE_FRACTION) {
  return phase < drive ? ease(phase / drive) : 1 - ease((phase - drive) / (1 - drive));
}

export class Pacer {
  constructor() {
    this.spm = null;
    this.phase = 0; // 0..1 through the current stroke; 0 = catch
    this.lastS = null;
    this.startPending = false;
  }

  /**
   * Set the target rate, or null to stop. A new rate keeps the current phase, so the
   * marker changes speed instead of jumping; starting from stopped begins at a catch.
   */
  setRate(spm) {
    if (spm == null) {
      this.spm = null;
      this.lastS = null;
      return;
    }
    if (this.spm == null) {
      this.phase = 0;
      this.startPending = true;
    }
    this.spm = spm;
  }

  /**
   * Advance to `nowS` (seconds).
   * @returns {boolean} true when a catch happened since the last tick (play the click)
   */
  tick(nowS) {
    if (this.spm == null) return false;
    if (this.lastS == null || this.startPending) {
      this.lastS = nowS;
      const start = this.startPending;
      this.startPending = false;
      return start;
    }
    const dt = Math.max(0, nowS - this.lastS);
    this.lastS = nowS;
    this.phase += (dt * this.spm) / 60;
    if (this.phase < 1) return false;
    this.phase %= 1; // after a long gap (hidden tab) carry on with one catch, not a burst
    return true;
  }

  /** Seat position 0..1, or null when stopped. */
  get position() {
    return this.spm == null ? null : seatPosition(this.phase);
  }
}

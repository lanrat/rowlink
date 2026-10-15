// Session timing. The rower's Elapsed Time freezes while it is auto-paused,
// so it is used for moving time; total time is the app's own wall clock.

export class SessionClock {
  constructor() {
    this.state = 'idle'; // idle -> active <-> paused
    this.startT = null;
    this.movingBase = null; // rower moving-time counter value at session start
    this.movingS = 0;
    this.lastSampleT = null;
  }

  get started() {
    return this.startT != null;
  }

  /** @returns {boolean} true when the session started on this sample */
  onSample(sample) {
    let startedNow = false;
    if (!this.started && sample.newStroke) {
      this.startT = sample.t;
      this.movingBase = sample.movingS;
      startedNow = true;
    }
    if (this.started) {
      this.state = sample.paused ? 'paused' : 'active';
      this.movingS = sample.movingS - this.movingBase;
    }
    this.lastSampleT = sample.t;
    return startedNow;
  }

  totalS(now) {
    return this.started ? Math.max(0, now - this.startT) : 0;
  }

  /** moving time, interpolated between 1 Hz samples while active */
  movingNow(now) {
    if (!this.started) return 0;
    const extra = this.state === 'active' && this.lastSampleT != null ? Math.min(1, now - this.lastSampleT) : 0;
    return this.movingS + Math.max(0, extra);
  }
}
